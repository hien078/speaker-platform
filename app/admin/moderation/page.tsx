import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { formatDateShort, cn } from "@/src/lib/utils";
import {
  MODERATION_CASE_STATE_LABELS,
  MODERATION_PRIORITY_LABELS,
  REPORT_REASON_LABELS,
} from "@/src/lib/constants";
import {
  ACTIVE_MODERATION_CASE_STATES,
  MODERATION_CASE_STATES,
  type ModerationCaseState,
} from "@/src/lib/moderation-vocab";
import { Flag } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Báo cáo & kiểm duyệt" };

/**
 * Moderation case queue (Batch 3 Task 6 — spec §5.5 moderation cases + §5.4.1
 * report.resolve ✓ cells). Guard server-side (spec §4.5/§4.9): super/ops/
 * moderator (ô ✓); analyst/support fail closed (A1 — ô Scoped chưa định nghĩa).
 * requireAdminUser ở layout chỉ là cổng vào /admin — KHÔNG phải quyền xem queue.
 *
 * Filter tabs theo state (?state= — mặc định "active" = open|triaged|
 * investigating — các case còn đang xử lý; closed/dismissed xem qua tab riêng).
 * Nav lọc theo capability là CONVENIENCE — trang tự guard.
 */

/** Badge màu theo state (UI convenience — không phải authorization). */
const STATE_BADGE: Record<ModerationCaseState, string> = {
  open: "bg-amber-500/15 text-amber-400",
  triaged: "bg-sky-500/15 text-sky-400",
  investigating: "bg-violet-500/15 text-violet-400",
  actioned: "bg-emerald-500/15 text-emerald-400",
  dismissed: "bg-zinc-700/60 text-zinc-300",
  appealed: "bg-red-500/15 text-red-400",
  closed: "bg-zinc-700/60 text-zinc-300",
};

const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-zinc-700/60 text-zinc-300",
  normal: "bg-[var(--paper-deep)] text-[var(--ink-2)]",
  high: "bg-red-500/15 text-red-400",
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  listing: "Tin đăng",
  user: "Người dùng",
  message: "Tin nhắn",
};

export default async function AdminModerationPage({
  searchParams,
}: PageProps<"/admin/moderation">) {
  // Guard server-side (spec §4.5) — TRƯỚC mọi db read (moderation-resource
  // IDOR — Review Focus 3).
  await requireCapability("report.resolve");

  const sp = (await searchParams) as { state?: string };
  const raw = sp.state ?? "active";
  const mode: "active" | "all" | ModerationCaseState =
    raw === "all" || (MODERATION_CASE_STATES as readonly string[]).includes(raw)
      ? (raw as "active" | "all" | ModerationCaseState)
      : "active";

  let query = db.orm.public.ModerationCase
    .orderBy((c) => c.updatedAt.desc())
    .limit(100);
  if (mode === "active") {
    // Mặc định: các case còn đang xử lý (grouping/dedupe domain states).
    query = query.where((c) => c.state.in([...ACTIVE_MODERATION_CASE_STATES]));
  } else if (mode !== "all") {
    query = query.where({ state: mode });
  }
  const cases = await query
    .include("assignedModerator", (m) => m.select("id", "name"))
    .include("reports", (r) => r.count())
    .all();

  const tabs: Array<{ value: string; label: string }> = [
    { value: "active", label: "Đang xử lý" },
    ...MODERATION_CASE_STATES.map((s) => ({
      value: s,
      label: MODERATION_CASE_STATE_LABELS[s],
    })),
    { value: "all", label: "Tất cả" },
  ];

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Flag className="size-6 text-[var(--accent)]" />
        Báo cáo &amp; kiểm duyệt
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Hàng đợi case lạm dụng — phân loại theo lý do báo cáo có kiểu, gán người xử lý,
        chuyển trạng thái theo quy trình.
      </p>

      {/* Filter tabs theo state */}
      <div className="mt-5 flex flex-wrap gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1">
        {tabs.map((t) => (
          <Link
            key={t.value}
            href={t.value === "active" ? "/admin/moderation" : `/admin/moderation?state=${t.value}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition",
              mode === t.value
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--ink-2)] hover:text-white",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="table-wrap mt-5">
        <table className="table-base">
          <thead>
            <tr>
              <th>Đích báo cáo</th>
              <th>Lý do</th>
              <th>Trạng thái</th>
              <th>Ưu tiên</th>
              <th>Người xử lý</th>
              <th>Báo cáo</th>
              <th>Cập nhật</th>
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-[var(--muted)]">
                  Không có case nào ở trạng thái này
                </td>
              </tr>
            ) : (
              cases.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link
                      href={`/admin/moderation/${c.id}`}
                      className="text-sm font-semibold hover:text-[var(--accent)]"
                    >
                      {TARGET_TYPE_LABELS[c.targetType] ?? c.targetType}
                      <span className="ml-1.5 font-mono text-xs text-[var(--muted)]">
                        #{c.targetId.slice(0, 8)}
                      </span>
                    </Link>
                  </td>
                  <td className="text-sm">
                    {REPORT_REASON_LABELS[c.reasonCategory] ?? c.reasonCategory}
                  </td>
                  <td>
                    <span className={cn("badge", STATE_BADGE[c.state])}>
                      {MODERATION_CASE_STATE_LABELS[c.state]}
                    </span>
                  </td>
                  <td>
                    <span className={cn("badge", PRIORITY_BADGE[c.priority])}>
                      {MODERATION_PRIORITY_LABELS[c.priority]}
                    </span>
                  </td>
                  <td className="text-sm">
                    {c.assignedModerator ? c.assignedModerator.name : <span className="text-[var(--muted)]">Chưa gán</span>}
                  </td>
                  <td className="text-sm">{c.reports}</td>
                  <td className="whitespace-nowrap text-xs text-[var(--muted)]">
                    {formatDateShort(c.updatedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
