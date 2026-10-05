import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { financialFeaturesEnabled } from "@/src/lib/financial-features";
import { formatVND } from "@/src/lib/utils";
import { updateCartItemAction, removeFromCartAction } from "@/src/lib/actions/cart";
import { Trash2, ShoppingCart, Minus, Plus } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Giỏ hàng" };

export default async function CartPage() {
  // Private beta (Batch 0–1): tài chính tắt mặc định — finance-only page không còn
  // reachable. Kiểm tra ranh giới TRƯỚC mọi read/mutation; code bên dưới giữ
  // nguyên dormant (không xóa code/dữ liệu lịch sử).
  if (!financialFeaturesEnabled()) notFound();

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const cart = await db.orm.public.Cart.first({ userId: user.id });
  const items = cart
    ? await db.orm.public.CartItem
        .where({ cartId: cart.id })
        .include("listing", (l) =>
          l.select("id", "title", "slug", "price", "status", "city", "negotiable")
            .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
            .include("seller", (s) => s.select("name")),
        )
        .orderBy((ci) => ci.id.asc())
        .all()
    : [];

  const available = items.filter((i) => i.listing!.status === "approved");
  const total = available.reduce((sum, i) => sum + i.listing!.price * i.quantity, 0);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <ShoppingCart className="size-6 text-[var(--accent)]" />
        Giỏ hàng
      </h1>

      {items.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">🛒</span>
          <p className="text-lg font-bold">Giỏ hàng đang trống</p>
          <p className="text-sm text-[var(--muted)]">Khám phá chợ loa và chọn cho mình một dàn âm thanh đã!</p>
          <Link href="/listings" className="btn-primary mt-2 text-sm">Đi đến chợ loa</Link>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* ─── Danh sách ─── */}
          <div className="space-y-3">
            {items.map((item) => {
              const unavailable = item.listing!.status !== "approved";
              return (
                <div
                  key={item.id}
                  className={`card flex gap-4 p-4 ${unavailable ? "opacity-50" : ""}`}
                >
                  <Link href={`/listings/${item.listing!.slug}`} className="relative size-24 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                    {item.listing!.images[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.listing!.images[0].url} alt={item.listing!.title} className="size-full object-cover" />
                    ) : (
                      <span className="grid size-full place-items-center text-3xl text-[var(--muted)]">🔇</span>
                    )}
                  </Link>

                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                      href={`/listings/${item.listing!.slug}`}
                      className="line-clamp-2 text-sm font-semibold leading-snug hover:text-[var(--accent)]"
                    >
                      {item.listing!.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      Bán bởi {item.listing!.seller!.name} · {item.listing!.city}
                    </p>
                    {unavailable && (
                      <p className="mt-1 text-xs font-semibold text-[var(--red)]">
                        Sản phẩm không còn bán — vui lòng xóa khỏi giỏ
                      </p>
                    )}

                    <div className="mt-auto flex items-center justify-between pt-2">
                      <div className="flex items-center gap-1.5">
                        <form action={updateCartItemAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <input type="hidden" name="quantity" value={item.quantity - 1} />
                          <button type="submit" className="grid size-7 place-items-center rounded-md border border-[var(--line)] text-[var(--ink-2)] transition hover:bg-[var(--paper)] hover:text-white">
                            <Minus className="size-3.5" />
                          </button>
                        </form>
                        <span className="w-8 text-center text-sm font-bold">{item.quantity}</span>
                        <form action={updateCartItemAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <input type="hidden" name="quantity" value={item.quantity + 1} />
                          <button type="submit" className="grid size-7 place-items-center rounded-md border border-[var(--line)] text-[var(--ink-2)] transition hover:bg-[var(--paper)] hover:text-white">
                            <Plus className="size-3.5" />
                          </button>
                        </form>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="text-sm font-extrabold text-[var(--accent)]">
                          {formatVND(item.listing!.price * item.quantity)}
                        </span>
                        <form action={removeFromCartAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <button
                            type="submit"
                            className="grid size-8 place-items-center rounded-md text-[var(--muted)] transition hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
                            title="Xóa khỏi giỏ"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ─── Tổng kết ─── */}
          <aside className="card h-fit p-5 lg:sticky lg:top-20">
            <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Tổng cộng</p>
            <p className="mt-2 text-3xl font-extrabold tracking-tight text-[var(--accent)]">
              {formatVND(total)}
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {available.length} sản phẩm · phí giao hàng tính riêng khi thỏa thuận
            </p>

            <Link
              href="/checkout"
              aria-disabled={available.length === 0}
              className={`btn-primary mt-5 w-full ${available.length === 0 ? "pointer-events-none opacity-50" : ""}`}
            >
              Tiến hành thanh toán
            </Link>
            <Link href="/listings" className="btn-ghost mt-2 w-full text-sm">
              Tiếp tục mua sắm
            </Link>

            <div className="mt-5 rounded-lg bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink-2)]">
              💡 Khi thanh toán qua nền tảng (escrow), tiền của bạn được giữ cho đến khi bạn xác nhận
              đã nhận được loa.
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
