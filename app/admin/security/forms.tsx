"use client";

import { useActionState } from "react";
import {
  stepUpAction,
  regenerateRecoveryCodesAction,
  setAdminRoleAction,
  type AdminSecurityFormState,
} from "@/src/lib/actions/admin-identity";
import {
  ADMIN_ROLES,
  ADMIN_ROLE_LABELS,
  ADMIN_ROLE_REASON_CODES,
  ADMIN_ROLE_REASON_LABELS,
} from "@/src/lib/admin-roles";
import { LoaderCircle, CheckCircle2 } from "lucide-react";

/**
 * Form client của /admin/security (plan Task 9 + Task 11). Server component
 * page giữ guard + inventory (listUserSessions); các form useActionState sống ở đây:
 *
 * - StepUpForm: xác thực lại (TOTP/mã khôi phục) → markSessionSteppedUp —
 *   sau đó các capability step-up (rbac.requireCapabilityWithStepUp) cho qua.
 * - RegenerateRecoveryCodesForm: sinh lại 10 mã khôi phục (bắt buộc mã MFA
 *   đúng) — state.recoveryCodes hiển thị MỘT LẦN (DB chỉ lưu hash).
 * - SetAdminRoleForm (Task 11): cấp/đổi/GỠ vai trò quản trị — lỗi typed
 *   (STEP_UP_REQUIRED / MFA_CODE_INVALID / LAST_SUPER_ADMIN…) hiển thị qua
 *   state cho operator (minor — không throw ra error page); role/reason
 *   select sinh từ danh sách typed (ADMIN_ROLES/ADMIN_ROLE_REASON_CODES —
 *   "none" = gỡ quyền quản trị, D6).
 */

function FormMessage({ state }: { state: AdminSecurityFormState }) {
  if (state.error) {
    return (
      <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2.5 text-sm text-[var(--green)]">
        <CheckCircle2 className="size-4 shrink-0" />
        {state.success}
      </p>
    );
  }
  return null;
}

export function StepUpForm() {
  const [state, action, pending] = useActionState(stepUpAction, {});

  return (
    <form action={action} className="space-y-2.5">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          name="mfaCode"
          className="input"
          placeholder="Mã TOTP / mã khôi phục"
          inputMode="text"
          autoComplete="one-time-code"
          required
          aria-label="Mã xác thực để step-up"
        />
        <button type="submit" disabled={pending} className="btn-primary shrink-0">
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Xác thực lại (step-up)
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function RegenerateRecoveryCodesForm() {
  const [state, action, pending] = useActionState(regenerateRecoveryCodesAction, {});

  return (
    <form action={action} className="space-y-2.5">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          name="mfaCode"
          type="password"
          className="input"
          placeholder="Mã TOTP / mã khôi phục hiện tại"
          autoComplete="one-time-code"
          required
          aria-label="Mã xác thực để sinh lại mã khôi phục"
        />
        <button type="submit" disabled={pending} className="btn-secondary shrink-0">
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Sinh lại mã khôi phục
        </button>
      </div>
      <FormMessage state={state} />
      {state.recoveryCodes && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-bold text-amber-600">
            Mã khôi phục mới — hiển thị một lần duy nhất
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Lưu vào trình quản lý mật khẩu ngay. LoaViet chỉ lưu hash — mất hết mã thì phải
            reset MFA qua bootstrap (runbook quản trị).
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-1 font-mono text-sm sm:grid-cols-2">
            {state.recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

/** Form cấp/đổi/gỡ vai trò quản trị (Task 11 — action tự guard admin.role_manage). */
export function SetAdminRoleForm() {
  const [state, action, pending] = useActionState(setAdminRoleAction, {});

  return (
    <form action={action} className="space-y-2.5">
      <input
        name="userId"
        className="input text-sm"
        placeholder="User ID cần cấp/đổi/gỡ (tìm trong /admin/users)"
        required
        aria-label="User ID cần cấp, đổi hoặc gỡ vai trò quản trị"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <select name="role" className="input text-sm" required defaultValue="" aria-label="Vai trò quản trị">
          <option value="" disabled>— Chọn vai trò —</option>
          {ADMIN_ROLES.map((r) => (
            <option key={r} value={r}>{ADMIN_ROLE_LABELS[r]}</option>
          ))}
          {/* D6 — gỡ quyền quản trị hoàn toàn (adminRole → null, restore role display) */}
          <option value="none">Gỡ quyền quản trị</option>
        </select>
        <select name="reason" className="input text-sm" required defaultValue="" aria-label="Lý do (ghi audit)">
          <option value="" disabled>— Lý do (ghi audit) —</option>
          {ADMIN_ROLE_REASON_CODES.map((c) => (
            <option key={c} value={c}>{ADMIN_ROLE_REASON_LABELS[c]}</option>
          ))}
        </select>
      </div>
      <input
        name="totpCode"
        className="input text-sm"
        inputMode="text"
        autoComplete="one-time-code"
        placeholder="Mã TOTP / mã khôi phục (bắt buộc khi step-up hết hạn)"
        aria-label="Mã xác thực cho step-up"
      />
      <button type="submit" disabled={pending} className="btn-primary text-sm">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Đặt vai trò
      </button>
      <FormMessage state={state} />
      {state.stepUpRequired && (
        <p className="text-xs text-[var(--muted)]">
          Nhập mã TOTP/mã khôi phục vào ô mã rồi gửi lại — step-up có hiệu lực 15 phút.
        </p>
      )}
    </form>
  );
}
