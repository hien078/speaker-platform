import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { getWalletSummary } from "@/src/lib/wallet";
import { WithdrawForm } from "@/src/components/withdraw-form";
import { formatVND, formatDate, cn } from "@/src/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ví & rút tiền" };

const STATUS_LABELS: Record<string, string> = {
  requested: "Chờ xử lý",
  processing: "Đang chuyển khoản",
  paid: "Đã nhận tiền",
  rejected: "Bị từ chối",
};

const STATUS_BADGE: Record<string, string> = {
  requested: "bg-amber-400/15 text-amber-300",
  processing: "bg-sky-400/15 text-sky-300",
  paid: "bg-emerald-400/15 text-emerald-300",
  rejected: "bg-red-400/15 text-red-300",
};

export default async function WalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [wallet, withdraws] = await Promise.all([
    getWalletSummary(user.id),
    db.orm.public.WithdrawRequest
      .where({ sellerId: user.id })
      .orderBy((w) => w.createdAt.desc())
      .limit(20)
      .all(),
  ]);

  const cards = [
    { label: "Khả dụng để rút", value: wallet.available, accent: "text-spotlight" },
    { label: "Đang chờ xử lý", value: wallet.pendingWithdraw, accent: "text-amber-300" },
    { label: "Tổng đã kiếm (sau hoa hồng)", value: wallet.totalEarned, accent: "text-emerald-400" },
    { label: "Đã rút thành công", value: wallet.totalWithdrawn, accent: "text-sky-400" },
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      <h1 className="text-2xl font-bold tracking-tight">Ví &amp; rút tiền</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Tiền từ đơn hoàn tất được ghi có vào ví sau khi escrow giải ngân.
      </p>

      {/* Số dư */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p className="text-xs text-zinc-500">{c.label}</p>
            <p className={cn("mt-2 font-[family-name:var(--font-space-grotesk)] text-xl font-bold tracking-tight", c.accent)}>
              {formatVND(c.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* Form rút */}
        <div className="ring-gradient h-fit p-5">
          <p className="mb-4 text-sm font-bold uppercase tracking-wider text-zinc-400">
            Gửi yêu cầu rút
          </p>
          <WithdrawForm available={wallet.available} />
        </div>

        {/* Lịch sử */}
        <div className="card p-5">
          <p className="text-sm font-bold uppercase tracking-wider text-zinc-400">
            Lịch sử rút tiền
          </p>

          {withdraws.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-600">
              Chưa có yêu cầu rút nào — tiền trong ví sẽ nằm đây an toàn.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {withdraws.map((w) => (
                <div key={w.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-[family-name:var(--font-space-grotesk)] text-base font-bold text-spotlight">
                      {formatVND(w.amount)}
                    </p>
                    <span className={cn("badge", STATUS_BADGE[w.status])}>
                      {STATUS_LABELS[w.status]}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-zinc-500">
                    {w.bankName} · {w.bankAccount} · {formatDate(w.createdAt)}
                  </p>
                  {w.adminNote && (
                    <p className="mt-1.5 rounded-lg bg-white/[.03] px-3 py-1.5 text-xs text-zinc-400">
                      Quản trị: {w.adminNote}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
