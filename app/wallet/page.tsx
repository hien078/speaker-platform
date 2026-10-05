import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { financialFeaturesEnabled } from "@/src/lib/financial-features";
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
  requested: "bg-[var(--accent-soft)] text-[var(--accent)]",
  processing: "bg-[#eaf2fb] text-[#2563a8]",
  paid: "bg-[var(--green-soft)] text-[var(--green)]",
  rejected: "bg-[var(--red-soft)] text-[var(--red)]",
};

export default async function WalletPage() {
  // Private beta (Batch 0–1): tài chính tắt mặc định — finance-only page không còn
  // reachable. Kiểm tra ranh giới TRƯỚC mọi read/mutation; code bên dưới giữ
  // nguyên dormant (không xóa code/dữ liệu lịch sử).
  if (!financialFeaturesEnabled()) notFound();

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
    { label: "Khả dụng để rút", value: wallet.available, accent: "price" },
    { label: "Đang chờ xử lý", value: wallet.pendingWithdraw, accent: "text-[var(--accent)]" },
    { label: "Tổng đã kiếm (sau hoa hồng)", value: wallet.totalEarned, accent: "text-[var(--green)]" },
    { label: "Đã rút thành công", value: wallet.totalWithdrawn, accent: "text-[#2563a8]" },
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      <h1 className="text-2xl font-bold tracking-tight">Ví &amp; rút tiền</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Tiền từ đơn hoàn tất được ghi có vào ví sau khi escrow giải ngân.
      </p>

      {/* Số dư */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p className="text-xs text-[var(--muted)]">{c.label}</p>
            <p className={cn("mt-2 text-xl font-bold tracking-tight", c.accent)}>
              {formatVND(c.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* Form rút */}
        <div className="card h-fit p-5">
          <p className="mb-4 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Gửi yêu cầu rút
          </p>
          <WithdrawForm available={wallet.available} />
        </div>

        {/* Lịch sử */}
        <div className="card p-5">
          <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Lịch sử rút tiền
          </p>

          {withdraws.length === 0 ? (
            <p className="py-10 text-center text-sm text-[var(--muted)]">
              Chưa có yêu cầu rút nào — tiền trong ví sẽ nằm đây an toàn.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {withdraws.map((w) => (
                <div key={w.id} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-base font-bold price">
                      {formatVND(w.amount)}
                    </p>
                    <span className={cn("badge", STATUS_BADGE[w.status])}>
                      {STATUS_LABELS[w.status]}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-[var(--muted)]">
                    {w.bankName} · {w.bankAccount} · {formatDate(w.createdAt)}
                  </p>
                  {w.adminNote && (
                    <p className="mt-1.5 rounded-lg bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink-2)]">
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
