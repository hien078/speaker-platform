import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import {
  SELLER_VERIFICATION_REASON_CODES,
  SELLER_VERIFICATION_REASON_LABELS,
  SELLER_VERIFICATION_STATUS_LABELS,
  type SellerVerificationReasonCode,
} from "@/src/lib/seller-verification-policy";
import { PROVINCE_CODES } from "@/src/lib/provinces";
import { reviewSellerVerificationAction } from "@/src/lib/actions/seller-verification";
import { formatDate, formatDateShort, cn } from "@/src/lib/utils";
import { BadgeCheck, ScrollText, Search, ShieldQuestion } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Xác minh người bán" };

/**
 * /admin/seller-verification (plan Task 10 — spec §5.3.2/§5.3.3) — hàng đợi
 * review SellerVerification. Guard: requireCapability("seller.verify") —
 * super/ops (ma trận §5.4.1); moderator/support fail closed (Review Focus 4).
 *
 * Mỗi row queue surface ĐỦ tín hiệu mà checklist operations (spec §5.3.3)
 * cần để con người review: tuổi tài khoản, seller type + tỉnh khai báo, trạng
 * thái xác minh email/phone, số tin đăng, quyết định verification TRƯỚC ĐÓ
 * (AuditEvent), founding_seller membership hiện tại — reviewer đối chiếu
 * duplicate/suspension/revocation/inconsistency và ghi kết quả bằng reason
 * code TYPED (không free text tuỳ ý). KHÔNG thu thập giấy tờ danh tính
 * (spec §5.3.2).
 *
 * Quyết định là step-up capability (Ambiguity A5): form có ô mã TOTP —
 * requireCapabilityWithStepUp("seller.verify"|"seller.verification.revoke")
 * trong action; step-up cũ mà không kèm mã → STEP_UP_REQUIRED (error surface).
 */

/** Nhãn hiển thị cho trạng thái verified email/phone. */
const VerifiedBadge = ({ ok }: { ok: boolean }) => (
  <span className={cn("badge", ok ? "bg-[var(--green-soft)] text-[var(--green)]" : "bg-[var(--paper-deep)] text-[var(--ink-2)]")}>
    {ok ? "Đã xác minh" : "Chưa"}
  </span>
);

/**
 * Quyết định từ audit detail (review fix L4) — detail của
 * "seller_verification.reviewed" ghi `decision=<verified|needs_review|…>`
 * (typed, do chính action này ghi) — hiển thị kèm reason cho đủ ngữ cảnh.
 */
const decisionOfAuditDetail = (detail: string | null | undefined): string | null => {
  const match = /decision=([a-z_]+)/.exec(detail ?? "");
  return match === null ? null : match[1]!;
};

export default async function AdminSellerVerificationPage({
  searchParams,
}: PageProps<"/admin/seller-verification">) {
  await requireCapability("seller.verify");
  const sp = (await searchParams) as { q?: string };
  const q = sp.q?.trim() ?? "";

  // Hàng đợi (review fix M1): pending + needs_review — needs_review là MỘT
  // quyết định chờ xử lý tiếp (ops soi thêm/bổ sung), KHÔNG phải ngõ chết:
  // quyết định cuối (verified/rejected) claim được từ cả hai trạng thái.
  const queue = await db.orm.public.SellerVerification
    .where((v) => v.status.in(["pending", "needs_review"]))
    .include("user")
    .orderBy((v) => v.updatedAt.asc())
    .limit(50)
    .all();

  // Row focus theo ?q=<userId> (link từ /admin/users) — bất kể trạng thái.
  const focused = q
    ? await db.orm.public.SellerVerification.where({ userId: q }).include("user").first()
    : null;

  // Lịch sử quyết định (spec §4.6/§5.3.3 — reviewer + reason + policy version).
  const history = await db.orm.public.AuditEvent
    .where({ action: "seller_verification.reviewed" })
    .include("actor")
    .include("subject")
    .orderBy((e) => e.createdAt.desc())
    .limit(20)
    .all();

  /** Tín hiệu review cho MỘT hồ sơ (spec §5.3.3 checklist). */
  const reviewSignals = async (userId: string) => {
    const [user, listingCount, priorDecisions, membership] = await Promise.all([
      db.orm.public.User.first({ id: userId }),
      db.orm.public.Listing.where({ sellerId: userId }).aggregate((a) => ({ c: a.count() })),
      db.orm.public.AuditEvent
        .where({ subjectId: userId, action: "seller_verification.reviewed" })
        .orderBy((e) => e.createdAt.desc())
        .limit(5)
        .all(),
      db.orm.public.BetaCohortMembership.first({ userId, cohort: "founding_seller" }),
    ]);
    return { user, listingCount: listingCount.c, priorDecisions, membership };
  };

  const rows = focused ? [focused, ...queue.filter((r) => r.userId !== focused.userId)] : queue;

  const enriched = await Promise.all(
    rows.map(async (row) => ({ row, signals: await reviewSignals(row.userId) })),
  );

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <BadgeCheck className="size-6 text-[var(--accent)]" />
        Xác minh người bán
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Review theo chính sách <b>v1</b> — mọi quyết định ghi reviewer, reason code typed, policy
        version. Quyết định cần step-up tươi hoặc mã TOTP trong cùng request.
      </p>

      {/* Tìm hồ sơ theo user id */}
      <form action="/admin/seller-verification" className="mt-5 flex flex-wrap gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
          <input
            name="q"
            defaultValue={q}
            className="input pl-9 text-sm"
            placeholder="userId (từ trang Người dùng)…"
          />
        </div>
        <button type="submit" className="btn-secondary px-4 text-sm">Xem hồ sơ</button>
      </form>

      {/* ─── Hàng đợi + hồ sơ focus ─── */}
      <div className="mt-6 space-y-4">
        {enriched.length === 0 && (
          <div className="card grid place-items-center gap-2 p-12 text-center">
            <ShieldQuestion className="size-8 text-[var(--muted)]" />
            <p className="font-bold">Hàng đợi trống</p>
            <p className="text-sm text-[var(--muted)]">Không có hồ sơ nào đang chờ review.</p>
          </div>
        )}
        {enriched.map(({ row, signals }) => {
          const user = signals.user;
          const province = user?.sellerOperatingProvinceCode ?? null;
          return (
            <div key={row.id} className="card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn(
                  "badge",
                  row.status === "pending" ? "bg-amber-500/15 text-amber-600" :
                  row.status === "verified" ? "bg-[var(--green-soft)] text-[var(--green)]" :
                  row.status === "revoked" ? "bg-[var(--red-soft)] text-[var(--red)]" :
                  "bg-[var(--paper-deep)] text-[var(--ink-2)]",
                )}>
                  {SELLER_VERIFICATION_STATUS_LABELS[row.status as keyof typeof SELLER_VERIFICATION_STATUS_LABELS] ?? row.status}
                </span>
                {row.status === "needs_review" && (
                  <span className="badge bg-sky-500/15 text-sky-600">cần xử lý tiếp — quyết định cuối claim được từ đây</span>
                )}
                {focused && row.id === focused.id && (
                  <span className="badge bg-[var(--accent-soft)] text-[var(--accent)]">Hồ sơ đang xem</span>
                )}
                <span className="text-xs text-[var(--muted)]">
                  gửi {formatDate(row.submittedAt)} · chính sách {row.policyVersion}
                </span>
              </div>

              <p className="mt-2 font-bold">{user?.name ?? row.userId}</p>
              <p className="text-xs text-[var(--muted)]">
                userId: <code className="text-[var(--ink-2)]">{row.userId}</code>
              </p>

              {/* Tín hiệu review (spec §5.3.3 checklist) */}
              <div className="mt-3 grid gap-2 text-xs text-[var(--ink-2)] sm:grid-cols-2">
                <p>Tuổi tài khoản: <b>{user ? formatDateShort(user.createdAt) : "—"}</b></p>
                <p>Loại người bán: <b>{user?.sellerType === "business" ? "Doanh nghiệp" : user?.sellerType === "individual" ? "Cá nhân" : "Chưa khai báo"}</b></p>
                <p>Khu vực hoạt động: <b>{province && PROVINCE_CODES[province] ? PROVINCE_CODES[province] : "Chưa khai báo"}</b></p>
                <p className="flex items-center gap-1.5">Số tin đăng: <b>{signals.listingCount}</b></p>
                <p className="flex items-center gap-1.5">Email: <VerifiedBadge ok={user?.emailVerifiedAt != null} /></p>
                <p className="flex items-center gap-1.5">Số điện thoại: <VerifiedBadge ok={user?.phoneVerifiedAt != null} /></p>
                <p className="flex items-center gap-1.5">
                  founding_seller:{" "}
                  <span className={cn(
                    "badge",
                    signals.membership?.status === "active"
                      ? "bg-[var(--green-soft)] text-[var(--green)]"
                      : "bg-[var(--paper-deep)] text-[var(--ink-2)]",
                  )}>
                    {signals.membership?.status ?? "không có"}
                  </span>
                </p>
                <p>
                  Quyết định trước đó:{" "}
                  {signals.priorDecisions.length === 0
                    ? "chưa có"
                    : signals.priorDecisions
                        .map((d) => {
                          const decision = decisionOfAuditDetail(d.detail);
                          return decision === null ? (d.reason ?? "?") : `${decision} · ${d.reason ?? "?"}`;
                        })
                        .slice(0, 3)
                        .join(", ")}
                </p>
              </div>

              {/* Form quyết định — step-up (TOTP) + reason code typed */}
              <form action={reviewSellerVerificationAction} className="mt-4 space-y-2.5 border-t border-[var(--line)] pt-4">
                <input type="hidden" name="userId" value={row.userId} />
                <div className="grid gap-2 sm:grid-cols-3">
                  <select name="decision" className="input text-sm" required defaultValue="">
                    <option value="" disabled>— Quyết định —</option>
                    <option value="verified">Duyệt (verified)</option>
                    <option value="needs_review">Cần xem xét thêm</option>
                    <option value="rejected">Từ chối</option>
                    <option value="revoked">Thu hồi (đã duyệt)</option>
                  </select>
                  <select name="reasonCode" className="input text-sm" required defaultValue="">
                    <option value="" disabled>— Lý do (typed) —</option>
                    {SELLER_VERIFICATION_REASON_CODES
                      .filter((c) => c !== "migrated_legacy_verified") // chỉ backfill dùng
                      .map((c) => (
                        <option key={c} value={c}>{SELLER_VERIFICATION_REASON_LABELS[c]}</option>
                      ))}
                  </select>
                  <input
                    name="totpCode"
                    className="input text-sm"
                    placeholder="Mã TOTP (step-up)"
                    inputMode="text"
                    autoComplete="one-time-code"
                  />
                </div>
                <textarea
                  name="note"
                  className="input min-h-16 text-sm"
                  placeholder="Ghi chú nội bộ (tuỳ chọn — KHÔNG chứa thông tin danh tính nhạy cảm)"
                />
                <button type="submit" className="btn-primary text-sm">Ghi quyết định</button>
              </form>
            </div>
          );
        })}
      </div>

      {/* ─── Lịch sử quyết định ─── */}
      <div className="card mt-8 p-5">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          <ScrollText className="size-4" />
          Lịch sử quyết định (audit)
        </p>
        {history.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Chưa có quyết định nào được ghi.</p>
        ) : (
          <div className="table-wrap">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Thời điểm</th>
                  <th>Reviewer</th>
                  <th>Người bán</th>
                  <th>Quyết định</th>
                  <th>Lý do (typed)</th>
                  <th>Chính sách</th>
                </tr>
              </thead>
              <tbody>
                {history.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDate(e.createdAt)}</td>
                    <td className="text-sm">{e.actor?.name ?? e.actorId ?? "system"}</td>
                    <td className="text-sm">
                      {e.subject?.name ?? e.subjectId}
                      {e.subjectId ? (
                        <Link
                          href={`/admin/seller-verification?q=${e.subjectId}`}
                          className="ml-1 text-xs text-[var(--accent)] hover:underline"
                        >
                          xem
                        </Link>
                      ) : null}
                    </td>
                    <td className="font-mono text-xs">{decisionOfAuditDetail(e.detail) ?? "—"}</td>
                    <td className="text-xs">
                      {e.reason && (SELLER_VERIFICATION_REASON_LABELS[e.reason as SellerVerificationReasonCode] ?? e.reason)}
                    </td>
                    <td className="text-xs text-[var(--muted)]">{e.policyVersion ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
