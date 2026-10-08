"use client";

/**
 * DealCreateForm — form tạo thỏa thuận §5.2 (Batch 6 Task 6b, spec §6.1/§5.2).
 *
 * Hai variant (plan Task 6):
 *  - "compact" (trang listing §6.1 secondary CTA): CHỈ nút submit —
 *    agreedPrice/fulfillmentMethod bỏ trống (action nhận chuỗi rỗng → null);
 *  - "full" (DealPanel trên trang hội thoại): đủ hai trường.
 *
 * "use client" + useActionState(createDealAction) — chữ ký (prevState,
 * formData) nên KHÔNG gắn được vào <form action> thô; mọi mount đều qua
 * component này. Import CHỈ từ deal-vocab (client-safe) + constants +
 * actions/deals (B2 hygiene — pin deal-ui.test.ts).
 *
 * FORM RESET (b6-review LOW-2): form KHÔNG gắn action prop — dispatch thủ
 * công onSubmit + preventDefault + startTransition (pattern b4-holistic
 * round-1) để agreedPrice/fulfillmentMethod KHÔNG bị React 19
 * requestFormReset wipe sau action trả {error} (pin deal-ui.test.ts §4b).
 *
 * Enforcement sống ở ACTION (createDealAction đọc FRESH + enforce §5.2:
 * listing approved, buyer của hội thoại, seller eligibility §7.8, block,
 * suspension, một deal open per (listing, buyer)); form chỉ là UX — nút
 * render không có nghĩa được phép.
 */
import { useActionState, useTransition } from "react";
import { Handshake, LoaderCircle } from "lucide-react";
import { createDealAction, type DealFormState } from "@/src/lib/actions/deals";
import {
  DEAL_AGREED_PRICE_MAX,
  DEAL_AGREED_PRICE_MIN,
  DEAL_FULFILLMENT_METHODS,
} from "@/src/lib/deal-vocab";
import { FULFILLMENT_METHOD_LABELS } from "@/src/lib/constants";

/**
 * Text lỗi typed → tiếng Việt (mechanics only — KHÔNG promise language §4.2).
 * Code lạ hiển thị thô (fail closed — code là hằng số của action, không phải
 * input người dùng, KHÔNG có phản chiếu). D12: ba mã SELLER_* hiển thị cùng
 * một copy trung tính như CTA trang listing.
 */
const DEAL_CREATE_ERROR_TEXT: Record<string, string> = {
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
  DEAL_PRICE_INVALID: "Giá thỏa thuận chưa hợp lệ",
  DEAL_FULFILLMENT_INVALID: "Phương thức giao nhận chưa hợp lệ",
  LISTING_NOT_FOUND: "Tin đăng không tồn tại",
  DEAL_OWN_LISTING: "Đây là tin đăng của chính bạn",
  LISTING_NOT_DEALABLE: "Tin đăng không còn nhận thỏa thuận mới",
  ACCOUNT_SUSPENDED: "Tài khoản đang bị đình chỉ",
  CHAT_BLOCKED: "Hai bên đang chặn nhau — không thể tạo thỏa thuận",
  SELLER_SUSPENDED: "Người bán hiện không nhận tin nhắn mới",
  SELLER_NOT_VERIFIED: "Người bán hiện không nhận tin nhắn mới",
  SELLER_MEMBERSHIP_INACTIVE: "Người bán hiện không nhận tin nhắn mới",
  DEAL_CONVERSATION_REQUIRED: "Hãy nhắn người bán trước khi tạo thỏa thuận",
  DEAL_ALREADY_OPEN: "Đã có thỏa thuận đang mở với tin này",
};

export function DealCreateForm({
  listingId,
  variant = "full",
}: {
  listingId: string;
  /** "compact" (trang listing §6.1) — chỉ nút; "full" (deal panel) — đủ trường. */
  variant?: "full" | "compact";
}) {
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(
    createDealAction,
    {},
  );
  // Dispatch thủ công (b6-review LOW-2 — pattern b4-holistic round-1 của
  // PortableListingForm): React 19 gọi requestFormReset trên MỌI form action
  // KHÔNG throw — kể cả action trả {error} — nên gắn action prop sẽ
  // form.reset() wipe agreedPrice/fulfillmentMethod (DOM) sau error → người
  // dùng phải nhập lại. Bỏ action prop + dispatch qua onSubmit +
  // startTransition: KHÔNG requestFormReset; pending của useActionState vẫn
  // track đúng (gọi trong transition — React docs).
  const [, startTransition] = useTransition();
  const compact = variant === "compact";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => {
          void formAction(fd);
        });
      }}
      className={compact ? "" : "space-y-3"}
    >
      <input type="hidden" name="listingId" value={listingId} />

      {!compact && (
        <>
          <div>
            <label className="label text-xs" htmlFor={`deal-agreed-price-${listingId}`}>
              Giá thỏa thuận (tùy chọn — do hai bên tự nhập, LoaViet không thu)
            </label>
            <input
              id={`deal-agreed-price-${listingId}`}
              name="agreedPrice"
              type="number"
              min={DEAL_AGREED_PRICE_MIN}
              max={DEAL_AGREED_PRICE_MAX}
              step={1000}
              className="input"
            />
            <p className="mt-1 text-[11px] text-[var(--muted)]">
              Để trống nếu thỏa thuận không có phần tiền.
            </p>
          </div>
          <div>
            <label className="label text-xs" htmlFor={`deal-fulfillment-${listingId}`}>
              Phương thức giao nhận (tùy chọn)
            </label>
            <select id={`deal-fulfillment-${listingId}`} name="fulfillmentMethod" className="input">
              <option value="">— Chọn phương thức</option>
              {DEAL_FULFILLMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {FULFILLMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2 text-xs text-[var(--red)]">
          {DEAL_CREATE_ERROR_TEXT[state.error] ?? state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg border border-[var(--green)]/30 bg-[var(--green-soft)] px-3.5 py-2 text-xs text-[var(--green)]">
          {state.success}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className={compact ? "btn-secondary w-full text-sm" : "btn-primary w-full text-sm"}
      >
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Handshake className="size-4" />
        )}
        Tạo thỏa thuận
      </button>
    </form>
  );
}
