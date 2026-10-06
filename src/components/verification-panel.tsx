"use client";

import { useActionState, useState } from "react";
import {
  requestEmailVerificationAction,
  confirmEmailVerificationAction,
  requestPhoneVerificationAction,
  confirmPhoneVerificationAction,
  changePasswordAction,
  requestEmailChangeAction,
  confirmEmailChangeAction,
  requestPhoneChangeAction,
  confirmPhoneChangeAction,
  type VerificationFormState,
} from "@/src/lib/actions/verification";
import { LoaderCircle, CheckCircle2, ShieldCheck } from "lucide-react";

/**
 * Xác minh danh tính + bảo mật tài khoản (Batch 2 Task 6 — spec §5.3/§5.3.1).
 * Ba phần theo plan: (1) trạng thái xác minh email/phone + gửi/nhập mã;
 * (2) đổi mật khẩu; (3) đổi email / đổi số điện thoại (hai bước: request →
 * confirm, mã OTP tới kênh MỚI). Copy trung tính — không có ngôn ngữ bảo
 * đảm (spec §6.2).
 */

type PanelProps = {
  email: string;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
};

function StatusBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="badge bg-[var(--green-soft)] text-[var(--green)]">
      <ShieldCheck className="size-3" />
      Đã xác minh
    </span>
  ) : (
    <span className="badge bg-amber-500/15 text-amber-600">Chưa xác minh</span>
  );
}

function FormMessage({ state }: { state: VerificationFormState }) {
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

// ─── (1a) Xác minh email ─────────────────────────────────────────────────────

function EmailVerificationSection({ email, emailVerified }: { email: string; emailVerified: boolean }) {
  const [requestState, requestAction, requestPending] = useActionState(
    requestEmailVerificationAction,
    {},
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmEmailVerificationAction,
    {},
  );

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm">
          Email: <span className="font-medium">{email}</span>
        </p>
        <StatusBadge verified={emailVerified} />
      </div>
      {!emailVerified && (
        <div className="space-y-2">
          <form action={requestAction}>
            <button type="submit" disabled={requestPending} className="btn-primary w-full">
              {requestPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Gửi mã
            </button>
          </form>
          <form action={confirmAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              name="code"
              className="input"
              placeholder="Mã 6 chữ số"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Mã xác minh email"
            />
            <input
              type="password"
              name="currentPassword"
              className="input"
              placeholder="Mật khẩu hiện tại"
              autoComplete="current-password"
              required
              aria-label="Mật khẩu hiện tại"
            />
            <button type="submit" disabled={confirmPending} className="btn-primary shrink-0">
              {confirmPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Xác nhận
            </button>
          </form>
        </div>
      )}
      <FormMessage state={requestState} />
      <FormMessage state={confirmState} />
    </div>
  );
}

// ─── (1b) Xác minh số điện thoại — CHỈ số đang lưu (target derive từ DB) ──────

function PhoneVerificationSection({ phone, phoneVerified }: { phone: string | null; phoneVerified: boolean }) {
  const [requestState, requestAction, requestPending] = useActionState(
    requestPhoneVerificationAction,
    {},
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmPhoneVerificationAction,
    {},
  );

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm">
          Số điện thoại:{" "}
          <span className="font-medium">{phone ?? "Chưa có"}</span>
        </p>
        <StatusBadge verified={phoneVerified} />
      </div>
      {phone == null ? (
        <p className="text-xs text-[var(--muted)]">
          Chưa có số điện thoại trên tài khoản — thêm số ở &quot;Chỉnh sửa thông tin&quot;
          hoặc &quot;Đổi số điện thoại&quot; rồi xác minh.
        </p>
      ) : !phoneVerified ? (
        <div className="space-y-2">
          <form action={requestAction}>
            <button type="submit" disabled={requestPending} className="btn-primary w-full">
              {requestPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Gửi mã
            </button>
          </form>
          <form action={confirmAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              name="code"
              className="input"
              placeholder="Mã 6 chữ số"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Mã xác minh số điện thoại"
            />
            <input
              type="password"
              name="currentPassword"
              className="input"
              placeholder="Mật khẩu hiện tại"
              autoComplete="current-password"
              required
              aria-label="Mật khẩu hiện tại"
            />
            <button type="submit" disabled={confirmPending} className="btn-primary shrink-0">
              {confirmPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Xác nhận
            </button>
          </form>
        </div>
      ) : null}
      <FormMessage state={requestState} />
      <FormMessage state={confirmState} />
    </div>
  );
}

// ─── (2) Đổi mật khẩu ────────────────────────────────────────────────────────

function PasswordSection() {
  const [state, action, pending] = useActionState(changePasswordAction, {});

  return (
    <form action={action} className="space-y-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="password"
          name="currentPassword"
          className="input"
          placeholder="Mật khẩu hiện tại"
          autoComplete="current-password"
          required
          aria-label="Mật khẩu hiện tại"
        />
        <input
          type="password"
          name="newPassword"
          className="input"
          placeholder="Mật khẩu mới (tối thiểu 6 ký tự)"
          autoComplete="new-password"
          required
          minLength={6}
          aria-label="Mật khẩu mới"
        />
      </div>
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Đổi mật khẩu
      </button>
      <FormMessage state={state} />
    </form>
  );
}

// ─── (3a) Đổi email (hai bước: gửi mã tới email mới → nhập mã) ──────────────

function EmailChangeSection() {
  const [requestState, requestAction, requestPending] = useActionState(
    requestEmailChangeAction,
    {},
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmEmailChangeAction,
    {},
  );
  const [newEmail, setNewEmail] = useState("");

  return (
    <div className="space-y-2.5">
      <form action={requestAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          type="email"
          name="newEmail"
          className="input"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="Email mới"
          autoComplete="email"
          required
          aria-label="Email mới"
        />
        <input
          type="password"
          name="currentPassword"
          className="input"
          placeholder="Mật khẩu hiện tại"
          autoComplete="current-password"
          required
          aria-label="Mật khẩu hiện tại"
        />
        <button type="submit" disabled={requestPending} className="btn-primary shrink-0">
          {requestPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Gửi mã
        </button>
      </form>
      <form action={confirmAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input type="hidden" name="newEmail" value={newEmail} />
        <input
          name="code"
          className="input"
          placeholder="Mã 6 chữ số gửi tới email mới"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Mã xác minh email mới"
        />
        <input
          type="password"
          name="currentPassword"
          className="input"
          placeholder="Mật khẩu hiện tại"
          autoComplete="current-password"
          required
          aria-label="Mật khẩu hiện tại"
        />
        <button type="submit" disabled={confirmPending} className="btn-primary shrink-0">
          {confirmPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Xác nhận đổi email
        </button>
      </form>
      <FormMessage state={requestState} />
      <FormMessage state={confirmState} />
    </div>
  );
}

// ─── (3b) Đổi số điện thoại (hai bước: gửi mã tới số mới → nhập mã) ──────────

function PhoneChangeSection() {
  const [requestState, requestAction, requestPending] = useActionState(
    requestPhoneChangeAction,
    {},
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmPhoneChangeAction,
    {},
  );
  const [newPhone, setNewPhone] = useState("");

  return (
    <div className="space-y-2.5">
      <form action={requestAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          name="newPhone"
          className="input"
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
          placeholder="Số điện thoại mới (0901234567)"
          inputMode="tel"
          autoComplete="tel"
          required
          aria-label="Số điện thoại mới"
        />
        <input
          type="password"
          name="currentPassword"
          className="input"
          placeholder="Mật khẩu hiện tại"
          autoComplete="current-password"
          required
          aria-label="Mật khẩu hiện tại"
        />
        <button type="submit" disabled={requestPending} className="btn-primary shrink-0">
          {requestPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Gửi mã
        </button>
      </form>
      <form action={confirmAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input type="hidden" name="newPhone" value={newPhone} />
        <input
          name="code"
          className="input"
          placeholder="Mã 6 chữ số gửi tới số mới"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Mã xác minh số điện thoại mới"
        />
        <input
          type="password"
          name="currentPassword"
          className="input"
          placeholder="Mật khẩu hiện tại"
          autoComplete="current-password"
          required
          aria-label="Mật khẩu hiện tại"
        />
        <button type="submit" disabled={confirmPending} className="btn-primary shrink-0">
          {confirmPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Xác nhận đổi số
        </button>
      </form>
      <FormMessage state={requestState} />
      <FormMessage state={confirmState} />
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function VerificationPanel({ email, emailVerified, phone, phoneVerified }: PanelProps) {
  return (
    <div className="card mt-6 p-6">
      <p className="mb-1 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
        Xác minh &amp; bảo mật
      </p>
      <p className="mb-5 text-xs text-[var(--muted)]">
        Xác minh email/số điện thoại giúp LoaViet xác nhận đây là tài khoản của bạn khi hỗ trợ.
        Nhập mật khẩu hiện tại khi xác nhận mã.
      </p>

      <div className="space-y-6">
        <EmailVerificationSection email={email} emailVerified={emailVerified} />
        <PhoneVerificationSection phone={phone} phoneVerified={phoneVerified} />

        <div className="border-t border-[var(--line)] pt-5">
          <p className="mb-2.5 text-sm font-semibold">Đổi mật khẩu</p>
          <PasswordSection />
        </div>

        <div className="border-t border-[var(--line)] pt-5">
          <p className="mb-2.5 text-sm font-semibold">Đổi email / số điện thoại</p>
          <p className="mb-2.5 text-xs text-[var(--muted)]">
            Cần mật khẩu hiện tại + mã xác minh gửi tới email/số mới (nhập mật khẩu ở cả hai bước).
            Sau khi đổi, các thiết bị khác sẽ bị đăng xuất và kênh cũ đã xác minh nhận thông báo bảo mật.
          </p>
          <EmailChangeSection />
          <div className="mt-5">
            <PhoneChangeSection />
          </div>
        </div>
      </div>
    </div>
  );
}
