"use client";

import { useActionState, useTransition } from "react";
import { KeyRound, LifeBuoy, ShieldCheck, XCircle } from "lucide-react";
import {
  cancelManualAccountRecoveryAction,
  decideManualAccountRecoveryAction,
  requestManualAccountRecoveryAction,
  type ManualRecoveryFormState,
} from "@/src/lib/actions/manual-account-recovery";
import {
  MANUAL_RECOVERY_CHECKS,
  MANUAL_RECOVERY_CHECK_LABELS,
  MANUAL_RECOVERY_STATUS_LABELS,
  type ManualRecoveryStatus,
} from "@/src/lib/manual-account-recovery";

/**
 * Panel "Khôi phục tài khoản thủ công" — Task E (founder FD-R3 2026-10-13).
 * "use client" + useActionState + dispatch thủ công (React 19 giữ input qua
 * action error — pattern manual-contact-verification-forms.tsx: form
 * KHÔNG gắn action prop, onSubmit preventDefault + startTransition để
 * requestFormReset KHÔNG wipe input khi action trả error).
 *
 * PII minimization (§4.8/§7.6): client CHỈ nhận maskedPhone (maskContact đã
 * chạy server-side) — KHÔNG BAO GIỜ số đầy đủ đến client. Operator TICK câu
 * đúng (checkbox boolean) — KHÔNG BAO GIỜ nhập câu trả lời.
 *
 * Two-person rule (UI là CONVENIENCE — action tự guard, spec §4.5):
 *  - isSubject (admin hiện tại là người được khôi phục): MỌI form disable +
 *    lý do rõ — tự khôi phục cho chính mình là đường leo thang;
 *  - isRequester (admin hiện tại là người mở request): approve/reject
 *    disable + lý do — cần admin KHÁC duyệt;
 *  - subject là admin / chưa có phone đã xác minh: request disable + lý do
 *    (procedure KHÔNG dùng được — action tự refuse).
 *
 * resetUrl sau approve hiển thị MỘT LẦN trong state (admin B copy gửi
 * out-of-band — phone/Zalo) — KHÔNG bao giờ render lại từ DB (token thô
 * không tồn tại nơi khác), KHÔNG auto-copy vào clipboard log. DecideForm
 * render CHO CẢ requested LẪN approved-unconsumed (BLOCK fix review
 * zc-efix #1): approve gọi revalidatePath("/admin/users") → Next 16 re-render
 * page NGAY (revalidatePath.md:19 — Server Function "Updates the UI
 * immediately") với row approved; nếu chỉ render khi requested, DecideForm
 * unmount → useActionState (giữ resetUrl) bị discard → link MỘT LẦN mất
 * vĩnh viễn. key theo request id (preserving-ui-state.md:281): cùng row qua
 * requested→approved GIỮ state; đổi subject/request → remount → state reset.
 *
 * Copy PROVISIONAL (FD-3): mechanics only (§4.2), không claim bảo đảm gì.
 */

/** Mã lỗi typed → tiếng Việt trung tính (mechanics only — §4.2). Code lạ hiển thị thô (fail closed). */
const ERROR_TEXT: Record<string, string> = {
  "STEP_UP_REQUIRED": "Cần xác thực lại — nhập mã TOTP/mã khôi phục trong ô mã rồi gửi lại.",
  "MFA_CODE_INVALID": "Mã xác thực không đúng.",
  "MFA_RATE_LIMITED": "Quá nhiều lần thử mã xác thực — chờ chút rồi thử lại.",
  "RATE_LIMITED": "Bạn thao tác quá nhanh — thử lại sau ít phút.",
  "INVALID_INPUT": "Dữ liệu gửi không hợp lệ — thử lại.",
  "USER_NOT_FOUND": "Không tìm thấy tài khoản.",
  "NOT_FOUND": "Không tìm thấy yêu cầu — tải lại trang.",
  "SELF_RECOVERY_FORBIDDEN": "Bạn không thể mở/duyệt khôi phục cho chính mình.",
  "SAME_PERSON_FORBIDDEN": "Bạn là người mở yêu cầu này — cần một admin khác duyệt.",
  "PHONE_NOT_VERIFIED": "Tài khoản chưa có số điện thoại đã xác minh — quy trình này không dùng được (cuộc gọi phải tới số đã xác minh).",
  "ADMIN_SUBJECT_FORBIDDEN": "Tài khoản admin không khôi phục qua đây — dùng runbook bootstrap (MFA reset).",
  "CHECKS_INSUFFICIENT": "Người dùng phải trả đúng ít nhất 2 trên 3 câu hỏi — không mở được yêu cầu.",
  "ATTESTATION_REQUIRED": "Cần xác nhận đã gọi đúng số đã xác minh của tài khoản.",
  "OPEN_REQUEST_EXISTS": "Đã có yêu cầu đang chờ (hoặc link reset còn hiệu lực) cho tài khoản này.",
  "CONTACT_CHANGED": "Số điện thoại đã đổi sau khi yêu cầu mở — hủy và mở lại yêu cầu mới.",
  "EXPIRED": "Yêu cầu đã hết hạn (24 giờ) — hủy và mở lại yêu cầu mới.",
  "ALREADY_DECIDED": "Yêu cầu đã có quyết định rồi — tải lại trang.",
  "NOT_REQUESTER": "Chỉ người mở yêu cầu mới được hủy.",
  "APP_URL_UNCONFIGURED": "Chưa cấu hình NEXT_PUBLIC_APP_URL — không sinh được link reset.",
};

/** Khung lỗi dùng chung (cùng style manual-contact-verification-forms). */
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

/** Trạng thái panel — dữ liệu đã mask server-side (KHÔNG giá trị thô). */
export type ManualRecoveryView = {
  subjectId: string;
  /** Phone đã mask (maskContact server-side) — KHÔNG bao giờ số đầy đủ. */
  maskedPhone: string;
  phoneVerified: boolean;
  phoneVerifiedAt: string | null;
  /** Subject là admin account — request disable (action tự refuse). */
  subjectIsAdmin: boolean;
  openRequest: {
    id: string;
    status: ManualRecoveryStatus;
    checksPassed: number;
    requestedAt: string;
    ageLabel: string;
    /** Admin hiện tại là người mở request này. */
    isRequester: boolean;
    /** Tên người mở (đã hiển thị — không phải PII liên hệ). */
    requesterName: string | null;
    /** approved-unconsumed: link reset còn hiệu lực tới (null với requested). */
    resetTokenExpiresAt: string | null;
  } | null;
};

export function ManualAccountRecoveryPanel({
  subjectId,
  isSubject,
  view,
}: {
  subjectId: string;
  /** Admin hiện tại là người được khôi phục — MỌI form disable + lý do. */
  isSubject: boolean;
  view: ManualRecoveryView;
}) {
  return (
    <section className="card mt-5 space-y-4 p-4">
      <p className="text-sm font-bold">Khôi phục tài khoản thủ công</p>
      <p className="text-xs text-[var(--muted)]">
        Hai bước: admin A gọi điện tới số điện thoại ĐÃ XÁM MINH của tài khoản, hỏi 3 câu
        (tiêu đề một tin đăng, tỉnh, tháng đăng ký) và mở yêu cầu khi người dùng trả đúng
        ít nhất 2 câu; admin B khác duyệt rồi gửi link reset cho người dùng qua kênh riêng
        (điện thoại/Zalo). Link reset dùng MỘT lần, hết hạn sau 30 phút.
      </p>

      <div className="rounded-lg border border-[var(--paper-deep)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">Số điện thoại đã xác minh</span>
          <span className="text-xs text-[var(--muted)]">{view.maskedPhone}</span>
          {view.phoneVerified ? (
            <span className="badge bg-[var(--green-soft)] text-[var(--green)]">Đã xác minh</span>
          ) : (
            <span className="badge bg-[var(--red-soft)] text-[var(--red)]">Chưa xác minh</span>
          )}
        </div>
        {view.phoneVerified && view.phoneVerifiedAt !== null && (
          <p className="mt-1 text-xs text-[var(--muted)]">Xác minh lúc {view.phoneVerifiedAt}</p>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {isSubject && (
          <p className="text-xs text-[var(--muted)]">
            Bạn là chủ tài khoản này — không thể tự khôi phục mật khẩu của chính mình.
          </p>
        )}
        {!isSubject && !view.phoneVerified && (
          <p className="text-xs text-[var(--muted)]">
            Tài khoản chưa có số điện thoại đã xác minh — cuộc gọi phải tới số đã xác
            minh nên quy trình này không dùng được cho tài khoản này.
          </p>
        )}
        {!isSubject && view.phoneVerified && view.subjectIsAdmin && (
          <p className="text-xs text-[var(--muted)]">
            Đây là tài khoản admin — khôi phục admin thuộc runbook bootstrap (MFA reset),
            không phải quy trình này.
          </p>
        )}
        {view.openRequest === null && (
          <RequestForm
            subjectId={subjectId}
            disabled={isSubject || !view.phoneVerified || view.subjectIsAdmin}
          />
        )}
        {view.openRequest !== null && (
          <>
            <OpenRequestInfo view={view} />
            {/* BLOCK fix (review zc-efix #1): DecideForm render CHO CẢ requested
                LẪN approved-unconsumed — approve gọi revalidatePath("/admin/users")
                → Next 16 re-render page NGAY (revalidatePath.md:19) với row
                approved; nếu chỉ render khi requested, DecideForm unmount và
                useActionState (giữ resetUrl MỘT LẦN — token thô không tồn tại
                nơi khác) bị discard → link mất vĩnh viễn, FD-R3 kẹt đến hết hạn
                30 phút (OPEN_REQUEST_EXISTS chặn request mới). key theo request
                id (preserving-ui-state.md:281 — key reset state): CÙNG row qua
                requested→approved GIỮ state; ĐỔI subject/request → remount →
                state reset (link của user khác không leak sang panel user khác). */}
            {(view.openRequest.status === "requested" ||
              view.openRequest.status === "approved") && (
              <DecideForm
                key={view.openRequest.id}
                requestId={view.openRequest.id}
                resultOnly={view.openRequest.status !== "requested"}
                disabled={isSubject || view.openRequest.isRequester}
                disabledReason={
                  view.openRequest.isRequester
                    ? "Bạn là người mở yêu cầu này — cần một admin khác duyệt."
                    : undefined
                }
              />
            )}
            {view.openRequest.isRequester && !isSubject && view.openRequest.status === "requested" && (
              <CancelForm requestId={view.openRequest.id} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function OpenRequestInfo({ view }: { view: ManualRecoveryView }) {
  const r = view.openRequest!;
  return (
    <div className="rounded-lg border border-[var(--paper-deep)] p-3 text-xs text-[var(--ink-2)]">
      <p>
        Yêu cầu mở lúc {r.requestedAt} ({r.ageLabel}) — người dùng trả đúng {r.checksPassed}/3 câu
        {r.requesterName !== null && ` — người mở: ${r.requesterName}`}
      </p>
      <p className="mt-1">
        Trạng thái: {MANUAL_RECOVERY_STATUS_LABELS[r.status]}
        {r.status === "approved" && r.resetTokenExpiresAt !== null && (
          <> — link reset hết hạn lúc {r.resetTokenExpiresAt}</>
        )}
      </p>
      {r.isRequester && <p className="mt-1 text-[var(--muted)]">Bạn là người mở yêu cầu này.</p>}
      {r.status === "approved" && (
        <p className="mt-1 text-[var(--muted)]">
          Link reset đã được hiển thị cho admin duyệt MỘT lần lúc duyệt — nếu mất, chờ hết
          hạn 30 phút rồi mở yêu cầu mới.
        </p>
      )}
    </div>
  );
}

// ─── Forms (useActionState + dispatch thủ công — React 19 giữ input) ─────────

function RequestForm({
  subjectId,
  disabled,
}: {
  subjectId: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState<ManualRecoveryFormState, FormData>(
    requestManualAccountRecoveryAction,
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
      <p className="text-xs font-semibold text-[var(--ink-2)]">
        Sau cuộc gọi — tick các câu người dùng trả ĐÚNG (không nhập câu trả lời):
      </p>
      <div className="flex flex-col gap-1">
        {MANUAL_RECOVERY_CHECKS.map((check) => (
          <label key={check} className="flex items-center gap-2 text-xs text-[var(--ink-2)]">
            <input type="checkbox" name={`check_${check}`} className="size-3.5" />
            {MANUAL_RECOVERY_CHECK_LABELS[check]}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-[var(--ink-2)]">
        <input type="checkbox" name="attestedCall" className="size-3.5" />
        Tôi đã gọi đúng số đã xác minh của tài khoản
      </label>
      <div className="flex flex-wrap gap-1.5">
        <TotpInput />
        <button
          type="submit"
          disabled={disabled || pending}
          className="btn h-8 bg-[var(--accent)] px-3 text-xs text-white hover:opacity-90"
          title="Mở yêu cầu khôi phục — admin khác sẽ duyệt (two-person rule)"
        >
          <LifeBuoy className="size-3.5" />
          Mở yêu cầu
        </button>
      </div>
      {state.error !== undefined && <FormError message={ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && <FormSuccess message={state.success} />}
    </form>
  );
}

function DecideForm({
  requestId,
  resultOnly,
  disabled,
  disabledReason,
}: {
  requestId: string;
  /**
   * Status approved-unconsumed: KHÔNG quyết lại (CAS ở action đã chặn) — nút +
   * ô TOTP ẩn; form CHỈ giữ state hiển thị (resetUrl MỘT LẦN phải sống qua
   * revalidatePath — BLOCK fix review zc-efix #1).
   */
  resultOnly: boolean;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = useActionState<ManualRecoveryFormState, FormData>(
    decideManualAccountRecoveryAction,
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
      <input type="hidden" name="requestId" value={requestId} />
      {!resultOnly && (
        <div className="flex flex-wrap gap-1.5">
          <TotpInput />
          <button
            type="submit"
            onClick={submit("approve")}
            disabled={disabled || pending}
            className="btn h-8 bg-[var(--green)] px-3 text-xs text-white hover:opacity-90"
            title="Duyệt — thu hồi mọi phiên của tài khoản và sinh link reset một lần (30 phút)"
          >
            <ShieldCheck className="size-3.5" />
            Duyệt
          </button>
          <button
            type="submit"
            onClick={submit("reject")}
            disabled={disabled || pending}
            className="btn h-8 bg-[var(--red)] px-3 text-xs text-white hover:opacity-90"
            title="Từ chối — không issue link reset"
          >
            <XCircle className="size-3.5" />
            Từ chối
          </button>
        </div>
      )}
      {!resultOnly && disabled && disabledReason !== undefined && (
        <p className="text-xs text-[var(--muted)]">{disabledReason}</p>
      )}
      {state.error !== undefined && <FormError message={ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && <FormSuccess message={state.success} />}
      {state.resetUrl !== undefined && (
        <div className="rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] p-3 text-xs">
          <p className="font-semibold text-[var(--accent)]">
            Link reset (hiện MỘT lần — copy ngay, hết hạn sau 30 phút):
          </p>
          <p className="mt-1 break-all font-mono text-[var(--ink-2)]">{state.resetUrl}</p>
          <p className="mt-1 text-[var(--muted)]">
            Gửi link cho người dùng qua kênh riêng (điện thoại/Zalo). Link không được lưu
            lại ở đâu khác — mất link thì chờ hết hạn rồi mở yêu cầu mới.
          </p>
        </div>
      )}
    </form>
  );
}

function CancelForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<ManualRecoveryFormState, FormData>(
    cancelManualAccountRecoveryAction,
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
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        disabled={pending}
        className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
        title="Hủy yêu cầu bạn đã mở (chỉ người mở mới hủy được)"
      >
        <KeyRound className="size-3.5" />
        Hủy yêu cầu
      </button>
      {state.error !== undefined && <FormError message={ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && <FormSuccess message={state.success} />}
    </form>
  );
}
