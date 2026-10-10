import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { cn, formatDate } from "@/src/lib/utils";
import { ScrollText, ChevronLeft, ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Nhật ký audit" };

/**
 * /admin/audit (plan Task 10 — spec §4.6 Auditability) — xem AuditEvent có
 * kiểu: actor, action, resource, reason, policy version, timestamp, context.
 * Guard: requireCapability("audit.read") — CHỈ super_admin (ma trận §5.4.1;
 * operations_admin KHÔNG có — fail closed).
 *
 * Batch 3 Task 8 — filter theo action prefix (?action=): registry audit mở
 * rộng (moderation.* của Tasks 5–7 + các nhóm Batch 2). Danh sách prefix ĐÓNG
 * (ACTION_PREFIXES) — giá trị query ngoài danh sách bị bỏ qua (fail closed,
 * KHÔNG phải pattern ilike tùy ý từ query string); filter giữ nguyên thứ tự
 * (createdAt desc) + phân trang — count cũng theo cùng filter.
 *
 * PII (spec §4.8): bảng render đúng những gì đã ghi — detail theo quy ước
 * KHÔNG chứa email/phone/OTP/secret (enforced bởi review + Task 12 scan);
 * ipHash KHÔNG được render ở đây (keyed hash nội bộ phục vụ truy vết —
 * không mang giá trị hiển thị). Không có surface export ở đây (pii.export
 * không cấp cho ai — Ambiguities A2).
 */

const PAGE_SIZE = 50;

/**
 * Prefix filter (?action=) — các nhóm action prefix của registry audit
 * (src/lib/audit-event.ts + moderation Tasks 5–7). Danh sách ĐÓNG: giá trị
 * query lạ → không filter (fail closed).
 */
const ACTION_PREFIXES = [
  { value: "moderation", label: "Kiểm duyệt" },
  { value: "seller_verification", label: "Duyệt seller" },
  { value: "session", label: "Phiên" },
  { value: "admin", label: "Quản trị" },
  { value: "user", label: "Người dùng" },
] as const;

/** Link phân trang/filter giữ nguyên các param đang chọn. */
const auditHref = (page: number, prefix: string): string =>
  prefix === ""
    ? `/admin/audit?p=${page}`
    : `/admin/audit?p=${page}&action=${prefix}`;

export default async function AdminAuditPage({
  searchParams,
}: PageProps<"/admin/audit">) {
  await requireCapability("audit.read");
  const sp = (await searchParams) as { p?: string; action?: string };
  const page = Math.max(1, Number.parseInt(sp.p ?? "1", 10) || 1);
  // Prefix ĐÓNG — giá trị ngoài ACTION_PREFIXES → bỏ filter (fail closed).
  const prefix =
    ACTION_PREFIXES.find((t) => t.value === (sp.action ?? ""))?.value ?? "";

  let eventsQuery = db.orm.public.AuditEvent
    .orderBy((e) => e.createdAt.desc())
    .include("actor")
    .include("subject")
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  let countQuery = db.orm.public.AuditEvent;
  if (prefix !== "") {
    // Filter theo prefix (ilike "<prefix>.%" — dot-namespace của registry).
    eventsQuery = eventsQuery.where((a) => a.action.ilike(`${prefix}.%`));
    countQuery = countQuery.where((a) => a.action.ilike(`${prefix}.%`));
  }

  const [events, total] = await Promise.all([
    eventsQuery.all(),
    countQuery.aggregate((a) => ({ c: a.count() })),
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

      {/* Filter theo action prefix (Batch 3 Task 8) — danh sách đóng */}
      <div className="mt-5 flex flex-wrap gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1">
        <a
          href={auditHref(1, "")}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition",
            prefix === ""
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--ink-2)] hover:text-white",
          )}
        >
          Tất cả
        </a>
        {ACTION_PREFIXES.map((t) => (
          <a
            key={t.value}
            href={auditHref(1, t.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition",
              prefix === t.value
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--ink-2)] hover:text-white",
            )}
          >
            {t.label}
          </a>
        ))}
      </div>

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

      {/* Phân trang — giữ nguyên prefix đang filter */}
      <div className="mt-4 flex items-center justify-between text-sm">
        <p className="text-[var(--muted)]">Trang {page} / {totalPages}</p>
        <div className="flex gap-2">
          {page > 1 && (
            <a href={auditHref(page - 1, prefix)} className="btn-secondary flex items-center gap-1 px-3 text-xs">
              <ChevronLeft className="size-3.5" /> Trước
            </a>
          )}
          {page < totalPages && (
            <a href={auditHref(page + 1, prefix)} className="btn-secondary flex items-center gap-1 px-3 text-xs">
              Sau <ChevronRight className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
