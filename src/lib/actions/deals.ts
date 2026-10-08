"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { assertCanStartConversation } from "@/src/lib/moderation";
import {
  DEAL_AGREED_PRICE_MAX,
  DEAL_AGREED_PRICE_MIN,
  DEAL_CANCELLATION_REASON_MAX,
  DEAL_CREATE_LISTING_STATUSES,
  DEAL_FULFILLMENT_METHODS,
  DEAL_MUTATION_RATE,
  DEAL_OUTCOMES,
  assertDealParticipant,
  assertDealOutcomeAllowed,
  assertListingSellerInteractable,
  requireDealConversation,
  type DealFulfillmentMethod,
  type DealOutcome,
} from "@/src/lib/deal";
import { emitProductEvent } from "@/src/lib/product-events";
import { assertBuyerBetaChatAccess } from "@/src/lib/beta-access";
import { notify } from "@/src/lib/notify";
import { captureError } from "@/src/lib/observability";

/**
 * Deal actions (Batch 6 Tasks 4–5 — spec §5.2 lightweight Deal, §7.1 "Deal
 * mutation" rate limit, §7.3 cross-account Deal modification, §7.8
 * seller-side eligibility; §9 Batch 6 Gate: KHÔNG finance transaction nào
 * được tạo từ đây — pinned bởi tests/unit/deal-finance-isolation.test.ts).
 *
 * Deal là domain RIÊNG, money-free (§5.2): KHÔNG phải hệ quản lý giao dịch
 * có tiền — không hoa hồng, không giữ tiền hộ, không sổ kế toán;
 * agreedPrice là bản ghi người dùng TỰ NHẬP, LoaViet không bao giờ thu tiền
 * này trong P0 (D5 — bound giá = bound create-validation THẬT của repo,
 * drift-pinned ở deal-domain.test.ts).
 *
 * Guard reuse (Q5 — KHÔNG duplicate): actor suspension/block đi qua
 * assertCanStartConversation của Batch 3 (gọi TRỰC TIẾP — creation không
 * cần guard mới); seller-side eligibility (suspension/revocation/membership)
 * đi qua assertListingSellerInteractable của Task 2 (D2 — NEW interaction
 * only); hội thoại tương ứng qua requireDealConversation (§5.2). Mọi guard
 * đọc FRESH từ DB mỗi call — enforcement sống ở action, KHÔNG ở UI.
 *
 * CHỈ BUYER tạo Deal (D11 — §5.2 liệt kê "authorized buyer", không có
 * seller-initiation): mọi guard khóa theo user.id = buyer của hội thoại
 * (listing, buyer); seller không có đường khởi tạo.
 *
 * Global Constraints — transaction constraint-violation rule: violation
 * (SQLSTATE 23505) LUÔN throw ra khỏi callback (Postgres abort tx — catch
 * bên trong rồi return là silent-success bug: COMMIT thành ROLLBACK),
 * classify NGOÀI tx theo constraint name (corrections #11: SqlQueryError.is
 * + sqlState + PREFIX — tên index render kèm hash suffix
 * `deal_one_open_per_listing_buyer_<8hex>`; KHÔNG map mù mọi 23505).
 *
 * Emission + notify SAU tx (S1/Q6 — corrections #25): emitProductEvent ghi
 * qua db (KHÔNG qua tx) + fail-open nên MỌI emission/notify chỉ chạy SAU
 * `await db.transaction(...)` resolve — rollback không thể để lại event
 * ma của successful_match/deal_created. Metadata TYPED (dealId +
 * fulfillmentMethod) — KHÔNG agreedPrice, KHÔNG free text (§4.8).
 *
 * KHÔNG ghi audit log bảo mật (D7 — DealStatusHistory là user-action record;
 * audit log bảo mật là privileged-actor domain, §4.6). KHÔNG revalidatePath
 * trên error path (corrections #14 — chỉ sau commit).
 */

export type DealFormState = { error?: string; success?: string };

/**
 * Typed error codes của ba guard creation — map → form state (fail closed).
 * Lỗi infra/db KHÔNG nằm trong list → rethrow (KHÔNG masquerade thành
 * form error — server action error 500, observability bắt).
 */
const DEAL_CREATE_GUARD_ERROR_CODES = [
  "ACCOUNT_SUSPENDED", // assertCanStartConversation — actor đình chỉ (§7.8)
  "CHAT_BLOCKED", // assertCanStartConversation — block hai hướng (§5.5)
  "SELLER_SUSPENDED", // assertListingSellerInteractable — D2
  "SELLER_NOT_VERIFIED", // assertListingSellerInteractable — D2
  "SELLER_MEMBERSHIP_INACTIVE", // assertListingSellerInteractable — D2
  "BETA_MEMBERSHIP_REQUIRED", // assertBuyerBetaChatAccess — B7 Task 6 (§2.1/§7.8)
  "DEAL_CONVERSATION_REQUIRED", // requireDealConversation — §5.2
] as const;

/** Thông báo thành công — mechanics only, KHÔNG promise language (§4.2/Q9). */
const DEAL_CREATED_MESSAGE = "Đã tạo thỏa thuận.";

export async function createDealAction(
  _prev: DealFormState,
  formData: FormData,
): Promise<DealFormState> {
  // 1. Authorization + rate limit (§7.1 "Deal mutation" — 20 create+outcome/
  //    giờ/user, bucket `deal:mutation:<userId>` DÙNG CHUNG với
  //    markDealOutcomeAction của Task 5). TRƯỚC mọi read/mutation — không
  //    dùng deal mutation để dò trạng thái DB.
  const user = await requireUser();
  const limited = checkRateLimit(`deal:mutation:${user.id}`, DEAL_MUTATION_RATE);
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  // 2. Input validation (zod — D5/D7): agreedPrice rỗng → null (deal không
  //    có thành phần tiền thì bỏ trống); có → integer trong bound THẬT của
  //    repo (DEAL_AGREED_PRICE_MIN..MAX — drift với PRICE_MIN/PRICE_MAX của
  //    listing-schema.ts, corrections #21). fulfillmentMethod ∈ §5.2 vocab
  //    (drift với LISTING_FULFILLMENT_METHODS — corrections #20); bỏ trống → null.
  const agreedPriceRaw = String(formData.get("agreedPrice") ?? "").trim();
  let agreedPrice: number | null = null;
  if (agreedPriceRaw !== "") {
    const parsedPrice = z
      .number()
      .int()
      .min(DEAL_AGREED_PRICE_MIN)
      .max(DEAL_AGREED_PRICE_MAX)
      .safeParse(Number(agreedPriceRaw));
    if (!parsedPrice.success) return { error: "DEAL_PRICE_INVALID" };
    agreedPrice = parsedPrice.data;
  }

  const fulfillmentRaw = String(formData.get("fulfillmentMethod") ?? "").trim();
  let fulfillmentMethod: DealFulfillmentMethod | null = null;
  if (fulfillmentRaw !== "") {
    if (!(DEAL_FULFILLMENT_METHODS as readonly string[]).includes(fulfillmentRaw)) {
      return { error: "DEAL_FULFILLMENT_INVALID" };
    }
    fulfillmentMethod = fulfillmentRaw as DealFulfillmentMethod;
  }

  // 3. Listing (§5.2 "live eligible listing") — load FRESH, mọi check ở
  //    action (form giả mạo không giúp gì: nút disabled chỉ là convenience).
  const listingId = String(formData.get("listingId") ?? "");
  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (listing === null) return { error: "LISTING_NOT_FOUND" };
  if (listing.sellerId === user.id) return { error: "DEAL_OWN_LISTING" };
  if (!(DEAL_CREATE_LISTING_STATUSES as readonly string[]).includes(listing.status)) {
    return { error: "LISTING_NOT_DEALABLE" };
  }

  // 4-6. §5.2 creation requirements: Batch 3 REUSE cho actor suspension +
  //      block (Q5 — gọi TRỰC TIẾP, không guard mới), D2 cho seller-side
  //      eligibility, §5.2 cho hội thoại tương ứng (CHỈ buyer tạo — D11:
  //      mọi bước khóa theo user.id = buyer của hội thoại (listing, buyer)).
  //      Typed guard errors → form state; lỗi infra/db rethrow (fail closed).
  let convo: { id: string };
  try {
    await assertCanStartConversation(user.id, listing.sellerId);
    await assertListingSellerInteractable(listing.sellerId);
    // B7 Task 6 (C2 — §7.8 "Deal mutation" beta-membership status; actor LÀ
    // buyer per D11): guard buyer-side chạy SAU D2 seller-side, TRƯỚC
    // requireDealConversation. Typed error → form state qua allowlist trên.
    // markDealOutcomeAction KHÔNG đụng — Batch 6 D10/D2 đã định nghĩa guard
    // của marking (actor suspension + block cho success); ongoing deal
    // participation KHÔNG bị gate trên membership (blocking a member's
    // confirmation would strand the bilateral record).
    await assertBuyerBetaChatAccess(user.id);
    convo = await requireDealConversation(listing.id, user.id);
  } catch (e) {
    if (
      e instanceof Error &&
      (DEAL_CREATE_GUARD_ERROR_CODES as readonly string[]).includes(e.message)
    ) {
      return { error: e.message };
    }
    throw e;
  }

  // 7. Pre-check open deal (D4 — một deal OPEN duy nhất per (listing, buyer)):
  //    race double-create đóng bằng partial unique index (bước 8 classify);
  //    pre-check cho path UX bình thường.
  const existing = await db.orm.public.Deal
    .where({ listingId: listing.id, buyerId: user.id, status: "open" })
    .first();
  if (existing !== null) return { error: "DEAL_ALREADY_OPEN" };

  // 8. MỘT transaction: Deal + DealStatusHistory append (§5.2). Violation
  //    LUÔN throw ra khỏi callback (Global Constraints — KHÔNG BAO GIỜ
  //    catch-and-return trong callback); classify NGOÀI theo constraint name.
  let deal: { id: string };
  try {
    deal = await db.transaction(async (tx) => {
      const d = await tx.orm.public.Deal.create({
        listingId: listing.id,
        conversationId: convo.id, // D9/S11 — không FK, sống qua listing deletion
        buyerId: user.id,
        sellerId: listing.sellerId,
        status: "open",
        agreedPrice,
        fulfillmentMethod,
      });
      // History append-only — typed marker per party, KHÔNG PII (§4.8)
      await tx.orm.public.DealStatusHistory.create({
        dealId: d.id,
        status: "open",
        actorId: user.id,
        note: "buyer:created",
      });
      return d;
    });
  } catch (e) {
    if (
      SqlQueryError.is(e) &&
      e.sqlState === "23505" &&
      e.constraint != null &&
      e.constraint.startsWith("deal_one_open_per_listing_buyer")
    ) {
      // Concurrent double-create — race đã đóng: row của người thắng là row
      // duy nhất được persist (tx của mình đã bị Postgres abort từ khi
      // violation ném ra; KHÔNG retry — D4 không cho phép deal OPEN thứ hai).
      return { error: "DEAL_ALREADY_OPEN" };
    }
    throw e; // fail closed — KHÔNG masquerade lỗi infra thành form error
  }

  // 9. Notify seller (Q6/§4.8 — PII-free): typed title + listing title slice
  //    + link hội thoại; KHÔNG giá, KHÔNG thông tin liên hệ. Best-effort
  //    (corrections #22): notify throw trên lỗi db — wrap + captureError MÃ
  //    CHUỖI (KHÔNG error object — observability-core ghi error.message +
  //    stack, Batch 5 correction #17); deal đã commit thì KHÔNG được biến
  //    thành 500.
  try {
    await notify(
      listing.sellerId,
      "deal",
      "Thỏa thuận mới",
      listing.title.slice(0, 60),
      `/chat/${convo.id}`,
    );
  } catch (notifyError) {
    captureError("deal", "DEAL_NOTIFY_FAILED", {
      sqlState: SqlQueryError.is(notifyError) ? notifyError.sqlState : undefined,
    });
  }

  // 10. Telemetry (S1/Q6 — SAU tx thành công, fail-open): deal_created với
  //     metadata TYPED — dealId + fulfillmentMethod; KHÔNG agreedPrice
  //     (§4.8), KHÔNG free text. sessionId THÔ từ SessionUser — emit core tự
  //     HMAC (corrections #25); KHÔNG wrap try/catch (emit core fail-open).
  await emitProductEvent({
    name: "deal_created",
    actorId: user.id,
    sessionId: user.sessionId,
    conversationId: convo.id,
    listingId: listing.id,
    provinceCode: listing.provinceLevelCode ?? null,
    metadata: { dealId: deal.id, fulfillmentMethod },
  });

  // 11. Refresh trang hội thoại (corrections #14) — DealPanel server-rendered
  //     cần thấy deal mới; CHỈ sau tx (error path ở trên đã return, không
  //     revalidate gì cả).
  revalidatePath(`/chat/${convo.id}`);

  return { success: DEAL_CREATED_MESSAGE };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 5 — markDealOutcomeAction (spec §5.2 Deal outcome, §5.5 block semantics
// D10, §4.8 telemetry privacy, §7.1 "Deal mutation", §7.3 cross-account Deal
// modification, §7.8 actor-side; corrections 2026-10-08 items 12/13/14/22/23/
// 25/26/30).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed error codes của outcome guards — map → form state (fail closed).
 * Lỗi infra/db KHÔNG nằm trong list → rethrow (KHÔNG masquerade thành form
 * error — server action error 500, observability bắt). DEAL_FORBIDDEN dùng
 * CHUNG cho deal thiếu + non-participant (S9 — không existence oracle).
 */
const DEAL_OUTCOME_GUARD_ERROR_CODES = [
  "DEAL_FORBIDDEN", // assertDealParticipant — non-participant (§7.3) + deal thiếu (S9)
  "ACCOUNT_SUSPENDED", // assertDealOutcomeAllowed — actor đình chỉ, chặn MỌI outcome (§7.8)
  "CHAT_BLOCKED", // assertDealOutcomeAllowed — block hai hướng, CHỈ outcome "success" (D10)
] as const;

/**
 * Thông báo thành công — mechanics only, KHÔNG promise language (§4.2/Q9).
 * Noop (re-submit cùng giá trị) cũng dùng thông báo này — trạng thái hiển thị
 * giống hệt marking thành công (idempotent per party, D3).
 */
const DEAL_OUTCOME_RECORDED_MESSAGE = "Đã ghi kết quả thỏa thuận.";

/**
 * Notify label per outcome — TYPED, PII-free (Q6/§4.8): không giá, không
 * thông tin liên hệ, không free text. Khớp label radio của Task 6
 * (DEAL_OUTCOME_LABELS — constants.ts) để copy nhất quán.
 */
const DEAL_OUTCOME_NOTIFY_LABELS: Record<DealOutcome, string> = {
  success: "Thỏa thuận thành công",
  no_deal: "Không đạt thỏa thuận",
  cancelled: "Đã hủy thỏa thuận",
};

/** Kết quả tx — flags drive MỌI emission + notify SAU commit (S1/Q6). */
type DealOutcomeTxResult = {
  /** true = re-submit cùng giá trị — no-op, KHÔNG event/notify/revalidate. */
  noop: boolean;
  /** true = claim open→completed THẮNG (bilateral — §5.2). */
  completedClaimed: boolean;
  /** true = claim Listing approved→sold THẮNG (D6 — seller tick markSold). */
  soldClaimed: boolean;
};

/**
 * Đánh dấu kết quả Deal theo vai của người gọi (D3 — mỗi bên MỘT LẦN, bất kỳ
 * lúc nào; §5.2 "Either party may independently mark outcome").
 *
 * formData: dealId, outcome ("success" | "no_deal" | "cancelled"),
 * cancellationReason? (chỉ "cancelled", ≤ DEAL_CANCELLATION_REASON_MAX),
 * markSold? ("on" — CHỈ có nghĩa khi role === "seller" && outcome ===
 * "success"; default off — D6/FD-3).
 *
 * SEMANTICS (D3 — recorded, reversible):
 *  - "success"    → set outcomeAt của bên gọi. Nếu SAU đó CẢ HAI outcomeAt đã
 *                   set VÀ deal còn "open" → claim open→completed + completedAt
 *                   (bilateral confirmation — §5.2). Deal đã terminal (bên kia
 *                   đã mark no_deal/cancelled) → KHÔNG transition, KHÔNG
 *                   successful_match — mismatch ghi trong history (A1 — không
 *                   tự resolve, Batch 8 register).
 *  - "no_deal"    → set outcomeAt + claim open→no_deal (unilateral).
 *  - "cancelled"  → set outcomeAt + claim open→cancelled + cancellationReason.
 *
 * MARK SOLD (D6/FD-3 — S7): KHÔNG tự động. Chỉ seller + markSold + outcome
 * success → claim Listing approved→sold trong CÙNG tx. Bilateral completion
 * một mình KHÔNG bán listing (sold không thể hoàn tác; một listing có thể
 * giao dịch với nhiều buyer — bán tự động là policy bị chế; lựa chọn tường
 * minh của seller là default an toàn theo FD-3).
 *
 * IDEMPOTENCY (gate item "Deal idempotency"): re-submit CÙNG giá trị → no-op
 * thành công (không history row mới, không event, không notify — note prefix
 * `<role>:<outcome>` CHÍNH XÁC, corrections #23: reason KHÔNG vào note); re-
 * submit KHÁC giá trị → DEAL_ALREADY_MARKED (per-party immutable — đường sửa
 * sai là ops reconciliation A1, không phải self-service).
 *
 * CONCURRENCY (gate item "Deal concurrency"): mọi transition là ATOMIC CLAIM
 * (`.where(...).updateAll(...)` — corrections #12: updateAll trả MẢNG row,
 * `.length`; #13: NULL khớp qua `isNull()`, một branch per role, KHÔNG
 * computed key). Hai tx cùng claim MỘT row Deal → row-lock serialization của
 * Postgres: tx thua thấy status đã đổi → 0 row → KHÔNG transition, KHÔNG
 * event ma. Guarded row (Deal) được RE-READ bên trong tx (Global Constraints
 * #5 — không tin read trước tx cho một claim).
 *
 * Transaction constraint-violation rule (Global Constraints): violation LUÔN
 * throw ra khỏi callback (Postgres abort tx); classify NGOÀI tx. Trong outcome
 * path KHÔNG có 23505 nào được map — mọi lỗi không phải DEAL_ALREADY_MARKED
 * rethrow (fail closed).
 *
 * Emission + notify SAU tx (S1/Q6 — corrections #25): emitProductEvent ghi qua
 * db (KHÔNG qua tx) + fail-open nên MỌI emission/notify chỉ chạy SAU
 * `await db.transaction(...)` resolve — rollback không thể để lại event ma của
 * successful_match/listing_marked_sold/deal_outcome_marked. Metadata TYPED
 * (dealId + outcome + role) — KHÔNG cancellationReason free text, KHÔNG giá
 * (§4.8). successful_match actor = BUYER (corrections #26 — metrics fixture
 * shape; sessionId chỉ khi caller LÀ buyer).
 *
 * D2 perimeter: outcome marking KHÔNG gate theo counterpart eligibility
 * (revocation/membership) — chỉ theo actor suspension/block (§7.8 "relevant"
 * reading; chặn revoked seller xác nhận deal đang mở sẽ stranded bản ghi
 * song phương — A10). Eligibility sống ở creation (createDealAction).
 *
 * KHÔNG ghi audit log bảo mật (D7 — DealStatusHistory là user-action record).
 * KHÔNG revalidatePath trên error path (corrections #14 — chỉ sau commit).
 */
export async function markDealOutcomeAction(
  _prev: DealFormState,
  formData: FormData,
): Promise<DealFormState> {
  // 1. Authorization + rate limit (§7.1 "Deal mutation" — cùng bucket
  //    `deal:mutation:<userId>` với createDealAction). TRƯỚC mọi read/
  //    mutation — không dùng deal mutation để dò trạng thái DB.
  const user = await requireUser();
  const limited = checkRateLimit(`deal:mutation:${user.id}`, DEAL_MUTATION_RATE);
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  // 2. Input validation (D3/D5): outcome ∈ DEAL_OUTCOMES; cancellationReason
  //    chỉ đọc cho "cancelled" (trên no_deal → bỏ qua), ≤ DEAL_CANCELLATION_
  //    REASON_MAX; markSold chỉ là "on" checkbox (ý nghĩa được kiểm lại theo
  //    role + outcome ở bước 5 — buyer submit markSold bị bỏ qua, D6).
  const dealId = String(formData.get("dealId") ?? "").trim();
  const outcomeRaw = String(formData.get("outcome") ?? "").trim();
  if (!(DEAL_OUTCOMES as readonly string[]).includes(outcomeRaw)) {
    return { error: "DEAL_OUTCOME_INVALID" };
  }
  const outcome = outcomeRaw as DealOutcome;

  const reasonTrimmed = String(formData.get("cancellationReason") ?? "").trim();
  let cancellationReason: string | null = null;
  if (outcome === "cancelled" && reasonTrimmed !== "") {
    if (reasonTrimmed.length > DEAL_CANCELLATION_REASON_MAX) {
      return { error: "DEAL_REASON_INVALID" };
    }
    cancellationReason = reasonTrimmed;
  }

  const markSold = formData.get("markSold") === "on";

  // 3. Load deal — thiếu → DEAL_FORBIDDEN (S9 — CÙNG mã với non-participant:
  //    probe dealId không phân biệt tồn tại/không — không existence oracle).
  const deal = await db.orm.public.Deal.first({ id: dealId });
  if (deal === null) return { error: "DEAL_FORBIDDEN" };

  // 4. Participant (§7.3 IDOR — Review Focus 1) + actor guards (§7.8/D10 —
  //    Batch 3 delegation qua Task 2, Q5): suspension chặn MỌI outcome; block
  //    chặn CHỈ "success" — no_deal/cancelled ĐƯỢC PHÉP dưới block (§5.5
  //    "where appropriate" — block không được làm stranded bản ghi kết quả).
  //    Typed guard errors → form state; lỗi infra/db rethrow (fail closed).
  let role: "buyer" | "seller";
  try {
    role = await assertDealParticipant(deal, user.id);
    await assertDealOutcomeAllowed(user.id, role === "buyer" ? deal.sellerId : deal.buyerId, outcome);
  } catch (e) {
    if (
      e instanceof Error &&
      (DEAL_OUTCOME_GUARD_ERROR_CODES as readonly string[]).includes(e.message)
    ) {
      return { error: e.message };
    }
    throw e;
  }
  const counterpartId = role === "buyer" ? deal.sellerId : deal.buyerId;

  // 5. MỘT transaction — mọi transition là ATOMIC CLAIM (D3/D6). Violation/
  //    domain error LUÔN throw ra khỏi callback (Global Constraints — KHÔNG
  //    BAO GIỜ catch-and-return trong callback); classify NGOÀI tx.
  const now = new Date().toISOString();
  let result: DealOutcomeTxResult;
  try {
    result = await db.transaction(async (tx) => {
      // ATOMIC CLAIM per party (corrections #13 — NULL khớp qua isNull(), một
      // branch per role, KHÔNG computed key; #12 — updateAll trả MẢNG row):
      // 1 row → marking mới; 0 row → bên này ĐÃ mark (idempotency bên dưới).
      const claimed =
        role === "buyer"
          ? await tx.orm.public.Deal
              .where({ id: dealId })
              .where((d) => d.buyerOutcomeAt.isNull())
              .updateAll({ buyerOutcomeAt: now })
          : await tx.orm.public.Deal
              .where({ id: dealId })
              .where((d) => d.sellerOutcomeAt.isNull())
              .updateAll({ sellerOutcomeAt: now });
      if (claimed.length === 0) {
        // Bên này ĐÃ mark — idempotency qua DealStatusHistory note prefix
        // CHÍNH XÁC `<role>:<outcome>` (corrections #23: reason KHÔNG vào
        // note nên prefix match không nhiễm). Cùng giá trị → no-op; khác giá
        // trị → fail closed (D3 — per-party immutable).
        const last = await tx.orm.public.DealStatusHistory
          .where({ dealId, actorId: user.id })
          .orderBy([(h) => h.createdAt.desc(), (h) => h.id.desc()])
          .first();
        if (last !== null && last.note !== null && last.note.startsWith(`${role}:${outcome}`)) {
          return { noop: true, completedClaimed: false, soldClaimed: false };
        }
        throw new Error("DEAL_ALREADY_MARKED");
      }

      let completedClaimed = false;
      let soldClaimed = false;
      if (outcome === "success") {
        // Re-read TRONG tx (Global Constraints #5 — guarded row re-read bên
        // trong tx): cả hai outcomeAt đã set (bên kia mark success trước) VÀ
        // deal còn "open" → claim open→completed (bilateral — §5.2).
        const fresh = await tx.orm.public.Deal.first({ id: dealId });
        if (fresh !== null && fresh.buyerOutcomeAt !== null && fresh.sellerOutcomeAt !== null) {
          const completed = await tx.orm.public.Deal
            .where({ id: dealId, status: "open" })
            .updateAll({ status: "completed", completedAt: now });
          completedClaimed = completed.length > 0;
          // 0 row → deal đã terminal bởi bên kia (mismatch) — KHÔNG completed,
          // KHÔNG successful_match — ghi nhận trong history (A1 — không tự resolve).
        }
        // MARK SOLD (D6/FD-3): CHỈ seller + markSold + listing còn approved —
        // trong CÙNG tx. 0 row → listing đã đổi trạng thái — KHÔNG sold, KHÔNG
        // event (claim CAS trên status, KHÔNG read-then-write).
        if (role === "seller" && markSold && deal.listingId !== null) {
          const sold = await tx.orm.public.Listing
            .where({ id: deal.listingId, status: "approved" })
            .updateAll({ status: "sold" });
          soldClaimed = sold.length > 0;
        }
      } else {
        // Unilateral (D3): claim open→no_deal/cancelled + cancellationReason
        // (chỉ cancelled — reason sống Ở Deal row, KHÔNG vào history note/
        // telemetry — corrections #23/§4.8). 0 row → deal đã terminal →
        // marking vẫn được ghi (history), không transition.
        const reason = outcome === "cancelled" ? cancellationReason : null;
        await tx.orm.public.Deal
          .where({ id: dealId, status: "open" })
          .updateAll({ status: outcome, cancellationReason: reason });
      }

      // History append-only — status = trạng thái deal SAU marking (re-read),
      // note = typed marker `<role>:<outcome>` (corrections #23 — KHÔNG PII,
      // KHÔNG reason free text; §4.8).
      const after = await tx.orm.public.Deal.first({ id: dealId });
      if (after === null) throw new Error("DEAL_FORBIDDEN"); // fail closed — không thể (vừa claim row này)
      await tx.orm.public.DealStatusHistory.create({
        dealId,
        status: after.status,
        actorId: user.id,
        note: `${role}:${outcome}`,
      });
      return { noop: false, completedClaimed, soldClaimed };
    });
  } catch (e) {
    // Classify NGOÀI tx (Global Constraints): chỉ domain error đã ghi nhận →
    // form state; mọi lỗi khác (infra/db) rethrow — KHÔNG masquerade.
    if (e instanceof Error && e.message === "DEAL_ALREADY_MARKED") {
      return { error: "DEAL_ALREADY_MARKED" };
    }
    throw e;
  }

  // 6. SAU commit (S1) — mọi emission + notify SAU tx, driven bởi flags tx trả
  //    về. Rollback không thể đến đây (tx throw → catch ở trên → return/throw,
  //    không có flags) → không bao giờ có event ma.
  if (!result.noop) {
    // Notify counterpart (Q6/§4.8 — PII-free): typed title + typed label per
    // outcome + link hội thoại; KHÔNG giá, KHÔNG reason, KHÔNG thông tin liên
    // hệ. Best-effort (corrections #22): notify throw trên lỗi db — wrap +
    // captureError MÃ CHUỖI (KHÔNG error object); marking đã commit thì
    // KHÔNG được biến thành 500.
    try {
      await notify(
        counterpartId,
        "deal",
        "Thỏa thuận có kết quả mới",
        DEAL_OUTCOME_NOTIFY_LABELS[outcome],
        deal.conversationId !== null ? `/chat/${deal.conversationId}` : "/chat",
      );
    } catch (notifyError) {
      captureError("deal", "DEAL_NOTIFY_FAILED", {
        sqlState: SqlQueryError.is(notifyError) ? notifyError.sqlState : undefined,
      });
    }

    // deal_outcome_marked — metadata TYPED { dealId, outcome, role }; KHÔNG
    // cancellationReason free text, KHÔNG giá (§4.8). sessionId THÔ từ
    // SessionUser — emit core tự HMAC (corrections #25); KHÔNG wrap
    // try/catch (emit core fail-open).
    await emitProductEvent({
      name: "deal_outcome_marked",
      actorId: user.id,
      sessionId: user.sessionId,
      conversationId: deal.conversationId,
      listingId: deal.listingId,
      metadata: { dealId, outcome, role },
    });
  }
  if (result.completedClaimed) {
    // successful_match — CHỈ khi claim open→completed THẮNG (bilateral — §5.2;
    // không bao giờ trên mismatch, không bao giờ hai lần — once-per-deal đến từ
    // atomic claim). Corrections #26: actor = BUYER (metrics fixture shape —
    // successfulMatchCount đếm theo buyer); sessionId chỉ khi caller LÀ buyer
    // (session của seller không phải session của buyer).
    await emitProductEvent({
      name: "successful_match",
      actorId: deal.buyerId,
      sessionId: user.id === deal.buyerId ? user.sessionId : null,
      conversationId: deal.conversationId,
      listingId: deal.listingId,
      metadata: { dealId },
    });
  }
  if (result.soldClaimed) {
    // listing_marked_sold — CHỈ khi claim approved→sold THẮNG (D6 — seller
    // tường minh tick markSold; bilateral completion một mình KHÔNG bán).
    await emitProductEvent({
      name: "listing_marked_sold",
      actorId: user.id,
      sessionId: user.sessionId,
      listingId: deal.listingId,
      metadata: { dealId },
    });
  }

  // 7. Refresh trang (corrections #14) — DealPanel server-rendered cần thấy
  //    marking mới; trang listing khi soldClaimed. CHỈ sau tx (mọi error path
  //    ở trên đã return/throw — KHÔNG revalidate gì cả); noop → không state
  //    change → KHÔNG revalidate.
  if (!result.noop && deal.conversationId !== null) {
    revalidatePath(`/chat/${deal.conversationId}`);
  }
  if (result.soldClaimed && deal.listingId !== null) {
    const listing = await db.orm.public.Listing.first({ id: deal.listingId });
    if (listing !== null) revalidatePath(`/listings/${listing.slug}`);
  }

  return { success: DEAL_OUTCOME_RECORDED_MESSAGE };
}
