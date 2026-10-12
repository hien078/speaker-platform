"use client";

import { useActionState, useTransition } from "react";
import Link from "next/link";
import { loginAction, registerAction, type AuthFormState } from "@/src/lib/actions/auth";
import { LoaderCircle } from "lucide-react";

/**
 * AuthForm — login + register (app/(auth)/login + register).
 *
 * FORM RESET (React 19 — pattern deal-create-form.tsx / founding-seller-forms.tsx,
 * b6-review LOW-2): form KHÔNG gắn action prop — dispatch thủ công onSubmit +
 * preventDefault + startTransition để input KHÔNG bị requestFormReset wipe
 * sau khi action trả {error} (React 19 gọi requestFormReset trên MỌI form
 * action KHÔNG throw — kể cả action trả {error}). Task D: register bị từ chối
 * vì thiếu consent → người dùng KHÔNG phải nhập lại tên/email/mật khẩu.
 *
 * Task D (founder decision 2026-10-12): mode register có checkbox bắt buộc
 * "Tôi đã đọc và đồng ý…" với link /policies/terms + /policies/privacy
 * (target="_blank" — giữ form), server reject tường minh khi thiếu
 * (registerAction — POLICY_CONSENT_REQUIRED). Login KHÔNG bị chặn theo
 * acceptance (guard chỉ áp cho action tạo nội dung user-facing).
 */
export function AuthForm({ mode, next = "" }: { mode: "login" | "register"; next?: string }) {
  const action = mode === "login" ? loginAction : registerAction;
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(action, {});
  const [, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => {
          void formAction(fd);
        });
      }}
      className="space-y-4"
    >
      {next && <input type="hidden" name="next" value={next} />}
      {mode === "register" && (
        <>
          <div>
            <label className="label" htmlFor="name">Họ và tên</label>
            <input id="name" name="name" className="input" placeholder="Nguyễn Văn A" required />
          </div>
          <div>
            <label className="label" htmlFor="phone">Số điện thoại</label>
            <input id="phone" name="phone" className="input" placeholder="090xxxxxxx" />
          </div>
          <div>
            <label className="label">Bạn muốn</label>
            <div className="grid grid-cols-2 gap-2">
              <label className="group cursor-pointer">
                <input type="radio" name="role" value="buyer" defaultChecked className="peer sr-only" />
                <span className="block rounded-lg border border-[var(--line)] px-3 py-2.5 text-center text-sm text-[var(--ink-2)] transition peer-checked:border-[var(--accent)]/65 peer-checked:bg-[var(--accent-soft)] peer-checked:text-[var(--accent)]">
                  Mua loa
                </span>
              </label>
              <label className="group cursor-pointer">
                <input type="radio" name="role" value="seller" className="peer sr-only" />
                <span className="block rounded-lg border border-[var(--line)] px-3 py-2.5 text-center text-sm text-[var(--ink-2)] transition peer-checked:border-[var(--accent)]/65 peer-checked:bg-[var(--accent-soft)] peer-checked:text-[var(--accent)]">
                  Bán loa
                </span>
              </label>
            </div>
          </div>
        </>
      )}

      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" placeholder="ban@example.com" required />
      </div>

      <div>
        <label className="label" htmlFor="password">Mật khẩu</label>
        <input id="password" name="password" type="password" className="input" placeholder="••••••••" required />
      </div>

      {/* Task D (founder decision 2026-10-12): consent Điều khoản sử dụng +
          Chính sách quyền riêng tư — bắt buộc khi đăng ký; server reject
          (registerAction) kể cả khi client required bị bypass. Links mở tab
          mới (target="_blank" + rel) — người đọc không mất form. */}
      {mode === "register" && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-2)]">
          <input
            type="checkbox"
            name="acceptPolicies"
            required
            className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
          />
          <span>
            Tôi đã đọc và đồng ý với{" "}
            <Link
              href="/policies/terms"
              target="_blank"
              rel="noopener"
              className="font-semibold text-[var(--accent)] hover:underline"
            >
              Điều khoản sử dụng
            </Link>{" "}
            và{" "}
            <Link
              href="/policies/privacy"
              target="_blank"
              rel="noopener"
              className="font-semibold text-[var(--accent)] hover:underline"
            >
              Chính sách quyền riêng tư
            </Link>{" "}
            của LoaViet.
          </span>
        </label>
      )}

      {/* Admin MFA (Batch 2 Task 8): field chỉ hiện khi loginAction trả
          mfaRequired — đúng mật khẩu admin nhưng thiếu mã TOTP/mã khôi phục.
          Submit lại kèm mfaCode; user thường không bao giờ thấy field này. */}
      {state.mfaRequired && (
        <div>
          <label className="label" htmlFor="mfaCode">Mã TOTP / mã khôi phục</label>
          <input
            id="mfaCode"
            name="mfaCode"
            className="input"
            inputMode="text"
            autoComplete="one-time-code"
            placeholder="6 chữ số hoặc XXXX-XXXX"
            required
          />
          <p className="text-xs text-[var(--muted)]">
            Nhập mã 6 chữ số từ ứng dụng xác thực (TOTP), hoặc một mã khôi phục chưa dùng.
          </p>
        </div>
      )}

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
      </button>

      {mode === "login" && (
        <p className="text-center text-xs text-[var(--muted)]">
          <Link href="/recover" className="hover:text-[var(--accent)]">Quên mật khẩu?</Link>
          {" · "}
          <Link href="/register" className="hover:text-[var(--accent)]">Chưa có tài khoản? Đăng ký</Link>
        </p>
      )}
    </form>
  );
}
