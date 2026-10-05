import { db } from "@/src/prisma/db.client";
import { DormantFinanceNotice } from "../dormant-notice";
import { Settings, Percent, SlidersHorizontal } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Hoa hồng & cấu hình" };

export default async function AdminSettingsPage() {
  const [categories, settings, auditLogs] = await Promise.all([
    db.orm.public.Category.orderBy((c) => c.sortOrder.asc()).all(),
    db.orm.public.PlatformSetting.all(),
    db.orm.public.AdminAuditLog
      .include("admin", (a) => a.select("name"))
      .orderBy((l) => l.createdAt.desc())
      .limit(20)
      .all(),
  ]);

  const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Settings className="size-6 text-[var(--accent)]" />
        Hoa hồng &amp; cấu hình
      </h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Không hardcode chính sách kinh doanh — mọi cấu hình lưu trong database (nguyên tắc §73).
      </p>

      {/* Cấu hình tài chính lịch sử — chỉ đọc khi tài chính tắt (plan Task 5):
          form sửa hoa hồng và cấu hình nền tảng đã bỏ khỏi UI; action dưới
          đáy vẫn deny server-side với FINANCIAL_FEATURES_DISABLED (spec §4.1/§4.10). */}
      <DormantFinanceNotice />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ─── Hoa hồng theo danh mục (chỉ đọc) ─── */}
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            <Percent className="size-4 text-[var(--accent)]" />
            Hoa hồng theo danh mục (%)
          </h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Áp cho giao dịch hoàn tất. Trao đổi thu trên phần tiền bù.
          </p>

          <div className="mt-4 space-y-2">
            {categories.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-2.5"
              >
                <span className="text-lg">{c.icon}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                <span className="text-sm font-bold text-[var(--green)]">
                  {c.commissionRate}
                  <span className="ml-0.5 text-xs text-[var(--muted)]">%</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Cấu hình nền tảng (chỉ đọc) ─── */}
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            <SlidersHorizontal className="size-4 text-[#2563a8]" />
            Cấu hình nền tảng
          </h2>

          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3.5">
              <p className="label text-xs">Số ngày escrow tự giải ngân (khiếu nại bị đóng băng trong thời gian này)</p>
              <p className="mt-1 text-sm font-bold">
                {settingsMap.get("escrow_auto_release_days") ?? "7"}
                <span className="ml-1 text-xs font-medium text-[var(--muted)]">ngày</span>
              </p>
            </div>

            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3.5">
              <p className="label text-xs">Hoa hồng mặc định cho danh mục mới (%)</p>
              <p className="mt-1 text-sm font-bold">
                {settingsMap.get("default_commission_rate") ?? "5"}
                <span className="ml-0.5 text-xs font-medium text-[var(--muted)]">%</span>
              </p>
            </div>
          </div>

          {/* Audit log */}
          <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
            Audit log gần đây
          </h3>
          <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {auditLogs.length === 0 ? (
              <p className="py-4 text-center text-xs text-[var(--muted)]">Chưa có thao tác quản trị nào</p>
            ) : (
              auditLogs.map((log) => (
                <div key={log.id} className="rounded-lg bg-[var(--paper)] px-3 py-2 text-xs">
                  <p className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[var(--accent)]">{log.action}</span>
                    <span className="text-[var(--muted)]">{new Date(log.createdAt).toLocaleString("vi-VN")}</span>
                  </p>
                  <p className="mt-0.5 text-[var(--ink-2)]">
                    {log.admin!.name} → <b>{log.entity}</b>{log.entityId ? ` (${log.entityId.slice(0, 8)}…)` : ""}
                  </p>
                  {log.detail && <p className="mt-0.5 line-clamp-1 text-[var(--muted)]">{log.detail}</p>}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
