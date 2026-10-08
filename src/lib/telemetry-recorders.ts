import "server-only";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { captureError } from "@/src/lib/observability";
import { actorPseudonymFor, emitProductEvent, productEventKeyAvailable } from "@/src/lib/product-events";
import type { ReportReasonCode, ReportTargetType } from "@/src/lib/moderation-vocab";

/**
 * Funnel event recorders (Batch 5 Task 8 — S7/S-22) — module server THUẦN
 * (`import "server-only"`, KHÔNG BAO GIỜ "use server" — S-13): mọi emission
 * logic sống Ở ĐÂY, page/action/route chỉ gọi recorder với dữ liệu đã có sẵn
 * trong request context (không query lại những gì caller đã đọc — corrections
 * #15: getCurrentUser().sessionId là SessionUser, KHÔNG lookup session lần hai).
 *
 * Fail-open TOÀN PHẦN (correction #9): telemetry KHÔNG phải ranh giới sản phẩm —
 * MỌI lỗi trong recorder (db read validate, throttle, emit) được bắt và log
 * chỉ mang event name + sqlState (KHÔNG value/payload — correction #17), product
 * flow tiếp tục. Fail-closed cho ROW (validation/PII) sống trong emit core
 * (src/lib/product-events.ts) — recorder không lặp lại logic đó.
 *
 * Emits NGOÀI mọi db.transaction (corrections #7): caller chỉ gọi recorder SAU
 * khi `await db.transaction(...)` resolve — KHÔNG BAO GIỜ trong callback (Postgres
 * abort tx khi violation; emit trong callback = row có thể bị rollback im lặng).
 *
 * Pseudonym (S-10/S-11 + b5-review T6): caller truyền sessionId THÔ
 * (UserSession.id) trong `viewer.sessionId` / `sessionId` — emit core HMAC MỘT
 * lần; recorder KHÔNG BAO GIỜ nhận pseudonym đã tính sẵn (HMAC kép phá join
 * search→click→chat của Task 9/10).
 */

// ─── Shared shapes ─────────────────────────────────────────────────────────────

/** Listing scalars mà recorder cần — caller truyền từ row đã đọc. */
export type TelemetryListingRef = {
  id: string;
  provinceLevelCode: string | null;
};

/** Viewer của request — id + sessionId THÔ (emit core tự pseudonymize — S-10). */
export type TelemetryViewer = {
  id: string | null;
  /** UserSession.id THÔ — KHÔNG pseudonym precomputed (b5-review T6). */
  sessionId: string | null;
} | null;

/** JsonValue → Record | null (metadata ProductEvent là Json — narrowing an toàn). */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Log lỗi recorder — CHỈ event name + sqlState, KHÔNG BAO GIỀ value (correction #17). */
function recorderFailure(name: string, e: unknown): void {
  captureError("telemetry", "TELEMETRY_RECORDER_FAILED", {
    name,
    sqlState: SqlQueryError.is(e) ? e.sqlState : undefined,
  });
}

// ─── listing_viewed (S-12/S-8/S-15) ────────────────────────────────────────────

/** Throttle view (S-15): 1 view / viewer / listing / 10 phút — anti-inflation. */
export const LISTING_VIEW_THROTTLE = { limit: 1, windowMs: 10 * 60_000 } as const;

/**
 * Ghi listing_viewed — analytics source of truth cho view (Listing.viewCount
 * chỉ là counter hiển thị — Legacy Migration Decisions, không đọc bởi metrics).
 *
 *  - S-12: CHỈ listing approved (draft/hidden/pending/removed/sold KHÔNG vào
 *    analytics — moderator/owner xem tin non-public không phải demand thật).
 *  - S-8: prefetch KHÔNG phải view thật → skip (header best-effort — Proxy strip
 *    internal Flight headers, corrections #14; deterministic anti-double-count
 *    là prefetch={false} trên link kết quả của Task 7).
 *  - S-15: throttle per (viewer, listing) — exceeded → skip emission (view vẫn
 *    render; residual inflation risk recorded dưới A4 — KHÔNG phải bot rule).
 */
export async function recordListingView(input: {
  listing: { id: string; slug: string; status: string; sellerId: string; provinceLevelCode: string | null };
  viewer: TelemetryViewer;
  isPrefetch: boolean;
  /** View đến từ link kết quả tìm kiếm (?ss= của Task 7) — flag của schema. */
  fromSearch: boolean;
}): Promise<void> {
  try {
    if (input.listing.status !== "approved") return; // S-12
    if (input.isPrefetch) return; // S-8
    const ownerView = input.viewer?.id === input.listing.sellerId;
    const viewerKey = input.viewer?.id ?? input.viewer?.sessionId ?? "anonymous";
    const limited = checkRateLimit(
      `listing-view:${viewerKey}:${input.listing.id}`,
      LISTING_VIEW_THROTTLE,
    );
    if (!limited.allowed) return; // S-15 — skip emission, view vẫn render
    await emitProductEvent({
      name: "listing_viewed",
      actorId: input.viewer?.id ?? null,
      sessionId: input.viewer?.sessionId ?? null,
      listingId: input.listing.id,
      provinceCode: input.listing.provinceLevelCode,
      metadata: { ownerView, fromSearch: input.fromSearch },
    });
  } catch (e) {
    recorderFailure("listing_viewed", e);
  }
}

// ─── search_result_clicked (S-14 — Review Focus 7) ───────────────────────────

/**
 * Ghi search_result_clicked sau khi validate ss binding (S-14):
 *  1. ss phải khớp MỘT row search_submitted ĐÃ GHI (Task 7 emit khi search chạy)
 *     — ss lạ/forge → KHÔNG event;
 *  2. listing được click phải nằm trong resultListingIds ĐÃ GHI của chính search
 *     đó — click listing ngoài result set → KHÔNG event (ss copy/chia sẻ không
 *     chế tạo được CTR — Review Focus 7).
 *
 * Actor được emit đầy đủ (b5-review Task 9): engine bind click actor ↔ session
 * actor LÚC ĐẾM — ss copy của người khác không credit session gốc kể cả khi
 * listing nằm trong result set.
 *
 * @returns true khi event được emit; false khi validate chặn (không event).
 */
export async function recordSearchResultClick(input: {
  ss: string | null;
  listing: TelemetryListingRef;
  viewer: TelemetryViewer;
}): Promise<boolean> {
  try {
    const ss = input.ss === "" ? null : input.ss;
    if (ss === null) return false; // không có ss → không phải click từ search
    const searchEvent = await db.orm.public.ProductEvent.first({
      name: "search_submitted",
      searchSessionId: ss,
    });
    if (searchEvent === null) return false; // ss không khớp search nào — forge
    const metadata = asRecord(searchEvent.metadata);
    const resultListingIds: unknown = metadata?.["resultListingIds"];
    if (!Array.isArray(resultListingIds) || !resultListingIds.includes(input.listing.id)) {
      return false; // listing ngoài result set đã ghi — click không hợp lệ
    }
    await emitProductEvent({
      name: "search_result_clicked",
      actorId: input.viewer?.id ?? null,
      sessionId: input.viewer?.sessionId ?? null,
      searchSessionId: ss,
      listingId: input.listing.id,
      provinceCode: input.listing.provinceLevelCode,
    });
    return true;
  } catch (e) {
    recorderFailure("search_result_clicked", e);
    return false;
  }
}

// ─── conversation_started (S5/S7) ─────────────────────────────────────────────

/**
 * Ghi conversation_started — CHỈ gọi từ path tạo conversation MỚI của
 * startConversationAction (branch redirect vào convo cũ KHÔNG gọi), SAU MỌI
 * guard Batch 3 (block/suspension) + status approved + Conversation.create
 * thành công (S5), TRƯỚC redirect() (corrections #15 — KHÔNG trong catch nuốt
 * NEXT_REDIRECT). Actor = buyer (người bắt đầu hội thoại).
 */
export async function recordConversationStarted(input: {
  convo: { id: string; listingId: string | null };
  listing: { provinceLevelCode: string | null } | null;
  buyerId: string;
  /** Session id THÔ của buyer — emit core tự pseudonymize (S-10). */
  sessionId: string | null;
}): Promise<void> {
  try {
    await emitProductEvent({
      name: "conversation_started",
      actorId: input.buyerId,
      sessionId: input.sessionId,
      conversationId: input.convo.id,
      listingId: input.convo.listingId,
      provinceCode: input.listing?.provinceLevelCode ?? null,
    });
  } catch (e) {
    recorderFailure("conversation_started", e);
  }
}

// ─── conversation_buyer_first_message (D4 eligibility signal) ─────────────────

/**
 * Ghi conversation_buyer_first_message — tín hiệu cơ học D4: buyer gửi tin
 * ĐẦU TIÊN của mình trong convo (caller đã đếm 0 tin buyer trước đó). occurredAt
 * của event = lúc emit ≈ createdAt của tin (cùng request) — anchor cho
 * seller_response_rate_v1 / median_first_response_time_v1. Actor = buyer.
 * firstBuyerMessageAt giữ trong interface cho đối xứng với recordFirstResponse
 * (D4 anchor) — occurredAt của event đã mang mốc thời gian này.
 */
export async function recordBuyerFirstMessage(input: {
  convo: { id: string; listingId: string | null };
  buyerId: string;
  firstBuyerMessageAt: string;
}): Promise<void> {
  void input.firstBuyerMessageAt; // occurredAt của event = mốc này (cùng request)
  try {
    await emitProductEvent({
      name: "conversation_buyer_first_message",
      actorId: input.buyerId,
      conversationId: input.convo.id,
      listingId: input.convo.listingId,
    });
  } catch (e) {
    recorderFailure("conversation_buyer_first_message", e);
  }
}

// ─── message_first_response (D4 anchor) ──────────────────────────────────────

/**
 * Ghi message_first_response — seller trả lời ĐẦU TIÊN sau ≥1 tin buyer
 * (caller đã đếm: ≥1 tin buyer trước đó + 0 tin seller trước đó). responseMs
 * tính từ tin buyer ĐẦU (D4 anchor) đến tin seller này — KHÔNG phải từ
 * conversation_started. Actor = seller.
 */
export async function recordFirstResponse(input: {
  convo: { id: string; listingId: string | null };
  sellerId: string;
  firstBuyerMessageAt: string;
  sellerRepliedAt: string;
}): Promise<void> {
  try {
    const responseMs = Math.max(
      0,
      Date.parse(input.sellerRepliedAt) - Date.parse(input.firstBuyerMessageAt),
    );
    await emitProductEvent({
      name: "message_first_response",
      actorId: input.sellerId,
      conversationId: input.convo.id,
      listingId: input.convo.listingId,
      metadata: { responseMs },
    });
  } catch (e) {
    recorderFailure("message_first_response", e);
  }
}

// ─── listing_rejected / listing_removed (S7 — actor = admin) ───────────────────

/** Ghi listing_rejected — sau khi rejectListingAction update thành công. Lý do từ chối là FREE TEXT — KHÔNG BAO GIỀ vào telemetry. */
export async function recordListingRejected(input: {
  actorId: string;
  sessionId: string | null;
  listingId: string;
}): Promise<void> {
  try {
    await emitProductEvent({
      name: "listing_rejected",
      actorId: input.actorId,
      sessionId: input.sessionId,
      listingId: input.listingId,
    });
  } catch (e) {
    recorderFailure("listing_rejected", e);
  }
}

/** Ghi listing_removed — sau khi takeDownListingAction updateAll thành công (non-zero rows), NGOÀI tx (corrections #7). */
export async function recordListingRemoved(input: {
  actorId: string;
  sessionId: string | null;
  listingId: string;
}): Promise<void> {
  try {
    await emitProductEvent({
      name: "listing_removed",
      actorId: input.actorId,
      sessionId: input.sessionId,
      listingId: input.listingId,
    });
  } catch (e) {
    recorderFailure("listing_removed", e);
  }
}

// ─── seller_first_listing_published (S-19 re-fire guard) ─────────────────────

/**
 * Ghi seller_first_listing_published — SAU checkListingPublication pass +
 * update approve thành công (S5 — caller chỉ gọi ở điểm đó). S-19 re-fire guard:
 * event-existence check theo actorPseudonym của seller — ProductEvent append-only
 * nên check này chính xác "lần approve ĐẦU" (approve tin thứ hai của cùng seller
 * KHÔNG emit lại). Actor = seller được kích hoạt (KHÔNG phải admin duyệt) —
 * dashboard seller_activation đếm distinct actorPseudonym (Task 10).
 */
export async function recordSellerFirstListingPublished(input: {
  sellerId: string;
  listingId: string;
}): Promise<void> {
  try {
    // Key gate TRƯỚC khi tính pseudonym (b5-review fix 2 — correction #9):
    // S-19 existence filter cần actorPseudonymFor(sellerId) — THÔNG QN key;
    // thiếu/sai key NGOÀI production phải là no-op SILENT (KHÔNG captureError
    // mỗi lần duyệt thành công ở dev/CI/integration), Ở production log
    // TELEMETRY_KEY_UNAVAILABLE đúng như emit core — MỘT nguồn semantics
    // (productEventKeyAvailable — emit core bước 4 cũng chạy qua đây).
    if (!productEventKeyAvailable("seller_first_listing_published")) return;
    const existing = await db.orm.public.ProductEvent.first({
      name: "seller_first_listing_published",
      actorPseudonym: actorPseudonymFor(input.sellerId),
    });
    if (existing !== null) return; // S-19 — đã có event cho seller này
    await emitProductEvent({
      name: "seller_first_listing_published",
      actorId: input.sellerId,
      listingId: input.listingId,
    });
  } catch (e) {
    recorderFailure("seller_first_listing_published", e);
  }
}

// ─── report_submitted (S7 — corrections #6 typed metadata) ─────────────────────

/**
 * Ghi report_submitted — sau khi report transaction thành công (caller đã
 * compute result ONCE — corrections #7). Metadata CHỈ targetType/reasonCode
 * TYPED (moderation-vocab): KHÔNG note text, KHÔNG targetId trong metadata
 * (raw user id là PII khi targetType="user" — corrections #6); đích LISTING đi
 * cột typed listingId, đích user/message KHÔNG lưu id. Actor = reporter.
 */
export async function recordReportSubmitted(input: {
  reporterId: string;
  sessionId: string | null;
  targetType: ReportTargetType;
  targetId: string;
  reasonCode: ReportReasonCode;
}): Promise<void> {
  try {
    await emitProductEvent({
      name: "report_submitted",
      actorId: input.reporterId,
      sessionId: input.sessionId,
      // corrections #6: CHỈ đích listing có id trong row (cột typed); user/message → null
      listingId: input.targetType === "listing" ? input.targetId : null,
      metadata: { targetType: input.targetType, reasonCode: input.reasonCode },
    });
  } catch (e) {
    recorderFailure("report_submitted", e);
  }
}

// ─── seller_verified / beta_membership_activated (S7 — actor = người được kích hoạt) ──

/** Ghi seller_verified — khi reviewSellerVerificationAction quyết verified, SAU atomic claim thành công (NGOÀI tx — corrections #7). Actor = seller được xác minh. */
export async function recordSellerVerified(input: { sellerId: string }): Promise<void> {
  try {
    await emitProductEvent({
      name: "seller_verified",
      actorId: input.sellerId,
    });
  } catch (e) {
    recorderFailure("seller_verified", e);
  }
}

/**
 * Ghi beta_membership_activated — khi setBetaMembershipAction chuyển status
 * sang "active" (caller derive wasActive từ existing?.status TRƯỚC upsert —
 * corrections #15: action không atomic, duplicate events của hai grant chạy
 * đồng thời được TOLERATE — không dedup nặng). Actor = member được kích hoạt.
 */
export async function recordBetaMembershipActivated(input: { memberId: string }): Promise<void> {
  try {
    await emitProductEvent({
      name: "beta_membership_activated",
      actorId: input.memberId,
    });
  } catch (e) {
    recorderFailure("beta_membership_activated", e);
  }
}
