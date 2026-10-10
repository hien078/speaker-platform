import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { ListingCard } from "@/src/components/listing-card";
import { toggleWishlistAction } from "@/src/lib/actions/wishlist";
import { Heart, HeartOff } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tin đã lưu" };

/**
 * /wishlist (§28) — b4-holistic-2 (CONFIRMED MEDIUM): REDACTION.
 *
 * Trước fix, query KHÔNG có status filter — ListingCard render title + ảnh
 * đầu của listing pending/rejected/removed: seller edit approved → pending
 * ghi đè title/ảnh IN PLACE (không shadow revision) nên buyer wishlist thấy
 * content CHƯA DUYỆT; takedown chỉ đổi status → content vi phạm vẫn lộ qua
 * badge "Đã gỡ bởi kiểm duyệt". Batch 4 mở rộng lỗ (edit hidden cũng vào
 * pending; structured edit + slot ảnh swap in-place).
 *
 * Sau fix (recorded decision — fail-closed cho visibility):
 *  - Listing công khai (approved | sold) hoặc CỦA CHÍNH user → ListingCard
 *    đầy đủ (sold vẫn hiển thị — đã qua duyệt trước khi bán; owner thấy tin mình).
 *  - Listing KHÔNG công khai → card REDACTED: KHÔNG title, KHÔNG ảnh, KHÔNG
 *    link slug — chỉ "Tin không còn hiển thị" + nút Bỏ lưu (dọn entry stale;
 *    toggleWishlistAction cho phép BỎ với mọi status). KHÔNG bao giờ đưa
 *    title/ảnh của listing redacted vào ListingCard.
 */
export default async function WishlistPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const items = await db.orm.public.WishlistItem
    .where({ userId: user.id })
    .include("listing", (l) =>
      l.select(
        "id", "title", "slug", "price", "condition", "city", "status",
        "viewCount", "acceptExchange", "negotiable", "sellerId",
      )
        .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
        .include("category", (c) => c.select("name"))
        .include("brand", (b) => b.select("name")),
    )
    .orderBy((w) => w.createdAt.desc())
    .all();

  // Redaction — listing KHÔNG công khai và KHÔNG phải của user (owner thấy
  // tin của chính mình ở mọi status).
  const isRedacted = (l: { status: string; sellerId: string }): boolean =>
    l.status !== "approved" && l.status !== "sold" && l.sellerId !== user.id;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Heart className="size-6 fill-red-500 text-red-500" />
        Tin đã lưu
      </h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Theo dõi giá và tình trạng những chiếc loa bạn để mắt tới.
      </p>

      {items.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">🤍</span>
          <p className="text-lg font-bold">Chưa lưu tin nào</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">
            Bấm vào biểu tượng ❤️ ở trang chi tiết tin đăng để lưu sản phẩm vào đây.
          </p>
          <Link href="/listings" className="btn-primary mt-2 text-sm">Đi đến chợ loa</Link>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((w) => {
            const l = w.listing;
            if (l == null) return null; // listing biến mất (cascade đã xoá item — defensive)
            if (isRedacted(l)) {
              // Card REDACTED — KHÔNG title/ảnh/giá/link slug của content
              // chưa công khai; chỉ nút Bỏ lưu để dọn entry stale.
              return (
                <div key={w.id} className="card flex flex-col overflow-hidden opacity-80">
                  <div className="grid aspect-[4/3] place-items-center bg-[var(--paper-deep)]">
                    <HeartOff className="size-8 text-[var(--muted)]" />
                  </div>
                  <div className="flex flex-1 flex-col gap-1 p-3">
                    <p className="text-[13px] font-medium leading-snug text-[var(--ink-2)]">
                      Tin không còn hiển thị
                    </p>
                    <p className="text-[11px] text-[var(--muted)]">
                      Tin đã bị gỡ, đang chờ duyệt lại hoặc bị ẩn.
                    </p>
                    <form action={toggleWishlistAction} className="mt-auto pt-1.5">
                      <input type="hidden" name="listingId" value={w.listingId} />
                      <button
                        type="submit"
                        className="btn-secondary w-full px-2 py-1 text-[11px]"
                        title="Bỏ tin này khỏi danh sách lưu"
                      >
                        Bỏ lưu
                      </button>
                    </form>
                  </div>
                </div>
              );
            }
            return <ListingCard key={w.id} listing={l} />;
          })}
        </div>
      )}
    </main>
  );
}
