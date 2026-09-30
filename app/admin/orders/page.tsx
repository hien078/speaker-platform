import Link from "next/link";
import { db } from "@/src/prisma/db";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/src/lib/constants";
import { Package } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Đơn hàng" };

export default async function AdminOrdersPage({
  searchParams,
}: PageProps<"/admin/orders">) {
  const sp = (await searchParams) as { status?: string };
  type OrderStatus = "awaiting_payment" | "paid_escrow" | "processing" | "shipped" | "completed" | "cancelled" | "refunded" | "disputed";
  const status = sp.status && ORDER_STATUS_LABELS[sp.status] ? (sp.status as OrderStatus) : undefined;

  const orders = await db.orm.public.Order
    .where(status ? { status } : {})
    .include("buyer", (b) => b.select("name"))
    .include("seller", (s) => s.select("name"))
    .include("payments", (p) => p.select("status", "method"))
    .orderBy((o) => o.createdAt.desc())
    .limit(100)
    .all();

  const escrowHeld = orders
    .filter((o) => o.payments.some((p) => p.status === "held"))
    .reduce((s, o) => s + o.totalAmount, 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <Package className="size-6 text-amber-400" />
          Đơn hàng
        </h1>
        <p className="text-sm text-zinc-500">
          Escrow đang giữ: <b className="text-violet-400">{formatVND(escrowHeld)}</b>
        </p>
      </div>

      {/* Bộ lọc trạng thái */}
      <div className="mt-5 flex flex-wrap gap-1.5">
        <a
          href="/admin/orders"
          className={cn("badge border px-3 py-1.5", !status ? "border-amber-500/60 bg-amber-500/10 text-amber-300" : "border-[var(--border)] bg-[var(--surface-2)] text-zinc-400")}
        >
          Tất cả
        </a>
        {Object.entries(ORDER_STATUS_LABELS).map(([k, v]) => (
          <a
            key={k}
            href={`/admin/orders?status=${k}`}
            className={cn("badge border px-3 py-1.5", status === k ? "border-amber-500/60 bg-amber-500/10 text-amber-300" : "border-[var(--border)] bg-[var(--surface-2)] text-zinc-400")}
          >
            {v}
          </a>
        ))}
      </div>

      <div className="table-wrap mt-5">
        <table className="table-base">
          <thead>
            <tr>
              <th>Mã đơn</th>
              <th>Người mua</th>
              <th>Người bán</th>
              <th>Tổng</th>
              <th>Hoa hồng</th>
              <th>Thanh toán</th>
              <th>Trạng thái</th>
              <th>Ngày</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-zinc-500">Chưa có đơn hàng</td>
              </tr>
            ) : (
              orders.map((o) => {
                const payment = o.payments[0];
                return (
                  <tr key={o.id}>
                    <td className="font-mono text-xs font-bold text-amber-400">{o.code}</td>
                    <td className="text-sm">{o.buyer!.name}</td>
                    <td className="text-sm">{o.seller!.name}</td>
                    <td className="text-sm font-bold">{formatVND(o.totalAmount)}</td>
                    <td className="text-sm text-emerald-400">
                      {formatVND(o.commissionAmount)}
                      <span className="ml-1 text-[10px] text-zinc-500">({o.commissionRate}%)</span>
                    </td>
                    <td className="text-xs">
                      <p className="text-zinc-300">{PAYMENT_METHOD_LABELS[o.paymentMethod]}</p>
                      <p className="text-zinc-500">{payment ? PAYMENT_STATUS_LABELS[payment.status] : "—"}</p>
                    </td>
                    <td>
                      <span className={cn("badge", ORDER_STATUS_BADGE[o.status])}>
                        {ORDER_STATUS_LABELS[o.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-zinc-500">{formatDate(o.createdAt)}</td>
                    <td>
                      <Link href={`/orders/${o.id}`} className="btn-ghost h-8 px-2.5 text-xs">
                        Chi tiết
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
