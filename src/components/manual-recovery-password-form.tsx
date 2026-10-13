"use client";

import { useActionState } from "react";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import {
  consumeManualAccountRecoveryAction,
  type ManualRecoveryFormState,
} from "@/src/lib/actions/manual-account-recovery";

/**
 * Form đặt mật khẩu mới qua link reset thủ công (Task E — FD-R3 founder
 * 2026-10-13). "use client" + useActionState (React 19 giữ input qua action
 * error — pattern recovery-form.tsx). Token sống TRONG COOKIE HttpOnly
 * sp_manual_recovery (route handler đã set) — form KHÔNG mang token, KHÔNG
 * next/query; action tự đọc cookie server-side.
 *
 * Mật khẩu mới CÙNG chính sách self-service recovery (6..100 — recovery.ts).
 * Mọi lỗi token (hết hạn/dùng lại/rác) collapse về MỘT thông báo chung
 * (enumeration-safe — spec §7.7).
 */
export function ManualRecoveryPasswordForm() {
  const [state, formAction, pending] = useActionState<ManualRecoveryFormState, FormData>(
    consumeManualAccountRecoveryAction,
    {},
  );

  if (state.success) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3.5 py-2.5 text-sm text-[var(--accent)]">
          {state.success}
        </p>
        <p className="text-center text-[13px] text-[var(--ink-2)]">
          <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
            Đăng nhập bằng mật khẩu mới
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="newPassword">Mật khẩu mới</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          placeholder="••••••••"
          required
          minLength={6}
          maxLength={100}
        />
      </div>
      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Đặt lại mật khẩu
      </button>
    </form>
  );
}
