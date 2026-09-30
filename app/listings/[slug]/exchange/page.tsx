import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { formatVND } from "@/src/lib/utils";
import { ExchangeOfferForm } from "@/src/components/exchange-offer-form";
import { ArrowLeft, Handshake, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đề nghị trao đổi" };

export default async function ExchangeOfferPage({
  params,
}: PageProps<"/listings/[slug]/exchange">) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const listing = await db.orm.public.Listing
    .where({ slug })
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name", "commissionRate"))
    .include("brand", (b) => b.select("name"))
    .include("seller", (s) => s.select("name"))
    .first();

  if (!listing || !listing.acceptExchange || listing.status !== "approved") notFound();
  if (listing.sellerId === user.id) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center lg:px-8">
        <p className="text-lg font-bold">Đây là tin đăng của chính bạn 🙂</p>
        <Link href="/sell/my" className="btn-secondary mt-4 text-sm">Quản lý tin đăng</Link>
      </main>
    );
  }

  // các tin đã duyệt của user để chọn đưa ra trao đổi
  const myListings = await db.orm.public.Listing
    .where({ sellerId: user.id, status: "approved" })
    .select("id", "title", "price")
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .orderBy((l) => l.createdAt.desc())
    .limit(30)
    .all();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <Link href={`/listings/${listing.slug}`} className="btn-ghost mb-5 h-9 px-3 text-sm">
        <ArrowLeft className="size-4" />
        Về tin đăng
      </Link>

      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Handshake className="size-6 text-sky-400" />
        Đề nghị trao đổi
      </h1>
      <p className="mt-1.5 text-sm text-zinc-500">
        Trao đổi sản phẩm của bạn + tiền bù (nếu có) — phần tiền bù được giữ qua escrow.
      </p>

      {/* Tin mục tiêu */}
      <div className="card mt-6 flex items-center gap-4 p-4">
        <div className="size-16 shrink-0 overflow-hidden rounded-lg bg-zinc-900">
          {listing.images[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={listing.images[0].url} alt="" className="size-full object-cover" />
          ) : (
            <span className="grid size-full place-items-center text-2xl text-zinc-700">🔇</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500">Bạn muốn đổi để lấy</p>
          <p className="line-clamp-1 text-sm font-bold">{listing.title}</p>
          <p className="text-sm font-extrabold text-amber-400">{formatVND(listing.price)}</p>
        </div>
      </div>

      <div className="card mt-4 p-6">
        <ExchangeOfferForm listingId={listing.id} myListings={myListings} />
      </div>

      <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
        Nền tảng thu hoa hồng {listing.category!.commissionRate}% trên phần tiền bù khi giao dịch
        hoàn tất. Nếu không bù tiền, giao dịch trao đổi thuần túy không mất phí.
      </p>
    </main>
  );
}
