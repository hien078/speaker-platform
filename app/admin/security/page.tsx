import { db } from "@/src/prisma/db.client";
import { requireAdminUser, capabilitiesOf } from "@/src/lib/rbac";
import {
  listUserSessions,
  stepUpIsFresh,
  STEP_UP_MAX_AGE_MINUTES,
  ADMIN_SESSION_TTL_HOURS,
} from "@/src/lib/session";
import {
  revokeUserSessionAction,
  revokeAllUserSessionsAction,
} from "@/src/lib/actions/admin-identity";
import { ADMIN_ROLE_LABELS } from "@/src/lib/admin-roles";
import { StepUpForm, RegenerateRecoveryCodesForm, SetAdminRoleForm } from "./forms";
import { formatDate, cn } from "@/src/lib/utils";
import { ShieldCheck, MonitorSmartphone, KeyRound, UserCog } from "lucide-react";

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

  // Quản lý role (Task 11): CHỈ super_admin có admin.role_manage — lọc nút là
  // CONVENIENCE; setAdminRoleAction TỰ requireCapabilityWithStepUp (spec §4.5).
  const canManageRoles = capabilitiesOf(user.adminRole).includes("admin.role_manage");
  // Minor (review): select field TƯỜNG MINH — không kéo hash mật khẩu ra render path.
  const adminRows = canManageRoles
    ? await db.orm.public.User
        .where((u) => u.adminRole.isNotNull())
        .select("id", "name", "email", "role", "adminRole")
        .all()
    : [];
  const admins = await Promise.all(
    adminRows.map(async (a) => ({
      ...a,
      // MFA state: admin chưa enroll MFA không login được (fail closed —
      // enrollment qua bootstrap script, runbook quản trị).
      mfaEnrolled: (await db.orm.public.AdminMfa.first({ userId: a.id })) !== null,
    })),
  );

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
            {/* TÍN HIỆU "giữ session hiện tại" — action bỏ qua GIÁ TRỊ, except luôn
                derive server-side = session hiện tại của chính admin (review fix #1). */}
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

      {/* Quản lý vai trò quản trị — Task 11 (spec §5.4/§5.4.1/§8.5) */}
      {canManageRoles && (
        <div className="card mt-6 p-6">
          <p className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            <UserCog className="size-4" />
            Vai trò quản trị
          </p>
          <p className="mb-4 text-xs text-[var(--muted)]">
            Cấp/đổi vai trò (chỉ super_admin, cần step-up hoặc mã TOTP trong cùng request).
            Mọi thay đổi thu hồi TOÀN BỘ phiên của người được đổi — họ phải đăng nhập lại qua
            MFA. Không thể hạ vai trò của super_admin cuối cùng.
          </p>

          {/* Danh sách admin hiện tại — hiển thị trạng thái, không phải form */}
          <div className="space-y-2.5">
            {admins.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--line)] px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{a.name}</p>
                  <p className="text-xs text-[var(--muted)]">{a.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="badge bg-[var(--red-soft)] text-[var(--red)]">
                    {ADMIN_ROLE_LABELS[a.adminRole!]}
                  </span>
                  <span
                    className={cn(
                      "badge",
                      a.mfaEnrolled
                        ? "bg-[var(--green-soft)] text-[var(--green)]"
                        : "bg-amber-500/15 text-amber-600",
                    )}
                  >
                    {a.mfaEnrolled ? "MFA" : "chưa MFA"}
                  </span>
                </div>
              </div>
            ))}
            {admins.length === 0 && (
              <p className="text-sm text-[var(--muted)]">Chưa có quản trị viên nào.</p>
            )}
          </div>

          {/* Cấp/đổi/gỡ role — client form useActionState (lỗi typed hiển thị
              cho operator); action tự guard requireCapabilityWithStepUp */}
          <div className="mt-4 border-t border-[var(--line)] pt-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--ink-2)]">
              Cấp / đổi / gỡ vai trò
            </p>
            <SetAdminRoleForm />
          </div>
        </div>
      )}
    </div>
  );
}
