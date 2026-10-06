"use client";

import { useActionState } from "react";
import {
  stepUpAction,
  regenerateRecoveryCodesAction,
  type AdminSecurityFormState,
} from "@/src/lib/actions/admin-identity";
import { LoaderCircle, CheckCircle2 } from "lucide-react";

/**
 * Form client của /admin/security (plan Task 9). Server component page giữ
 * guard + inventory (listUserSessions); hai form useActionState sống ở đây:
 *
 * - StepUpForm: xác thực lại (TOTP/mã khôi phục) → markSessionSteppedUp —
 *   sau đó các capability step-up (rbac.requireCapabilityWithStepUp) cho qua.
 * - RegenerateRecoveryCodesForm: sinh lại 10 mã khôi phục (bắt buộc mã MFA
 *   đúng) — state.recoveryCodes hiển thị MỘT LẦN (DB chỉ lưu hash).
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
