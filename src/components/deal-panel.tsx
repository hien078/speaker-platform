/**
 * DealPanel — panel thỏa thuận §5.2 trên trang hội thoại (Batch 6 Task 6b).
 *
 * Server component (props in — React out; KHÔNG directive client, KHÔNG đọc
 * db: trang hội thoại load deal THEO conversationId — S11, Deal.conversationId
 * không FK nên deal sống qua listing deletion — rồi truyền vào). Listing
 * truyền theo redaction của trang (listingVisible — corrections #15):
 * viewer không được thấy content của tin đã gỡ → null → status-only.
 *
 * Trạng thái render (plan Task 6 + D3/D4/S11):
 *  - deal ≠ null → trạng thái (DEAL_STATUS_LABELS) + agreedPrice (formatVND —
 *    bản ghi tự nhập, LoaViet không thu) + fulfillment label (Batch 4 map) +
 *    dòng §5.2 + cancellationReason (React text — stored-XSS contract);
 *  - deal open + viewer chưa mark → DealOutcomeForm; đã mark → chờ
 *    counterpart (KHÔNG form — marking per party immutable, D3);
 *  - buyer + listing approved + (deal null HOẶC terminal) → DealCreateForm
 *    full (S11/D4 — deal terminal không chặn deal MỚI; trạng thái cuối vẫn
 *    hiển thị ở trên, form tạo mới ở dưới);
 *  - listing null (đã xóa — SetNull) → status-only, KHÔNG create form.
 *
 * KHÔNG tự mount component hướng dẫn an toàn §6.4 — trang hội thoại mount nó
 * MỘT LẦN, sau panel (tránh render đôi). Copy mechanics only, KHÔNG promise
 * language (§4.2 — pin deal-ui.test.ts).
 */
import { Handshake } from "lucide-react";
import { DealCreateForm } from "@/src/components/deal-create-form";
import { DealOutcomeForm } from "@/src/components/deal-outcome-form";
import { formatVND } from "@/src/lib/utils";
import { DEAL_STATUS_LABELS, FULFILLMENT_METHOD_LABELS } from "@/src/lib/constants";
import {
  isTerminalDealStatus,
  type DealFulfillmentMethod,
  type DealStatus,
} from "@/src/lib/deal-vocab";

/** Dòng §5.2 — bắt buộc trong UI (copy-safety SAFETY_52_LINE). */
const INDEPENDENT_TRANSACTION_LINE =
  "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.";

/** Deal row (structural — trang truyền row Deal đã load theo conversationId). */
export type DealPanelDeal = {
  id: string;
  status: DealStatus;
  agreedPrice: number | null;
  fulfillmentMethod: DealFulfillmentMethod | null;
  buyerOutcomeAt: string | null;
  sellerOutcomeAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
};

export function DealPanel({
  deal,
  listing,
  viewerRole,
}: {
  deal: DealPanelDeal | null;
  /** null khi listing đã xóa (SetNull) HOẶC redaction (listingVisible) — status-only. */
  listing: { id: string; title: string; status: string } | null;
  viewerRole: "buyer" | "seller";
}) {
  const viewerOutcomeAt =
    deal === null ? null : viewerRole === "buyer" ? deal.buyerOutcomeAt : deal.sellerOutcomeAt;

  // S11/D4: deal terminal KHÔNG chặn buyer tạo deal MỚI; listing null (đã
  // xóa) hoặc không approved → KHÔNG create form (deal vẫn hiển thị status).
  const canCreateDeal =
    viewerRole === "buyer" &&
    listing?.status === "approved" &&
    (deal === null || isTerminalDealStatus(deal.status));
  // Outcome form chỉ khi deal còn open VÀ viewer chưa mark (D3 — đã mark thì
  // per-party immutable, chờ counterpart, KHÔNG form).
  const canMarkOutcome = deal !== null && deal.status === "open" && viewerOutcomeAt === null;

  if (deal === null && !canCreateDeal) return null;

  return (
    <section className="card mt-4 p-5" aria-label="Thỏa thuận">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
        <Handshake className="size-4 text-[var(--accent)]" />
        Thỏa thuận
      </p>

      {deal !== null && (
        <div className="mt-3 space-y-2 text-sm text-[var(--ink-2)]">
          <p>
            Trạng thái:{" "}
            <span className="font-bold text-[var(--ink)]">{DEAL_STATUS_LABELS[deal.status]}</span>
          </p>
          {deal.agreedPrice !== null && (
            <p>
              Giá đã ghi: <span className="font-bold">{formatVND(deal.agreedPrice)}</span>{" "}
              <span className="text-xs text-[var(--muted)]">
                (do hai bên tự nhập — LoaViet không thu tiền này)
              </span>
            </p>
          )}
          {deal.fulfillmentMethod !== null && (
            <p>Giao nhận: {FULFILLMENT_METHOD_LABELS[deal.fulfillmentMethod]}</p>
          )}
          {deal.status === "cancelled" && deal.cancellationReason !== null && (
            <p>Lý do hủy: {deal.cancellationReason}</p>
          )}
          <p className="text-xs text-[var(--muted)]">{INDEPENDENT_TRANSACTION_LINE}</p>
        </div>
      )}

      {canMarkOutcome && deal !== null && (
        <DealOutcomeForm dealId={deal.id} viewerRole={viewerRole} />
      )}
      {deal !== null && deal.status === "open" && viewerOutcomeAt !== null && (
        <p className="mt-3 rounded-lg bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink-2)]">
          Bạn đã đánh dấu kết quả — chờ người còn lại đánh dấu.
        </p>
      )}

      {canCreateDeal && listing !== null && (
        <div className="mt-3 border-t border-[var(--line)] pt-3">
          <DealCreateForm listingId={listing.id} variant="full" />
        </div>
      )}
    </section>
  );
}
