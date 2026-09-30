import { db } from "@/src/prisma/db";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { processWithdrawAction } from "@/src/lib/actions/withdraw";
import { Banknote, LoaderCircle } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Rút tiền" };

const STATUS_LABELS: Record<string, string> = {
  requested: "Chờ xử lý",
  processing: "Đang chuyển khoản",
  paid: "Đã thanh toán",
  rejected: "Từ chối",
};

const STATUS_BADGE: Record<string, string> = {
  requested: "bg-amber-400/15 text-amber-300",
  processing: "bg-sky-400/15 text-sky-300",
  paid: "bg-emerald-400/15 text-emerald-300",
  rejected: "bg-red-400/15 text-red-300",
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
          <Banknote className="size-6 text-amber-400" />
          Duyệt rút tiền
        </h1>
        <p className="text-sm text-zinc-500">
          Chờ duyệt: <b className="text-amber-300">{pendingCount}</b> ·{" "}
          <b className="text-amber-300">{formatVND(pendingTotal)}</b>
        </p>
      </div>

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
                r.status === "requested" && "border-amber-400/30",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="font-[family-name:var(--font-space-grotesk)] text-lg font-bold text-spotlight">
                    {formatVND(r.amount)}
                  </p>
                  <span className={cn("badge", STATUS_BADGE[r.status])}>
                    {STATUS_LABELS[r.status]}
                  </span>
                </div>
                <span className="text-xs text-zinc-500">{formatDate(r.createdAt)}</span>
              </div>

              <div className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
                <p className="text-zinc-400">
                  Người bán:{" "}
                  <b className="text-zinc-200">{r.seller!.name}</b>
                  {r.seller!.isVerifiedSeller && <span className="ml-1 text-emerald-400">✓</span>}
                  <span className="ml-2 text-xs text-zinc-600">{r.seller!.email}</span>
                </p>
                <p className="text-zinc-400">
                  Ngân hàng: <b className="text-zinc-200">{r.bankName}</b>
                </p>
                <p className="text-zinc-400">
                  STK: <b className="font-mono text-zinc-200">{r.bankAccount}</b>
                </p>
                <p className="text-zinc-400">
                  Chủ TK: <b className="text-zinc-200">{r.accountHolder}</b>
                </p>
              </div>

              {r.note && (
                <p className="mt-2 rounded-lg bg-white/[.03] px-3 py-1.5 text-xs text-zinc-400">
                  Ghi chú seller: {r.note}
                </p>
              )}
              {r.adminNote && (
                <p className="mt-2 rounded-lg bg-white/[.03] px-3 py-1.5 text-xs text-zinc-400">
                  Ghi chú admin: {r.adminNote}
                  {r.processedAt && ` · ${formatDate(r.processedAt)}`}
                </p>
              )}

              {["requested", "processing"].includes(r.status) && (
                <form action={processWithdrawAction} className="mt-4 space-y-2.5 border-t border-[var(--border)] pt-4">
                  <input type="hidden" name="withdrawId" value={r.id} />
                  <input
                    name="adminNote"
                    className="input text-sm"
                    placeholder="Ghi chú xử lý (tùy chọn) — vd: đã chuyển khoản lúc 14h"
                  />
                  <div className="flex flex-wrap gap-2">
                    {r.status === "requested" && (
                      <button type="submit" name="action" value="processing" className="btn-secondary h-9 flex-1 text-sm">
                        <LoaderCircle className="size-4" />
                        Đang chuyển khoản
                      </button>
                    )}
                    <button type="submit" name="action" value="paid" className="btn-primary h-9 flex-1 text-sm">
                      ✓ Đã chuyển khoản xong
                    </button>
                    <button
                      type="submit"
                      name="action"
                      value="reject"
                      className="btn h-9 flex-1 border border-red-500/30 bg-red-500/10 text-sm text-red-300 transition hover:bg-red-500/20"
                    >
                      Từ chối
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
