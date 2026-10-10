"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  confirmPasswordRecoveryAction,
  requestPasswordRecoveryAction,
  type RecoveryFormState,
} from "@/src/lib/actions/recovery";
import { LoaderCircle } from "lucide-react";

/**
 * Form đặt lại mật khẩu 2 bước (plan Task 7, spec §7.7):
 *  1. Nhập email HOẶC số điện thoại đã xác minh → yêu cầu mã. Phản hồi luôn
 *     trung tính (kể cả khi không khớp tài khoản) — chống enumeration.
 *  2. Nhập mã + mật khẩu mới → đặt lại. Completion thu hồi MỌI phiên đăng
 *     nhập (kể cả phiên hiện tại) → phải đăng nhập lại bằng mật khẩu mới.
 */
export function RecoveryForm() {
  const [step, setStep] = useState<"request" | "confirm">("request");
  const [identifier, setIdentifier] = useState("");

  const [requestState, runRequest, requestPending] = useActionState<RecoveryFormState, FormData>(
    async (_prev, formData) => {
      const result = await requestPasswordRecoveryAction({}, formData);
      // Thông báo trung tính luôn trả về (trừ rate limit / lỗi nhập liệu) → bước 2
      if (result.success !== undefined) {
        setIdentifier(String(formData.get("identifier") ?? "").trim());
        setStep("confirm");
      }
      return result;
    },
    {},
  );

  const [confirmState, runConfirm, confirmPending] = useActionState<RecoveryFormState, FormData>(
    async (_prev, formData) => confirmPasswordRecoveryAction({}, formData),
    {},
  );

  if (confirmState.success) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3.5 py-2.5 text-sm text-[var(--accent)]">
          {confirmState.success}
        </p>
        <p className="text-center text-[13px] text-[var(--ink-2)]">
          <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
            Đăng nhập bằng mật khẩu mới
          </Link>
        </p>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <form action={runConfirm} className="space-y-4">
        <input type="hidden" name="identifier" value={identifier} />
        <p className="text-[13px] text-[var(--muted)]">
          {requestState.success}{" "}
          <button
            type="button"
            onClick={() => setStep("request")}
            className="font-semibold text-[var(--accent)] hover:underline"
          >
            Thay đổi
          </button>
        </p>
        <div>
          <label className="label" htmlFor="code">Mã xác minh</label>
          <input
            id="code"
            name="code"
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="••••••"
            required
          />
        </div>
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
          />
        </div>
        {confirmState.error && (
          <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
            {confirmState.error}
          </p>
        )}
        <button type="submit" disabled={confirmPending} className="btn-primary w-full">
          {confirmPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Đặt lại mật khẩu
        </button>
      </form>
    );
  }

  return (
    <form action={runRequest} className="space-y-4">
      <div>
        <label className="label" htmlFor="identifier">Email hoặc số điện thoại</label>
        <input
          id="identifier"
          name="identifier"
          className="input"
          placeholder="ban@example.com hoặc 090xxxxxxx"
          autoComplete="username"
          required
        />
      </div>
      {requestState.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {requestState.error}
        </p>
      )}
      <button type="submit" disabled={requestPending} className="btn-primary w-full">
        {requestPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Gửi mã đặt lại mật khẩu
      </button>
    </form>
  );
}
