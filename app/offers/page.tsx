import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { OfferCard, type OfferWithListing } from "@/src/components/offer-card";
import { HandCoins } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trả giá" };

async function fetchOffers(where: { listingId?: string; buyerId?: string }) {
  let q = db.orm.public.Offer
    .include("listing", (l) =>
      l.select("id", "title", "slug", "price", "status")
        .include("seller", (s) => s.select("name"))
        .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)),
    )
    .include("buyer", (b) => b.select("name"))
    .orderBy((o) => o.createdAt.desc())
    .limit(50);
  if (where.listingId) q = q.where({ listingId: where.listingId });
  if (where.buyerId) q = q.where({ buyerId: where.buyerId });
  return (await q.all()) as unknown as OfferWithListing[];
}

export default async function OffersPage({
  searchParams,
}: PageProps<"/offers">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const sp = (await searchParams) as { sent?: string };

  // đề nghị nhận được (trên tin của tôi)
  const myListingIds = (await db.orm.public.Listing
    .where({ sellerId: user.id })
    .select("id")
    .all()).map((l) => l.id);

  const receivedLists: OfferWithListing[][] = [];
  for (const listingId of myListingIds) {
    receivedLists.push(await fetchOffers({ listingId }));
  }
  const received = receivedLists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // đề nghị tôi gửi
  const sent = (await fetchOffers({ buyerId: user.id }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
        <HandCoins className="size-6 text-amber-400" />
        Trả giá &amp; đề nghị
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Thỏa thuận giá qua đề nghị — chấp nhận là tạo đơn escrow ngay tại giá đã chốt.
      </p>

      {sp.sent === "1" && (
        <div className="mt-5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
          ✓ Đề nghị đã gửi — seller có 3 ngày phản hồi.
        </div>
      )}

      {/* Nhận được */}
      <section className="mt-8">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Đề nghị nhận được ({received.length})
        </h2>
        <div className="mt-4 space-y-4">
          {received.length === 0 ? (
            <p className="card p-6 text-center text-sm text-zinc-500">
              Chưa ai trả giá tin của bạn. Đánh dấu “Mở đón thương lượng” khi đăng tin để nhận đề nghị.
            </p>
          ) : (
            received.map((o) => <OfferCard key={o.id} offer={o} role="received" />)
          )}
        </div>
      </section>

      {/* Đã gửi */}
      <section className="mt-10">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Đề nghị bạn đã gửi ({sent.length})
        </h2>
        <div className="mt-4 space-y-4">
          {sent.length === 0 ? (
            <p className="card p-6 text-center text-sm text-zinc-500">
              Bạn chưa trả giá tin nào. Vào tin có nhãn “mặc cả” và đề nghị giá của bạn.
            </p>
          ) : (
            sent.map((o) => <OfferCard key={o.id} offer={o} role="sent" />)
          )}
        </div>
      </section>
    </main>
  );
}
