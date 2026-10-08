/**
 * Private-beta analytics dashboard (Batch 5 Task 10 — spec §5.8.2) — unit tests.
 *
 * CỔNG dashboard access + honesty gate của task (Review Focus 6 + Acceptance
 * Gate "Dashboard authorization" + "Metric-contract honesty"):
 *  1. /admin/analytics TỰ guard server-side requireCapability("analytics.read")
 *     TRƯỚC MỌI db read (spec §4.5 — nav filtering chỉ là convenience);
 *  2. nav entry /admin/analytics trong app/admin/layout.tsx gated
 *     analytics.read + lọc qua capabilitiesOf (Batch 2 Task 9 pattern);
 *  3. contract pending (A1/A2/A3) render trạng thái pending CÓ TÊN tham số —
 *     KHÔNG BAO GIỜ con số tự chế; search_to_chat_v1 render GIÁ TRỊ THẬT
 *     (unbounded click chain — S-16);
 *  4. mọi rate render kèm n=numerator/denominator (low-sample context —
 *     spec §5.8.2 "Avoid displaying misleading low-sample percentages
 *     without context");
 *  5. segmentation helpers (cohort / primary-secondary market / category /
 *     brand-model — spec §5.8.2; "where sample size permits" = count luôn
 *     hiển thị, KHÔNG ngưỡng minimum-n tự chế);
 *  6. aggregates không cần contract (query volume, median listing age,
 *     listing marked sold, report count, seller activation, seller listing
 *     count, active seller count);
 *  7. module ghi nhận giới hạn full-scan P0 (scaling ceiling — nit) + quyết
 *     định "active seller" (§12.2) trong module comment.
 *
 * Cơ chế mock: recipe chuẩn (như tests/unit/financial-shutdown-actions.test.ts)
 * — server-only/next/cache/next/navigation/next/headers + db.client STRICT
 * (Proxy ném lỗi khi bị chạm: pure helper chạm db = test fail ngay). Helper
 * thuần được export từ app/admin/analytics/page.tsx (file nguồn duy nhất của
 * task theo plan); page component KHÔNG được gọi ở đây — guard là hợp đồng
 * source (spec §4.5), hành vi render thuộc integration/review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    has: () => false,
    getAll: () => [],
  })),
}));

// db.client STRICT — mọi truy cập db trong unit test = lỗi hợp đồng (helper
// thuần KHÔNG bao giờ chạm db; page component không được gọi ở đây).
vi.mock("@/src/prisma/db.client", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("DB_TOUCHED_IN_ANALYTICS_UNIT_TEST");
      },
    },
  ),
}));

import * as analyticsPage from "../../app/admin/analytics/page";
import type { ListingRow } from "../../app/admin/analytics/page";
import {
  METRIC_CONTRACTS,
  PENDING_FOUNDER_DECISION,
  type MetricName,
} from "@/src/lib/metric-contracts";
import { actorPseudonymFor } from "@/src/lib/product-events";
import type { ProductEventRow } from "@/src/lib/metrics";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── fixture helpers ───────────────────────────────────────────────────────────

/** Key test base64 của đúng 32 byte (như tests/unit/product-events.test.ts). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let seq = 0;

/** Row ProductEvent cho fixture — default "bên ngoài" mọi metric, ghi đè từng field. */
const ev = (partial: Partial<ProductEventRow> & { name: string }): ProductEventRow => ({
  id: `e${++seq}`,
  occurredAt: new Date(Date.UTC(2026, 9, 1)).toISOString(),
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

/** Row Listing (approved) cho fixture aggregate/segment. */
const listing = (partial: Partial<ListingRow> & { id: string }): ListingRow => ({
  sellerId: "s-x",
  categoryId: "c-x",
  brandId: null,
  productModelId: null,
  createdAt: new Date(Date.UTC(2026, 9, 1)).toISOString(),
  ...partial,
});

// ─── 1+2. Dashboard access — guard server-side (spec §4.5, Review Focus 6) ─────

describe("dashboard access — guard server-side trước mọi db read (spec §4.5)", () => {
  const pageSrc = () => read("app/admin/analytics/page.tsx");

  it('page gọi await requireCapability("analytics.read") — server component, không client-only gating', () => {
    const src = pageSrc();
    expect(src).toContain('await requireCapability("analytics.read")');
    // server component (spec §4.5: hidden nav/client gating không phải authorization)
    expect(src).not.toContain('"use client"');
  });

  it("guard đứng TRƯỚC db read đầu tiên trong page (requireCapability trước db.orm)", () => {
    const src = pageSrc();
    const guardIdx = src.indexOf('await requireCapability("analytics.read")');
    const firstDbIdx = src.indexOf("db.orm.");
    expect(guardIdx, "guard phải có mặt trong source").toBeGreaterThanOrEqual(0);
    expect(firstDbIdx, "page phải đọc db (dashboard)").toBeGreaterThanOrEqual(0);
    expect(firstDbIdx).toBeGreaterThan(guardIdx);
  });

  it("nav entry /admin/analytics gated analytics.read + lọc qua capabilitiesOf (convenience)", () => {
    const src = read("app/admin/layout.tsx");
    expect(src).toContain('href: "/admin/analytics"');
    expect(src).toContain('label: "Phân tích beta"');
    expect(src).toContain('capability: "analytics.read"');
    // Batch 2 Task 9 filtering giữ nguyên — nav là CONVENIENCE (spec §4.5),
    // guard trang mới là ranh giới thật.
    expect(src).toContain("capabilitiesOf(admin.user.adminRole)");
    expect(src).toContain("caps.includes(item.capability)");
  });
});

// ─── 3. Pending state trung thực (A1/A2/A3 — spec §4.11 Policy Non-Invention) ──

describe("renderMetricValue — pending state CÓ TÊN, không bao giờ con số tự chế", () => {
  /** 4 contract phụ thuộc founder decision (A1/A2/A3) — sentinel trong registry. */
  const PENDING_METRICS = [
    "listing_to_chat_v1",
    "seller_response_rate_v1",
    "successful_match_rate_v1",
    "repeat_user_rate_v1",
  ] as const satisfies readonly MetricName[];
  type PendingMetric = (typeof PENDING_METRICS)[number];

  /** TÊN tham số từng contract chờ founder quyết — pending phải NÊN ĐƯỢC tham số. */
  const PENDING_PARAM: Record<PendingMetric, string> = {
    listing_to_chat_v1: "attribution window",
    seller_response_rate_v1: "response window",
    successful_match_rate_v1: "reconciliation policy",
    repeat_user_rate_v1: "return window",
  };

  it("4 contract pending mang sentinel PENDING_FOUNDER_DECISION trong registry", () => {
    for (const name of PENDING_METRICS) {
      expect(METRIC_CONTRACTS[name].attributionWindow).toBe(PENDING_FOUNDER_DECISION);
    }
  });

  it("render pending CÓ TÊN tham số — KHÔNG render số kể cả khi caller truyền aggregate có rate", () => {
    for (const name of PENDING_METRICS) {
      // aggregate CÓ rate (fixture window) — render helper vẫn KHÔNG render số:
      // window production là PENDING (A1/A2/A3), không tự chế để hiển thị.
      const out = analyticsPage.renderMetricValue(METRIC_CONTRACTS[name], {
        numerator: 3,
        denominator: 4,
        rate: 0.75,
      });
      expect(out).toContain("— chờ quyết định:");
      expect(out).toContain(PENDING_PARAM[name]);
      expect(out).not.toMatch(/[%0-9]/); // KHÔNG con số, KHÔNG %
    }
  });

  it("search_to_chat_v1 render GIÁ TRỊ THẬT (unbounded click chain — S-16), không pending", () => {
    const out = analyticsPage.renderMetricValue(METRIC_CONTRACTS.search_to_chat_v1, {
      numerator: 1,
      denominator: 6,
      rate: 1 / 6,
    });
    expect(out).not.toContain("chờ quyết định");
    expect(out).toContain("n=1/6");
  });
});

// ─── 4. Mọi rate kèm n=numerator/denominator (low-sample context §5.8.2) ────────

describe("renderMetricValue / renderDurationValue — low-sample context (§5.8.2)", () => {
  it('zeroResultRate 2/5 → "40.0% (n=2/5)" — rate luôn kèm n=numerator/denominator', () => {
    const out = analyticsPage.renderMetricValue(METRIC_CONTRACTS.zero_result_rate_v1, {
      numerator: 2,
      denominator: 5,
      rate: 0.4,
    });
    expect(out).toBe("40.0% (n=2/5)");
  });

  it("denominator 0 → \"chưa có dữ liệu\", KHÔNG render 0% (rate null từ engine)", () => {
    const out = analyticsPage.renderMetricValue(METRIC_CONTRACTS.search_result_ctr_v1, {
      numerator: 0,
      denominator: 0,
      rate: null,
    });
    expect(out).toBe("chưa có dữ liệu (n=0/0)");
    expect(out).not.toContain("%");
  });

  it("renderDurationValue: median duration kèm sample; null → chưa có dữ liệu", () => {
    // 90_000 ms = 1 phút 30 giây
    expect(analyticsPage.renderDurationValue(90_000, 3)).toBe("1 phút 30 giây (n=3)");
    expect(analyticsPage.renderDurationValue(null, 0)).toBe("chưa có dữ liệu (n=0)");
  });

  it("formatDurationMs: giây → phút → giờ → ngày (đơn vị lớn nhất + phần dư)", () => {
    expect(analyticsPage.formatDurationMs(500)).toBe("500 ms");
    expect(analyticsPage.formatDurationMs(42_000)).toBe("42 giây");
    expect(analyticsPage.formatDurationMs(120_000)).toBe("2 phút");
    expect(analyticsPage.formatDurationMs(7_200_000)).toBe("2 giờ");
    expect(analyticsPage.formatDurationMs(3 * 86_400_000 + 2 * 3_600_000)).toBe("3 ngày 2 giờ");
  });
});

// ─── 5. Segmentation helpers (spec §5.8.2) ──────────────────────────────────────

describe("segmentation helpers (spec §5.8.2)", () => {
  beforeEach(() => {
    vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
    vi.stubEnv("NODE_ENV", "test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cohort: event có actorPseudonym ∈ tập pseudonym của cohort (membership fixture → pseudonym set → filtered count)", () => {
    // fixture BetaCohortMembership rows (ACTIVE founding_seller) → pseudonym set
    // (cùng seam cohortPseudonyms dùng — actorPseudonymFor dưới key dedicated).
    const memberships = [
      { userId: "u-fs-1", cohort: "founding_seller", status: "active" },
      { userId: "u-fs-2", cohort: "founding_seller", status: "active" },
    ] as const;
    const pseudonyms = memberships.map((m) => actorPseudonymFor(m.userId));

    const events = [
      ev({ name: "search_submitted", actorPseudonym: pseudonyms[0] }),
      ev({ name: "listing_viewed", actorPseudonym: pseudonyms[1] }),
      // ngoài cohort (user khác — pseudonym khác)
      ev({ name: "search_submitted", actorPseudonym: actorPseudonymFor("u-khac") }),
      // anonymous — không thuộc cohort nào (không có pseudonym để join)
      ev({ name: "search_submitted", actorPseudonym: null }),
    ];
    const inCohort = analyticsPage.eventsInCohort(events, pseudonyms);
    expect(inCohort).toHaveLength(2);
    expect(inCohort.map((e) => e.name).sort()).toEqual(["listing_viewed", "search_submitted"]);
  });

  it("market: ha-noi (primary) vs ho-chi-minh (secondary) vs khác (kể cả null) — bucket đúng, không mất row", () => {
    const events = [
      ev({ name: "search_submitted", provinceCode: "ha-noi" }),
      ev({ name: "search_submitted", provinceCode: "ha-noi" }),
      ev({ name: "search_submitted", provinceCode: "ho-chi-minh" }),
      ev({ name: "search_submitted", provinceCode: "da-nang" }),
      ev({ name: "search_submitted", provinceCode: null }),
    ];
    const seg = analyticsPage.segmentByMarket(events);
    expect(seg.primary).toHaveLength(2);
    expect(seg.secondary).toHaveLength(1);
    // "other" = mọi giá trị không phải primary/secondary — KỂ CẢ null (không chọn)
    expect(seg.other).toHaveLength(2);
    // bucketing phân hoạch đúng — mỗi row đúng một bucket
    expect(seg.primary.length + seg.secondary.length + seg.other.length).toBe(events.length);
  });

  it("category: join listingId → Listing.categoryId; event không join được KHÔNG xuất hiện (fail closed)", () => {
    const listings = [
      listing({ id: "L1", categoryId: "c-speaker", brandId: "b-jbl", productModelId: "m-charge" }),
      listing({ id: "L2", categoryId: "c-other" }),
    ];
    const events = [
      ev({ name: "listing_viewed", listingId: "L1" }),
      ev({ name: "listing_viewed", listingId: "L1" }),
      ev({ name: "listing_viewed", listingId: "L2" }),
      // listing không trong tập approved đã nạp (đã bị gỡ / chưa duyệt) — không đoán danh mục
      ev({ name: "listing_viewed", listingId: "L-gone" }),
      // event không mang listingId (search) — không segment theo danh mục
      ev({ name: "search_submitted", listingId: null }),
    ];
    const byCategory = analyticsPage.segmentByCategory(events, listings);
    expect(byCategory.get("c-speaker")).toHaveLength(2);
    expect(byCategory.get("c-other")).toHaveLength(1);
    expect([...byCategory.keys()].sort()).toEqual(["c-other", "c-speaker"]);
  });

  it("brand/model: join listingId → Listing.brandId/productModelId; brand/model null bỏ qua", () => {
    const listings = [
      listing({ id: "L1", categoryId: "c-speaker", brandId: "b-jbl", productModelId: "m-charge" }),
      listing({ id: "L2", categoryId: "c-other", brandId: null, productModelId: null }),
    ];
    const events = [
      ev({ name: "listing_viewed", listingId: "L1" }),
      ev({ name: "search_result_clicked", listingId: "L1" }),
      ev({ name: "listing_viewed", listingId: "L2" }),
    ];
    const { byBrand, byModel } = analyticsPage.segmentByBrandModel(events, listings);
    expect(byBrand.get("b-jbl")).toHaveLength(2);
    expect(byModel.get("m-charge")).toHaveLength(2);
    // L2 không có brand/model → KHÔNG tạo bucket null (fail closed, không đoán)
    expect([...byBrand.keys()]).toEqual(["b-jbl"]);
    expect([...byModel.keys()]).toEqual(["m-charge"]);
  });
});

// ─── 6. Aggregates không cần contract (spec §5.8.2) ─────────────────────────────

describe("aggregates không cần contract (spec §5.8.2)", () => {
  it("query volume = count search_submitted (count thô mọi row)", () => {
    const events = [
      ev({ name: "search_submitted" }),
      ev({ name: "search_submitted" }),
      ev({ name: "search_submitted", isInternal: true }), // count thô — internal vẫn đếm
      ev({ name: "listing_viewed" }),
      ev({ name: "report_submitted" }),
    ];
    // TÍNH TAY: 3 search_submitted
    expect(analyticsPage.queryVolume(events)).toBe(3);
  });

  it("listing marked sold = count listing_marked_sold — honest zero trước Batch 6 (S7)", () => {
    expect(analyticsPage.listingMarkedSoldCount([ev({ name: "listing_viewed" })])).toBe(0);
    expect(
      analyticsPage.listingMarkedSoldCount([
        ev({ name: "listing_marked_sold" }),
        ev({ name: "listing_marked_sold" }),
      ]),
    ).toBe(2);
  });

  it("report count = count report_submitted (Batch 3 emit — S7)", () => {
    const events = [
      ev({ name: "report_submitted" }),
      ev({ name: "report_submitted" }),
      ev({ name: "listing_removed" }),
    ];
    expect(analyticsPage.reportCount(events)).toBe(2);
  });

  it("seller activation = distinct actorPseudonym trong seller_first_listing_published", () => {
    const events = [
      ev({ name: "seller_first_listing_published", actorPseudonym: "ps-A" }),
      ev({ name: "seller_first_listing_published", actorPseudonym: "ps-A" }), // dedup
      ev({ name: "seller_first_listing_published", actorPseudonym: "ps-B" }),
      ev({ name: "seller_first_listing_published", actorPseudonym: null }), // không pseudonym → không đếm
      ev({ name: "listing_viewed", actorPseudonym: "ps-C" }), // event khác — bỏ qua
    ];
    // TÍNH TAY: distinct {ps-A, ps-B} = 2
    expect(analyticsPage.sellerActivation(events)).toBe(2);
  });

  it("median listing age over approved listings — lẻ: giữa; chẵn: trung bình 2 giữa; rỗng: null", () => {
    const NOW = Date.UTC(2026, 9, 8);
    const DAY = 86_400_000;
    // 3 listing tuổi [10, 20, 30] ngày → median 20 ngày
    const odd = [
      listing({ id: "L1", createdAt: new Date(NOW - 10 * DAY).toISOString() }),
      listing({ id: "L2", createdAt: new Date(NOW - 20 * DAY).toISOString() }),
      listing({ id: "L3", createdAt: new Date(NOW - 30 * DAY).toISOString() }),
    ];
    expect(analyticsPage.medianListingAgeMs(odd, NOW)).toBe(20 * DAY);
    // 4 listing tuổi [10, 20, 30, 40] ngày → median (20+30)/2 = 25 ngày
    const even = [
      ...odd,
      listing({ id: "L4", createdAt: new Date(NOW - 40 * DAY).toISOString() }),
    ];
    expect(analyticsPage.medianListingAgeMs(even, NOW)).toBe(25 * DAY);
    expect(analyticsPage.medianListingAgeMs([], NOW)).toBe(null);
  });

  it("seller listing count = approved total + median mỗi seller", () => {
    const listings = [
      listing({ id: "L1", sellerId: "s1" }),
      listing({ id: "L2", sellerId: "s1" }),
      listing({ id: "L3", sellerId: "s2" }),
      listing({ id: "L4", sellerId: "s3" }),
      listing({ id: "L5", sellerId: "s3" }),
      listing({ id: "L6", sellerId: "s3" }),
    ];
    // TÍNH TAY: per-seller [s1: 2, s2: 1, s3: 3] → total 6, median [1,2,3] = 2
    expect(analyticsPage.sellerListingCount(listings)).toEqual({ total: 6, medianPerSeller: 2 });
    expect(analyticsPage.sellerListingCount([])).toEqual({ total: 0, medianPerSeller: null });
  });

  it("active seller count = sellers với ≥ 1 tin approved (§12.2 — raw aggregate)", () => {
    const listings = [
      listing({ id: "L1", sellerId: "s1" }),
      listing({ id: "L2", sellerId: "s1" }),
      listing({ id: "L3", sellerId: "s2" }),
    ];
    // TÍNH TAY: distinct sellers {s1, s2} = 2
    expect(analyticsPage.activeSellerCount(listings)).toBe(2);
    expect(analyticsPage.activeSellerCount([])).toBe(0);
  });
});

// ─── 7. Module docs — giới hạn đã ghi nhận (nit) ─────────────────────────────────

describe("module docs — giới hạn & quyết định đã ghi nhận", () => {
  it("dashboard module ghi nhận full-scan P0 + scaling ceiling cho review post-beta (nit)", () => {
    const src = read("app/admin/analytics/page.tsx");
    expect(src).toContain("full scan");
    expect(src).toContain("scaling");
  });

  it("không cửa sổ hiển thị tự chế — tổng từ khi telemetry bắt đầu ghi (A6 retention pending)", () => {
    const src = read("app/admin/analytics/page.tsx");
    expect(src).toContain("không cửa sổ");
  });

  it('quyết định "active seller" (§12.2) ghi trong module comment — không tự chế định nghĩa', () => {
    const src = read("app/admin/analytics/page.tsx");
    expect(src).toContain("§12.2");
  });
});
