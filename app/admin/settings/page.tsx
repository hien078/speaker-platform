import { db } from "@/src/prisma/db";
import { updateCommissionAction, updateSettingAction } from "@/src/lib/actions/admin";
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
        <Settings className="size-6 text-amber-400" />
        Hoa hồng &amp; cấu hình
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Không hardcode chính sách kinh doanh — mọi cấu hình lưu trong database (nguyên tắc §73).
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ─── Hoa hồng theo danh mục ─── */}
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-400">
            <Percent className="size-4 text-amber-400" />
            Hoa hồng theo danh mục (%)
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Áp cho giao dịch hoàn tất. Trao đổi thu trên phần tiền bù.
          </p>

          <div className="mt-4 space-y-2">
            {categories.map((c) => (
              <form
                key={c.id}
                action={updateCommissionAction}
                className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5"
              >
                <input type="hidden" name="categoryId" value={c.id} />
                <span className="text-lg">{c.icon}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                <div className="relative w-24">
                  <input
                    name="commissionRate"
                    type="number"
                    min={0}
                    max={30}
                    defaultValue={c.commissionRate}
                    className="input h-9 pr-7 text-center text-sm"
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-zinc-500">%</span>
                </div>
                <button type="submit" className="btn-primary h-9 px-3 text-xs">Lưu</button>
              </form>
            ))}
          </div>
        </section>

        {/* ─── Cấu hình nền tảng ─── */}
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-400">
            <SlidersHorizontal className="size-4 text-sky-400" />
            Cấu hình nền tảng
          </h2>

          <div className="mt-4 space-y-3">
            <form action={updateSettingAction} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
              <input type="hidden" name="key" value="escrow_auto_release_days" />
              <label className="label text-xs">Số ngày escrow tự giải ngân (khiếu nại bị đóng băng trong thời gian này)</label>
              <div className="flex gap-2">
                <input
                  name="value"
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={settingsMap.get("escrow_auto_release_days") ?? "7"}
                  className="input h-9 text-sm"
                />
                <button type="submit" className="btn-primary h-9 px-4 text-xs">Lưu</button>
              </div>
            </form>

            <form action={updateSettingAction} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
              <input type="hidden" name="key" value="default_commission_rate" />
              <label className="label text-xs">Hoa hồng mặc định cho danh mục mới (%)</label>
              <div className="flex gap-2">
                <input
                  name="value"
                  type="number"
                  min={0}
                  max={30}
                  defaultValue={settingsMap.get("default_commission_rate") ?? "5"}
                  className="input h-9 text-sm"
                />
                <button type="submit" className="btn-primary h-9 px-4 text-xs">Lưu</button>
              </div>
            </form>
          </div>

          {/* Audit log */}
          <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-zinc-500">
            Audit log gần đây
          </h3>
          <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {auditLogs.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-600">Chưa có thao tác quản trị nào</p>
            ) : (
              auditLogs.map((log) => (
                <div key={log.id} className="rounded-lg bg-zinc-800/50 px-3 py-2 text-xs">
                  <p className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-amber-400">{log.action}</span>
                    <span className="text-zinc-600">{new Date(log.createdAt).toLocaleString("vi-VN")}</span>
                  </p>
                  <p className="mt-0.5 text-zinc-400">
                    {log.admin!.name} → <b>{log.entity}</b>{log.entityId ? ` (${log.entityId.slice(0, 8)}…)` : ""}
                  </p>
                  {log.detail && <p className="mt-0.5 line-clamp-1 text-zinc-500">{log.detail}</p>}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
