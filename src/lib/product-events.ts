import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@prisma/orm-postgres/target/codec-types";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { captureError } from "@/src/lib/observability";
import {
  PRODUCT_EVENT_KEY_INVALID,
  PRODUCT_EVENT_KEY_UNCONFIGURED,
  getProductEventPseudonymKey,
  productEventPseudonymKeyInfo,
  productEventPseudonymKeyVersion,
} from "@/src/lib/product-event-key";
import { REPORT_REASON_CODES, REPORT_TARGET_TYPES } from "@/src/lib/moderation-vocab";

/**
 * Product telemetry — taxonomy + emit core (Batch 5 Task 6 — spec §5.8/§4.8).
 *
 * Domain RIÊNG với audit log bảo mật của Batch 2 (S10): ProductEvent là
 * analytics first-party, append-only, KHÔNG FK (event sống qua vòng đời
 * listing/conversation/model), KHÔNG bao giờ ghi audit log bảo mật từ đây
 * và ngược lại — product-code path không update/delete ProductEvent
 * (retention là A6).
 *
 * Posture fail-open/fail-closed (Global Constraints):
 *  - FAIL-CLOSED (validation): sai schema / PII shape trong free string →
 *    KHÔNG row, log chỉ mang event name + rule — KHÔNG BAO GIỜ value/payload
 *    (correction #17: captureError in error.message + stack nên chỉ sqlState
 *    / issue codes được log, không bao giờ error gốc).
 *  - FAIL-OPEN (infrastructure): lỗi db (insert, isInternalActor) / key →
 *    product flow TIẾP TỤC, KHÔNG bao giờ throw ra caller (telemetry không
 *    phải ranh giới sản phẩm). Key chưa cấu hình NGOÀI production = silent
 *    no-op không captureError (correction #9 — dev/test không set key là
 *    bình thường); Ở production env validation đã exit sớm khi start nên
 *    nhánh đó chỉ là belt-and-suspenders.
 *
 * Pseudonym (S-10/S-11): actor/session lưu DUY NHẤT HMAC-SHA256(id, HKDF(
 * PRODUCT_EVENT_PSEUDONYM_KEY, info)) hex — KHÔNG bao giờ id thô (session id
 * thô join thẳng về userId qua UserSession). Key DÀNH RIÊNG, không derive từ
 * AUTH_SECRET (rotate AUTH_SECRET không phá join) — src/lib/product-event-key.ts.
 * Pseudonymity là defense-in-depth, KHÔNG phải anonymity: ổn định per user per
 * key version → events linkable được khi có key + bảng user; erasure user
 * đòi recompute dưới key version mới (A6). Mỗi row ghi pseudonymKeyVersion.
 *
 * `import "server-only"`, KHÔNG BAO GIỜ "use server" (S-13): đây là module
 * server thuần (hằng số + hàm), import được bởi page/action/route — không
 * expose server action. Pinned bởi tests/unit/product-events.test.ts.
 */

export const PRODUCT_EVENT_SCHEMA_VERSION = "1";

/**
 * 19 event của spec §5.8 (12 initial + 7 beta-operations) + 1 event tín hiệu
 * cơ học `conversation_buyer_first_message` — do contract
 * seller_response_rate_v1 yêu cầu eligibility "≥1 buyer message" (D4) và
 * anchor "first buyer message"; flagged cho founder, schema-versioned.
 */
export type ProductEventName =
  | "search_submitted"
  | "search_zero_result"
  | "search_result_clicked"
  | "listing_viewed"
  | "conversation_started"
  | "conversation_buyer_first_message"
  | "message_first_response"
  | "deal_created"
  | "deal_outcome_marked"
  | "successful_match"
  | "listing_marked_sold"
  | "report_submitted"
  | "user_returned"
  | "seller_invited"
  | "seller_registered"
  | "seller_verified"
  | "seller_first_listing_published"
  | "listing_rejected"
  | "listing_removed"
  | "beta_membership_activated";

/** Taxonomy đóng — registry trong code, KHÔNG phải enum DB (Task 1). */
export const PRODUCT_EVENT_NAMES = [
  "search_submitted",
  "search_zero_result",
  "search_result_clicked",
  "listing_viewed",
  "conversation_started",
  "conversation_buyer_first_message",
  "message_first_response",
  "deal_created",
  "deal_outcome_marked",
  "successful_match",
  "listing_marked_sold",
  "report_submitted",
  "user_returned",
  "seller_invited",
  "seller_registered",
  "seller_verified",
  "seller_first_listing_published",
  "listing_rejected",
  "listing_removed",
  "beta_membership_activated",
] as const satisfies readonly ProductEventName[];

// ─── Giá trị enum đóng (S-9 — KHÔNG free string cho thứ có vocabulary) ──────

/** Sort của search — Task 7 thêm "relevance" (ranking textual-first, spec §5.7). */
const SEARCH_SORT_VALUES = [
  "newest",
  "price_asc",
  "price_desc",
  "popular",
  "relevance",
] as const;

/** product_condition của contract (src/prisma/contract.prisma) — enum đóng. */
const CONDITION_VALUES = [
  "new",
  "open_box",
  "like_new",
  "excellent",
  "good",
  "fair",
  "refurbished",
  "for_parts",
] as const;

// ─── Per-event metadata schemas (zod .strict() — struct đóng, S-9/B8) ────────
//
// KHÔNG schema nào có field free-text/query-text (Review Focus 1 — pinned bởi
// test structural): query box là free text nên event chỉ lưu structured ids
// (brand/model/category đã validate, result counts, filter facets typed).
// Field id là z.uuid(), enum là z.enum() — MIỄN NHIỄM PII shape scan (B8);
// CHỈ categorySlug/brandSlug là free string (slug đã validate against row đã
// load ở caller — Task 7 S-9) và được scan shape ở emit.

/**
 * Per-event zod schemas — mọi emission (Batch 5 Task 7/8, Batch 6/7 sau này)
 * validate qua đây; schema tồn tại trước để batch sau KHÔNG emit payload chưa
 * validate (S7 forward seams: deal_created + deal_outcome_marked +
 * successful_match + listing_marked_sold → Batch 6; seller_invited +
 * seller_registered → Batch 7; user_returned → A3).
 */
export const EVENT_SCHEMAS: Record<ProductEventName, z.ZodType> = {
  // resultListingIds: tập kết quả đã ghi cho click attribution (S-14 —
  // search_result_clicked validate listing ∈ result set của search session).
  // KHÔNG query text; province buyer chọn đi cột typed provinceCode.
  search_submitted: z.strictObject({
    resultCount: z.number().int().min(0),
    resultListingIds: z.array(z.uuid()).max(60),
    categorySlug: z.string().min(1).nullish(), // CHỈ khi khớp Category row đã load (S-9)
    brandSlug: z.string().min(1).nullish(), // CHỈ khi khớp Brand row đã load (S-9)
    conditionFilter: z.enum(CONDITION_VALUES).nullish(),
    priceMin: z.number().int().nullish(),
    priceMax: z.number().int().nullish(),
    sort: z.enum(SEARCH_SORT_VALUES).nullish(),
  }),
  // Demand-interest record (spec §5.7.1): brand/model canonical ĐƯỢC TÌM,
  // không bao giờ raw text.
  search_zero_result: z.strictObject({
    resolvedBrandIds: z.array(z.uuid()),
    resolvedModelIds: z.array(z.uuid()),
  }),
  // Cột typed searchSessionId + listingId mang tất cả (S-14).
  search_result_clicked: z.strictObject({}),
  listing_viewed: z.strictObject({
    ownerView: z.boolean(),
    fromSearch: z.boolean(),
  }),
  // Cột: conversationId, listingId; actor = buyer.
  conversation_started: z.strictObject({}),
  // D4 — tín hiệu cơ học: buyer gửi tin ĐẦU TIÊN của mình trong convo.
  // Cột: conversationId, listingId; actor = buyer.
  conversation_buyer_first_message: z.strictObject({}),
  // Cột: conversationId, listingId; actor = seller; anchor = first buyer message (D4).
  message_first_response: z.strictObject({
    responseMs: z.number().int().min(0),
  }),
  // Forward seams Batch 6 (Deal) — schema trước, emission thuộc batch đó (S7).
  deal_created: z.strictObject({}),
  deal_outcome_marked: z.strictObject({}),
  successful_match: z.strictObject({}),
  listing_marked_sold: z.strictObject({}),
  // Corrections #6: concrete schema khớp Task 8 — targetType/reasonCode là
  // typed codes (moderation-vocab, spec §5.5 verbatim), KHÔNG note text.
  // PII rule: KHÔNG bao giờ targetId trong metadata (raw user id khi
  // targetType="user" là PII) — đích listing đi cột typed listingId, đích
  // user/message KHÔNG lưu id.
  report_submitted: z.strictObject({
    targetType: z.enum(REPORT_TARGET_TYPES),
    reasonCode: z.enum(REPORT_REASON_CODES),
  }),
  user_returned: z.strictObject({}), // emission blocked A3 (return window chưa định nghĩa)
  seller_invited: z.strictObject({}), // Batch 7
  seller_registered: z.strictObject({}), // Batch 7
  seller_verified: z.strictObject({}), // Batch 2 review action — Task 8 wire (S7)
  seller_first_listing_published: z.strictObject({}), // Batch 4 approve — Task 8 wire (S7)
  listing_rejected: z.strictObject({}), // rejectListingAction — lý do là FREE TEXT, KHÔNG vào telemetry
  listing_removed: z.strictObject({}), // takeDownListingAction — Task 8 wire (S7)
  beta_membership_activated: z.strictObject({}), // setBetaMembershipAction — Task 8 wire (S7)
};

// ─── Pseudonym (S-10/S-11) ────────────────────────────────────────────────────

const ACTOR_INFO = "product-event-actor";
const SESSION_INFO = "product-event-session";

/** Pseudonym actor — HMAC-SHA256(userId, HKDF(key, "product-event-actor")) hex. */
export function actorPseudonymFor(userId: string): string {
  return createHmac("sha256", productEventPseudonymKeyInfo(ACTOR_INFO))
    .update(userId, "utf8")
    .digest("hex");
}

/** Pseudonym session — HMAC-SHA256(sessionId, HKDF(key, "product-event-session")) hex (S-10). */
export function sessionPseudonymFor(sessionId: string): string {
  return createHmac("sha256", productEventPseudonymKeyInfo(SESSION_INFO))
    .update(sessionId, "utf8")
    .digest("hex");
}

/**
 * internal = BetaCohortMembership(internal, active) ∪ User.adminRole != null —
 * tính LÚC emit (S-12): exclusion theo flag trên row, KHÔNG phụ thuộc pseudonym
 * ổn định qua key rotation.
 */
export async function isInternalActor(userId: string): Promise<boolean> {
  const membership = await db.orm.public.BetaCohortMembership.first({
    userId,
    cohort: "internal",
    status: "active",
  });
  if (membership !== null) return true;
  const user = await db.orm.public.User.first({ id: userId });
  return user !== null && user.adminRole !== null;
}

// ─── PII guard (B8 — spec §4.8) ──────────────────────────────────────────────

/**
 * Key denylist — exact/word match, KHÔNG substring (nit: "ip" KHÔNG khớp
 * "shipping"/"membership"). Key nằm trong denylist → reject bất kể value:
 * key tên note/body/message/query/text/email/phone/ip/address là mùi
 * free-text/PII trong telemetry — schema strict đã chặn key lạ, denylist là
 * defense-in-depth cho schema tương lai vô tình khai field đó.
 */
export const METADATA_KEY_DENYLIST = [
  "email",
  "phone",
  "otp",
  "password",
  "secret",
  "token",
  "ip",
  "address",
  "note",
  "body",
  "message",
  "query",
  "text",
  "name",
] as const;

/** Match denylist entry theo exact/word — trả entry khớp hoặc null. */
export function denylistedMetadataKey(key: string): string | null {
  for (const entry of METADATA_KEY_DENYLIST) {
    // entry là literal alnum lowercase — escape an toàn; ranh giới = đầu/cuối
    // chuỗi hoặc ký tự KHÔNG phải [A-Za-z0-9] (không substring).
    if (new RegExp(`(^|[^A-Za-z0-9])${entry}([^A-Za-z0-9]|$)`, "i").test(key)) {
      return entry;
    }
  }
  return null;
}

/** Có khớp denylist không — tiện thể cho test + caller khác. */
export function isDenylistedMetadataKey(key: string): boolean {
  return denylistedMetadataKey(key) !== null;
}

// Shape regexes — fail-closed: match = reject, KHÔNG log value.
const EMAIL_SHAPE_RE = /[^\s@]+@[^\s@]+\.[^\s@]/;
const PHONE_SHAPE_RE = /(\+84|0)\d{9,10}/;
const OTP_SHAPE_RE = /(^|\D)\d{6}(\D|$)/;
const IPV4_SHAPE_RE = /(\d{1,3}\.){3}\d{1,3}/;
// IPv6: dạng đầy đủ 8 group HOẶC dạng nén "::" — KHÔNG match loosely kiểu
// "12:30:45" (2 dấu hai chấm) để tránh false-positive trên giá trị giờ.
const IPV6_SHAPE_RE = /::|(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7})/;
/** Free string trong metadata tối đa 120 ký tự (parity isMalformedQuery). */
const FREE_STRING_MAX = 120;

type PiiShapeRule =
  | "email_shape"
  | "phone_shape"
  | "otp_shape"
  | "ip_shape"
  | "overlength";

function detectPiiShape(value: string): PiiShapeRule | null {
  if (value.length > FREE_STRING_MAX) return "overlength";
  if (EMAIL_SHAPE_RE.test(value)) return "email_shape";
  if (PHONE_SHAPE_RE.test(value)) return "phone_shape";
  if (OTP_SHAPE_RE.test(value)) return "otp_shape";
  if (IPV4_SHAPE_RE.test(value) || IPV6_SHAPE_RE.test(value)) return "ip_shape";
  return null;
}

// zod introspection (v4): unwrap optional/nullable/default về terminal schema,
// đọc def.type/def.format — field TYPED (uuid/enum/number/boolean/array/literal)
// miễn nhiễm scan (B8: 6 chữ số liên tục trong uuid hợp lệ KHÔNG bị từ chối);
// z.string() thường (không format uuid) là free string → scan.
type ZodDefLike = {
  _zod?: {
    def?: {
      type?: string;
      format?: string;
      innerType?: unknown;
    };
  };
};

function terminalSchemaOf(field: unknown): unknown {
  let s = field as ZodDefLike | undefined | null;
  while (
    s?._zod?.def &&
    (s._zod.def.type === "optional" ||
      s._zod.def.type === "nullable" ||
      s._zod.def.type === "default")
  ) {
    s = s._zod.def.innerType as ZodDefLike | undefined;
  }
  return s;
}

/**
 * Field có bị scan shape không? Key NGOÀI schema → scan (không có type nào
  bảo vệ nó); field đã zod TYPED → miễn nhiễm (B8); z.string() thường → scan.
 * Introspect không được → scan (fail-closed).
 */
function isScannableStringField(schema: z.ZodType, key: string): boolean {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  const field = shape?.[key];
  if (field === undefined) return true; // key ngoài schema — schema sẽ reject sau
  const terminal = terminalSchemaOf(field) as ZodDefLike | undefined | null;
  const def = terminal?._zod?.def;
  if (def === undefined) return true; // không introspect được → fail-closed scan
  if (def.type !== "string") return false; // enum/number/boolean/array/literal → typed
  if (def.format === "uuid") return false; // z.uuid() → typed id (B8)
  return true; // z.string() thường (kể cả format email/url — đều đáng scan)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── Emit core ────────────────────────────────────────────────────────────────

export type ProductEventInput = {
  name: ProductEventName;
  /** Raw user id — emit core tự pseudonymize, KHÔNG lưu id thô (S-10). */
  actorId?: string | null;
  /**
   * UserSession.id THÔ (getCurrentUser().sessionId — corrections #15) — emit
   * core TỰ pseudonymize thành sessionPseudonym (S-10). Emitters (Tasks 7/8)
   * LUÔN truyền session id thô trong field này, KHÔNG BAO GIỜ pseudonym đã
   * tính sẵn (sessionPseudonymFor): HMAC kép (HMAC(HMAC(id))) cho cùng một
   * session HAI giá trị sessionPseudonym khác nhau qua các loại event và phá
   * join search→click→chat của Task 9/10 (b5-review T6 — plan Task 7/8 gọi
   * field caller-side là "sessionPseudonym"; emit input CHỈ có sessionId).
   */
  sessionId?: string | null;
  searchSessionId?: string | null;
  listingId?: string | null;
  productModelId?: string | null;
  conversationId?: string | null;
  /** Mã tỉnh canonical — coarse location (spec §4.8), không bao giờ địa chỉ chi tiết. */
  provinceCode?: string | null;
  /** Allowlisted theo event schema (zod strict) — KHÔNG PII, KHÔNG query text thô. */
  metadata?: Record<string, unknown>;
};

const nonEmpty = (v: string | null | undefined): string | null =>
  v === undefined || v === null || v === "" ? null : v;

/**
 * Emit MỘT product event. Thứ tự:
 *  1. name ∈ taxonomy? (không → SCHEMA_REJECTED, không row)
 *  2. PII guard trên metadata thô: key denylist (word match) → PII_REJECTED;
 *     value shape scan (email/phone/OTP/IP/overlength) CHỈ trên field KHÔNG
 *     được zod typed (B8) → PII_REJECTED — KHÔNG row, KHÔNG value trong log
 *  3. zod schema strict → SCHEMA_REJECTED (issue codes only — correction #17)
 *  4. key load → fail-open (ngoài production: silent no-op — correction #9)
 *  5. pseudonym + isInternal (fail-open, flag degrade false + log)
 *  6. insert (fail-open — db error → sqlState log, product flow tiếp tục)
 */
export async function emitProductEvent(input: ProductEventInput): Promise<void> {
  const schema: z.ZodType | undefined = EVENT_SCHEMAS[input.name];
  if (schema === undefined) {
    captureError("telemetry", "TELEMETRY_SCHEMA_REJECTED", {
      name: input.name,
      rule: "unknown_event",
    });
    return;
  }

  // 2. PII guard TRƯỚC schema validation — fail-closed, KHÔNG row, KHÔNG value.
  const metadata = input.metadata;
  if (isPlainObject(metadata)) {
    for (const key of Object.keys(metadata)) {
      const denied = denylistedMetadataKey(key);
      if (denied !== null) {
        captureError("telemetry", "TELEMETRY_PII_REJECTED", {
          name: input.name,
          rule: `denylisted_key:${denied}`,
        });
        return;
      }
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== "string") continue;
      if (!isScannableStringField(schema, key)) continue; // typed → miễn nhiễm (B8)
      const shape = detectPiiShape(value);
      if (shape !== null) {
        captureError("telemetry", "TELEMETRY_PII_REJECTED", {
          name: input.name,
          rule: shape,
        });
        return;
      }
    }
  }

  // 3. zod strict — sai schema → KHÔNG row. Log CHỈ issue codes (correction
  //    #17): KHÔNG path (chứa tên key caller gửi), KHÔNG message, KHÔNG input.
  const parsed = schema.safeParse(metadata ?? {});
  if (!parsed.success) {
    captureError("telemetry", "TELEMETRY_SCHEMA_REJECTED", {
      name: input.name,
      rules: parsed.error.issues.map((issue) => issue.code),
    });
    return;
  }

  // 4. Key dedicated — fail-open cho flow, fail-closed cho row (KHÔNG thể
  //    pseudonymize mà không có key → KHÔNG BAO GIỜ ghi id thô thay thế).
  try {
    getProductEventPseudonymKey(); // validate + warm cache per process
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const code = message.startsWith(PRODUCT_EVENT_KEY_UNCONFIGURED)
      ? PRODUCT_EVENT_KEY_UNCONFIGURED
      : PRODUCT_EVENT_KEY_INVALID;
    if (process.env.NODE_ENV === "production") {
      // production: env validation đã exit sớm khi start — nhánh này là
      // belt-and-suspenders; ngoài production: silent no-op (correction #9).
      captureError("telemetry", "TELEMETRY_KEY_UNAVAILABLE", {
        name: input.name,
        code,
      });
    }
    return;
  }

  // 5. Pseudonym + internal flag (S-10/S-12).
  const actorId = nonEmpty(input.actorId);
  const sessionId = nonEmpty(input.sessionId);
  const actorPseudonym = actorId === null ? null : actorPseudonymFor(actorId);
  const sessionPseudonym = sessionId === null ? null : sessionPseudonymFor(sessionId);

  let isInternal = false;
  if (actorId !== null) {
    try {
      isInternal = await isInternalActor(actorId);
    } catch (e) {
      // fail-open: flag degrade về false (default cột) + log sqlState — event
      // vẫn ghi (append-only analytics), exclusion có thể thiếu chính xác trong
      // cửa sổ lỗi ngắn; KHÔNG phá product flow.
      captureError("telemetry", "TELEMETRY_INTERNAL_LOOKUP_FAILED", {
        name: input.name,
        sqlState: SqlQueryError.is(e) ? e.sqlState : undefined,
      });
    }
  }

  // 6. Insert — append-only, KHÔNG FK, KHÔNG bao giờ update/delete từ code path.
  try {
    await db.orm.public.ProductEvent.create({
      name: input.name,
      schemaVersion: PRODUCT_EVENT_SCHEMA_VERSION,
      occurredAt: new Date().toISOString(),
      actorPseudonym,
      sessionPseudonym,
      pseudonymKeyVersion: productEventPseudonymKeyVersion(),
      isInternal,
      searchSessionId: nonEmpty(input.searchSessionId),
      listingId: nonEmpty(input.listingId),
      productModelId: nonEmpty(input.productModelId),
      conversationId: nonEmpty(input.conversationId),
      provinceCode: nonEmpty(input.provinceCode),
      metadata: (metadata === undefined ? null : parsed.data) as JsonValue,
    });
  } catch (e) {
    // fail-open: KHÔNG rethrow (telemetry không phá flow); KHÔNG log error gốc
    // (message db có thể chứa payload) — chỉ sqlState (correction #17).
    captureError("telemetry", "TELEMETRY_EMIT_FAILED", {
      name: input.name,
      sqlState: SqlQueryError.is(e) ? e.sqlState : undefined,
    });
  }
}

/**
 * Pseudonym của member ACTIVE của cohort — cho dashboard segmentation
 * (Task 10: event có actorPseudonym ∈ set → thuộc cohort). KHÔNG phải
 * exclusion — exclusion dùng row.isInternal (S-12). Fail-open: lỗi đọc → []
 * + log (dashboard không vỡ vì telemetry).
 */
export async function cohortPseudonyms(
  cohort: "internal" | "founding_seller" | "private_beta_buyer",
): Promise<string[]> {
  try {
    const rows = await db.orm.public.BetaCohortMembership.where({
      cohort,
      status: "active",
    }).all();
    return rows.map((row) => actorPseudonymFor(row.userId));
  } catch (e) {
    captureError("telemetry", "TELEMETRY_COHORT_READ_FAILED", {
      sqlState: SqlQueryError.is(e) ? e.sqlState : undefined,
    });
    return [];
  }
}
