import { db } from "@/src/prisma/db.client";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { DormantFinanceNotice } from "../dormant-notice";
import { Banknote } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Rút tiền" };

const STATUS_LABELS: Record<string, string> = {
  requested: "Chờ xử lý",
  processing: "Đang chuyển khoản",
  paid: "Đã thanh toán",
  rejected: "Từ chối",
};

const STATUS_BADGE: Record<string, string> = {
  requested: "bg-[var(--accent-soft)] text-[var(--accent)]",
  processing: "bg-[#eaf2fb] text-[#2563a8]",
  paid: "bg-[var(--green-soft)] text-[var(--green)]",
  rejected: "bg-[var(--red-soft)] text-[var(--red)]",
};

export default async function AdminWithdrawsPage() {
  const requests = await db.orm.public.WithdrawRequest
    .include("seller", (s) => s.select("name", "email", "phone", "isVerifiedSeller"))
    .orderBy((w) => w.createdAt.desc())
    .limit(60)
    .all();

  // sắp: requested → processing → còn lại
  const order: Record<string, number> = { requested: 0, processing: 1, paid: 2, rejected: 3 };
  requests.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  const pendingCount = requests.filter((r) => r.status === "requested").length;
  const pendingTotal = requests
    .filter((r) => r.status === "requested")
    .reduce((s, r) => s + r.amount, 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <Banknote className="size-6 text-[var(--accent)]" />
          Rút tiền
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Chờ duyệt: <b className="text-[var(--accent)]">{pendingCount}</b> ·{" "}
          <b className="text-[var(--accent)]">{formatVND(pendingTotal)}</b>
        </p>
      </div>

      {/* Yêu cầu rút tiền lịch sử — chỉ đọc khi tài chính tắt (plan Task 5):
          control xử lý đã bỏ khỏi UI; action dưới đáy vẫn deny server-side
          với FINANCIAL_FEATURES_DISABLED (spec §4.10). */}
      <DormantFinanceNotice />

      {requests.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-2 p-16 text-center">
          <span className="text-4xl">💸</span>
          <p className="font-bold">Chưa có yêu cầu rút tiền nào</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {requests.map((r) => (
            <div
              key={r.id}
              className={cn(
                "card p-5",
                r.status === "requested" && "border-[var(--accent)]/35",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-lg font-bold price">
                    {formatVND(r.amount)}
                  </p>
                  <span className={cn("badge", STATUS_BADGE[r.status])}>
                    {STATUS_LABELS[r.status]}
                  </span>
                </div>
                <span className="text-xs text-[var(--muted)]">{formatDate(r.createdAt)}</span>
              </div>

              <div className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
                <p className="text-[var(--ink-2)]">
                  Người bán:{" "}
                  <b className="text-[var(--ink)]">{r.seller!.name}</b>
                  {r.seller!.isVerifiedSeller && <span className="ml-1 text-[var(--green)]">✓</span>}
                  <span className="ml-2 text-xs text-[var(--muted)]">{r.seller!.email}</span>
                </p>
                <p className="text-[var(--ink-2)]">
                  Ngân hàng: <b className="text-[var(--ink)]">{r.bankName}</b>
                </p>
                <p className="text-[var(--ink-2)]">
                  STK: <b className="font-mono text-[var(--ink)]">{r.bankAccount}</b>
                </p>
                <p className="text-[var(--ink-2)]">
                  Chủ TK: <b className="text-[var(--ink)]">{r.accountHolder}</b>
                </p>
              </div>

              {r.note && (
                <p className="mt-2 rounded-lg bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink-2)]">
                  Ghi chú seller: {r.note}
                </p>
              )}
              {r.adminNote && (
                <p className="mt-2 rounded-lg bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink-2)]">
                  Ghi chú admin: {r.adminNote}
                  {r.processedAt && ` · ${formatDate(r.processedAt)}`}
                </p>
              )}

              {/* Form xử lý đã bỏ (plan Task 5) — bản ghi lịch sử chỉ đọc,
                  không duyệt/chuyển khoản/từ chối. */}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
