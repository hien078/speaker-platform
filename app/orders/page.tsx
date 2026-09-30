import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE, PAYMENT_METHOD_LABELS } from "@/src/lib/constants";
import { Package, ArrowRight } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đơn hàng của tôi" };

export default async function OrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orders = await db.orm.public.Order
    .where({ buyerId: user.id })
    .include("items", (i) => i.select("title", "price", "imageUrl", "quantity"))
    .include("seller", (s) => s.select("name"))
    .orderBy((o) => o.createdAt.desc())
    .limit(50)
    .all();

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <Package className="size-6 text-[var(--accent)]" />
          Đơn hàng của tôi
        </h1>
        <Link href="/orders/sales" className="btn-ghost text-sm text-[var(--accent)] hover:text-[var(--accent)]">
          Đơn bán được <ArrowRight className="size-4" />
        </Link>
      </div>

      {orders.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">📦</span>
          <p className="text-lg font-bold">Chưa có đơn hàng nào</p>
          <p className="text-sm text-[var(--muted)]">Mua chiếc loa đầu tiên của bạn nhé!</p>
          <Link href="/listings" className="btn-primary mt-2 text-sm">Đi đến chợ loa</Link>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {orders.map((order) => (
            <Link
              key={order.id}
              href={`/orders/${order.id}`}
              className="card block p-5 transition hover:border-[var(--accent)]/45"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-bold text-[var(--accent)]">{order.code}</span>
                  <span className={cn("badge", ORDER_STATUS_BADGE[order.status])}>
                    {ORDER_STATUS_LABELS[order.status]}
                  </span>
                </div>
                <span className="text-xs text-[var(--muted)]">{formatDate(order.createdAt)}</span>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex -space-x-3">
                  {order.items.slice(0, 3).map((item, i) => (
                    <div key={i} className="relative size-12 overflow-hidden rounded-lg border-2 border-[var(--card)] bg-[var(--paper-deep)]">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt="" className="size-full object-cover" />
                      ) : (
                        <span className="grid size-full place-items-center text-lg text-[var(--muted)]">🔇</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--ink)]">
                    {order.items[0]?.title ?? "—"}
                    {order.items.length > 1 && (
                      <span className="text-[var(--muted)]"> +{order.items.length - 1} sản phẩm</span>
                    )}
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    Bán bởi {order.seller!.name} · {PAYMENT_METHOD_LABELS[order.paymentMethod]}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-base font-extrabold text-[var(--accent)]">{formatVND(order.totalAmount)}</p>
                  <p className="text-[11px] text-[var(--muted)]">{order.items.reduce((s, i) => s + i.quantity, 0)} món</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
