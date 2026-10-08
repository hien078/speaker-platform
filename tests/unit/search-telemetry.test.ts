/**
 * Search telemetry (Batch 5 Task 7 — spec §5.8/§7.1/§4.8, S-5/S-6/S-7/S-8/S-9)
 * — unit tests cho `runSearchWithTelemetry` + `searchRateLimitKey`.
 *
 * Tách khỏi page component (S-7): toàn bộ nhánh rate-limit/emit test được ở đây
 * không cần render async page. Cơ chế mock:
 *  - `@/src/lib/search-query`: GIỮ describeSearchQuery THẬT (plan pure), mock
 *    runSearchQuery (db — kết quả điều khiển được);
 *  - `@/src/lib/product-events`: GIỮ EMIT CORE THẬT (spy = row persisted trên db
 *    mock — cùng kiểu tests/unit/product-events.test.ts) — pseudonym/isInternal
 *    chạy thật dưới key test;
 *  - `@/src/lib/rate-limit`: THẬT (in-memory — resetRateLimits giữa các case).
 *
 * Cổng (plan Task 7 Step 1):
 *  1. Query hợp lệ → emit search_submitted { resultCount, resultListingIds,
 *     facets đã validate } — KHÔNG query text (spec §4.8); actor/session lưu
 *     HMAC dưới key dedicated (raw id KHÔNG bao giờ persist — S-10);
 *  2. Query blank/malformed → KHÔNG emit, KHÔNG tốn budget rate limit (S-5);
 *  3. Rate limit: request valid thứ 61 trong 60s → soft-throttle, KHÔNG query,
 *     KHÔNG emit (S-5); searchRateLimitKey: authed → user key, anonymous → ip
 *     key, TRUST_PROXY_HEADERS=false → bucket "local" chung;
 *  4. Prefetch skip emission (S-8);
 *  5. Zero-result → emit search_zero_result { resolvedBrandIds, resolvedModelIds }
 *     (demand record — spec §5.7.1); eventsEmitted.zeroResult === true → dòng
 *     "ghi nhận nhu cầu" chỉ render khi ĐÓ (S-6 — §4.2 no-misleading-promise);
 *  6. categorySlug/brandSlug CHỈ emit khi khớp row đã load (S-9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// captureError spy — rejection log KHÔNG bao giờ mang value (correction #17).
vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── db.client mock — ProductEvent (emit + read-back) + membership/user ───────

const dbState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  fail: {} as { eventCreate?: unknown },
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = Record<string, unknown>;
  const matches = (row: Row, pred: Pred) =>
    Object.entries(pred).every(([k, v]) => row[k] === v);

  const productEventModel = {
    create: async (data: Row) => {
      if (dbState.fail.eventCreate) throw dbState.fail.eventCreate;
      const row = { id: `pe-${dbState.events.length + 1}`, occurredAt: new Date().toISOString(), ...data };
      dbState.events.push(row);
      return { ...row };
    },
    first: async (filter?: Pred) => {
      const hit = dbState.events.find((r) => filter === undefined || matches(r, filter));
      return hit === undefined ? null : { ...hit };
    },
    where: (pred: Pred) => ({
      all: async () => dbState.events.filter((r) => matches(r, pred)).map((r) => ({ ...r })),
    }),
  };

  const membershipModel = {
    first: async (filter?: Pred) => {
      const hit = dbState.memberships.find((r) => filter === undefined || matches(r, filter));
      return hit === undefined ? null : { ...hit };
    },
  };

  const userModel = {
    first: async (filter?: Pred) => {
      const hit = dbState.users.find((r) => filter === undefined || matches(r, filter));
      return hit === undefined ? null : { ...hit };
    },
  };

  return {
    db: {
      orm: {
        public: {
          ProductEvent: productEventModel,
          BetaCohortMembership: membershipModel,
          User: userModel,
        },
      },
    },
  };
});

// ─── search-query mock — describeSearchQuery THẬT, runSearchQuery mock ───────

const searchRun = vi.hoisted(() => ({
  listings: [] as Array<{ id: string }>,
  resultCount: 0,
  calls: 0,
}));

vi.mock("@/src/lib/search-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/search-query")>();
  return {
    ...actual,
    runSearchQuery: vi.fn(async () => {
      searchRun.calls += 1;
      return { listings: searchRun.listings, resultCount: searchRun.resultCount };
    }),
  };
});

import { runSearchWithTelemetry, searchRateLimitKey, SEARCH_RATE } from "@/src/lib/search-telemetry";
import { runSearchQuery } from "@/src/lib/search-query";
import { checkRateLimit, clientIpFromHeaders, resetRateLimits } from "@/src/lib/rate-limit";
import type { SearchResolution } from "@/src/lib/search-resolve";

const runSearchQueryMock = vi.mocked(runSearchQuery);

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Key test hợp lệ — base64 của đúng 32 byte (cùng fixture product-events.test.ts). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const EMPTY_RESOLUTION: SearchResolution = {
  textVariants: [],
  brandIds: [],
  productModelIds: [],
};

const AUTHED = { id: "user-buyer", sessionId: "sess-raw-1" };
const ANON = { id: null, sessionId: null };

const loaded = {
  categories: [{ slug: "portable_bluetooth_speaker" }, { slug: "loa-thung-pa" }],
  brands: [{ slug: "jbl" }, { slug: "bose" }],
};

const eventsOf = (name: string) => dbState.events.filter((r) => r["name"] === name);

beforeEach(() => {
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TRUST_PROXY_HEADERS", "");
  dbState.events.length = 0;
  dbState.memberships.length = 0;
  dbState.users.length = 0;
  dbState.fail = {};
  searchRun.listings = [];
  searchRun.resultCount = 0;
  searchRun.calls = 0;
  runSearchQueryMock.mockClear();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Query hợp lệ → search_submitted (spec §4.8 — KHÔNG query text) ────────

describe("runSearchWithTelemetry — query hợp lệ emit search_submitted", () => {
  it("emit resultCount + resultListingIds + facets; searchSessionId set; KHÔNG query text", async () => {
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }, { id: "22222222-2222-4222-8222-222222222222" }];
    searchRun.resultCount = 2;

    const run = await runSearchWithTelemetry({
      user: AUTHED,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: { textVariants: ["loa jbl"], brandIds: [], productModelIds: [] },
      params: { q: "Loa JBL", category: "portable_bluetooth_speaker", brand: "jbl", sort: "relevance" },
      loadedCategories: loaded.categories,
      loadedBrands: loaded.brands,
    });

    expect(run.throttled).toBe(false);
    expect(run.resultCount).toBe(2);
    expect(run.searchSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.eventsEmitted.submitted).toBe(true);

    const rows = eventsOf("search_submitted");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row["searchSessionId"]).toBe(run.searchSessionId);
    expect(row["provinceCode"]).toBe(null);

    const metadata = row["metadata"] as Record<string, unknown>;
    expect(metadata["resultCount"]).toBe(2);
    expect(metadata["resultListingIds"]).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    // facets đã validate (S-9): slug khớp row đã load → emit
    expect(metadata["categorySlug"]).toBe("portable_bluetooth_speaker");
    expect(metadata["brandSlug"]).toBe("jbl");
    expect(metadata["sort"]).toBe("relevance");

    // spec §4.8 — KHÔNG query text: không key nào mang query/q/text
    for (const key of Object.keys(metadata)) {
      expect(key).not.toMatch(/^(q|query|text|searchText)$/i);
    }
    // giá trị metadata KHÔNG chứa chuỗi query thô/chuẩn hóa
    expect(JSON.stringify(metadata)).not.toContain("loa jbl");
  });

  it("actor/session lưu HMAC dưới key dedicated — raw id KHÔNG bao giờ persist (S-10)", async () => {
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }];
    searchRun.resultCount = 1;

    await runSearchWithTelemetry({
      user: AUTHED,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa" },
      loadedCategories: [],
      loadedBrands: [],
    });

    const row = eventsOf("search_submitted")[0]!;
    expect(row["actorPseudonym"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["actorPseudonym"]).not.toBe(AUTHED.id);
    expect(row["sessionPseudonym"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["sessionPseudonym"]).not.toBe(AUTHED.sessionId);
    // toàn row KHÔNG chứa id thô
    expect(JSON.stringify(row)).not.toContain(AUTHED.sessionId);
    expect(JSON.stringify(row)).not.toMatch(/"actorId"/);
  });

  it("provinceFilter đi cột typed provinceCode (KHÔNG metadata)", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];

    await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "198.51.100.9",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa", province: "ha-noi" },
      loadedCategories: [],
      loadedBrands: [],
    });

    const row = eventsOf("search_submitted")[0]!;
    expect(row["provinceCode"]).toBe("ha-noi");
    expect((row["metadata"] as Record<string, unknown>)["provinceCode"]).toBeUndefined();
  });

  it("internal actor (cohort internal active) → isInternal true trên row (S-12)", async () => {
    dbState.memberships.push({ id: "m1", userId: AUTHED.id, cohort: "internal", status: "active" });
    searchRun.resultCount = 1;
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }];

    await runSearchWithTelemetry({
      user: AUTHED,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa" },
      loadedCategories: [],
      loadedBrands: [],
    });

    expect(eventsOf("search_submitted")[0]!["isInternal"]).toBe(true);
  });
});

// ─── 2. Blank/malformed → KHÔNG emit, KHÔNG tốn budget (S-5) ──────────────────

describe("runSearchWithTelemetry — blank/malformed query (browsing)", () => {
  it("q blank → KHÔNG emit, vẫn chạy search, KHÔNG tốn budget rate limit", async () => {
    const run = await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "   " },
      loadedCategories: loaded.categories,
      loadedBrands: loaded.brands,
    });

    expect(run.eventsEmitted).toEqual({ submitted: false, zeroResult: false });
    expect(run.searchSessionId).toBe(null);
    expect(dbState.events).toHaveLength(0);
    // vẫn chạy search (browsing) — KHÔNG rate limit
    expect(runSearchQueryMock).toHaveBeenCalledTimes(1);
    // budget nguyên vẹn: call tiếp theo trên cùng key vẫn còn full limit
    const decision = checkRateLimit("search:ip:203.0.113.7", SEARCH_RATE);
    expect(decision.remaining).toBe(SEARCH_RATE.limit - 1); // chính call này mới tốn 1
  });

  it("q malformed (121 ký tự) → KHÔNG emit, KHÔNG tốn budget", async () => {
    const run = await runSearchWithTelemetry({
      user: AUTHED,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "a".repeat(121) },
      loadedCategories: [],
      loadedBrands: [],
    });

    expect(run.eventsEmitted.submitted).toBe(false);
    expect(dbState.events).toHaveLength(0);
    const decision = checkRateLimit("search:user:user-buyer", SEARCH_RATE);
    expect(decision.remaining).toBe(SEARCH_RATE.limit - 1);
  });
});

// ─── 3. Rate limit (S-5) ──────────────────────────────────────────────────────

describe("runSearchWithTelemetry — rate limit (§7.1, S-5)", () => {
  it("request valid thứ 61 trong 60s → soft-throttle: KHÔNG query, KHÔNG emit", async () => {
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }];
    searchRun.resultCount = 1;

    const input = {
      user: AUTHED,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa" } as Record<string, string>,
      loadedCategories: [] as { slug: string }[],
      loadedBrands: [] as { slug: string }[],
    };

    for (let i = 0; i < SEARCH_RATE.limit; i++) {
      const run = await runSearchWithTelemetry(input);
      expect(run.throttled).toBe(false);
    }
    expect(eventsOf("search_submitted")).toHaveLength(SEARCH_RATE.limit);

    const blocked = await runSearchWithTelemetry(input);
    expect(blocked.throttled).toBe(true);
    expect(blocked.listings).toEqual([]);
    expect(blocked.resultCount).toBe(0);
    expect(blocked.searchSessionId).toBe(null);
    expect(blocked.eventsEmitted).toEqual({ submitted: false, zeroResult: false });
    // KHÔNG query, KHÔNG emit thêm
    expect(eventsOf("search_submitted")).toHaveLength(SEARCH_RATE.limit);
  });

  it("throttle KHÔNG ảnh hưởng bucket khác (per user/ip — §7.1)", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];
    const input = {
      isPrefetch: false,
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa" } as Record<string, string>,
      loadedCategories: [] as { slug: string }[],
      loadedBrands: [] as { slug: string }[],
    };

    for (let i = 0; i < SEARCH_RATE.limit; i++) {
      await runSearchWithTelemetry({ ...input, user: AUTHED, ip: "203.0.113.7" });
    }
    const blocked = await runSearchWithTelemetry({ ...input, user: AUTHED, ip: "203.0.113.7" });
    expect(blocked.throttled).toBe(true);

    // user khác + ip khác → bucket riêng, vẫn chạy
    const other = await runSearchWithTelemetry({
      ...input,
      user: { id: "user-two", sessionId: "sess-2" },
      ip: "198.51.100.9",
    });
    expect(other.throttled).toBe(false);
  });
});

describe("searchRateLimitKey — S-5 (key derivation)", () => {
  it("authed → search:user:<userId>", () => {
    expect(searchRateLimitKey({ userId: "u-1", ip: "1.2.3.4" })).toBe("search:user:u-1");
  });

  it("anonymous → search:ip:<ip>", () => {
    expect(searchRateLimitKey({ userId: null, ip: "203.0.113.9" })).toBe("search:ip:203.0.113.9");
  });

  it("TRUST_PROXY_HEADERS=false → clientIpFromHeaders trả 'local' → bucket chung (fail-safe)", () => {
    // header do client tự đặt được — gate tắt (mặc định) → mọi client chung bucket
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const h = new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" });
    const ip = clientIpFromHeaders(h);
    expect(ip).toBe("local");
    expect(searchRateLimitKey({ userId: null, ip })).toBe("search:ip:local");
  });
});

// ─── 4. Prefetch skip emission (S-8) ───────────────────────────────────────────

describe("runSearchWithTelemetry — prefetch (S-8)", () => {
  it("isPrefetch: true → KHÔNG search_submitted, KHÔNG search_zero_result", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];

    const run = await runSearchWithTelemetry({
      user: AUTHED,
      isPrefetch: true,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa" },
      loadedCategories: [],
      loadedBrands: [],
    });

    // prefetch VẪN chạy query (render kết quả) nhưng KHÔNG emit — chống double-count
    expect(runSearchQueryMock.mock.calls.length).toBeGreaterThan(0);
    expect(dbState.events).toHaveLength(0);
    expect(run.eventsEmitted).toEqual({ submitted: false, zeroResult: false });
  });
});

// ─── 5. Zero-result → demand record (spec §5.7.1, S-6) ────────────────────────

describe("runSearchWithTelemetry — zero-result (spec §5.7.1)", () => {
  it("resultCount 0 → emit search_zero_result với resolution ids; eventsEmitted.zeroResult true", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];
    const resolution: SearchResolution = {
      textVariants: ["soundlink"],
      brandIds: ["33333333-3333-4333-8333-333333333333"],
      productModelIds: ["44444444-4444-4444-8444-444444444444"],
    };

    const run = await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution,
      params: { q: "SoundLink" },
      loadedCategories: [],
      loadedBrands: [],
    });

    const rows = eventsOf("search_zero_result");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["searchSessionId"]).toBe(run.searchSessionId);
    const metadata = rows[0]!["metadata"] as Record<string, unknown>;
    // demand record: brand/model canonical ĐƯỢC TÌM — KHÔNG bao giờ raw text
    expect(metadata["resolvedBrandIds"]).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(metadata["resolvedModelIds"]).toEqual(["44444444-4444-4444-8444-444444444444"]);
    expect(JSON.stringify(metadata)).not.toContain("soundlink");
    expect(run.eventsEmitted.zeroResult).toBe(true);
  });

  it("zero-result CŨNG emit search_submitted (session hợp lệ có denominator)", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];

    await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "khong co" },
      loadedCategories: [],
      loadedBrands: [],
    });

    expect(eventsOf("search_submitted")).toHaveLength(1);
    expect(eventsOf("search_zero_result")).toHaveLength(1);
  });

  it("eventsEmitted.zeroResult FALSE khi emit thất bại (db lỗi) — KHÔNG hứa suông (§4.2)", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];
    dbState.fail.eventCreate = new Error("db down");

    const run = await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "khong co" },
      loadedCategories: [],
      loadedBrands: [],
    });

    // fail-open cho flow — nhưng eventsEmitted trung thực: KHÔNG ghi nhận được
    expect(run.throttled).toBe(false);
    expect(run.eventsEmitted).toEqual({ submitted: false, zeroResult: false });
  });

  it("browsing (không query) zero-result → KHÔNG emit search_zero_result", async () => {
    searchRun.resultCount = 0;
    searchRun.listings = [];

    const run = await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: {},
      loadedCategories: [],
      loadedBrands: [],
    });

    expect(dbState.events).toHaveLength(0);
    expect(run.eventsEmitted.zeroResult).toBe(false);
  });
});

// ─── 6. Facets chỉ emit khi khớp row đã load (S-9) ────────────────────────────

describe("runSearchWithTelemetry — facets S-9 (slug chỉ emit khi khớp row đã load)", () => {
  it("categorySlug KHÔNG khớp loadedCategories → KHÔNG emit (không emit thô)", async () => {
    searchRun.resultCount = 1;
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }];

    await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa", category: "khong-ton-tai" },
      loadedCategories: loaded.categories,
      loadedBrands: loaded.brands,
    });

    const metadata = eventsOf("search_submitted")[0]!["metadata"] as Record<string, unknown>;
    expect(metadata["categorySlug"]).toBeUndefined();
  });

  it("brandSlug KHÔNG khớp loadedBrands → KHÔNG emit", async () => {
    searchRun.resultCount = 1;
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }];

    await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa", brand: "khong-ton-tai" },
      loadedCategories: loaded.categories,
      loadedBrands: loaded.brands,
    });

    const metadata = eventsOf("search_submitted")[0]!["metadata"] as Record<string, unknown>;
    expect(metadata["brandSlug"]).toBeUndefined();
  });

  it("conditionFilter/priceMin/priceMax/sort theo plan đã validate", async () => {
    searchRun.resultCount = 1;
    searchRun.listings = [{ id: "11111111-1111-4111-8111-111111111111" }];

    await runSearchWithTelemetry({
      user: ANON,
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY_RESOLUTION,
      params: { q: "loa", condition: "good", min: "500000", max: "2000000", sort: "price_asc" },
      loadedCategories: [],
      loadedBrands: [],
    });

    const metadata = eventsOf("search_submitted")[0]!["metadata"] as Record<string, unknown>;
    expect(metadata["conditionFilter"]).toBe("good");
    expect(metadata["priceMin"]).toBe(500000);
    expect(metadata["priceMax"]).toBe(2000000);
    expect(metadata["sort"]).toBe("price_asc");
  });
});

// ─── Source contract — module posture ──────────────────────────────────────────

describe("search-telemetry.ts — source contract", () => {
  /** Directive "use server" tồn tại ở DÒNG nào đó (không phải nhắc trong comment). */
  const hasUseServerDirective = (src: string): boolean =>
    src.split("\n").some((line) => /^\s*["']use server["']\s*;?\s*$/.test(line));

  it("import \"server-only\", KHÔNG directive \"use server\" (S-13)", () => {
    const src = read("src/lib/search-telemetry.ts");
    expect(src).toMatch(/import "server-only"/);
    expect(hasUseServerDirective(src)).toBe(false);
  });

  it("emit đi qua emitProductEvent — KHÔNG ghi ProductEvent trực tiếp", () => {
    const src = read("src/lib/search-telemetry.ts");
    expect(src).toMatch(/emitProductEvent\(/);
    // read-back sự tồn tại (§4.2) là READ — không có .create trực tiếp
    expect(src).not.toMatch(/ProductEvent\.create/);
  });

  it("sessionId THÔ truyền cho emit core (b5-review T6 — KHÔNG pseudonym kép)", () => {
    const src = read("src/lib/search-telemetry.ts");
    expect(src).not.toMatch(/sessionPseudonymFor/); // KHÔNG tự HMAC trước
    expect(src).not.toMatch(/actorPseudonymFor/);
  });
});
