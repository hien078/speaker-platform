import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { financialFeaturesEnabled } from "@/src/lib/financial-features";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE, PAYMENT_METHOD_LABELS } from "@/src/lib/constants";
import { sellerConfirmPaymentAction, shipOrderAction } from "@/src/lib/actions/orders";
import { Package, Banknote, Truck, HandCoins } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đơn bán được" };

export default async function SalesPage() {
  // Private beta (Batch 0–1): tài chính tắt mặc định — finance-only page không còn
  // reachable. Kiểm tra ranh giới TRƯỚC mọi read/mutation; code bên dưới giữ
  // nguyên dormant (không xóa code/dữ liệu lịch sử).
  if (!financialFeaturesEnabled()) notFound();

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orders = await db.orm.public.Order
    .where({ sellerId: user.id })
    .include("items", (i) => i.select("title", "price", "imageUrl", "quantity"))
    .include("buyer", (b) => b.select("name"))
    .orderBy((o) => o.createdAt.desc())
    .limit(50)
    .all();

  const completed = orders.filter((o) => o.status === "completed");
  const revenue = completed.reduce((s, o) => s + o.sellerPayout, 0);
  const commissionPaid = completed.reduce((s, o) => s + o.commissionAmount, 0);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <Banknote className="size-6 text-[var(--accent)]" />
          Đơn bán được
        </h1>
        <Link href="/orders" className="btn-ghost text-sm text-[var(--accent)] hover:text-[var(--accent)]">
          Đơn đã mua
        </Link>
      </div>

      {/* ─── Thống kê ─── */}
      <div className="mt-6 grid grid-cols-3 gap-3">
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)]">Đơn hoàn tất</p>
          <p className="mt-1 text-2xl font-extrabold">{completed.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)]">Đã nhận (sau hoa hồng)</p>
          <p className="mt-1 text-2xl font-extrabold text-[var(--green)]">{formatVND(revenue)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)]">Hoa hồng đã đóng</p>
          <p className="mt-1 text-2xl font-extrabold text-[var(--accent)]">{formatVND(commissionPaid)}</p>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">🛍️</span>
          <p className="text-lg font-bold">Chưa bán được đơn nào</p>
          <p className="text-sm text-[var(--muted)]">Đăng tin để tiếp cận hàng nghìn người mua loa!</p>
          <Link href="/sell/new" className="btn-primary mt-2 text-sm">Đăng tin bán loa</Link>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {orders.map((order) => (
            <div key={order.id} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={`/orders/${order.id}`} className="font-mono text-sm font-bold text-[var(--accent)] hover:text-[var(--accent)]">
                    {order.code}
                  </Link>
                  <span className={cn("badge", ORDER_STATUS_BADGE[order.status])}>
                    {ORDER_STATUS_LABELS[order.status]}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{formatDate(order.createdAt)}</span>
                </div>
                <div className="text-right">
                  <p className="text-base font-extrabold text-[var(--accent)]">{formatVND(order.totalAmount)}</p>
                  <p className="text-[11px] text-[var(--muted)]">
                    nhận {formatVND(order.sellerPayout)} (hoa hồng {order.commissionRate}%)
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <div className="flex -space-x-3">
                  {order.items.slice(0, 3).map((item, i) => (
                    <div key={i} className="relative size-11 overflow-hidden rounded-lg border-2 border-[var(--card)] bg-[var(--paper-deep)]">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt="" className="size-full object-cover" />
                      ) : (
                        <span className="grid size-full place-items-center text-[var(--muted)]">🔇</span>
                      )}
                    </div>
                  ))}
                </div>
                <p className="min-w-0 flex-1 truncate text-sm text-[var(--ink-2)]">
                  {order.items[0]?.title}
                  {order.items.length > 1 && <span className="text-[var(--muted)]"> +{order.items.length - 1}</span>}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  Mua bởi <b className="text-[var(--ink-2)]">{order.buyer!.name}</b> · {PAYMENT_METHOD_LABELS[order.paymentMethod]}
                </p>
              </div>

              {/* ─── Hành động seller ─── */}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-4">
                {["awaiting_payment"].includes(order.status) && order.paymentMethod !== "escrow" && (
                  <form action={sellerConfirmPaymentAction}>
                    <input type="hidden" name="orderId" value={order.id} />
                    <button type="submit" className="btn-primary h-9 text-sm">
                      <HandCoins className="size-4" />
                      Xác nhận đã nhận tiền
                    </button>
                  </form>
                )}
                {["paid_escrow", "processing"].includes(order.status) && (
                  <form action={shipOrderAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="orderId" value={order.id} />
                    <input
                      name="tracking"
                      className="input h-9 w-48 text-sm"
                      placeholder="Mã vận đơn (tùy chọn)"
                    />
                    <button type="submit" className="btn-primary h-9 text-sm">
                      <Truck className="size-4" />
                      Đã gửi hàng
                    </button>
                  </form>
                )}
                <Link href={`/orders/${order.id}`} className="btn-secondary h-9 text-sm">
                  <Package className="size-4" />
                  Chi tiết đơn
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
