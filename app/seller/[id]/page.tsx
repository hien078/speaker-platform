import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { getBlockState } from "@/src/lib/moderation";
import { blockUserAction, unblockUserAction } from "@/src/lib/actions/blocks";
import { ReportDialog } from "@/src/components/report-dialog";
import { ListingCard } from "@/src/components/listing-card";
import { formatDate, formatDateShort, cn } from "@/src/lib/utils";
import {
  SELLER_VERIFIED_BADGE_LABEL,
  isVerifiedSellerStatus,
} from "@/src/lib/seller-verification-status";
import { BadgeCheck, MapPin, Star, Package, Ban, CircleSlash } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SellerProfilePage({
  params,
}: PageProps<"/seller/[id]">) {
  const { id } = await params;

  // Badge "đã xác minh" đọc WORKFLOW (SellerVerification.status — spec §8.2),
  // không còn boolean legacy isVerifiedSeller (đã đóng băng từ Task 10).
  const seller = await db.orm.public.User
    .where({ id })
    .select("id", "name", "city", "bio", "createdAt", "role")
    .first();

  if (!seller || seller.role === "buyer") notFound();

  // Batch 3 Task 3 (spec §5.5) — nút Chặn/Bỏ chặn. UI convenience: action tự
  // enforce auth + rate limit + self/target checks server-side. Visitor hoặc
  // chính seller không thấy gì; `other_blocked` không có nút (không thể bỏ
  // chặn block của người khác — chỉ getBlockState direction-aware mới biết).
  const viewer = await getCurrentUser();
  const blockState =
    viewer !== null && viewer.id !== seller.id
      ? await getBlockState(viewer.id, seller.id)
      : null;

  const [listings, reviewAgg, completedSales, reviews, verification] = await Promise.all([
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
    db.orm.public.SellerVerification.first({ userId: seller.id }),
  ]);

  const initials = seller.name.split(" ").map((w) => w[0]).slice(-2).join("").toUpperCase();
  const rating = reviewAgg.avg ?? 0;

  return (
    <main className="mx-auto max-w-7xl px-4 py-10 lg:px-8">
      {/* ═══ Thẻ người bán ═══ */}
      <div className="card p-6 sm:p-8">

        <div className="relative flex flex-wrap items-center gap-6">
          <span className="grid size-20 shrink-0 place-items-center rounded-2xl bg-[var(--accent)] text-xl font-bold text-white ">
            {initials}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-bold tracking-tight">
              {seller.name}
              {isVerifiedSellerStatus(verification?.status) && (
                <span className="badge border-[var(--green)]/35 bg-[var(--green-soft)] text-[var(--green)]">
                  <BadgeCheck className="size-3.5" />
                  {SELLER_VERIFIED_BADGE_LABEL}
                </span>
              )}
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
              {seller.city && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-3.5" />
                  {seller.city}
                </span>
              )}
              <span>Tham gia {formatDateShort(seller.createdAt)}</span>
            </p>
            {seller.bio && (
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--ink-2)]">{seller.bio}</p>
            )}
          </div>

          {/* Thống kê */}
          <div className="grid grid-cols-3 gap-6 text-center">
            <div>
              <p className="text-2xl font-bold price">
                {listings.length}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">tin đang bán</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--green)]">
                {completedSales.c}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">giao dịch hoàn tất</p>
            </div>
            <div>
              <p className="flex items-center justify-center gap-1 text-2xl font-bold text-[var(--accent)]">
                <Star className="size-4 fill-[var(--accent)]" />
                {reviewAgg.c > 0 ? rating.toFixed(1) : "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">{reviewAgg.c} đánh giá</p>
            </div>
          </div>

          {/* Chặn / bỏ chặn (Batch 3 Task 3 — spec §5.5; enforcement đối xứng ở chat) */}
          {blockState === "none" && (
            <form action={blockUserAction} className="self-center">
              <input type="hidden" name="userId" value={seller.id} />
              <button
                type="submit"
                className="btn-secondary h-9 px-3.5 text-xs text-[var(--red)] hover:border-[var(--red)]/40 hover:bg-[var(--red-soft)]"
                title="Chặn người này — không bắt đầu hội thoại/tin nhắn mới (lịch sử cũ vẫn đọc được)"
              >
                <Ban className="size-3.5" />
                Chặn
              </button>
            </form>
          )}
          {blockState === "viewer_blocked" && (
            <form action={unblockUserAction} className="self-center">
              <input type="hidden" name="userId" value={seller.id} />
              <button
                type="submit"
                className="btn-secondary h-9 px-3.5 text-xs"
                title="Bỏ chặn người này — mở lại hội thoại/tin nhắn mới"
              >
                <CircleSlash className="size-3.5" />
                Bỏ chặn
              </button>
            </form>
          )}

          {/* Báo cáo người bán (Batch 3 Task 4 — spec §5.5) — chỉ render cho
              người đã đăng nhập khác chính seller (UI convenience; action tự
              enforce auth + self-report checks server-side). */}
          {viewer !== null && viewer.id !== seller.id && (
            <ReportDialog
              targetType="user"
              targetId={seller.id}
              triggerLabel="Báo cáo"
              className="btn-secondary h-9 px-3.5 text-xs text-[var(--red)] hover:border-[var(--red)]/40 hover:bg-[var(--red-soft)]"
            />
          )}
        </div>

        <p className="relative mt-6 flex items-start gap-2 rounded-xl border border-[var(--green)]/25 bg-[var(--green-soft)] px-4 py-2.5 text-xs leading-relaxed text-[var(--green)]/90">
          <BadgeCheck className="mt-0.5 size-4 shrink-0" />
          Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet. Thanh
          toán và giao nhận hàng do bạn và người bán tự thỏa thuận — LoaViet không giữ tiền
          và không bảo đảm giao dịch.
        </p>
      </div>

      {/* ═══ Tin đang bán ═══ */}
      <section className="mt-10">
        <h2 className="flex items-center gap-2.5 text-xl font-bold tracking-tight">
          <Package className="size-5 text-[var(--accent)]" />
          Tin đang bán
        </h2>
        {listings.length === 0 ? (
          <p className="card mt-5 p-12 text-center text-sm text-[var(--muted)]">
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
                          i <= r.rating ? "fill-[var(--accent)] text-[var(--accent)]" : "text-[var(--muted)]",
                        )}
                      />
                    ))}
                  </div>
                </div>
                {r.comment && (
                  <p className="mt-2 text-sm leading-relaxed text-[var(--ink-2)]">{r.comment}</p>
                )}
                <p className="mt-1.5 text-[11px] text-[var(--muted)]">{formatDate(r.createdAt)}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
