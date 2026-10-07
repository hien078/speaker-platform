/**
 * Metric contract registry (Batch 5 Task 9 — spec §5.8.1) — unit tests.
 *
 * CỔNG structural của batch cho tính trung thực metric (Review Focus 5 +
 * Acceptance Gate "Metric-contract honesty"):
 *  - registry mang ĐÚNG 8 contract của spec §5.8.1 — không tự chế cái thứ 9,
 *    không thiếu cái nào;
 *  - 4 contract phụ thuộc window (listing_to_chat_v1, seller_response_rate_v1,
 *    successful_match_rate_v1, repeat_user_rate_v1 — A1/A2/A3) mang sentinel
 *    PENDING_FOUNDER_DECISION — một window tự chế KHÔNG THỂ merge (test fail);
 *  - search_to_chat_v1 mang "unbounded_click_chain" (S-16/D3 — "eventually"
 *    của spec là unbounded), KHÔNG phải pending;
 *  - 3 contract fully-specified (zero_result_rate_v1, search_result_ctr_v1,
 *    median_first_response_time_v1) mang semantics cụ thể khớp nguyên văn spec;
 *  - exclusionRules của MỌI contract nêu exclusion internal/test; contract
 *    zero_result_rate_v1 liệt kê 4 exclusion của spec NGUYÊN VĂN.
 *
 * Module thuần (src/lib/metric-contracts.ts — không db, không server-only):
 * test trực tiếp, không mock.
 */
import { describe, expect, it } from "vitest";
import {
  METRIC_CONTRACTS,
  PENDING_FOUNDER_DECISION,
  type MetricContract,
  type MetricName,
  type MetricSegment,
} from "@/src/lib/metric-contracts";

/** 8 tên metric của spec §5.8.1 — đúng thứ tự xuất hiện trong spec. */
const SPEC_METRIC_NAMES: readonly MetricName[] = [
  "zero_result_rate_v1",
  "search_result_ctr_v1",
  "listing_to_chat_v1",
  "search_to_chat_v1",
  "seller_response_rate_v1",
  "median_first_response_time_v1",
  "successful_match_rate_v1",
  "repeat_user_rate_v1",
];

/** 4 segment spec §5.8.2 cho phép hỗ trợ. */
const SPEC_SEGMENTS: readonly MetricSegment[] = [
  "beta_cohort",
  "primary_secondary_market",
  "category",
  "brand_model",
];

/** Toàn bộ registry dưới dạng entry — duyệt cấu trúc từng contract. */
const CONTRACT_ENTRIES = Object.entries(METRIC_CONTRACTS) as Array<
  [MetricName, MetricContract]
>;

// ─── registry: đúng 8 contract của spec ────────────────────────────────────────

describe("METRIC_CONTRACTS — registry", () => {
  it("mang ĐÚNG 8 contract của spec §5.8.1 với đúng tên (không chế cái thứ 9, không thiếu)", () => {
    expect(Object.keys(METRIC_CONTRACTS).sort()).toEqual(
      [...SPEC_METRIC_NAMES].sort(),
    );
    expect(CONTRACT_ENTRIES).toHaveLength(8);
  });

  it("mỗi contract điền ĐẦY ĐỦ mọi field của struct spec §5.8.1 (không field rỗng)", () => {
    for (const [name, contract] of CONTRACT_ENTRIES) {
      expect(contract.name, `name của ${name}`).toBe(name);
      expect(contract.version, `version của ${name}`).toBe("v1");
      // non-empty text fields
      expect(contract.definition.trim()).not.toBe("");
      expect(contract.numerator.trim()).not.toBe("");
      expect(contract.denominator.trim()).not.toBe("");
      expect(contract.deduplicationKey.trim()).not.toBe("");
      expect(contract.attributionWindow.trim()).not.toBe("");
      expect(contract.botInternalTrafficRules.trim()).not.toBe("");
      // non-empty rule lists, mỗi rule non-empty
      expect(contract.inclusionRules.length).toBeGreaterThan(0);
      for (const rule of contract.inclusionRules) {
        expect(rule.trim(), `inclusionRule của ${name}`).not.toBe("");
      }
      expect(contract.exclusionRules.length).toBeGreaterThan(0);
      for (const rule of contract.exclusionRules) {
        expect(rule.trim(), `exclusionRule của ${name}`).not.toBe("");
      }
      // segments hợp lệ + non-empty
      expect(contract.supportedSegments.length).toBeGreaterThan(0);
      for (const segment of contract.supportedSegments) {
        expect(SPEC_SEGMENTS).toContain(segment);
      }
      // owner của spec §5.8.1 = founder (policy non-invention — §4.11)
      expect(contract.owner).toBe("founder");
    }
  });

  it("mọi contract khai báo bot rules đã ghi nhận của A4 (chưa có tín hiệu bot — không exclude gì)", () => {
    for (const [name, contract] of CONTRACT_ENTRIES) {
      expect(contract.botInternalTrafficRules, name).toMatch(
        /no bot signal defined/i,
      );
    }
  });

  it("mọi contract có exclusionRules nêu exclusion internal/test (S-12)", () => {
    for (const [name, contract] of CONTRACT_ENTRIES) {
      const joined = contract.exclusionRules.join(" | ");
      expect(joined, `exclusionRules của ${name}`).toMatch(/internal|test/i);
    }
  });
});

// ─── sentinel pending + window unbounded (S-16) ─────────────────────────────────

describe("attribution window — pending sentinel vs unbounded", () => {
  it("PENDING_FOUNDER_DECISION là sentinel chuỗi cố định", () => {
    expect(PENDING_FOUNDER_DECISION).toBe("PENDING_FOUNDER_DECISION");
  });

  it("4 contract phụ thuộc window mang PENDING_FOUNDER_DECISION — window tự chế KHÔNG THỂ merge (A1/A2/A3)", () => {
    const pending: readonly MetricName[] = [
      "listing_to_chat_v1", // A1 — attribution window
      "seller_response_rate_v1", // A1 — response window
      "successful_match_rate_v1", // A2 — attribution period (reconciliation policy)
      "repeat_user_rate_v1", // A3 — return window
    ];
    for (const name of pending) {
      expect(METRIC_CONTRACTS[name].attributionWindow, name).toBe(
        PENDING_FOUNDER_DECISION,
      );
    }
  });

  it("search_to_chat_v1 mang unbounded_click_chain, KHÔNG phải pending (S-16/D3)", () => {
    expect(METRIC_CONTRACTS.search_to_chat_v1.attributionWindow).toBe(
      "unbounded_click_chain",
    );
    expect(METRIC_CONTRACTS.search_to_chat_v1.attributionWindow).not.toBe(
      PENDING_FOUNDER_DECISION,
    );
  });
});

// ─── 3 contract fully-specified mang semantics cụ thể khớp nguyên văn spec ──────

describe("contract fully-specified — semantics nguyên văn spec §5.8.1", () => {
  it("zero_result_rate_v1: numerator/denominator nguyên văn + window per_search_session", () => {
    const contract = METRIC_CONTRACTS.zero_result_rate_v1;
    expect(contract.numerator).toBe(
      "valid search sessions producing zero eligible results",
    );
    expect(contract.denominator).toBe(
      "all valid submitted search sessions",
    );
    expect(contract.attributionWindow).toBe("per_search_session");
  });

  it("zero_result_rate_v1: 4 exclusion của spec NGUYÊN VĂN (blank/malformed/internal/automated)", () => {
    const contract = METRIC_CONTRACTS.zero_result_rate_v1;
    expect(contract.exclusionRules).toContain("blank query");
    expect(contract.exclusionRules).toContain("malformed query");
    expect(contract.exclusionRules).toContain(
      "test/internal users where configured",
    );
    expect(contract.exclusionRules).toContain("known automated traffic");
    expect(contract.exclusionRules).toHaveLength(4);
  });

  it("search_result_ctr_v1: numerator/denominator nguyên văn + window per_search_session", () => {
    const contract = METRIC_CONTRACTS.search_result_ctr_v1;
    expect(contract.numerator).toBe(
      "eligible search sessions with at least one result click",
    );
    expect(contract.denominator).toBe(
      "eligible search sessions with at least one displayed result",
    );
    expect(contract.attributionWindow).toBe("per_search_session");
  });

  it("median_first_response_time_v1: duration metric — anchor buyer đầu → response seller đầu, window n/a_duration", () => {
    const contract = METRIC_CONTRACTS.median_first_response_time_v1;
    expect(contract.definition).toMatch(/first qualified buyer message/i);
    expect(contract.definition).toMatch(/first seller response/i);
    expect(contract.attributionWindow).toBe("n/a_duration");
  });
});

// ─── contract phụ thuộc window: phần unambiguous vẫn ghi rõ ────────────────────

describe("contract pending — phần unambiguous được ghi rõ, phần thiếu ghi PENDING", () => {
  it("listing_to_chat_v1: dedup nguyên văn spec (viewer + listing + attribution window), window PENDING (A1)", () => {
    const contract = METRIC_CONTRACTS.listing_to_chat_v1;
    expect(contract.numerator).toBe(
      "qualified unique listing views that generate a new buyer↔seller conversation within the attribution window",
    );
    expect(contract.denominator).toBe("qualified unique listing views");
    expect(contract.deduplicationKey).toBe(
      "viewer + listing + attribution window",
    );
    expect(contract.attributionWindow).toBe(PENDING_FOUNDER_DECISION);
  });

  it("search_to_chat_v1: numerator/denominator nguyên văn spec", () => {
    const contract = METRIC_CONTRACTS.search_to_chat_v1;
    expect(contract.numerator).toBe(
      "qualified search sessions that eventually produce a new buyer↔seller conversation through a clicked result",
    );
    expect(contract.denominator).toBe("qualified search sessions");
  });

  it("seller_response_rate_v1: numerator/denominator nguyên văn spec, window PENDING (A1)", () => {
    const contract = METRIC_CONTRACTS.seller_response_rate_v1;
    expect(contract.numerator).toBe(
      "new buyer conversations receiving a seller response within the defined response window",
    );
    expect(contract.denominator).toBe("eligible new buyer conversations");
    expect(contract.attributionWindow).toBe(PENDING_FOUNDER_DECISION);
  });

  it("successful_match_rate_v1: 4 mục spec yêu cầu định nghĩa đều ghi PENDING (A2)", () => {
    const contract = METRIC_CONTRACTS.successful_match_rate_v1;
    const joined = [
      contract.definition,
      contract.numerator,
      contract.denominator,
      contract.deduplicationKey,
      contract.attributionWindow,
    ].join(" | ");
    // spec: "Definition must specify: successful bilateral confirmation;
    // reconciliation policy; attribution period; duplicate handling."
    expect(joined).toMatch(/successful bilateral confirmation/i);
    expect(joined).toMatch(/reconciliation policy/i);
    expect(joined).toMatch(/attribution period/i);
    expect(joined).toMatch(/duplicate handling/i);
    expect(contract.attributionWindow).toBe(PENDING_FOUNDER_DECISION);
  });

  it("repeat_user_rate_v1: 3 mục spec yêu cầu định nghĩa đều ghi PENDING (A3)", () => {
    const contract = METRIC_CONTRACTS.repeat_user_rate_v1;
    const joined = [
      contract.definition,
      contract.numerator,
      contract.denominator,
      contract.attributionWindow,
    ].join(" | ");
    // spec: "Must specify: return window; eligible account definition;
    // internal/test exclusions."
    expect(joined).toMatch(/return window/i);
    expect(joined).toMatch(/eligible account definition/i);
    expect(contract.attributionWindow).toBe(PENDING_FOUNDER_DECISION);
  });
});

// ─── actor binding S-14 (b5-review — Review Focus 7: ss copy không chế tạo CTR) ─

describe("actor binding S-14 — click phải là click CỦA ACTOR session", () => {
  it("search_result_ctr_v1 + search_to_chat_v1 khai báo actor binding trong inclusionRules (Review Focus 7)", () => {
    // Plan Review Focus 7 (L120): threat = "a fabricated OR COPIED ss param
    // manufacturing search_result_clicked events"; plan L919 (Task 8):
    // "forged/copied ss không chế tạo được CTR". Task 7/8 chỉ chặn ss
    // FABRICATED (tồn tại + ∈ result set) — ss COPY từ người khác VẪN được
    // emit; engine phải bind actor để metric không bị thổi phồng.
    for (const name of ["search_result_ctr_v1", "search_to_chat_v1"] as const) {
      const joined = METRIC_CONTRACTS[name].inclusionRules.join(" | ");
      expect(joined, name).toMatch(/actor binding/i);
      expect(joined, name).toMatch(/Review Focus 7/);
    }
  });
});
