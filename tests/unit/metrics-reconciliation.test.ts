/**
 * Metric fixture reconciliation (Batch 5 Task 9 — spec §5.8.1) — unit tests.
 *
 * CỔNG reconciliation của batch (Review Focus 5 + Acceptance Gate): mỗi metric
 * được đối chiếu với fixture event array VIẾT TAY — expected value là literal
 * TÍNH TAY trong comment, KHÔNG phải output của engine. Engine thuần
 * (src/lib/metrics.ts — không db, không server-only) tiêu thụ ProductEventRow[]
 * → test trực tiếp, không mock.
 *
 * Quy ước fixture:
 *  - timestamp = ISO string tại BASE + offset PHÚT (at(minute)) — đọc được;
 *  - window là THAM SỐ của engine (A1/A2/A3: giá trị production PENDING trong
 *    registry — fixture dùng window CÓ NHÃN "FIXTURE", không phải policy);
 *  - exclusion internal qua row.isInternal (S-12 — flag tính lúc emit, không
 *    phụ thuộc key ổn định qua rotation);
 *  - blank/malformed query KHÔNG BAO GIỜ xuất hiện trong fixture THEO CẤU TRÚC
 *    (Task 7 không emit cho query malformed) — fixture chỉ chứng minh engine
 *    bỏ qua row không liên quan.
 */
import { describe, expect, it } from "vitest";
import {
  listingToChat,
  medianFirstResponseTime,
  searchResultCtr,
  searchToChat,
  sellerResponseRate,
  successfulMatchCount,
  zeroResultRate,
  type ProductEventRow,
} from "@/src/lib/metrics";

// ─── fixture helpers ───────────────────────────────────────────────────────────

/** Base epoch của fixture — 2026-10-01T00:00:00.000Z. */
const BASE = Date.UTC(2026, 9, 1);

/** ISO timestamp tại BASE + `minutes` phút. */
const at = (minutes: number): string =>
  new Date(BASE + minutes * 60_000).toISOString();

let seq = 0;

/** Row ProductEvent cho fixture — default là "bên ngoài" mọi metric, ghi đè từng field. */
const row = (partial: Partial<ProductEventRow> & { name: string }): ProductEventRow => ({
  id: `e${++seq}`,
  occurredAt: at(0),
  actorPseudonym: null,
  sessionPseudonym: null,
  isInternal: false,
  searchSessionId: null,
  listingId: null,
  conversationId: null,
  provinceCode: null,
  metadata: null,
  ...partial,
});

/** 24h bằng ms — FIXTURE window (A1: giá trị production = PENDING_FOUNDER_DECISION). */
const WINDOW_24H = 24 * 60 * 60_000;
/** 12h bằng ms — FIXTURE response window (A1: giá trị production = PENDING). */
const RESPONSE_WINDOW_12H = 12 * 60 * 60_000;

// ─── zero_result_rate_v1 ────────────────────────────────────────────────────────

describe("zeroResultRate — reconciliation", () => {
  /**
   * Fixture: 6 search_submitted — 3 resultCount 0 (s1 buyer-a, s2 buyer-b,
   * s3 internal-x), 3 có kết quả (s4, s5, s6). Cộng 2 row không liên quan
   * (search_zero_result + listing_viewed) — engine phải bỏ qua.
   *
   * TÍNH TAY (default excludeInternal):
   *   denominator = 5 (s1, s2, s4, s5, s6 — s3 internal bị loại)
   *   numerator   = 2 (s1, s2 — zero-result & không internal)
   *   rate        = 2/5 = 0.4
   */
  const fixture: ProductEventRow[] = [
    row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "s1", occurredAt: at(0), metadata: { resultCount: 0, resultListingIds: [] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-b", searchSessionId: "s2", occurredAt: at(10), metadata: { resultCount: 0, resultListingIds: [] } }),
    row({ name: "search_submitted", actorPseudonym: "internal-x", searchSessionId: "s3", occurredAt: at(20), isInternal: true, metadata: { resultCount: 0, resultListingIds: [] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "s4", occurredAt: at(30), metadata: { resultCount: 5, resultListingIds: ["L1"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-c", searchSessionId: "s5", occurredAt: at(40), metadata: { resultCount: 2, resultListingIds: ["L2"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-b", searchSessionId: "s6", occurredAt: at(50), metadata: { resultCount: 1, resultListingIds: ["L3"] } }),
    // row không phải search_submitted — engine bỏ qua (blank/malformed không bao giờ
    // có trong fixture THEO CẤU TRÚC: không được emit)
    row({ name: "search_zero_result", actorPseudonym: "buyer-a", searchSessionId: "s1", occurredAt: at(1), metadata: { resolvedBrandIds: [], resolvedModelIds: [] } }),
    row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(60), metadata: { ownerView: false, fromSearch: true } }),
  ];

  it("reconciles với expected tính tay { numerator: 2, denominator: 5, rate: 0.4 }", () => {
    expect(zeroResultRate(fixture)).toEqual({
      numerator: 2,
      denominator: 5,
      rate: 0.4,
    });
  });

  it("excludeInternal: false → internal được tính lại (numerator 3, denominator 6, rate 0.5)", () => {
    // TÍNH TAY: bỏ exclusion internal → s3 (zero-result, internal) vào cả hai vế
    expect(zeroResultRate(fixture, { excludeInternal: false })).toEqual({
      numerator: 3,
      denominator: 6,
      rate: 0.5,
    });
  });

  it("fixture rỗng → rate null (không chia cho 0)", () => {
    expect(zeroResultRate([])).toEqual({ numerator: 0, denominator: 0, rate: null });
  });
});

// ─── search_result_ctr_v1 ───────────────────────────────────────────────────────

describe("searchResultCtr — reconciliation", () => {
  /**
   * Fixture: 7 search_submitted — c1..c5 buyer thật có kết quả, c6 internal-x
   * (có kết quả), c7 buyer-f ZERO-result (ngoài denominator theo định nghĩa).
   * Clicks: c1 click HAI LẦN (dedup session-level → 1), c2 một lần, c6 một lần
   * (internal → bị loại), một click với searchSessionId không khớp session nào.
   *
   * TÍNH TAY (default excludeInternal):
   *   denominator = 5 (c1..c5 — có ≥ 1 kết quả hiển thị & không internal;
   *                   c6 internal bị loại, c7 zero-result không có kết quả hiển thị)
   *   numerator   = 2 (c1 — 2 click vẫn là 1 session click; c2)
   *   rate        = 2/5 = 0.4
   */
  const fixture: ProductEventRow[] = [
    row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "c1", occurredAt: at(0), metadata: { resultCount: 5, resultListingIds: ["L1", "L2"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-b", searchSessionId: "c2", occurredAt: at(10), metadata: { resultCount: 3, resultListingIds: ["L3"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-c", searchSessionId: "c3", occurredAt: at(20), metadata: { resultCount: 1, resultListingIds: ["L4"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-d", searchSessionId: "c4", occurredAt: at(30), metadata: { resultCount: 2, resultListingIds: ["L5"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-e", searchSessionId: "c5", occurredAt: at(40), metadata: { resultCount: 4, resultListingIds: ["L6"] } }),
    row({ name: "search_submitted", actorPseudonym: "internal-x", searchSessionId: "c6", occurredAt: at(50), isInternal: true, metadata: { resultCount: 2, resultListingIds: ["L7"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-f", searchSessionId: "c7", occurredAt: at(55), metadata: { resultCount: 0, resultListingIds: [] } }),
    // clicks
    row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "c1", listingId: "L1", occurredAt: at(1) }),
    row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "c1", listingId: "L2", occurredAt: at(2) }),
    row({ name: "search_result_clicked", actorPseudonym: "buyer-b", searchSessionId: "c2", listingId: "L3", occurredAt: at(11) }),
    row({ name: "search_result_clicked", actorPseudonym: "internal-x", searchSessionId: "c6", listingId: "L7", occurredAt: at(51), isInternal: true }),
    // click với searchSessionId không khớp session nào → bỏ qua
    row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "unknown-ss", listingId: "L1", occurredAt: at(3) }),
  ];

  it("reconciles với expected tính tay { numerator: 2, denominator: 5, rate: 0.4 } (double click = 1)", () => {
    expect(searchResultCtr(fixture)).toEqual({
      numerator: 2,
      denominator: 5,
      rate: 0.4,
    });
  });

  it("excludeInternal: false → denominator 6, numerator 3 (click của internal được tính), rate 0.5", () => {
    // TÍNH TAY: c6 (internal) vào denominator; click của c6 vào numerator
    expect(searchResultCtr(fixture, { excludeInternal: false })).toEqual({
      numerator: 3,
      denominator: 6,
      rate: 0.5,
    });
  });

  it("click của actor KHÁC qua ss copy KHÔNG credit session (S-14/Review Focus 7 — actor binding)", () => {
    // Fixture: s1 buyer-a (kết quả L1), s2 buyer-b (kết quả L9). buyer-b mở
    // link ?ss=s1 COPY từ buyer-a → click L1 với searchSessionId s1 (event
    // HỢP LỆ được emit: ss tồn tại + L1 ∈ result set đã ghi — Task 7/8 chỉ
    // chặn ss FABRICATED), rồi buyer-b click kết quả session riêng của mình.
    //
    // TÍNH TAY (default excludeInternal):
    //   denominator = 2 (s1, s2 — đều có ≥ 1 kết quả hiển thị)
    //   numerator   = 1 (CHỈ s2 — click trên s1 là click của buyer-b,
    //   KHÔNG phải click của buyer-a: ss copy không chế tạo CTR cho session
    //   gốc — Review Focus 7, plan L120/L919)
    const copied: ProductEventRow[] = [
      row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "s1", occurredAt: at(0), metadata: { resultCount: 3, resultListingIds: ["L1"] } }),
      row({ name: "search_submitted", actorPseudonym: "buyer-b", searchSessionId: "s2", occurredAt: at(10), metadata: { resultCount: 2, resultListingIds: ["L9"] } }),
      // buyer-b click qua ss COPY của s1 — actor click ≠ actor session
      row({ name: "search_result_clicked", actorPseudonym: "buyer-b", searchSessionId: "s1", listingId: "L1", occurredAt: at(20) }),
      // buyer-b click kết quả session riêng của mình — bound
      row({ name: "search_result_clicked", actorPseudonym: "buyer-b", searchSessionId: "s2", listingId: "L9", occurredAt: at(30) }),
    ];
    expect(searchResultCtr(copied)).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("fixture rỗng → rate null", () => {
    expect(searchResultCtr([])).toEqual({ numerator: 0, denominator: 0, rate: null });
  });
});

// ─── listing_to_chat_v1 (FIXTURE window 24h — có nhãn, không phải policy) ────────

describe("listingToChat — reconciliation (FIXTURE window 24h)", () => {
  /**
   * Fixture (windowMs = 24h = 1440 phút):
   *   views qualified: v1 buyer-a/L1 @0; v2 buyer-b/L2 @0; v3 buyer-b/L2 @60
   *     (dedup với v2 — cùng viewer+listing trong window → 1 unit); v7
   *     buyer-c/L6 @600.
   *   views bị loại: v4 owner (seller-1/L3, ownerView true — D2); v5 internal
   *     (internal-x/L4); v6 anonymous (actorPseudonym null — không join được).
   *   conversations: k1 buyer-a/L1 @120 (TRONG window của v1 → numerator);
   *     k2 buyer-b/L2 @1800 = 30h (NGOÀI window 0h+24h → không); k3 buyer-c/L6
   *     @540 (TRƯỚC view v7 @600 → chain order → không); k4 buyer-d/L7 @0
   *     (conversation KHÔNG có view trước → không vào denominator).
   *
   * TÍNH TAY (default excludeInternal, windowMs = 24h):
   *   denominator = 3 (v1; unit v2+v3 dedup; v7)
   *   numerator   = 1 (v1 ← k1 trong window)
   *   rate        = 1/3
   */
  const fixture: ProductEventRow[] = [
    // qualified views
    row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(0), metadata: { ownerView: false, fromSearch: true } }),
    row({ name: "listing_viewed", actorPseudonym: "buyer-b", listingId: "L2", occurredAt: at(0), metadata: { ownerView: false, fromSearch: false } }),
    row({ name: "listing_viewed", actorPseudonym: "buyer-b", listingId: "L2", occurredAt: at(60), metadata: { ownerView: false, fromSearch: true } }),
    // views bị loại (D2)
    row({ name: "listing_viewed", actorPseudonym: "seller-1", listingId: "L3", occurredAt: at(0), metadata: { ownerView: true, fromSearch: false } }),
    row({ name: "listing_viewed", actorPseudonym: "internal-x", listingId: "L4", occurredAt: at(0), isInternal: true, metadata: { ownerView: false, fromSearch: false } }),
    row({ name: "listing_viewed", actorPseudonym: null, listingId: "L5", occurredAt: at(0), metadata: { ownerView: false, fromSearch: false } }),
    row({ name: "listing_viewed", actorPseudonym: "buyer-c", listingId: "L6", occurredAt: at(600), metadata: { ownerView: false, fromSearch: false } }),
    // conversations
    row({ name: "conversation_started", actorPseudonym: "buyer-a", listingId: "L1", conversationId: "K1", occurredAt: at(120) }),
    row({ name: "conversation_started", actorPseudonym: "buyer-b", listingId: "L2", conversationId: "K2", occurredAt: at(1800) }),
    row({ name: "conversation_started", actorPseudonym: "buyer-c", listingId: "L6", conversationId: "K3", occurredAt: at(540) }),
    row({ name: "conversation_started", actorPseudonym: "buyer-d", listingId: "L7", conversationId: "K4", occurredAt: at(0) }),
  ];

  it("reconciles với expected tính tay { numerator: 1, denominator: 3, rate: 1/3 }", () => {
    expect(listingToChat(fixture, { windowMs: WINDOW_24H })).toEqual({
      numerator: 1,
      denominator: 3,
      rate: 1 / 3,
    });
  });

  it("excludeInternal: false → view internal được tính (denominator 4, numerator 1, rate 1/4)", () => {
    // TÍNH TAY: v5 (internal-x/L4) thành qualified → denominator 4; không có
    // conversation nào của internal-x trên L4 → numerator vẫn 1
    expect(
      listingToChat(fixture, { windowMs: WINDOW_24H, excludeInternal: false }),
    ).toEqual({ numerator: 1, denominator: 4, rate: 1 / 4 });
  });

  it("view lần 2 NGOÀI window trước đó → unit MỚI (dedup theo viewer+listing+window)", () => {
    // TÍNH TAY: buyer-b xem L2 @0 và @1500 (25h — NGOÀI window 24h của lần @0)
    // → 2 unit; k2 @1800 (30h) TRONG window của unit thứ hai (1500+1440=2940)
    // → numerator 1. Fixture chỉ giữ v1, v2, v3', k2:
    const spread: ProductEventRow[] = [
      row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(0), metadata: { ownerView: false, fromSearch: true } }),
      row({ name: "listing_viewed", actorPseudonym: "buyer-b", listingId: "L2", occurredAt: at(0), metadata: { ownerView: false, fromSearch: false } }),
      row({ name: "listing_viewed", actorPseudonym: "buyer-b", listingId: "L2", occurredAt: at(1500), metadata: { ownerView: false, fromSearch: true } }),
      row({ name: "conversation_started", actorPseudonym: "buyer-b", listingId: "L2", conversationId: "K2", occurredAt: at(1800) }),
    ];
    // denominator = 3 (v1; v2 @0; v3' @1500 — unit MỚI vì 1500 > 0 + 1440)
    // numerator   = 1 (unit v3' ← k2 @1800 ≤ 1500 + 1440 = 2940 ✓)
    expect(listingToChat(spread, { windowMs: WINDOW_24H })).toEqual({
      numerator: 1,
      denominator: 3,
      rate: 1 / 3,
    });
  });

  it("revisit TRONG window bị dedup vào unit view đầu — chat SAU window của view ĐẦU KHÔNG tính (b5-review T9 no-change)", () => {
    // TÍNH TAY (windowMs 24h): view @0, revisit @1380 (23h — TRONG window của
    // view đầu → CÙNG unit, dedup), chat @1500 (25h — NGOÀI [0, 1440]) → 0/1.
    //
    // Quyết định ghi nhận (no-change): plan Task 9 Step 4 (L1104) chốt anchor
    // = view GIỮ UNIT (view ĐẦU): "conversationStartedAt >= viewedAt &&
    // <= viewedAt + windowMs" — revisit trong window KHÔNG mở rộng window.
    // Spec §5.8.1 chỉ chốt dedup "viewer + listing + attribution window",
    // KHÔNG chốt anchor (first-view vs last-view) — đọc plan là quyết định
    // reversible: đảo lại cùng A1 khi founder chọn window production.
    const revisit: ProductEventRow[] = [
      row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(0), metadata: { ownerView: false, fromSearch: false } }),
      row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(1380), metadata: { ownerView: false, fromSearch: true } }),
      row({ name: "conversation_started", actorPseudonym: "buyer-a", listingId: "L1", conversationId: "K1", occurredAt: at(1500) }),
    ];
    expect(listingToChat(revisit, { windowMs: WINDOW_24H })).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
  });

  it("unit window CHƯA đóng vẫn vào denominator — KHÔNG as-of (b5-review T9 no-change)", () => {
    // TÍNH TAY (windowMs 24h): view @0 (window [0, 1440] chưa đóng tại thời
    // điểm đánh giá), CHƯA có conversation → denominator 1, numerator 0.
    // Conversation ĐẾ @60 (trong window) → 1/1 — unit "chưa chín" được đếm
    // ở cả hai thời điểm đánh giá, KHÔNG có khái niệm "immature"/as-of.
    //
    // Quyết định no-change (không thêm asOf/maturity cutoff):
    //  - Spec §5.8.1 chỉ chốt "within the attribution window" — KHÔNG có khái
    //    niệm as-of/maturity/censoring nào; thêm cutoff là TỰ CHẾ định nghĩa
    //    metric (spec §4.11 Policy Non-Invention — plan Global Constraints).
    //  - Plan A1 (L1280): GIÁ TRỊ window PENDING_FOUNDER_DECISION — dashboard
    //    (Task 10) render metric này ở trạng thái pending CÓ TÊN, không render
    //    số; "rate understated khi window chưa đóng" không ship trong Batch 5.
    //  - Engine interface pin (plan L1053): opts = { windowMs } & MetricOpts —
    //    KHÔNG asOf. Maturity semantics thuộc founder window decision (A1 —
    //    Batch 8 Founder Decision Register), đảo lại cùng quyết định window.
    const openWindow: ProductEventRow[] = [
      row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(0), metadata: { ownerView: false, fromSearch: false } }),
    ];
    expect(listingToChat(openWindow, { windowMs: WINDOW_24H })).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
    const closedLater: ProductEventRow[] = [
      ...openWindow,
      row({ name: "conversation_started", actorPseudonym: "buyer-a", listingId: "L1", conversationId: "K1", occurredAt: at(60) }),
    ];
    expect(listingToChat(closedLater, { windowMs: WINDOW_24H })).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
  });

  it("fixture rỗng → rate null", () => {
    expect(listingToChat([], { windowMs: WINDOW_24H })).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
  });
});

// ─── search_to_chat_v1 (UNBOUNDED — S-16/D3, không window) ──────────────────────

describe("searchToChat — reconciliation (UNBOUNDED click chain)", () => {
  /**
   * Fixture: 5 search_submitted — ss1 buyer-a, ss2 buyer-b, ss3 buyer-c, ss5
   * buyer-d (KHÔNG có click), ss4 internal-x (bị loại). Clicks: ss1/L1 @60,
   * ss2/L2 @60, ss3/L3 @60. Conversations: k1 buyer-a/L1 @120 (sau click, cùng
   * actor+listing → ss1 numerator ✓); k2 buyer-b/L9 @120 (listing KHÁC kết quả
   * đã click → không); k3 buyer-c/L3 @30 (TRƯỚC click @60 → chain order → không).
   *
   * TÍNH TAY (default excludeInternal):
   *   denominator = 4 (ss1, ss2, ss3, ss5 — mọi session qualified; ss4 internal bị loại)
   *   numerator   = 1 (ss1)
   *   rate        = 1/4
   */
  const fixture: ProductEventRow[] = [
    row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "ss1", occurredAt: at(0), metadata: { resultCount: 5, resultListingIds: ["L1"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-b", searchSessionId: "ss2", occurredAt: at(0), metadata: { resultCount: 3, resultListingIds: ["L2"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-c", searchSessionId: "ss3", occurredAt: at(0), metadata: { resultCount: 2, resultListingIds: ["L3"] } }),
    row({ name: "search_submitted", actorPseudonym: "buyer-d", searchSessionId: "ss5", occurredAt: at(0), metadata: { resultCount: 1, resultListingIds: ["L5"] } }),
    row({ name: "search_submitted", actorPseudonym: "internal-x", searchSessionId: "ss4", occurredAt: at(0), isInternal: true, metadata: { resultCount: 1, resultListingIds: ["L4"] } }),
    // clicks
    row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "ss1", listingId: "L1", occurredAt: at(60) }),
    row({ name: "search_result_clicked", actorPseudonym: "buyer-b", searchSessionId: "ss2", listingId: "L2", occurredAt: at(60) }),
    row({ name: "search_result_clicked", actorPseudonym: "buyer-c", searchSessionId: "ss3", listingId: "L3", occurredAt: at(60) }),
    // conversations
    row({ name: "conversation_started", actorPseudonym: "buyer-a", listingId: "L1", conversationId: "K1", occurredAt: at(120) }),
    row({ name: "conversation_started", actorPseudonym: "buyer-b", listingId: "L9", conversationId: "K2", occurredAt: at(120) }),
    row({ name: "conversation_started", actorPseudonym: "buyer-c", listingId: "L3", conversationId: "K3", occurredAt: at(30) }),
  ];

  it("reconciles với expected tính tay { numerator: 1, denominator: 4, rate: 1/4 } — KHÔNG window", () => {
    expect(searchToChat(fixture)).toEqual({
      numerator: 1,
      denominator: 4,
      rate: 1 / 4,
    });
  });

  it("chain unbounded: conversation NHIỀU NGÀY sau click vẫn tính (S-16 — không time bound)", () => {
    // TÍNH TAY: click @60, conversation cùng actor+listing @60 + 10 NGÀY (14400 phút)
    // → vẫn numerator (unbounded). Fixture 1 session + 1 click + 1 conversation.
    const unbounded: ProductEventRow[] = [
      row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "u1", occurredAt: at(0), metadata: { resultCount: 5, resultListingIds: ["L1"] } }),
      row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "u1", listingId: "L1", occurredAt: at(60) }),
      row({ name: "conversation_started", actorPseudonym: "buyer-a", listingId: "L1", conversationId: "K9", occurredAt: at(14460) }),
    ];
    expect(searchToChat(unbounded)).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
  });

  it("excludeInternal: false → denominator 5 (ss4 vào), numerator vẫn 1, rate 0.2", () => {
    // TÍNH TAY: ss4 (internal) vào denominator; ss4 không có click → numerator 1
    expect(searchToChat(fixture, { excludeInternal: false })).toEqual({
      numerator: 1,
      denominator: 5,
      rate: 0.2,
    });
  });

  it("multi-credit per-session (D3): MỘT conversation credit MỌI session đã click cùng listing (b5-review T9 no-change)", () => {
    // TÍNH TAY: buyer-a refine 3 lần (D1 — mỗi lần submit = session mới
    // ss1..ss3), click L ở cả 3, rồi MỘT conversation (buyer-a/L, sau click)
    // → MỌI session đều có "click L → conversation cùng actor+listing" →
    // numerator 3, denominator 3, rate 1.
    //
    // Quyết định ghi nhận (no-change): D3 (plan L1294) đếm THEO SESSION —
    // "a search session counts when a search_result_clicked on listing L is
    // followed by a conversation_started for the same actor on the same
    // listing" — KHÔNG single-attribution (một conversation chỉ credit session
    // click cuối). Spec §5.8.1 numerator session-centric ("qualified search
    // sessions that eventually produce a new buyer↔seller conversation
    // through a clicked result"). Đọc D3 là quyết định reversible — đảo lại
    // khi founder yêu cầu last-touch attribution.
    const multi: ProductEventRow[] = [
      row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "ss1", occurredAt: at(0), metadata: { resultCount: 3, resultListingIds: ["L1"] } }),
      row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "ss2", occurredAt: at(10), metadata: { resultCount: 2, resultListingIds: ["L1"] } }),
      row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "ss3", occurredAt: at(20), metadata: { resultCount: 1, resultListingIds: ["L1"] } }),
      row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "ss1", listingId: "L1", occurredAt: at(60) }),
      row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "ss2", listingId: "L1", occurredAt: at(70) }),
      row({ name: "search_result_clicked", actorPseudonym: "buyer-a", searchSessionId: "ss3", listingId: "L1", occurredAt: at(80) }),
      row({ name: "conversation_started", actorPseudonym: "buyer-a", listingId: "L1", conversationId: "K1", occurredAt: at(120) }),
    ];
    expect(searchToChat(multi)).toEqual({ numerator: 3, denominator: 3, rate: 1 });
  });

  it("click của actor KHÁC qua ss copy KHÔNG credit session — kể cả khi chính người click chat (S-14/Review Focus 7)", () => {
    // Fixture: ss1 buyer-a (kết quả L1). buyer-b mở link ?ss=ss1 copy, click
    // L1 (event HỢP LỆ: ss tồn tại + L1 ∈ result set), rồi buyer-b start
    // conversation trên L1. buyer-a KHÔNG bao giờ click/chat — session của
    // buyer-a không được credit.
    //
    // TÍNH TAY (default excludeInternal):
    //   denominator = 1 (ss1)
    //   numerator   = 0 — click trên ss1 là click của buyer-b (≠ actor
    //   session buyer-a): chain session→click phải CÙNG ACTOR (Review Focus
    //   7 — ss copy không chế tạo conversion cho session gốc, plan L120/L919)
    const copied: ProductEventRow[] = [
      row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "ss1", occurredAt: at(0), metadata: { resultCount: 3, resultListingIds: ["L1"] } }),
      row({ name: "search_result_clicked", actorPseudonym: "buyer-b", searchSessionId: "ss1", listingId: "L1", occurredAt: at(60) }),
      row({ name: "conversation_started", actorPseudonym: "buyer-b", listingId: "L1", conversationId: "K1", occurredAt: at(120) }),
    ];
    expect(searchToChat(copied)).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });

  it("fixture rỗng → rate null", () => {
    expect(searchToChat([])).toEqual({ numerator: 0, denominator: 0, rate: null });
  });
});

// ─── seller_response_rate_v1 (FIXTURE response window 12h) ──────────────────────

describe("sellerResponseRate — reconciliation (FIXTURE response window 12h)", () => {
  /**
   * Fixture (responseWindowMs = 12h = 720 phút): 4 conversation_buyer_first_message
   * (anchor D4 — eligibility theo cấu trúc): C1 buyer-a, C2 buyer-b, C3
   * internal-x (bị loại), C4 buyer-c. Responses: C1 @120 (2h ≤ 12h → numerator);
   * C2 @1200 (20h > 12h → ngoài window); C3 @60 (C3 bị loại theo anchor); C4
   * không có response → denominator only.
   *
   * TÍNH TAY (default excludeInternal):
   *   denominator = 3 (C1, C2, C4 — C3 internal buyer bị loại)
   *   numerator   = 1 (C1)
   *   rate        = 1/3
   */
  const fixture: ProductEventRow[] = [
    row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "C1", listingId: "L1", occurredAt: at(0) }),
    row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-b", conversationId: "C2", listingId: "L2", occurredAt: at(0) }),
    row({ name: "conversation_buyer_first_message", actorPseudonym: "internal-x", conversationId: "C3", listingId: "L3", occurredAt: at(0), isInternal: true }),
    row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-c", conversationId: "C4", listingId: "L4", occurredAt: at(0) }),
    // responses (actor = seller — KHÔNG exclude theo internal seller, S-18)
    row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "C1", listingId: "L1", occurredAt: at(120), metadata: { responseMs: 7_200_000 } }),
    row({ name: "message_first_response", actorPseudonym: "seller-2", conversationId: "C2", listingId: "L2", occurredAt: at(1200), metadata: { responseMs: 72_000_000 } }),
    row({ name: "message_first_response", actorPseudonym: "seller-3", conversationId: "C3", listingId: "L3", occurredAt: at(60), metadata: { responseMs: 3_600_000 } }),
  ];

  it("reconciles với expected tính tay { numerator: 1, denominator: 3, rate: 1/3 }", () => {
    expect(sellerResponseRate(fixture, { responseWindowMs: RESPONSE_WINDOW_12H })).toEqual({
      numerator: 1,
      denominator: 3,
      rate: 1 / 3,
    });
  });

  it("excludeInternal: false → denominator 4, numerator 2 (C3 được tính lại), rate 0.5", () => {
    // TÍNH TAY: C3 vào denominator; response C3 @60 ≤ 720 → numerator 2
    expect(
      sellerResponseRate(fixture, {
        responseWindowMs: RESPONSE_WINDOW_12H,
        excludeInternal: false,
      }),
    ).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
  });

  it("hai response cho cùng conversation → vẫn 1 numerator (dedup theo conversationId)", () => {
    // TÍNH TAY: C1 có 2 response (@120 và @300) → vẫn numerator 1; denominator 1
    const doubleResponse: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "C1", listingId: "L1", occurredAt: at(0) }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "C1", listingId: "L1", occurredAt: at(120), metadata: { responseMs: 7_200_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "C1", listingId: "L1", occurredAt: at(300), metadata: { responseMs: 18_000_000 } }),
    ];
    expect(
      sellerResponseRate(doubleResponse, { responseWindowMs: RESPONSE_WINDOW_12H }),
    ).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it("anchor window CHƯA đóng vẫn vào denominator — KHÔNG as-of (b5-review T9 no-change)", () => {
    // TÍNH TAY (responseWindowMs 12h): anchor @0, CHƯA có response → 0/1.
    // Response @60 (1h — trong window) → 1/1. Tại thời điểm đánh giá giữa
    // hai sự kiện, conversation này được đếm là "chưa được trả lời" dù
    // seller chưa có đủ window để trả lời — bias đã biết, ghi nhận no-change.
    //
    // Quyết định no-change (không thêm asOf/maturity cutoff):
    //  - Spec §5.8.1 chỉ chốt "within the defined response window" — không
    //    as-of/maturity; cutoff là định nghĩa metric MỚI → spec §4.11 Policy
    //    Non-Invention (plan Global Constraints).
    //  - Plan A1 (L1280): GIÁ TRỊ response window PENDING_FOUNDER_DECISION —
    //    dashboard (Task 10) render pending CÓ TÊN, không ship số understated.
    //  - Engine interface pin (plan L1064): opts = { responseWindowMs } &
    //    MetricOpts — KHÔNG asOf. Maturity semantics thuộc founder window
    //    decision (A1 — Batch 8 Founder Decision Register).
    const openWindow: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "C1", listingId: "L1", occurredAt: at(0) }),
    ];
    expect(
      sellerResponseRate(openWindow, { responseWindowMs: RESPONSE_WINDOW_12H }),
    ).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    const responded: ProductEventRow[] = [
      ...openWindow,
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "C1", listingId: "L1", occurredAt: at(60), metadata: { responseMs: 3_600_000 } }),
    ];
    expect(
      sellerResponseRate(responded, { responseWindowMs: RESPONSE_WINDOW_12H }),
    ).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it("fixture rỗng → rate null", () => {
    expect(sellerResponseRate([], { responseWindowMs: RESPONSE_WINDOW_12H })).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
  });
});

// ─── median_first_response_time_v1 (S-18 — fully specified, ship thật) ───────────

describe("medianFirstResponseTime — reconciliation", () => {
  it("fixture LẺ → median = giá trị giữa (sample 3)", () => {
    // TÍNH TAY: responseMs [3_600_000, 60_000, 600_000] → sort [60_000, 600_000,
    // 3_600_000] → lẻ → median = 600_000 (giữa). Sample 3.
    const odd: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "M1", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-b", conversationId: "M2", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-c", conversationId: "M3", occurredAt: at(0) }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "M1", occurredAt: at(1), metadata: { responseMs: 3_600_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-2", conversationId: "M2", occurredAt: at(1), metadata: { responseMs: 60_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-3", conversationId: "M3", occurredAt: at(1), metadata: { responseMs: 600_000 } }),
    ];
    expect(medianFirstResponseTime(odd)).toEqual({ medianMs: 600_000, sample: 3 });
  });

  it("fixture CHẴN → median = trung bình 2 giá trị giữa (quy ước ghi trong test)", () => {
    // QUY ƯỚC (chẵn): median = mean của 2 giá trị giữa.
    // TÍNH TAY: [60_000, 120_000, 600_000, 1_800_000] → sort giữ nguyên →
    // median = (120_000 + 600_000) / 2 = 360_000. Sample 4.
    const even: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "E1", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-b", conversationId: "E2", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-c", conversationId: "E3", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-d", conversationId: "E4", occurredAt: at(0) }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "E1", occurredAt: at(1), metadata: { responseMs: 60_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-2", conversationId: "E2", occurredAt: at(1), metadata: { responseMs: 1_800_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-3", conversationId: "E3", occurredAt: at(1), metadata: { responseMs: 120_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-4", conversationId: "E4", occurredAt: at(1), metadata: { responseMs: 600_000 } }),
    ];
    expect(medianFirstResponseTime(even)).toEqual({ medianMs: 360_000, sample: 4 });
  });

  it("hai message_first_response cho cùng conversationId → dedup về MỘT (giữ occurredAt sớm nhất)", () => {
    // TÍNH TAY: D1 có 2 response row (@120 responseMs 600_000; @300 responseMs
    // 900_000 — backfill/đếm đôi) → dedup giữ row sớm nhất → đóng góp 600_000.
    // Sample 1, median 600_000.
    const dedup: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "D1", occurredAt: at(0) }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "D1", occurredAt: at(300), metadata: { responseMs: 900_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "D1", occurredAt: at(120), metadata: { responseMs: 600_000 } }),
    ];
    expect(medianFirstResponseTime(dedup)).toEqual({ medianMs: 600_000, sample: 1 });
  });

  it("conversation của buyer INTERNAL bị loại qua join anchor (internal SELLER thì KHÔNG — S-18)", () => {
    // TÍNH TAY: I1 (buyer-a thường) response 60_000 → giữ; I2 (buyer internal-x)
    // response 120_000 → loại qua conversation_buyer_first_message.isInternal.
    // Seller-2 của I2 cũng internal nhưng KHÔNG phải lý do loại. Sample 1, median 60_000.
    const internalBuyer: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "I1", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "internal-x", conversationId: "I2", occurredAt: at(0), isInternal: true }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "I1", occurredAt: at(1), metadata: { responseMs: 60_000 } }),
      row({ name: "message_first_response", actorPseudonym: "internal-seller", conversationId: "I2", occurredAt: at(1), isInternal: true, metadata: { responseMs: 120_000 } }),
    ];
    expect(medianFirstResponseTime(internalBuyer)).toEqual({
      medianMs: 60_000,
      sample: 1,
    });
    // excludeInternal: false → I2 được tính lại → sample 2, median = (60_000+120_000)/2 = 90_000
    expect(medianFirstResponseTime(internalBuyer, { excludeInternal: false })).toEqual({
      medianMs: 90_000,
      sample: 2,
    });
  });

  it("response KHÔNG có anchor (buyer-first-message) → bị loại — không xác định được eligibility (fail-closed)", () => {
    // TÍNH TAY: response cho "NO-ANCHOR" không có conversation_buyer_first_message
    // → không thể xác định buyer qualified → loại. Sample 1 (chỉ M1), median 60_000.
    const noAnchor: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "M1", occurredAt: at(0) }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "M1", occurredAt: at(1), metadata: { responseMs: 60_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-9", conversationId: "NO-ANCHOR", occurredAt: at(1), metadata: { responseMs: 5_000 } }),
    ];
    expect(medianFirstResponseTime(noAnchor)).toEqual({ medianMs: 60_000, sample: 1 });
  });

  it("response với metadata thiếu responseMs (không phải số) → bị loại khỏi sample", () => {
    // TÍNH TAY: M1 đóng góp 60_000; M2 response row metadata null → không đóng
    // góp duration được → loại. Sample 1, median 60_000.
    const noResponseMs: ProductEventRow[] = [
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-a", conversationId: "M1", occurredAt: at(0) }),
      row({ name: "conversation_buyer_first_message", actorPseudonym: "buyer-b", conversationId: "M2", occurredAt: at(0) }),
      row({ name: "message_first_response", actorPseudonym: "seller-1", conversationId: "M1", occurredAt: at(1), metadata: { responseMs: 60_000 } }),
      row({ name: "message_first_response", actorPseudonym: "seller-2", conversationId: "M2", occurredAt: at(1), metadata: null }),
    ];
    expect(medianFirstResponseTime(noResponseMs)).toEqual({ medianMs: 60_000, sample: 1 });
  });

  it("fixture rỗng → { medianMs: null, sample: 0 }", () => {
    expect(medianFirstResponseTime([])).toEqual({ medianMs: null, sample: 0 });
  });
});

// ─── successful_match_rate_v1 — chỉ COUNT (rate bị chặn bởi A2 + Deal Batch 6) ───

describe("successfulMatchCount — reconciliation (rate PENDING — A2)", () => {
  /**
   * Fixture: 3 successful_match (2 buyer thật + 1 internal-x) + 2 row không
   * liên quan.
   *
   * TÍNH TAY (default excludeInternal): count = 2. excludeInternal: false → 3.
   */
  const fixture: ProductEventRow[] = [
    row({ name: "successful_match", actorPseudonym: "buyer-a", conversationId: "C1", listingId: "L1", occurredAt: at(0) }),
    row({ name: "successful_match", actorPseudonym: "buyer-b", conversationId: "C2", listingId: "L2", occurredAt: at(10) }),
    row({ name: "successful_match", actorPseudonym: "internal-x", conversationId: "C3", listingId: "L3", occurredAt: at(20), isInternal: true }),
    row({ name: "search_submitted", actorPseudonym: "buyer-a", searchSessionId: "s1", occurredAt: at(30), metadata: { resultCount: 0, resultListingIds: [] } }),
    row({ name: "listing_viewed", actorPseudonym: "buyer-a", listingId: "L1", occurredAt: at(40), metadata: { ownerView: false, fromSearch: false } }),
  ];

  it("đếm event successful_match (default: loại internal) → 2", () => {
    expect(successfulMatchCount(fixture)).toBe(2);
  });

  it("excludeInternal: false → 3", () => {
    expect(successfulMatchCount(fixture, { excludeInternal: false })).toBe(3);
  });

  it("fixture rỗng → 0 (honest zero — emission thuộc Deal của Batch 6)", () => {
    expect(successfulMatchCount([])).toBe(0);
  });
});
