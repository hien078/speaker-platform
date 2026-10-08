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
  DEAL_CREATE_LISTING_STATUSES,
  DEAL_FULFILLMENT_METHODS,
  DEAL_MUTATION_RATE,
  assertListingSellerInteractable,
  requireDealConversation,
  type DealFulfillmentMethod,
} from "@/src/lib/deal";
import { emitProductEvent } from "@/src/lib/product-events";
import { notify } from "@/src/lib/notify";
import { captureError } from "@/src/lib/observability";

/**
 * Deal actions (Batch 6 Task 4 — spec §5.2 lightweight Deal, §7.1 "Deal
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
