import { db } from "@/src/prisma/db.client";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { DISPUTE_STATUS_LABELS } from "@/src/lib/constants";
import { DormantFinanceNotice } from "../dormant-notice";
import { AlertTriangle } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Khiếu nại" };

export default async function AdminDisputesPage() {
  const allDisputes = await db.orm.public.Dispute
    .include("order", (o) =>
      o.select("id", "code", "totalAmount", "sellerPayout", "commissionAmount", "status", "paymentMethod")
        .include("buyer", (b) => b.select("name"))
        .include("seller", (s) => s.select("name"))
        .include("items", (i) => i.select("title")),
    )
    .include("openedBy", (u) => u.select("name"))
    .orderBy((d) => d.createdAt.desc())
    .limit(50)
    .all();
  // mở trước, sau đó theo ngày
  const disputes = [...allDisputes].sort((a, b) => {
    const aOpen = a.status === "open" ? 0 : 1;
    const bOpen = b.status === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const openCount = disputes.filter((d) => d.status === "open").length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <AlertTriangle className="size-6 text-[var(--red)]" />
          Khiếu nại
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Đang mở: <b className={cn(openCount > 0 ? "text-[var(--red)]" : "text-[var(--green)]")}>{openCount}</b>
        </p>
      </div>

      {/* Khiếu nại tài chính lịch sử — chỉ đọc khi tài chính tắt (plan Task 5):
          control xử lý đã bỏ khỏi UI; action dưới đáy vẫn deny server-side
          với FINANCIAL_FEATURES_DISABLED (spec §4.10). */}
      <DormantFinanceNotice />

      {disputes.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-2 p-16 text-center">
          <span className="text-4xl">🕊️</span>
          <p className="font-bold">Chưa có khiếu nại nào — marketplace khỏe mạnh!</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {disputes.map((d) => {
            const order = d.order!
            return (
              <div key={d.id} className={cn("card p-5", d.status === "open" && "border-red-500/40")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {/* Route chi tiết đơn public đã retire (Task 4) — mã đơn dạng text */}
                    <span className="font-mono text-sm font-bold text-[var(--accent)]">
                      {order.code}
                    </span>
                    <span className={cn(
                      "badge",
                      d.status === "open" ? "bg-[var(--red-soft)] text-[var(--red)]" :
                      d.status === "resolved_buyer" ? "bg-[var(--accent-soft)] text-[var(--accent)]" :
                      d.status === "resolved_seller" ? "bg-[var(--green-soft)] text-[var(--green)]" :
                      "bg-[var(--paper-deep)] text-[var(--ink-2)]",
                    )}>
                      {DISPUTE_STATUS_LABELS[d.status]}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--muted)]">Mở {formatDate(d.createdAt)}</span>
                </div>

                <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <p className="text-[var(--ink-2)]">
                    Người mua: <b className="text-[var(--ink)]">{order.buyer!.name}</b>
                    <span className="ml-2 text-xs text-[var(--muted)]">khiếu nại bởi {d.openedBy!.name}</span>
                  </p>
                  <p className="text-[var(--ink-2)]">
                    Người bán: <b className="text-[var(--ink)]">{order.seller!.name}</b>
                  </p>
                  <p className="text-[var(--ink-2)]">
                    Sản phẩm: <span className="text-[var(--ink-2)]">{order.items[0]?.title}</span>
                  </p>
                  <p className="text-[var(--ink-2)]">
                    Giá trị: <b className="text-[var(--accent)]">{formatVND(order.totalAmount)}</b>
                    <span className="ml-1.5 text-xs text-[var(--muted)]">
                      (escrow {formatVND(order.totalAmount)} → seller {formatVND(order.sellerPayout)})
                    </span>
                  </p>
                </div>

                <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--ink-2)]">
                  <span className="font-semibold text-[var(--red)]">Lý do: </span>
                  {d.reason}
                </p>

                {d.resolution && (
                  <p className="mt-2 rounded-lg bg-[var(--paper)] px-3.5 py-2.5 text-xs text-[var(--ink-2)]">
                    <b className="text-[var(--ink-2)]">Quyết định ({formatDate(d.resolvedAt)}):</b> {d.resolution}
                  </p>
                )}
                {/* Form xử lý khiếu nại đã bỏ khỏi UI (plan Task 5) — bản ghi lịch sử
                    chỉ đọc; quyết định cũ vẫn hiển thị phía trên. Action dưới đáy
                    vẫn deny server-side khi tài chính tắt (spec §4.10). */}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
