"use client";

import { useActionState, useTransition } from "react";
import { LoaderCircle, UserRoundPlus, Send, Save } from "lucide-react";
import {
  createCandidateAction,
  inviteCandidateAction,
  updateCandidateNotesAction,
  type FoundingSellerFormState,
} from "@/src/lib/actions/founding-sellers";
import { PROVINCES } from "@/src/lib/provinces";
import {
  FOUNDING_SELLER_NOTE_MAX_LENGTH,
  FOUNDING_SELLER_SOURCE_MAX_LENGTH,
} from "@/src/lib/founding-seller-vocab";

/**
 * Forms console founding seller — "use client" + useActionState (Batch 7
 * Task 5 — spec §5.10/§5.10.1; corrections 2026-10-08 items 33/36).
 *
 * Import client-safe ONLY (B2 hygiene): actions (server action references),
 * provinces (plain module FD-1), founding-seller-vocab (plain module Task 2).
 * KHÔNG import db/server-only — mọi enforcement sống ở action (tự guard
 * requireCapability("beta_cohort.manage") — hidden form không phải
 * authorization, spec §4.5).
 *
 * FORM RESET (React 19 — pattern invite-accept-form.tsx / deal-create-form.tsx,
 * b6-review LOW-2): form KHÔNG gắn action prop — dispatch thủ công onSubmit +
 * preventDefault + startTransition để input KHÔNG bị requestFormReset wipe
 * sau khi action trả {error} (người dùng không phải nhập lại).
 *
 * Token secrecy (Review Focus 1 — S1): form mời KHÔNG mang token nào; URL
 * tuyệt đối đến từ response state (FoundingSellerFormState.inviteUrl — sinh ở
 * action, KHÔNG persist) và hiển thị đúng MỘT LẦN trong state đó. Copy trung
 * tính — mechanics only (§4.2/§4.11 — PROVISIONAL, founder review qua Batch 8
 * register).
 */

/** Mã lỗi typed → tiếng Việt trung tính (mechanics only — §4.2). Code lạ hiển thị thô (fail closed). */
const CANDIDATE_CREATE_ERROR_TEXT: Record<string, string> = {
  INVALID_CONTACT_CHANNEL: "Kênh liên hệ phải là email hoặc số điện thoại",
  INVALID_SOURCE: "Hãy ghi kênh tuyển nguồn",
  INVALID_PROVINCE: "Khu vực mục tiêu không hợp lệ",
  NOTE_TOO_LONG: "Ghi chú quá dài",
  INVALID_PHONE_FORMAT: "Số điện thoại chưa đúng định dạng",
  CANDIDATE_CONTACT_IS_OPERATOR: "Kênh liên hệ này là của chính bạn — không thể tạo ứng viên cho chính mình",
  CANDIDATE_CONTACT_EXISTS: "Đã có ứng viên khác với kênh liên hệ này còn trong chương trình",
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
};

const INVITE_ERROR_TEXT: Record<string, string> = {
  NOT_FOUND: "Không tìm thấy ứng viên",
  CONTACT_REQUIRED: "Ứng viên chưa có kênh liên hệ — hãy tạo lại ứng viên",
  INVALID_STATE: "Ứng viên đã đăng ký — chỉ mời ứng viên trước khi đăng ký",
  APP_URL_UNCONFIGURED: "Chưa cấu hình NEXT_PUBLIC_APP_URL — không sinh được link mời",
  INVITE_ALREADY_ISSUED: "Đã có lời mời active cho ứng viên này — thử lại",
  CANDIDATE_CONTACT_IS_OPERATOR: "Kênh liên hệ của ứng viên là của chính bạn — không thể tự mời",
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
};

const NOTES_ERROR_TEXT: Record<string, string> = {
  INVALID_CANDIDATE_ID: "Không tìm thấy ứng viên",
  NOTE_TOO_LONG: "Ghi chú quá dài",
  NOT_FOUND: "Không tìm thấy ứng viên",
};

/** Khung lỗi dùng chung (cùng style invite-accept-form). */
function FormError({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2 text-xs text-[var(--red)]">
      {message}
    </p>
  );
}

// ─── 1. Thêm ứng viên (prospect) ───────────────────────────────────────────────

export function CandidateCreateForm() {
  const [state, formAction, pending] = useActionState<FoundingSellerFormState, FormData>(
    createCandidateAction,
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
      className="card mt-5 space-y-3 p-4"
    >
      <p className="text-sm font-bold">Thêm ứng viên founding seller</p>
      {state.error !== undefined && <FormError message={CANDIDATE_CREATE_ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && (
        <p className="rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2 text-xs text-[var(--green)]">
          {state.success}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-[var(--ink-2)]">
          Kênh liên hệ
          <select name="contactChannel" required defaultValue="email" className="input mt-1 h-9 text-sm">
            <option value="email">Email</option>
            <option value="phone">Số điện thoại</option>
          </select>
        </label>
        <label className="block text-xs font-semibold text-[var(--ink-2)]">
          Email / SĐT liên hệ
          <input name="contactReference" required className="input mt-1 h-9 text-sm" placeholder="lienhe@example.com" />
        </label>
        <label className="block text-xs font-semibold text-[var(--ink-2)]">
          Kênh tuyển nguồn
          <input
            name="source"
            required
            maxLength={FOUNDING_SELLER_SOURCE_MAX_LENGTH}
            className="input mt-1 h-9 text-sm"
            placeholder="giới thiệu bởi cộng đồng loa…"
          />
        </label>
        <label className="block text-xs font-semibold text-[var(--ink-2)]">
          Khu vực mục tiêu
          <select name="targetCommunity" required defaultValue="ha-noi" className="input mt-1 h-9 text-sm">
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>{p.displayName}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs font-semibold text-[var(--ink-2)]">
        Ghi chú ban đầu (tuỳ chọn — đã redact PII khi lưu)
        <textarea name="notes" maxLength={FOUNDING_SELLER_NOTE_MAX_LENGTH} rows={2} className="input mt-1 text-sm" />
      </label>
      <button type="submit" disabled={pending} className="btn-primary px-4 text-sm">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <UserRoundPlus className="size-4" />}
        Thêm ứng viên
      </button>
    </form>
  );
}

// ─── 2. Mời / mời lại ứng viên (invite issuance) ──────────────────────────────

export function InviteIssueForm({ candidateId }: { candidateId: string }) {
  const [state, formAction, pending] = useActionState<FoundingSellerFormState, FormData>(
    inviteCandidateAction,
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
      className="flex flex-col gap-1"
    >
      <input type="hidden" name="candidateId" value={candidateId} />
      {state.error !== undefined && <FormError message={INVITE_ERROR_TEXT[state.error] ?? state.error} />}
      {/* URL mời TUYỆT ĐỐI — response state MỘT LẦN (raw token chỉ tồn tại ở
          đây trong console; db chỉ lưu HMAC — Review Focus 1). */}
      {state.inviteUrl !== undefined && (
        <div className="rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3 py-2 text-xs">
          <p className="font-semibold text-[var(--green)]">{state.success ?? "Đã tạo lời mời."}</p>
          <p className="mt-1 text-[var(--ink-2)]">
            Link lời mời (hiển thị MỘT lần — sao chép gửi cho ứng viên qua kênh riêng của bạn):
          </p>
          <input
            readOnly
            value={state.inviteUrl}
            className="input mt-1 text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="mt-1 text-[var(--muted)]">
            Link chứa mã bí mật — không đăng công khai. Mất link → thu hồi rồi mời lại.
          </p>
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="btn h-8 bg-[var(--green)] px-3 text-xs text-white hover:opacity-90"
        title="Sinh lời mời single-use (14 ngày) — thu hồi token cũ nếu có (re-invite idempotent)"
      >
        {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
        Mời ứng viên
      </button>
    </form>
  );
}

// ─── 3. Ghi chú ops (writer duy nhất của candidate.notes — Task 4) ─────────────

export function CandidateNotesForm({ candidateId, notes }: { candidateId: string; notes: string | null }) {
  const [state, formAction, pending] = useActionState<FoundingSellerFormState, FormData>(
    updateCandidateNotesAction,
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
      className="flex flex-col gap-1"
    >
      <input type="hidden" name="candidateId" value={candidateId} />
      {state.error !== undefined && <FormError message={NOTES_ERROR_TEXT[state.error] ?? state.error} />}
      {state.success !== undefined && (
        <p className="text-[11px] font-semibold text-[var(--green)]">{state.success}</p>
      )}
      <textarea
        name="notes"
        rows={2}
        defaultValue={notes ?? ""}
        maxLength={FOUNDING_SELLER_NOTE_MAX_LENGTH}
        aria-label="Ghi chú ops"
        className="input text-xs"
        placeholder="Ghi chú onboarding (đã redact PII khi lưu)"
      />
      <button
        type="submit"
        disabled={pending}
        className="btn-secondary h-8 px-3 text-xs"
        title="Ghi đè ghi chú ops — audited (founding_seller.notes_updated)"
      >
        {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        Lưu ghi chú
      </button>
    </form>
  );
}
