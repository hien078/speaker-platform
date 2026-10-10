"use client";

import { useActionState, useTransition } from "react";
import { LoaderCircle, MailCheck } from "lucide-react";
import {
  acceptInviteAction,
  type FoundingSellerFormState,
} from "@/src/lib/actions/founding-sellers";

/**
 * InviteAcceptForm — form nhận lời mời founding seller (Batch 7 Task 3 — S1).
 *
 * "use client" + useActionState(acceptInviteAction) — chữ ký (prevState,
 * formData). KHÔNG hidden input token: action đọc token từ cookie HttpOnly
 * sp_invite (S1 — token KHÔNG BAO GIỜ trong form/next/query; forged field
 * "token" trong form bị action ignore hoàn toàn).
 *
 * FORM RESET (b6-review LOW-2 — pattern deal-create-form.tsx): form KHÔNG
 * gắn action prop — dispatch thủ công onSubmit + preventDefault +
 * startTransition để KHÔNG bị React 19 requestFormReset wipe sau action trả
 * {error} (kể cả khi form không có input — giữ pattern repo thống nhất).
 *
 * Error text map MÃ TYPED → tiếng Việt trung tính (mechanics only — KHÔNG
 * promise language §4.2; PROVISIONAL copy — founder review qua Batch 8
 * register). Mã lạ hiển thị thô (fail closed — code là hằng số của action,
 * không phải input người dùng, KHÔNG có phản chiếu). INVITE_INVALID là MỘT
 * chuỗi byte-identical cho mọi lý do token fail (enumeration-safe — §10.1).
 */
const INVITE_ACCEPT_ERROR_TEXT: Record<string, string> = {
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
  INVITE_INVALID: "Lời mời không còn hiệu lực",
  INVITE_CHANNEL_MISMATCH: "Lời mời được gửi cho một kênh liên hệ khác của tài khoản này",
  INVITE_CHANNEL_UNVERIFIED:
    "Kênh liên hệ của bạn chưa được xác minh — hãy xác minh email/số điện thoại rồi nhận lại lời mời",
  INVITE_ACCOUNT_SUSPENDED: "Tài khoản đang bị đình chỉ — không thể nhận lời mời",
  INVITE_MEMBERSHIP_NOT_ACCEPTABLE:
    "Trạng thái thành viên hiện tại không cho phép nhận lời mời này",
  INVITE_SELF_ISSUED: "Lời mời do chính bạn tạo — không thể tự nhận",
};

export function InviteAcceptForm() {
  const [state, formAction, pending] = useActionState<FoundingSellerFormState, FormData>(
    acceptInviteAction,
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
      className="space-y-3"
    >
      {state.error !== undefined && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2 text-xs text-[var(--red)]">
          {INVITE_ACCEPT_ERROR_TEXT[state.error] ?? state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full text-sm">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <MailCheck className="size-4" />
        )}
        Nhận lời mời
      </button>
      <p className="text-[12px] text-[var(--muted)]">
        Tư cách thành viên chỉ được ghi cho tài khoản có email/số điện thoại trùng với kênh lời
        mời và đã được xác minh.
      </p>
    </form>
  );
}
