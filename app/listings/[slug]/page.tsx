import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { ListingGallery } from "@/src/components/listing-gallery";
import { ListingCard } from "@/src/components/listing-card";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { CONDITION_LABELS } from "@/src/lib/constants";
import { addToCartAction } from "@/src/lib/actions/cart";
import { startConversationAction as startChat } from "@/src/lib/actions/chat";
import { toggleWishlistAction } from "@/src/lib/actions/wishlist";
import { OfferForm } from "@/src/components/offer-form";
import {
  MapPin,
  Eye,
  ShieldCheck,
  BadgeCheck,
  Handshake,
  ShoppingCart,
  MessageCircle,
  Banknote,
  Zap,
  Package,
  Heart,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ListingDetailPage({
  params,
}: PageProps<"/listings/[slug]">) {
  const { slug } = await params;
  const user = await getCurrentUser();

  const listing = await db.orm.public.Listing
    .where({ slug })
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()))
    .include("category", (c) => c.select("id", "name", "slug", "commissionRate"))
    .include("brand", (b) => b.select("name"))
    .include("seller", (s) => s.select("id", "name", "city", "createdAt", "isVerifiedSeller", "avatarUrl"))
    .first();

  if (!listing || (listing.status !== "approved" && listing.sellerId !== user?.id && user?.role !== "admin")) {
    notFound();
  }

  // tăng lượt xem (chỉ với tin đã duyệt)
  if (listing.status === "approved") {
    await db.orm.public.Listing
      .where({ id: listing.id })
      .update({ viewCount: listing.viewCount + 1 });
  }

  const isOwner = user?.id === listing.seller!.id;
  const commission = Math.round((listing.price * listing.category!.commissionRate) / 100);

  // đã lưu vào wishlist chưa?
  const saved = user
    ? await db.orm.public.WishlistItem
        .where({ userId: user.id, listingId: listing.id })
        .first()
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
      <nav className="mb-5 flex items-center gap-1.5 text-xs text-zinc-500">
        <Link href="/" className="hover:text-amber-400">Trang chủ</Link>
        <span>/</span>
        <Link href="/listings" className="hover:text-amber-400">Chợ loa</Link>
        <span>/</span>
        <Link href={`/listings?category=${listing.category!.slug}`} className="hover:text-amber-400">
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

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-400">
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-4 text-amber-500/80" />
                {listing.city}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Eye className="size-4" />
                {listing.viewCount} lượt xem
              </span>
              <span className="badge bg-zinc-800 text-zinc-300">
                {CONDITION_LABELS[listing.condition]}
              </span>
              {listing.negotiable && (
                <span className="badge bg-amber-500/15 text-amber-400">Mặc cả</span>
              )}
              {listing.acceptExchange && (
                <span className="badge bg-sky-500/15 text-sky-400">
                  <Handshake className="size-3" />
                  Nhận trao đổi
                </span>
              )}
            </div>

            <div className="mt-6 border-t border-[var(--border)] pt-5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                Mô tả sản phẩm
              </h2>
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-300">
                {listing.description}
              </p>
            </div>

            <div className="mt-6 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <p className="flex items-start gap-2.5 text-sm leading-relaxed text-zinc-300">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-amber-400" />
                <span>
                  Giao dịch qua LoaViet: bạn trả tiền vào nền tảng, người bán gửi hàng, bạn xác nhận
                  nhận được loa rồi nền tảng mới giải ngân. Nếu có vấn đề, mở khiếu nại trong{" "}
                  <b>7 ngày</b> — tiền vẫn đang được giữ.
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* ═══ Cột phải: giá + hành động ═══ */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:h-fit">
          <div className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-3xl font-extrabold tracking-tight text-amber-400">
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
                        ? "border-red-500/50 bg-red-500/15 text-red-400 hover:bg-red-500/25"
                        : "border-[var(--border)] text-zinc-400 hover:border-red-500/40 hover:text-red-400",
                    )}
                  >
                    <Heart className={cn("size-5", saved && "fill-red-400")} />
                  </button>
                </form>
              )}
            </div>
            {listing.negotiable && (
              <p className="mt-1 text-xs text-zinc-500">Người bán mở đón thương lượng</p>
            )}

            <div className="mt-4 space-y-2.5">
              {listing.status === "approved" && !isOwner ? (
                <>
                  <Link href={`/checkout?listing=${listing.slug}`} className="btn-primary w-full">
                    <Zap className="size-4" />
                    Mua ngay
                  </Link>
                  <form action={addToCartAction}>
                    <input type="hidden" name="listingId" value={listing.id} />
                    <button type="submit" className="btn-secondary w-full">
                      <ShoppingCart className="size-4" />
                      Thêm vào giỏ
                    </button>
                  </form>
                  {listing.acceptExchange && (
                    <Link
                      href={`/listings/${listing.slug}/exchange`}
                      className="btn w-full border border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
                    >
                      <Handshake className="size-4" />
                      Đề nghị trao đổi + tiền bù
                    </Link>
                  )}
                  <form action={startChat}>
                    <input type="hidden" name="listingId" value={listing.id} />
                    <button type="submit" className="btn-ghost w-full">
                      <MessageCircle className="size-4" />
                      Chat với người bán
                    </button>
                  </form>
                  {listing.negotiable && (
                    <OfferForm listingId={listing.id} listingPrice={listing.price} />
                  )}
                </>
              ) : listing.status === "sold" ? (
                <p className="rounded-lg bg-zinc-800 py-3 text-center text-sm font-semibold text-zinc-400">
                  Sản phẩm đã được bán
                </p>
              ) : isOwner ? (
                <Link href="/sell/my" className="btn-secondary w-full">
                  <Package className="size-4" />
                  Quản lý tin đăng của bạn
                </Link>
              ) : (
                <p className="rounded-lg bg-zinc-800 py-3 text-center text-sm text-zinc-400">
                  {listing.status === "pending" ? "Tin đang chờ quản trị duyệt" : "Tin không còn hiển thị"}
                </p>
              )}
            </div>

            <div className="mt-4 rounded-lg bg-zinc-800/50 p-3 text-xs leading-relaxed text-zinc-400">
              <p className="flex items-center gap-1.5 font-semibold text-zinc-300">
                <Banknote className="size-3.5 text-amber-400" />
                Hoa hồng nền tảng: {listing.category!.commissionRate}%
              </p>
              <p className="mt-1">
                Khi giao dịch hoàn tất, LoaViet thu {formatVND(commission)} ({listing.category!.commissionRate}%)
                từ người bán. Người mua không mất thêm phí.
              </p>
            </div>
          </div>

          {/* Thẻ người bán */}
          <div className="card p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
              Người bán
            </p>
            <Link href={`/seller/${listing.seller!.id}`} className="mt-3 flex items-center gap-3 transition hover:opacity-90">
              <span className="grid size-12 place-items-center rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-sm font-bold text-zinc-950">
                {listing.seller!.name.split(" ").map((w) => w[0]).slice(-2).join("").toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-sm font-bold hover:text-amber-200">
                  {listing.seller!.name}
                  {listing.seller!.isVerifiedSeller && (
                    <BadgeCheck className="size-4 shrink-0 text-emerald-400" />
                  )}
                </p>
                <p className="text-xs text-zinc-500">
                  {listing.seller!.isVerifiedSeller ? "Đã xác minh" : "Chưa xác minh"} · từ{" "}
                  {formatDate(listing.seller!.createdAt).split(" ")[0]}
                </p>
              </div>
            </Link>
            {listing.seller!.city && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
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
