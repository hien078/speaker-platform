"use client";

import { useActionState, useTransition } from "react";
import { BadgeCheck, PhoneCall, ShieldCheck, XCircle } from "lucide-react";
import {
  cancelManualContactVerificationAction,
  decideManualContactVerificationAction,
  requestManualContactVerificationAction,
  type ManualContactFormState,
} from "@/src/lib/actions/manual-contact-verification";
import {
  MANUAL_CONTACT_METHODS,
  MANUAL_CONTACT_METHOD_LABELS,
  MANUAL_CONTACT_NOTE_MAX_LENGTH,
} from "@/src/lib/manual-contact-verification";

/**
 * Panel "Xác minh liên hệ thủ công" — zero-cost launch Task A (founder
 * 2026-10-12). "use client" + useActionState + dispatch thủ công (React 19
 * giữ input qua action error — pattern founding-seller-forms.tsx b6-review
 * LOW-2: form KHÔNG gắn action prop, onSubmit preventDefault +
 * startTransition để requestFormReset KHÔNG wipe input khi action trả error).
 *
 * PII minimization (§4.8/§7.6): client CHỈ nhận maskedValue (maskContact đã
 * chạy server-side) — KHÔNG BAO GIỜ giá trị liên hệ đầy đủ đến client.
 *
 * Two-person rule (UI là CONVENIENCE — action tự guard, spec §4.5):
 *  - isSubject (admin hiện tại là người được xác minh): MỌI form disable +
 *    lý do rõ — tự xác minh liên hệ của chính mình là đường leo thang;
 *  - isRequester (admin hiện tại là người mở request): approve/reject
 *    disable + lý do — cần admin KHÁC duyệt.
 *
 * Copy PROVISIONAL (FD-3 — zero-cost launch Task A register note):
 * mechanics only (§4.2), không claim bảo đảm gì về danh tính.
 */

/** Mã lỗi typed → tiếng Việt trung tính (mechanics only — §4.2). Code lạ hiển thị thô (fail closed). */
const ERROR_TEXT: Record<string, string> = {
  "STEP_UP_REQUIRED": "Cần xác thực lại — nhập mã TOTP/mã khôi phục trong ô mã rồi gửi lại.",
  "MFA_CODE_INVALID": "Mã xác thực không đúng.",
  "MFA_RATE_LIMITED": "Quá nhiều lần thử mã xác thực — chờ chút rồi thử lại.",
  "RATE_LIMITED": "Bạn thao tác quá nhanh — thử lại sau ít phút.",
  "INVALID_INPUT": "Dữ liệu gửi không hợp lệ — thử lại.",
  "NOTE_TOO_LONG": "Ghi chú quá dài (tối đa 1000 ký tự).",
  "USER_NOT_FOUND": "Không tìm thấy tài khoản.",
  "NOT_FOUND": "Không tìm thấy yêu cầu — tải lại trang.",
  "SELF_VERIFICATION_FORBIDDEN": "Bạn không thể xác minh liên hệ của chính mình.",
  "SAME_PERSON_FORBIDDEN": "Bạn là người mở yêu cầu này — cần một admin khác duyệt.",
  "PHONE_NOT_ON_FILE": "Tài khoản chưa có số điện thoại hợp lệ để xác minh.",
  "ALREADY_VERIFIED": "Kênh này đã được xác minh rồi.",
  "OPEN_REQUEST_EXISTS": "Đã có yêu cầu đang chờ cho kênh này.",
  "CONTACT_CHANGED": "Giá trị liên hệ đã đổi sau khi yêu cầu mở — hủy và mở lại yêu cầu mới.",
  "EXPIRED": "Yêu cầu đã hết hạn (24 giờ) — hủy và mở lại yêu cầu mới.",
  "ALREADY_DECIDED": "Yêu cầu đã có quyết định rồi — tải lại trang.",
  "NOT_REQUESTER": "Chỉ người mở yêu cầu mới được hủy.",
  "PHONE_ALREADY_VERIFIED": "Số điện thoại này đã được xác minh bởi tài khoản khác.",
};

/** Khung lỗi dùng chung (cùng style founding-seller-forms). */
function FormError({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2 text-xs text-[var(--red)]">
      {message}
    </p>
  );
}

/** Khung thành công dùng chung. */
function FormSuccess({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2 text-xs text-[var(--green)]">
      {message}
    </p>
  );
}

/** Ô mã TOTP dùng chung (step-up — action tự requireCapabilityWithStepUp). */
function TotpInput() {
  return (
    <input
      name="totpCode"
      className="input h-8 px-2 text-xs"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="Mã TOTP (step-up)"
    />
  );
}

/** Trạng thái một kênh — dữ liệu đã mask server-side (KHÔNG giá trị thô). */
export type ManualContactChannelView = {
  channel: "email" | "phone";
  channelLabel: string;
  maskedValue: string;
  verified: boolean;
  verifiedAt: string | null;
  openRequest: {
    id: string;
    method: (typeof MANUAL_CONTACT_METHODS)[number];
    methodLabel: string;
    requestedAt: string;
    ageLabel: string;
    /** Admin hiện tại là người mở request này. */
    isRequester: boolean;
    /** Tên người mở (đã hiển thị — không phải PII liên hệ). */
    requesterName: string | null;
  } | null;
};

export function ManualContactVerificationPanel({
  subjectId,
  isSubject,
  channels,
}: {
  subjectId: string;
  /** Admin hiện tại là người được xác minh — MỌI form disable + lý do. */
  isSubject: boolean;
  channels: ManualContactChannelView[];
}) {
  return (
    <section className="card mt-5 space-y-4 p-4">
      <p className="text-sm font-bold">Xác minh liên hệ thủ công</p>
      <p className="text-xs text-[var(--muted)]">
        Hai bước: admin A mở yêu cầu sau khi liên hệ ngoài nền tảng (gọi điện / gặp
        mặt / gọi video) với chủ tài khoản; admin B khác duyệt. Yêu cầu hết hạn sau
        24 giờ.
      </p>
      {channels.map((c) => (
        <ChannelRow key={c.channel} subjectId={subjectId} isSubject={isSubject} view={c} />
      ))}
    </section>
  );
}

function ChannelRow({
  subjectId,
  isSubject,
  view,
}: {
  subjectId: string;
  isSubject: boolean;
  view: ManualContactChannelView;
}) {
  return (
    <div className="rounded-lg border border-[var(--paper-deep)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">{view.channelLabel}</span>
        <span className="text-xs text-[var(--muted)]">{view.maskedValue}</span>
        {view.verified ? (
          <span className="badge bg-[var(--green-soft)] text-[var(--green)]">
            <BadgeCheck className="size-3" />
            Đã xác minh
          </span>
        ) : view.openRequest ? (
          <span className="badge bg-amber-500/15 text-amber-600">Đang chờ duyệt</span>
        ) : (
          <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">Chưa xác minh</span>
        )}
      </div>

      {view.verified && view.verifiedAt !== null && (
        <p className="mt-1 text-xs text-[var(--muted)]">Xác minh lúc {view.verifiedAt}</p>
      )}

      {view.openRequest !== null && (
        <div className="mt-2 space-y-1 text-xs text-[var(--ink-2)]">
          <p>
            Yêu cầu mở lúc {view.openRequest.requestedAt} ({view.openRequest.ageLabel}) — cách
            xác nhận: {view.openRequest.methodLabel}
            {view.openRequest.requesterName !== null && ` — người mở: ${view.openRequest.requesterName}`}
          </p>
          {view.openRequest.isRequester && (
            <p className="text-[var(--muted)]">Bạn là người mở yêu cầu này.</p>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-2">
        {isSubject && (
          <p className="text-xs text-[var(--muted)]">
            Bạn là chủ tài khoản này — không thể tự xác minh liên hệ của chính mình.
          </p>
        )}
        {!view.verified && view.openRequest === null && (
          <RequestForm subjectId={subjectId} channel={view.channel} disabled={isSubject} />
        )}
        {view.openRequest !== null && (
          <>
            <DecideForm
              verificationId={view.openRequest.id}
              disabled={isSubject || view.openRequest.isRequester}
              disabledReason={
                view.openRequest.isRequester
                  ? "Bạn là người mở yêu cầu này — cần một admin khác duyệt."
                  : undefined
              }
            />
            {view.openRequest.isRequester && !isSubject && (
              <CancelForm verificationId={view.openRequest.id} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Forms (useActionState + dispatch thủ công — React 19 giữ input) ─────────

function RequestForm({
  subjectId,
  channel,
  disabled,
}: {
  subjectId: string;
  channel: "email" | "phone";
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState<ManualContactFormState, FormData>(
    requestManualContactVerificationAction,
    {},
  );
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
      className="flex flex-col gap-1.5"
    >
      <input type="hidden" name="userId" value={subjectId} />
      <input type="hidden" name="channel" value={channel} />
      <div className="flex flex-wrap gap-1.5">
        <select name="method" required defaultValue="phone_call" className="input h-8 px-2 text-xs" aria-label="Cách xác nhận ngoài nền tảng">
          {MANUAL_CONTACT_METHODS.map((m) => (
            <option key={m} value={m}>{MANUAL_CONTACT_METHOD_LABELS[m]}</option>
          ))}
        </select>
        <input
          name="note"
          className="input h-8 px-2 text-xs"
          placeholder="Ghi chú (tuỳ chọn — đã redact PII)"
          maxLength={MANUAL_CONTACT_NOTE_MAX_LENGTH}
        />
        <TotpInput />
        <button
          type="submit"
          disabled={disabled || pending}
          className="btn h-8 bg-[var(--accent)] px-3 text-xs text-white hover:opacity-90"
          title="Mở yêu cầu xác minh — admin khác sẽ duyệt (two-person rule)"
        >
          <PhoneCall className="size-3.5" />
          Mở yêu cầu
        </button>
      </div>
      {state.error !== undefined && <FormError message={ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && <FormSuccess message={state.success} />}
    </form>
  );
}

function DecideForm({
  verificationId,
  disabled,
  disabledReason,
}: {
  verificationId: string;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = useActionState<ManualContactFormState, FormData>(
    decideManualContactVerificationAction,
    {},
  );
  const [, startTransition] = useTransition();

  const submit =
    (decision: "approve" | "reject") => (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const form = e.currentTarget.form; // nút nằm trong form của panel
      if (form === null) return;
      const fd = new FormData(form);
      fd.set("decision", decision);
      startTransition(() => {
        void formAction(fd);
      });
    };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); // giữ input — quyết định qua nút riêng bên dưới
      }}
      className="flex flex-col gap-1.5"
    >
      <input type="hidden" name="verificationId" value={verificationId} />
      <div className="flex flex-wrap gap-1.5">
        <TotpInput />
        <button
          type="submit"
          onClick={submit("approve")}
          disabled={disabled || pending}
          className="btn h-8 bg-[var(--green)] px-3 text-xs text-white hover:opacity-90"
          title="Duyệt — đánh dấu kênh đã xác minh (chỉ khi còn null)"
        >
          <ShieldCheck className="size-3.5" />
          Duyệt
        </button>
        <button
          type="submit"
          onClick={submit("reject")}
          disabled={disabled || pending}
          className="btn h-8 bg-[var(--red)] px-3 text-xs text-white hover:opacity-90"
          title="Từ chối — kênh giữ nguyên trạng thái chưa xác minh"
        >
          <XCircle className="size-3.5" />
          Từ chối
        </button>
      </div>
      {disabled && disabledReason !== undefined && (
        <p className="text-xs text-[var(--muted)]">{disabledReason}</p>
      )}
      {state.error !== undefined && <FormError message={ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && <FormSuccess message={state.success} />}
    </form>
  );
}

function CancelForm({ verificationId }: { verificationId: string }) {
  const [state, formAction, pending] = useActionState<ManualContactFormState, FormData>(
    cancelManualContactVerificationAction,
    {},
  );
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
      className="flex flex-col gap-1.5"
    >
      <input type="hidden" name="verificationId" value={verificationId} />
      <button
        type="submit"
        disabled={pending}
        className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
        title="Hủy yêu cầu bạn đã mở (chỉ người mở mới hủy được)"
      >
        Hủy yêu cầu
      </button>
      {state.error !== undefined && <FormError message={ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && <FormSuccess message={state.success} />}
    </form>
  );
}
