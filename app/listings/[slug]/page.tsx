import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getSessionFromCookie } from "@/src/lib/session";
import { capabilitiesOf } from "@/src/lib/rbac";
import { ListingGallery } from "@/src/components/listing-gallery";
import { ListingCard } from "@/src/components/listing-card";
import { formatVND, formatDateShort, cn } from "@/src/lib/utils";
import { labelOf } from "@/src/lib/listing-error-text";
import {
  CONDITION_LABELS,
  FULFILLMENT_METHOD_LABELS,
  INVENTORY_CONTEXT_LABELS,
} from "@/src/lib/constants";
import {
  SELLER_VERIFIED_BADGE_LABEL,
  isVerifiedSellerStatus,
} from "@/src/lib/seller-verification-status";
import { startConversationAction as startChat } from "@/src/lib/actions/chat";
import { toggleWishlistAction } from "@/src/lib/actions/wishlist";
import { ReportDialog } from "@/src/components/report-dialog";
import {
  MapPin,
  Eye,
  BadgeCheck,
  Handshake,
  MessageCircle,
  Package,
  Heart,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ListingDetailPage({
  params,
}: PageProps<"/listings/[slug]">) {
  const { slug } = await params;
  // MỘT session read — user cho owner/wishlist/chat + session.isAdmin cho
  // admin authority của read gate bên dưới (không đọc session hai lần).
  const current = await getSessionFromCookie();
  const user = current?.user ?? null;

  const listing = await db.orm.public.Listing
    .where({ slug })
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()))
    .include("category", (c) => c.select("id", "name", "slug"))
    .include("brand", (b) => b.select("name"))
    // Badge "đã xác minh" đọc WORKFLOW (SellerVerification.status — spec §8.2),
    // không còn boolean legacy isVerifiedSeller (đã đóng băng từ Task 10).
    .include("seller", (s) =>
      s.select("id", "name", "city", "createdAt", "avatarUrl")
        .include("sellerVerification", (v) => v.select("status")))
    .first();

  // ─── Read gate (Batch 4 holistic review — thay legacy display-role check) ───
  // Admin authority KHÔNG BAO GIỜ từ `user.role` (display-only —
  // setAdminRoleAction gán role='admin' cho cả buyer được promote
  // support/analyst): moderator xem được listing non-public CHỈ KHI session
  // đã qua MFA (session.isAdmin — bằng chứng login path admin, rbac.ts review
  // fix #1) VÀ adminRole có listing.moderate (capability matrix —
  // capabilitiesOf non-throwing). Draft vẫn owner-only (L5 — /admin/listings
  // cũng loại draft khỏi queue moderator: spec §4.4 seller-private).
  const isModeratorSession =
    current !== null &&
    current.session.isAdmin &&
    capabilitiesOf(current.user.adminRole).includes("listing.moderate");
  if (
    !listing ||
    (listing.status !== "approved" &&
      listing.sellerId !== user?.id &&
      !(isModeratorSession && listing.status !== "draft"))
  ) {
    notFound();
  }

  // tăng lượt xem (chỉ với tin đã duyệt)
  if (listing.status === "approved") {
    await db.orm.public.Listing
      .where({ id: listing.id })
      .update({ viewCount: listing.viewCount + 1 });
  }

  const isOwner = user?.id === listing.seller!.id;

  // đã lưu vào wishlist chưa?
  const saved = user
    ? await db.orm.public.WishlistItem
        .where({ userId: user.id, listingId: listing.id })
        .first()
    : null;

  // Product Model link (§5) — specs + giá tham chiếu
  const model = listing.productModelId
    ? await db.orm.public.ProductModel
        .where({ id: listing.productModelId })
        .include("brand", (b) => b.select("name"))
        .first()
    : null;
  const modelStats = model
    ? await db.orm.public.PriceHistory
        .where({ modelId: model.id })
        .aggregate((a) => ({ avg: a.avg("price"), c: a.count() }))
    : null;

  // tin liên quan cùng danh mục
  const related = await db.orm.public.Listing
    .where({ status: "approved", categoryId: listing.category!.id })
    .where((l) => l.id.neq(listing.id))
    .select("id", "title", "slug", "price", "condition", "city", "status", "viewCount", "acceptExchange", "negotiable")
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name"))
    .include("brand", (b) => b.select("name"))
    .orderBy((l) => l.createdAt.desc())
    .limit(4)
    .all();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
      {/* breadcrumb */}
      <nav className="mb-5 flex items-center gap-1.5 text-xs text-[var(--muted)]">
        <Link href="/" className="hover:text-[var(--accent)]">Trang chủ</Link>
        <span>/</span>
        <Link href="/listings" className="hover:text-[var(--accent)]">Chợ loa</Link>
        <span>/</span>
        <Link href={`/listings?category=${listing.category!.slug}`} className="hover:text-[var(--accent)]">
          {listing.category!.name}
        </Link>
      </nav>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        {/* ═══ Cột trái: ảnh + mô tả ═══ */}
        <div className="min-w-0">
          <ListingGallery images={listing.images} title={listing.title} />

          <div className="card mt-6 p-6">
            <h1 className="text-xl font-extrabold leading-snug tracking-tight sm:text-2xl">
              {listing.title}
            </h1>

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--ink-2)]">
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-4 text-amber-500/80" />
                {listing.city}
                {listing.locationDisplayName != null && listing.locationDisplayName !== "" && (
                  <span className="text-[var(--muted)]">· {listing.locationDisplayName}</span>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Eye className="size-4" />
                {listing.viewCount} lượt xem
              </span>
              <span className="badge bg-[var(--paper)] text-[var(--ink-2)]">
                {labelOf(CONDITION_LABELS, listing.condition, listing.condition)}
              </span>
              {listing.negotiable && (
                <span className="badge bg-[var(--accent-soft)] text-[var(--accent)]">Mặc cả</span>
              )}
              {listing.acceptExchange && (
                <span className="badge bg-[#eaf2fb] text-[#2563a8]">
                  <Handshake className="size-3" />
                  Nhận trao đổi
                </span>
              )}
            </div>

            <div className="mt-6 border-t border-[var(--line)] pt-5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
                Mô tả sản phẩm
              </h2>
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--ink-2)]">
                {listing.description}
              </p>
            </div>

            {/* ═══ Thông tin chi tiết có cấu trúc (Batch 4 — spec §5.6) ═══
                Legacy listing giữ NULL ("chưa thu thập") → section vắng hoàn toàn
                (conditional render — KHÔNG render text "null"/placeholder). */}
            {(listing.inventoryContext != null ||
              listing.includedAccessories != null ||
              listing.knownDefects != null ||
              listing.repairHistory != null ||
              (Array.isArray(listing.fulfillmentMethods) &&
                (listing.fulfillmentMethods as string[]).length > 0)) && (
              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
                  Thông tin chi tiết
                </h2>
                <dl className="mt-3 space-y-2 text-sm">
                  {listing.inventoryContext != null && (
                    <div className="flex items-start justify-between gap-3">
                      <dt className="shrink-0 text-[var(--muted)]">Nguồn hàng</dt>
                      <dd className="text-right font-medium text-[var(--ink-2)]">
                        {labelOf(INVENTORY_CONTEXT_LABELS, listing.inventoryContext, listing.inventoryContext)}
                      </dd>
                    </div>
                  )}
                  {Array.isArray(listing.fulfillmentMethods) &&
                    (listing.fulfillmentMethods as string[]).length > 0 && (
                      <div className="flex items-start justify-between gap-3">
                        <dt className="shrink-0 text-[var(--muted)]">Giao hàng</dt>
                        <dd className="text-right font-medium text-[var(--ink-2)]">
                          {/* LOW-1: fulfillmentMethods là cột Json — giá trị arbitrary;
                              lookup own-property-safe, fallback hiển thị giá trị thô */}
                          {(listing.fulfillmentMethods as string[])
                            .map((m) => labelOf(FULFILLMENT_METHOD_LABELS, m, m))
                            .join(", ")}
                        </dd>
                      </div>
                    )}
                </dl>
                {listing.includedAccessories != null && (
                  <div className="mt-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                      Phụ kiện đi kèm
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--ink-2)]">
                      {listing.includedAccessories}
                    </p>
                  </div>
                )}
                {listing.knownDefects != null && (
                  <div className="mt-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                      Vết xước / hư hại đã biết
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--ink-2)]">
                      {listing.knownDefects}
                    </p>
                  </div>
                )}
                {listing.repairHistory != null && (
                  <div className="mt-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                      Lịch sử sửa chữa
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--ink-2)]">
                      {listing.repairHistory}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Model catalog (§5) */}
            {model && (
              <div className="mt-6 rounded-xl border border-violet-400/20 bg-violet-400/[.05] p-4">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--violet)]">
                    Catalog model
                  </span>
                  <Link href={`/models/${model.slug}`} className="font-bold hover:text-[var(--violet)]">
                    {model.brand!.name} {model.name}
                  </Link>
                  {model.releaseYear && <span className="text-xs text-[var(--muted)]">· {model.releaseYear}</span>}
                </p>
                {Object.keys((model.specs ?? {}) as Record<string, string>).length > 0 && (
                  <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                    {Object.entries((model.specs ?? {}) as Record<string, string>).slice(0, 6).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-2">
                        <dt className="text-[var(--muted)]">{k}</dt>
                        <dd className="font-medium text-[var(--ink-2)]">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {modelStats && modelStats.c > 0 && (
                  <p className="mt-3 text-xs text-[var(--muted)]">
                    Giá tham chiếu thị trường:{" "}
                    <b className="text-[var(--violet)]">{formatVND(Math.round(modelStats.avg ?? 0))}</b>{" "}
                    ({modelStats.c} mẫu giá) —{" "}
                    <Link href={`/models/${model.slug}`} className="text-[var(--violet)] hover:text-[var(--violet)]">
                      xem chi tiết model →
                    </Link>
                  </p>
                )}
              </div>
            )}

            <div className="mt-6 rounded-xl border border-[var(--accent)]/20 bg-[var(--accent-soft)] p-4">
              <p className="flex items-start gap-2.5 text-sm leading-relaxed text-[var(--ink-2)]">
                <Handshake className="mt-0.5 size-5 shrink-0 text-[var(--accent)]" />
                <span>
                  Thỏa thuận giá, hỏi tình trạng thật và hẹn xem hàng trực tiếp qua chat.
                  Hẹn ở nơi công cộng, kiểm tra và test loa kỹ trước khi trả tiền; không
                  chia sẻ OTP/mật khẩu và cẩn trọng với link thanh toán lạ.
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* ═══ Cột phải: giá + hành động ═══ */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:h-fit">
          <div className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-3xl font-extrabold tracking-tight text-[var(--accent)]">
                {formatVND(listing.price)}
              </p>
              {user && !isOwner && (
                <form action={toggleWishlistAction}>
                  <input type="hidden" name="listingId" value={listing.id} />
                  <button
                    type="submit"
                    title={saved ? "Bỏ lưu" : "Lưu tin"}
                    className={cn(
                      "grid size-10 shrink-0 place-items-center rounded-full border transition",
                      saved
                        ? "border-red-500/50 bg-[var(--red-soft)] text-[var(--red)] hover:bg-[var(--red-soft)]"
                        : "border-[var(--line)] text-[var(--ink-2)] hover:border-red-500/40 hover:text-[var(--red)]",
                    )}
                  >
                    <Heart className={cn("size-5", saved && "fill-red-400")} />
                  </button>
                </form>
              )}
            </div>
            {listing.negotiable && (
              <p className="mt-1 text-xs text-[var(--muted)]">Người bán mở đón thương lượng</p>
            )}

            <div className="mt-4 space-y-2.5">
              {listing.status === "approved" && !isOwner ? (
                <>
                  <form action={startChat}>
                    <input type="hidden" name="listingId" value={listing.id} />
                    <button type="submit" className="btn-primary w-full">
                      <MessageCircle className="size-4" />
                      Nhắn người bán
                    </button>
                  </form>
                  <p className="rounded-lg bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink-2)]">
                    Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận,
                    diễn ra độc lập ngoài LoaViet. LoaViet không giữ tiền và không bảo đảm giao dịch.
                  </p>
                </>
              ) : listing.status === "sold" ? (
                <p className="rounded-lg bg-[var(--paper)] py-3 text-center text-sm font-semibold text-[var(--ink-2)]">
                  Sản phẩm đã được bán
                </p>
              ) : isOwner ? (
                <Link href="/sell/my" className="btn-secondary w-full">
                  <Package className="size-4" />
                  Quản lý tin đăng của bạn
                </Link>
              ) : (
                <p className="rounded-lg bg-[var(--paper)] py-3 text-center text-sm text-[var(--ink-2)]">
                  {listing.status === "pending" ? "Tin đang chờ quản trị duyệt" : "Tin không còn hiển thị"}
                </p>
              )}
            </div>

            {/* Báo cáo tin đăng (Batch 3 Task 4 — spec §5.5) — chỉ render cho
                người đã đăng nhập KHÔNG phải seller (UI convenience; action tự
                enforce auth + self-report + participant checks server-side). */}
            {user && !isOwner && (
              <div className="mt-3 border-t border-[var(--line)] pt-3">
                <ReportDialog
                  targetType="listing"
                  targetId={listing.id}
                  triggerLabel="Báo cáo tin đăng"
                  className="btn-ghost w-full text-xs text-[var(--muted)] hover:text-[var(--red)]"
                />
              </div>
            )}
          </div>

          {/* Thẻ người bán */}
          <div className="card p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
              Người bán
            </p>
            <Link href={`/seller/${listing.seller!.id}`} className="mt-3 flex items-center gap-3 transition hover:opacity-90">
              <span className="grid size-12 place-items-center rounded-full bg-[var(--accent)] text-sm font-bold text-white">
                {listing.seller!.name.split(" ").map((w) => w[0]).slice(-2).join("").toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-sm font-bold hover:text-amber-200">
                  {listing.seller!.name}
                  {isVerifiedSellerStatus(listing.seller!.sellerVerification?.status) && (
                    <BadgeCheck className="size-4 shrink-0 text-[var(--green)]" />
                  )}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  {isVerifiedSellerStatus(listing.seller!.sellerVerification?.status)
                    ? SELLER_VERIFIED_BADGE_LABEL
                    : "Chưa xác minh"}{" "}
                  · từ {formatDateShort(listing.seller!.createdAt)}
                </p>
              </div>
            </Link>
            {listing.seller!.city && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <MapPin className="size-3.5" />
                {listing.seller!.city}
              </p>
            )}
            <Link href={`/seller/${listing.seller!.id}`} className="btn-secondary mt-3 w-full text-xs">
              Xem gian hàng
            </Link>
          </div>
        </aside>
      </div>

      {/* ═══ Tin liên quan ═══ */}
      {related.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-extrabold tracking-tight">
            Cùng danh mục {listing.category!.name}
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {related.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
