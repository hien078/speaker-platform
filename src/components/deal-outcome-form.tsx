"use client";

/**
 * DealOutcomeForm — đánh dấu kết quả thỏa thuận per party (Batch 6 Task 6b,
 * spec §5.2/D3/D6).
 *
 * "use client" + useActionState(markDealOutcomeAction). Ba lựa chọn từ
 * DEAL_OUTCOMES (D3 — marking per party, KHÔNG phải trạng thái deal), label
 * từ DEAL_OUTCOME_LABELS (constants — không tự chế giá trị).
 *
 * FORM RESET (b6-review LOW-1): form KHÔNG gắn action prop — dispatch thủ
 * công onSubmit + preventDefault + startTransition (pattern b4-holistic
 * round-1) để outcome/markSold/cancellationReason KHÔNG bị React 19
 * requestFormReset wipe sau action trả {error} (pin deal-ui.test.ts §4b).
 *
 * MARK SOLD (D6/FD-3): checkbox "Đánh dấu tin đã bán" CHỈ render khi
 * viewerRole === "seller" VÀ chọn "success", default OFF — bilateral
 * completion một mình KHÔNG bán listing (sold không thể hoàn tác); buyer
 * không thấy checkbox (action cũng bỏ qua markSold từ buyer — enforcement
 * ở action, không phải ở form).
 *
 * cancellationReason (D3): textarea CHỈ hiện khi chọn "cancelled", maxLength
 * DEAL_CANCELLATION_REASON_MAX (server enforce lại — client bound chỉ là UX).
 * Untrusted input — render React text, KHÔNG vào telemetry (§4.8).
 *
 * Import CHỈ từ deal-vocab (client-safe) + constants + actions/deals
 * (B2 hygiene — pin deal-ui.test.ts).
 */
import { useActionState, useState, useTransition } from "react";
import { ClipboardCheck, LoaderCircle } from "lucide-react";
import { markDealOutcomeAction, type DealFormState } from "@/src/lib/actions/deals";
import {
  DEAL_CANCELLATION_REASON_MAX,
  DEAL_OUTCOMES,
  type DealOutcome,
} from "@/src/lib/deal-vocab";
import { DEAL_OUTCOME_LABELS } from "@/src/lib/constants";

/** Text lỗi typed → tiếng Việt (mechanics only — §4.2; code lạ hiển thị thô). */
const DEAL_OUTCOME_ERROR_TEXT: Record<string, string> = {
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
  DEAL_OUTCOME_INVALID: "Vui lòng chọn kết quả",
  DEAL_REASON_INVALID: "Lý do hủy quá dài",
  DEAL_FORBIDDEN: "Không thể ghi kết quả cho thỏa thuận này",
  ACCOUNT_SUSPENDED: "Tài khoản đang bị đình chỉ",
  CHAT_BLOCKED: "Hai bên đang chặn nhau — không thể ghi kết quả thành công",
  DEAL_ALREADY_MARKED: "Bạn đã đánh dấu một kết quả khác cho thỏa thuận này",
};

export function DealOutcomeForm({
  dealId,
  viewerRole,
}: {
  dealId: string;
  /** markSold chỉ seller (D6) — buyer không thấy checkbox; action bỏ qua từ buyer. */
  viewerRole: "buyer" | "seller";
}) {
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(
    markDealOutcomeAction,
    {},
  );
  // Dispatch thủ công (b6-review LOW-1 — pattern b4-holistic round-1 của
  // PortableListingForm): React 19 gọi requestFormReset trên MỌI form action
  // KHÔNG throw — kể cả action trả {error} — nên gắn action prop sẽ
  // form.reset() bỏ chọn radio (DOM) + wipe textarea/checkbox TRONG KHI
  // useState vẫn giữ outcome cũ → retry đọc FormData từ DOM ĐÃ RESET (outcome
  // rỗng → DEAL_OUTCOME_INVALID, markSold mất). Bỏ action prop + dispatch qua
  // onSubmit + startTransition: KHÔNG requestFormReset; pending của
  // useActionState vẫn track đúng (gọi trong transition — React docs).
  const [, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<DealOutcome | "">("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => {
          void formAction(fd);
        });
      }}
      className="mt-3 space-y-3"
    >
      <input type="hidden" name="dealId" value={dealId} />

      <fieldset>
        <legend className="label text-xs">Kết quả của bạn</legend>
        <div className="mt-2 space-y-1.5">
          {DEAL_OUTCOMES.map((o) => (
            <div key={o} className="flex items-center gap-2">
              <input
                id={`deal-outcome-${dealId}-${o}`}
                type="radio"
                name="outcome"
                value={o}
                checked={outcome === o}
                onChange={() => setOutcome(o)}
                className="size-4 accent-[var(--accent)]"
              />
              <label
                htmlFor={`deal-outcome-${dealId}-${o}`}
                className="text-sm text-[var(--ink-2)]"
              >
                {DEAL_OUTCOME_LABELS[o]}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      {outcome === "cancelled" && (
        <div>
          <label className="label text-xs" htmlFor={`deal-cancellation-reason-${dealId}`}>
            Lý do hủy (tùy chọn)
          </label>
          <textarea
            id={`deal-cancellation-reason-${dealId}`}
            name="cancellationReason"
            rows={2}
            maxLength={DEAL_CANCELLATION_REASON_MAX}
            className="input resize-none text-sm"
          />
        </div>
      )}

      {viewerRole === "seller" && outcome === "success" && (
        <div className="flex items-center gap-2">
          <input
            id={`deal-mark-sold-${dealId}`}
            type="checkbox"
            name="markSold"
            className="size-4 accent-[var(--accent)]"
          />
          <label
            htmlFor={`deal-mark-sold-${dealId}`}
            className="text-sm text-[var(--ink-2)]"
          >
            Đánh dấu tin đã bán
          </label>
        </div>
      )}

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2 text-xs text-[var(--red)]">
          {DEAL_OUTCOME_ERROR_TEXT[state.error] ?? state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg border border-[var(--green)]/30 bg-[var(--green-soft)] px-3.5 py-2 text-xs text-[var(--green)]">
          {state.success}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || outcome === ""}
        className="btn-primary w-full text-sm"
      >
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <ClipboardCheck className="size-4" />
        )}
        Ghi kết quả
      </button>
    </form>
  );
}
