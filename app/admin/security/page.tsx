import { requireAdminUser, capabilitiesOf } from "@/src/lib/rbac";
import {
  listUserSessions,
  stepUpIsFresh,
  STEP_UP_MAX_AGE_MINUTES,
  ADMIN_SESSION_TTL_HOURS,
} from "@/src/lib/session";
import { revokeUserSessionAction, revokeAllUserSessionsAction } from "@/src/lib/actions/admin-identity";
import { StepUpForm, RegenerateRecoveryCodesForm } from "./forms";
import { formatDate } from "@/src/lib/utils";
import { ShieldCheck, MonitorSmartphone, KeyRound } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Bảo mật & phiên" };

/**
 * /admin/security (Batch 2 Task 9 — spec §5.4.2 admin session requirements,
 * §7.6 admin security): inventory phiên của CHÍNH MÌNH + thu hồi từng phiên /
 * mọi phiên khác + step-up + sinh lại mã khôi phục.
 *
 * Guard: requireAdminUser — MỌI adminRole (tự phục vụ MFA/phiên của chính mình;
 * moderator/support cũng xem được phiên của mình). Nút thu hồi lọc theo
 * capabilitiesOf(...).includes("session.revoke") là CONVENIENCE ONLY (spec
 * §4.5) — action tương ứng (admin-identity.ts) TỰ requireCapability; role
 * thiếu quyền POST thẳng form cũng bị FORBIDDEN.
 *
 * PII (spec §4.8): KHÔNG có IP; user-agent + session id hiển thị RÚT GỌN — đủ
 * nhận diện thiết bị, không render nguyên chuỗi.
 */

/** UA rút gọn — không render nguyên chuỗi PII dài (spec §4.8). */
function truncateUserAgent(ua: string | null): string {
  if (!ua) return "Không rõ thiết bị";
  return ua.length > 48 ? `${ua.slice(0, 48)}…` : ua;
}

/** Session id rút gọn — đủ nhận diện giữa các phiên, không lộ nguyên id. */
function shortSessionId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export default async function AdminSecurityPage() {
  const { user, session } = await requireAdminUser();
  const sessions = await listUserSessions(user.id);
  // Convenience filter (spec §4.5) — action vẫn tự guard capability.
  const canRevoke = capabilitiesOf(user.adminRole).includes("session.revoke");
  const others = sessions.filter((s) => s.id !== session.id);

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <ShieldCheck className="size-6 text-[var(--accent)]" />
        Bảo mật &amp; phiên
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Phiên admin của bạn (TTL {ADMIN_SESSION_TTL_HOURS} giờ). Thu hồi một phiên sẽ đăng xuất
        thiết bị đó ngay lần request kế tiếp.
      </p>

      {/* Inventory phiên của chính mình */}
      <div className="card mt-6 p-6">
        <p className="mb-4 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Phiên đang hoạt động
        </p>
        <div className="space-y-2.5">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--line)] px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm">
                  <MonitorSmartphone className="size-3.5 shrink-0 text-[var(--muted)]" />
                  <span className="truncate">{truncateUserAgent(s.userAgent)}</span>
                  {s.id === session.id && (
                    <span className="badge shrink-0 bg-[var(--accent-soft)] text-[var(--accent)]">
                      Thiết bị này
                    </span>
                  )}
                  {s.isAdmin && (
                    <span className="badge shrink-0 bg-[var(--red-soft)] text-[var(--red)]">MFA</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  Phiên {shortSessionId(s.id)} · bắt đầu {formatDate(s.createdAt)} · hoạt động{" "}
                  {formatDate(s.lastSeenAt)} · hết hạn {formatDate(s.expiresAt)}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  Step-up:{" "}
                  {stepUpIsFresh(s.steppedUpAt)
                    ? `còn hiệu lực (≤ ${STEP_UP_MAX_AGE_MINUTES} phút)`
                    : "chưa/hết hiệu lực"}
                </p>
              </div>
              {canRevoke && (
                <form action={revokeUserSessionAction}>
                  <input type="hidden" name="sessionId" value={s.id} />
                  <button
                    type="submit"
                    className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
                  >
                    {s.id === session.id ? "Đăng xuất" : "Thu hồi"}
                  </button>
                </form>
              )}
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-sm text-[var(--muted)]">Không có phiên nào đang hoạt động.</p>
          )}
        </div>

        {canRevoke && others.length > 0 && (
          <form
            action={revokeAllUserSessionsAction}
            className="mt-4 border-t border-[var(--line)] pt-4"
          >
            <input type="hidden" name="userId" value={user.id} />
            <input type="hidden" name="exceptSessionId" value={session.id} />
            <button type="submit" className="btn-secondary text-sm">
              Đăng xuất các thiết bị khác
            </button>
          </form>
        )}
      </div>

      {/* Step-up */}
      <div className="card mt-6 p-6">
        <p className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          <ShieldCheck className="size-4" />
          Xác thực lại (step-up)
        </p>
        <p className="mb-4 text-xs text-[var(--muted)]">
          Trạng thái hiện tại:{" "}
          {stepUpIsFresh(session.steppedUpAt)
            ? `còn hiệu lực (≤ ${STEP_UP_MAX_AGE_MINUTES} phút)`
            : "chưa/hết hiệu lực"}{" "}
          — các hành động nhạy cảm (quản lý role, duyệt xác minh người bán, PII) yêu cầu
          step-up tươi hoặc mã MFA trong cùng request.
        </p>
        <StepUpForm />
      </div>

      {/* Mã khôi phục */}
      <div className="card mt-6 p-6">
        <p className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          <KeyRound className="size-4" />
          Mã khôi phục
        </p>
        <p className="mb-4 text-xs text-[var(--muted)]">
          Sinh lại 10 mã khôi phục một lần dùng — mã cũ chết ngay sau khi sinh mới. Cần mã
          TOTP hoặc mã khôi phục hiện tại còn hợp lệ.
        </p>
        <RegenerateRecoveryCodesForm />
      </div>
    </div>
  );
}
