import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { formatDate } from "@/src/lib/utils";
import { ScrollText, ChevronLeft, ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Nhật ký audit" };

/**
 * /admin/audit (plan Task 10 — spec §4.6 Auditability) — xem AuditEvent có
 * kiểu: actor, action, resource, reason, policy version, timestamp, context.
 * Guard: requireCapability("audit.read") — CHỈ super_admin (ma trận §5.4.1;
 * operations_admin KHÔNG có — fail closed).
 *
 * PII (spec §4.8): bảng render đúng những gì đã ghi — detail theo quy ước
 * KHÔNG chứa email/phone/OTP/secret (enforced bởi review + Task 12 scan);
 * ipHash hiển thị RÚT GỌN (không phải giá trị dùng để truy vết). Không có
 * surface export ở đây (pii.export không cấp cho ai — Ambiguities A2).
 */

const PAGE_SIZE = 50;

export default async function AdminAuditPage({
  searchParams,
}: PageProps<"/admin/audit">) {
  await requireCapability("audit.read");
  const sp = (await searchParams) as { p?: string };
  const page = Math.max(1, Number.parseInt(sp.p ?? "1", 10) || 1);

  const [events, total] = await Promise.all([
    db.orm.public.AuditEvent
      .orderBy((e) => e.createdAt.desc())
      .include("actor")
      .include("subject")
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE)
      .all(),
    db.orm.public.AuditEvent.aggregate((a) => ({ c: a.count() })),
  ]);
  const totalPages = Math.max(1, Math.ceil(total.c / PAGE_SIZE));

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <ScrollText className="size-6 text-[var(--accent)]" />
        Nhật ký audit
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        {total.c.toLocaleString("vi-VN")} sự kiện privileged/bảo mật — actor, action, resource,
        reason typed, policy version. Chi tiết theo quy ước không chứa thông tin danh tính thô.
      </p>

      <div className="table-wrap mt-6">
        <table className="table-base">
          <thead>
            <tr>
              <th>Thời điểm</th>
              <th>Hành động</th>
              <th>Actor</th>
              <th>Chủ thể</th>
              <th>Resource</th>
              <th>Lý do</th>
              <th>Chính sách</th>
              <th>Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-[var(--muted)]">
                  Chưa có sự kiện nào (hoặc trang vượt quá số trang).
                </td>
              </tr>
            ) : (
              events.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDate(e.createdAt)}</td>
                  <td className="font-mono text-xs font-medium">{e.action}</td>
                  <td className="text-sm">
                    {e.actor?.name ?? (e.actorId ? `${e.actorId.slice(0, 8)}…` : "system")}
                  </td>
                  <td className="text-sm">
                    {e.subject ? e.subject.name : e.subjectId ? `${e.subjectId.slice(0, 8)}…` : "—"}
                  </td>
                  <td className="text-xs text-[var(--muted)]">
                    {e.resourceType ?? "—"}
                    {e.resourceId ? ` · ${e.resourceId.slice(0, 8)}…` : ""}
                  </td>
                  <td className="font-mono text-xs">{e.reason ?? "—"}</td>
                  <td className="text-xs text-[var(--muted)]">{e.policyVersion ?? "—"}</td>
                  <td className="max-w-64 truncate text-xs text-[var(--muted)]" title={e.detail ?? ""}>
                    {e.detail ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Phân trang */}
      <div className="mt-4 flex items-center justify-between text-sm">
        <p className="text-[var(--muted)]">Trang {page} / {totalPages}</p>
        <div className="flex gap-2">
          {page > 1 && (
            <a href={`/admin/audit?p=${page - 1}`} className="btn-secondary flex items-center gap-1 px-3 text-xs">
              <ChevronLeft className="size-3.5" /> Trước
            </a>
          )}
          {page < totalPages && (
            <a href={`/admin/audit?p=${page + 1}`} className="btn-secondary flex items-center gap-1 px-3 text-xs">
              Sau <ChevronRight className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
