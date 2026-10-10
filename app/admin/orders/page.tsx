import { db } from "@/src/prisma/db.client";
import { requireAdminUser } from "@/src/lib/rbac";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/src/lib/constants";
import { DormantFinanceNotice } from "../dormant-notice";
import { Package } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Đơn hàng" };

export default async function AdminOrdersPage({
  searchParams,
}: PageProps<"/admin/orders">) {
  // Guard server-side (spec §4.5) — view finance lịch sử: bất kỳ adminRole
  // (read-only historical, Batch 1 posture — plan Task 4).
  await requireAdminUser();
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
          <Package className="size-6 text-[var(--accent)]" />
          Đơn hàng
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Escrow đang giữ: <b className="text-[var(--violet)]">{formatVND(escrowHeld)}</b>
        </p>
      </div>

      {/* Đơn tài chính lịch sử — chỉ đọc khi tài chính tắt (plan Task 5) */}
      <DormantFinanceNotice />

      {/* Bộ lọc trạng thái */}
      <div className="mt-5 flex flex-wrap gap-1.5">
        <a
          href="/admin/orders"
          className={cn("badge border px-3 py-1.5", !status ? "border-[var(--accent)]/65 bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)]")}
        >
          Tất cả
        </a>
        {Object.entries(ORDER_STATUS_LABELS).map(([k, v]) => (
          <a
            key={k}
            href={`/admin/orders?status=${k}`}
            className={cn("badge border px-3 py-1.5", status === k ? "border-[var(--accent)]/65 bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)]")}
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
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-[var(--muted)]">Chưa có đơn hàng</td>
              </tr>
            ) : (
              orders.map((o) => {
                const payment = o.payments[0];
                return (
                  <tr key={o.id}>
                    <td className="font-mono text-xs font-bold text-[var(--accent)]">{o.code}</td>
                    <td className="text-sm">{o.buyer!.name}</td>
                    <td className="text-sm">{o.seller!.name}</td>
                    <td className="text-sm font-bold">{formatVND(o.totalAmount)}</td>
                    <td className="text-sm text-[var(--green)]">
                      {formatVND(o.commissionAmount)}
                      <span className="ml-1 text-[10px] text-[var(--muted)]">({o.commissionRate}%)</span>
                    </td>
                    <td className="text-xs">
                      <p className="text-[var(--ink-2)]">{PAYMENT_METHOD_LABELS[o.paymentMethod]}</p>
                      <p className="text-[var(--muted)]">{payment ? PAYMENT_STATUS_LABELS[payment.status] : "—"}</p>
                    </td>
                    <td>
                      <span className={cn("badge", ORDER_STATUS_BADGE[o.status])}>
                        {ORDER_STATUS_LABELS[o.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDate(o.createdAt)}</td>
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
