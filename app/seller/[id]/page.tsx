import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db";
import { ListingCard } from "@/src/components/listing-card";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { BadgeCheck, MapPin, Star, Package, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SellerProfilePage({
  params,
}: PageProps<"/seller/[id]">) {
  const { id } = await params;

  const seller = await db.orm.public.User
    .where({ id })
    .select("id", "name", "city", "bio", "createdAt", "isVerifiedSeller", "role")
    .first();

  if (!seller || seller.role === "buyer") notFound();

  const [listings, reviewAgg, completedSales, reviews] = await Promise.all([
    db.orm.public.Listing
      .where({ sellerId: seller.id, status: "approved" })
      .select(
        "id", "title", "slug", "price", "condition", "city", "status",
        "viewCount", "acceptExchange", "negotiable",
      )
      .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
      .include("category", (c) => c.select("name"))
      .include("brand", (b) => b.select("name"))
      .orderBy((l) => l.createdAt.desc())
      .limit(24)
      .all(),
    db.orm.public.Review
      .where({ targetUserId: seller.id })
      .aggregate((a) => ({ avg: a.avg("rating"), c: a.count() })),
    db.orm.public.Order
      .where({ sellerId: seller.id, status: "completed" })
      .aggregate((a) => ({ c: a.count() })),
    db.orm.public.Review
      .where({ targetUserId: seller.id })
      .include("author", (u) => u.select("name"))
      .orderBy((r) => r.createdAt.desc())
      .limit(10)
      .all(),
  ]);

  const initials = seller.name.split(" ").map((w) => w[0]).slice(-2).join("").toUpperCase();
  const rating = reviewAgg.avg ?? 0;

  return (
    <main className="mx-auto max-w-7xl px-4 py-10 lg:px-8">
      {/* ═══ Thẻ người bán ═══ */}
      <div className="ring-gradient relative overflow-hidden p-6 sm:p-8">
        <div className="orb right-[-4%] top-[-40%] size-64 bg-amber-500/15" aria-hidden />

        <div className="relative flex flex-wrap items-center gap-6">
          <span className="grid size-20 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 font-[family-name:var(--font-space-grotesk)] text-xl font-bold text-zinc-950 shadow-[0_8px_32px_-6px_rgba(251,146,60,.6)]">
            {initials}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-bold tracking-tight">
              {seller.name}
              {seller.isVerifiedSeller && (
                <span className="badge border-emerald-400/30 bg-emerald-400/15 text-emerald-300">
                  <BadgeCheck className="size-3.5" />
                  Đã xác minh
                </span>
              )}
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500">
              {seller.city && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-3.5" />
                  {seller.city}
                </span>
              )}
              <span>Tham gia {formatDate(seller.createdAt).split(" ")[0]}</span>
            </p>
            {seller.bio && (
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">{seller.bio}</p>
            )}
          </div>

          {/* Thống kê */}
          <div className="grid grid-cols-3 gap-6 text-center">
            <div>
              <p className="font-[family-name:var(--font-space-grotesk)] text-2xl font-bold text-spotlight">
                {listings.length}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">tin đang bán</p>
            </div>
            <div>
              <p className="font-[family-name:var(--font-space-grotesk)] text-2xl font-bold text-emerald-400">
                {completedSales.c}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">giao dịch hoàn tất</p>
            </div>
            <div>
              <p className="flex items-center justify-center gap-1 font-[family-name:var(--font-space-grotesk)] text-2xl font-bold text-amber-300">
                <Star className="size-4 fill-amber-300" />
                {reviewAgg.c > 0 ? rating.toFixed(1) : "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">{reviewAgg.c} đánh giá</p>
            </div>
          </div>
        </div>

        <p className="relative mt-6 flex items-start gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[.05] px-4 py-2.5 text-xs leading-relaxed text-emerald-300/90">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          Giao dịch với người bán này qua LoaViet để được escrow bảo vệ — nền tảng giữ tiền
          của bạn cho đến khi nhận hàng và xác nhận.
        </p>
      </div>

      {/* ═══ Tin đang bán ═══ */}
      <section className="mt-10">
        <h2 className="flex items-center gap-2.5 text-xl font-bold tracking-tight">
          <Package className="size-5 text-amber-400" />
          Tin đang bán
        </h2>
        {listings.length === 0 ? (
          <p className="card mt-5 p-12 text-center text-sm text-zinc-500">
            Người bán này hiện không có tin nào đang bán.
          </p>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {listings.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        )}
      </section>

      {/* ═══ Đánh giá ═══ */}
      {reviews.length > 0 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-xl font-bold tracking-tight">Đánh giá từ người mua</h2>
          <div className="mt-5 space-y-3">
            {reviews.map((r) => (
              <div key={r.id} className="card p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">{r.author!.name}</p>
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <Star
                        key={i}
                        className={cn(
                          "size-3.5",
                          i <= r.rating ? "fill-amber-300 text-amber-300" : "text-zinc-700",
                        )}
                      />
                    ))}
                  </div>
                </div>
                {r.comment && (
                  <p className="mt-2 text-sm leading-relaxed text-zinc-300">{r.comment}</p>
                )}
                <p className="mt-1.5 text-[11px] text-zinc-600">{formatDate(r.createdAt)}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
