/**
 * Metric contract registry (Batch 5 Task 9 — spec §5.8.1) — module THUẦN.
 *
 * Mọi metric dùng để RA QUYẾT ĐỊNH yêu cầu contract có version (spec §5.8.1).
 * Registry này ghi ĐÚNG struct của spec:
 *
 *   MetricContract
 *     name / version / definition / numerator / denominator
 *     deduplicationKey / attributionWindow
 *     inclusionRules / exclusionRules / botInternalTrafficRules
 *     supportedSegments / owner
 *
 * Nguyên tắc trung thực (spec §4.11 Policy Non-Invention + FD-3):
 *  - KHÔNG TỰ CHẾ giá trị window/attribution — 4 contract phụ thuộc window
 *    (A1/A2/A3) mang sentinel `PENDING_FOUNDER_DECISION`; dashboard (Task 10)
 *    render chúng ở trạng thái pending CÓ TÊN, không bao giờ render con số tự chế.
 *    Founder-authored items là launch blocker trong Batch 8 Founder Decision
 *    Register — không block batch (FD-3 proceed fail-closed).
 *  - `search_to_chat_v1` KHÔNG pending: "eventually" của spec là unbounded —
 *    ship click-chain không time bound (S-16/D3, reversible bằng cách thêm
 *    window khi A1 được quyết).
 *  - 3 contract fully-specified (zero_result_rate_v1, search_result_ctr_v1,
 *    median_first_response_time_v1) ship semantics cụ thể, nguyên văn spec.
 *  - bot rules: chưa có tín hiệu bot nào được định nghĩa (A4) — mọi contract
 *    ghi "no bot signal defined — nothing excluded".
 *
 * PLAIN MODULE (FD-1 precedent — Batch 2 admin-roles.ts): KHÔNG import db,
 * KHÔNG "server-only" — dashboard (Task 10) và mọi tooling import trực tiếp.
 * Định nghĩa tiếng Việt trong ghi chú; định nghĩa metric giữ NGUYÊN VĂN tiếng
 * Anh của spec để đối chiếu được.
 */

/** Sentinel cho giá trị phụ thuộc founder decision (A1/A2/A3) — KHÔNG tự chế. */
export const PENDING_FOUNDER_DECISION = "PENDING_FOUNDER_DECISION" as const;

/** 4 segment spec §5.8.2 cho phép hỗ trợ (cohort / market / category / brand-model). */
export type MetricSegment =
  | "beta_cohort"
  | "primary_secondary_market"
  | "category"
  | "brand_model";

/** Struct spec §5.8.1 — mọi field bắt buộc, không field nào optional. */
export type MetricContract = {
  /** Tên metric + version, vd "zero_result_rate_v1". */
  name: string;
  /** "v1" — bump khi semantics đổi (contract mới, không sửa silently). */
  version: string;
  /** Định nghĩa — nguyên văn spec (tiếng Anh) + ghi chú tiếng Việt. */
  definition: string;
  numerator: string;
  denominator: string;
  deduplicationKey: string;
  /** Giá trị cụ thể, "unbounded_click_chain" (S-16), hoặc PENDING_FOUNDER_DECISION (A1). */
  attributionWindow: string;
  inclusionRules: readonly string[];
  exclusionRules: readonly string[];
  /** A4: chưa có tín hiệu bot — không exclude gì. */
  botInternalTrafficRules: string;
  supportedSegments: readonly MetricSegment[];
  /** spec §5.8.1 — owner của contract là founder. */
  owner: string;
};

/** 8 metric của spec §5.8.1 — không cái thứ 9, không thiếu (test pin). */
export type MetricName =
  | "zero_result_rate_v1"
  | "search_result_ctr_v1"
  | "listing_to_chat_v1"
  | "search_to_chat_v1"
  | "seller_response_rate_v1"
  | "median_first_response_time_v1"
  | "successful_match_rate_v1"
  | "repeat_user_rate_v1";

/** A4 — ghi chung cho mọi contract: chưa có bot signal, không exclude gì. */
const BOT_RULES =
  "no bot signal defined — nothing excluded (A4; residual inflation recorded)";

/** 4 segment — mọi metric ở đây tính được trên từng segment (dashboard Task 10). */
const ALL_SEGMENTS: readonly MetricSegment[] = [
  "beta_cohort",
  "primary_secondary_market",
  "category",
  "brand_model",
];

/**
 * Registry — đúng 8 contract spec §5.8.1. Numerator/denominator NGUYÊN VĂN
 * tiếng Anh của spec; phần phụ thuộc founder ghi PENDING_FOUNDER_DECISION.
 */
export const METRIC_CONTRACTS: Record<MetricName, MetricContract> = {
  // ─── zero_result_rate_v1 — fully specified (window per-session) ──────────────
  zero_result_rate_v1: {
    name: "zero_result_rate_v1",
    version: "v1",
    definition:
      "Valid search sessions producing zero eligible results over all valid submitted search sessions. " +
      "Tỉ lệ session search hợp lệ không trả về kết quả phù hợp — spec §5.8.1.",
    numerator: "valid search sessions producing zero eligible results",
    denominator: "all valid submitted search sessions",
    deduplicationKey:
      "search_session_id — mỗi search_submitted emit đúng MỘT session (D1: mỗi render search có query hợp lệ = 1 searchSessionId mới)",
    attributionWindow: "per_search_session",
    inclusionRules: [
      "một search session = MỘT event search_submitted đã emit (D1 — query blank/malformed KHÔNG BAO GIỜ được emit nên không bao giờ vào denominator theo cấu trúc)",
      "số kết quả đọc từ metadata.resultCount của chính row search_submitted (đếm lúc submit)",
    ],
    exclusionRules: [
      "blank query",
      "malformed query",
      "test/internal users where configured",
      "known automated traffic",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── search_result_ctr_v1 — fully specified (window per-session) ─────────────
  search_result_ctr_v1: {
    name: "search_result_ctr_v1",
    version: "v1",
    definition:
      "Eligible search sessions with at least one result click over eligible search sessions with at least one displayed result. " +
      "CTR session-level — click gộp theo session, spec §5.8.1.",
    numerator: "eligible search sessions with at least one result click",
    denominator: "eligible search sessions with at least one displayed result",
    deduplicationKey:
      "search_session_id — dedup SESSION-level: click 2 kết quả của cùng session vẫn là 1 session click",
    attributionWindow: "per_search_session",
    inclusionRules: [
      "eligible search session = search_submitted đã emit với metadata.resultCount > 0 (có ≥ 1 kết quả hiển thị)",
      "session được tính là clicked khi có ≥ 1 row search_result_clicked join theo searchSessionId (S-14: click chỉ emit khi listing nằm trong result set đã ghi)",
    ],
    exclusionRules: [
      "test/internal users where configured",
      "known automated traffic",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── listing_to_chat_v1 — window PENDING (A1) ───────────────────────────────
  listing_to_chat_v1: {
    name: "listing_to_chat_v1",
    version: "v1",
    definition:
      "Qualified unique listing views that generate a new buyer↔seller conversation within the attribution window, over qualified unique listing views. " +
      "View listing đủ điều kiện dẫn đến conversation mới — spec §5.8.1.",
    numerator:
      "qualified unique listing views that generate a new buyer↔seller conversation within the attribution window",
    denominator: "qualified unique listing views",
    deduplicationKey: "viewer + listing + attribution window",
    attributionWindow: PENDING_FOUNDER_DECISION,
    inclusionRules: [
      "qualified listing view (D2) = đã xác thực (actorPseudonym != null) + không internal + không phải owner view (metadata.ownerView)",
      "conversation mới = event conversation_started đã emit (chỉ emit khi tạo conversation MỚI — Task 8)",
      "engine nhận windowMs THAM SỐ — giá trị production PENDING (A1); fixture test dùng window CÓ NHÃN",
    ],
    exclusionRules: [
      "test/internal users where configured",
      "known automated traffic",
      "owner views — seller xem listing của chính mình (D2)",
      "anonymous views — không có actorPseudonym để join conversation (D2)",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── search_to_chat_v1 — UNBOUNDED click chain (S-16/D3) — KHÔNG pending ─────
  search_to_chat_v1: {
    name: "search_to_chat_v1",
    version: "v1",
    definition:
      "Qualified search sessions that eventually produce a new buyer↔seller conversation through a clicked result, over qualified search sessions. " +
      "\"Eventually\" của spec là UNBOUNDED — ship click-chain không time bound (S-16/D3), reversible bằng cách thêm window khi A1 được quyết.",
    numerator:
      "qualified search sessions that eventually produce a new buyer↔seller conversation through a clicked result",
    denominator: "qualified search sessions",
    deduplicationKey:
      "search_session_id — MỘT session tính nhất MỘT lần bất kể bao nhiêu click/conversation",
    attributionWindow: "unbounded_click_chain",
    inclusionRules: [
      "qualified search session = search_submitted đã emit, không internal (D1)",
      "chain: search_result_clicked.listingId → conversation_started CÙNG actor pseudonym + CÙNG listing, tại hoặc sau thời điểm click — KHÔNG time bound (S-16)",
    ],
    exclusionRules: [
      "test/internal users where configured",
      "known automated traffic",
      "conversation không đi qua kết quả đã click của session đó (link trực tiếp, visit lại) — không tính vào numerator",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── seller_response_rate_v1 — response window PENDING (A1) ──────────────────
  seller_response_rate_v1: {
    name: "seller_response_rate_v1",
    version: "v1",
    definition:
      "New buyer conversations receiving a seller response within the defined response window, over eligible new buyer conversations. " +
      "Tỉ lệ conversation buyer mới được seller trả lời trong response window — spec §5.8.1.",
    numerator:
      "new buyer conversations receiving a seller response within the defined response window",
    denominator: "eligible new buyer conversations",
    deduplicationKey:
      "conversation_id — MỘT conversation đóng góp nhất MỘT vào numerator/denominator",
    attributionWindow: PENDING_FOUNDER_DECISION,
    inclusionRules: [
      "eligible new buyer conversation (D4) = conversation có ≥ 1 tin nhắn của buyer — tín hiệu conversation_buyer_first_message (event cơ học, schema-versioned, flagged cho founder)",
      "seller response = event message_first_response của conversation đó (chỉ emit cho tin ĐẦU TIÊN của seller sau ≥ 1 tin buyer)",
      "engine nhận responseWindowMs THAM SỐ — giá trị production PENDING (A1); fixture test dùng window CÓ NHÃN",
    ],
    exclusionRules: [
      "test/internal users where configured (phía BUYER — theo isInternal của conversation_buyer_first_message; internal seller KHÔNG bị loại — S-18)",
      "known automated traffic",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── median_first_response_time_v1 — fully specified (duration) ──────────────
  median_first_response_time_v1: {
    name: "median_first_response_time_v1",
    version: "v1",
    definition:
      "Time from first qualified buyer message to first seller response, excluding internal/test traffic. " +
      "Median thời gian từ tin nhắn buyer đầu tiên đến response seller đầu — anchor = tin buyer ĐẦU (D4), spec §5.8.1.",
    numerator:
      "per-conversation responseMs (first seller response − first qualified buyer message, từ metadata của message_first_response)",
    denominator:
      "eligible conversations — mỗi conversation đóng góp MỘT responseMs (sample size)",
    deduplicationKey:
      "conversation_id — mỗi convo đóng góp MỘT responseMs (event chỉ emit một lần; dedup phòng backfill/đếm đôi — S-18)",
    attributionWindow: "n/a_duration",
    inclusionRules: [
      "anchor = tin nhắn buyer ĐẦU TIÊN của conversation (conversation_buyer_first_message — D4)",
      "responseMs đọc từ metadata của message_first_response (tính lúc emit), KHÔNG tính lại từ timestamp",
      "median: lẻ → giá trị giữa; chẵn → trung bình 2 giá trị giữa (quy ước ghi trong test)",
    ],
    exclusionRules: [
      "test/internal traffic (phía BUYER — qua join conversation_buyer_first_message.isInternal; internal SELLER không bị loại — S-18)",
      "known automated traffic",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── successful_match_rate_v1 — PENDING (A2 + Deal của Batch 6) ───────────────
  successful_match_rate_v1: {
    name: "successful_match_rate_v1",
    version: "v1",
    definition:
      "Rate of successfully matched deals. Definition must specify: successful bilateral confirmation; reconciliation policy; attribution period; duplicate handling — all PENDING_FOUNDER_DECISION (A2) và bị chặn trên Deal domain của Batch 6. " +
      "Batch 5 chỉ ship COUNT thô (successful_match events — zero cho đến khi Batch 6 emit); RATE không render.",
    numerator:
      "successful bilateral confirmations (successful_match events) — COUNT ONLY; rate PENDING_FOUNDER_DECISION (A2)",
    denominator:
      "PENDING_FOUNDER_DECISION — reconciliation policy + attribution period chưa được định nghĩa (A2)",
    deduplicationKey:
      "PENDING_FOUNDER_DECISION — duplicate handling chưa được định nghĩa (A2)",
    attributionWindow: PENDING_FOUNDER_DECISION,
    inclusionRules: [
      "event schema successful_match ship ngay (Task 6); emission thuộc Deal domain (Batch 6)",
      "dashboard hiển thị COUNT thô (honest zero cho đến khi Batch 6 emit)",
    ],
    exclusionRules: [
      "test/internal users where configured",
      "known automated traffic",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ALL_SEGMENTS,
    owner: "founder",
  },

  // ─── repeat_user_rate_v1 — PENDING (A3) ──────────────────────────────────────
  repeat_user_rate_v1: {
    name: "repeat_user_rate_v1",
    version: "v1",
    definition:
      "Rate of returning accounts. Must specify: return window; eligible account definition; internal/test exclusions — return window + eligible account definition PENDING_FOUNDER_DECISION (A3). " +
      "Event user_returned ship schema nhưng emission bị hoãn — không thể detect \"return\" mà không tự chế window (A3).",
    numerator:
      "PENDING_FOUNDER_DECISION — returning accounts trong return window (A3)",
    denominator:
      "PENDING_FOUNDER_DECISION — eligible accounts (A3: eligible account definition chưa được định nghĩa)",
    deduplicationKey:
      "actor_pseudonym (per key version) — metric cấp account; pseudonym ổn định per user per key version (S-10/S-11)",
    attributionWindow: PENDING_FOUNDER_DECISION,
    inclusionRules: [
      "event schema user_returned ship ngay (Task 6); emission deferred (A3 — blocked cho đến khi return window được quyết)",
    ],
    exclusionRules: [
      "test/internal users where configured",
      "known automated traffic",
    ],
    botInternalTrafficRules: BOT_RULES,
    supportedSegments: ["beta_cohort"],
    owner: "founder",
  },
};
