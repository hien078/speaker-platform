/**
 * Search query plan (Batch 5 Task 7 — spec §5.7/§5.9/§4.7) — unit tests cho
 * `describeSearchQuery` (PURE — không db) + seam `SEARCHABLE_LISTING_STATUSES`
 * (S6) + `BETA_SPEAKER_CATEGORY_SLUG` (S8).
 *
 * Cổng (plan Task 7 Step 1):
 *  1. Query chuẩn hóa + spacing variants chữ↔số vào plan (một tsquery OR-joined
 *     build từ textVariants — S-2);
 *  2. Query blank/malformed → hasQuery: false, textVariants rỗng (browsing —
 *     loại khỏi search metrics THEO CẤU TRÚC, spec §5.8.1 exclusion);
 *  3. Province filter: mã canonical hợp lệ → provinceFilter; mã lạ → null
 *     (KHÔNG đoán); param `city` cũ (link legacy) map qua FD-1 rule
 *     (resolveLegacyLocation — Task 2): "Hà Nội" → ha-noi, "Bình Dương" →
 *     ho-chi-minh (merged legacy name AUTHORITATIVE per NQ 202/2025/QH15),
 *     "Khác" → null (mọi khu vực — KHÔNG bao giờ đoán);
 *  4. KHÔNG có trường ranking boost theo province khi buyer chưa chọn location
 *     (Review Focus 3 — structural: plan KHÔNG mang boost term; priority market
 *     KHÔNG tự nổi lên — spec §5.7 rule 5);
 *  5. Resolution ids chảy vào plan; sort validation: lạ → "newest",
 *     "relevance" CHỈ khi hasQuery;
 *  6. S6 drift test: liệt kê MỌI giá trị listing_status TỪ CONTRACT EMITTED
 *     (contract.json — nguồn thật, không phải literal copy trong test) và assert
 *     chỉ "approved" là searchable (giá trị tương lai rò rỉ vào search → FAIL);
 *  7. S8: BETA_SPEAKER_CATEGORY_SLUG = "portable_bluetooth_speaker" import từ
 *     Batch 4 allowlist — KHÔNG còn fallback "loa-bluetooth".
 *
 * Facets giữ "như hôm nay" (plan): condition validate theo enum contract,
 * min/max > 0, exchange="1", brand facet theo slug (trường plan thiếu — bổ sung
 * brandSlug, xem ghi chú trong src/lib/search-query.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import {
  BETA_SPEAKER_CATEGORY_SLUG,
  SEARCHABLE_LISTING_STATUSES,
  describeSearchQuery,
  isListingSearchable,
} from "@/src/lib/search-query";
import type { SearchResolution } from "@/src/lib/search-resolve";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");

/** Resolution rỗng — fixture mặc định (query không resolve gì). */
const EMPTY: SearchResolution = { textVariants: [], brandIds: [], productModelIds: [] };

// ─── 1. Chuẩn hóa + spacing variants (S-2) ────────────────────────────────────

describe("describeSearchQuery — chuẩn hóa query + spacing variants (S-2)", () => {
  it("q 'Charge4' → textVariants chứa 'charge4' + 'charge 4' (chữ↔số, đã chuẩn hóa)", () => {
    const plan = describeSearchQuery({ q: "Charge4" }, EMPTY);
    expect(plan.hasQuery).toBe(true);
    expect(plan.textVariants).toContain("charge4");
    expect(plan.textVariants).toContain("charge 4");
  });

  it("q có dấu/hoa → textVariants là dạng CHUẨN HÓA (lowercase, không dấu)", () => {
    const plan = describeSearchQuery({ q: "  LOA  JBL   Charge 4 " }, EMPTY);
    expect(plan.textVariants[0]).toBe("loa jbl charge 4");
    expect(plan.textVariants).toContain("loa jbl charge4");
  });

  it("textVariants DERIVE TỪ query (Task 3) — resolution lệch KHÔNG làm hỏng arm text", () => {
    // Plan tự chuẩn hóa từ q (đơn nguồn Task 3 — byte-identical với
    // resolution.textVariants của cùng query) — resolution chỉ đóng góp IDS.
    const res: SearchResolution = {
      textVariants: ["garbage-khong-dung"],
      brandIds: ["brand-9"],
      productModelIds: [],
    };
    const plan = describeSearchQuery({ q: "Loa JBL Charge 4" }, res);
    expect(plan.textVariants).toEqual(["loa jbl charge 4", "loa jbl charge4"]);
    expect(plan.brandIds).toEqual(["brand-9"]); // ids vẫn chảy từ resolution
  });
});

// ─── 2. Malformed/blank → browsing (spec §5.8.1 exclusion cấu trúc) ───────────

describe("describeSearchQuery — blank/malformed query → browsing", () => {
  it("q blank → hasQuery: false, textVariants rỗng", () => {
    const plan = describeSearchQuery({ q: "   " }, EMPTY);
    expect(plan.hasQuery).toBe(false);
    expect(plan.textVariants).toEqual([]);
  });

  it("q vắng mặt → hasQuery: false", () => {
    expect(describeSearchQuery({}, EMPTY).hasQuery).toBe(false);
  });

  it("q 121 ký tự (malformed — isMalformedQuery) → hasQuery: false", () => {
    const plan = describeSearchQuery({ q: "a".repeat(121) }, EMPTY);
    expect(plan.hasQuery).toBe(false);
    expect(plan.textVariants).toEqual([]);
  });

  it("q chứa control char (malformed) → hasQuery: false", () => {
    expect(describeSearchQuery({ q: "loa\u0000" }, EMPTY).hasQuery).toBe(false);
  });

  it("q đúng 120 ký tự → hasQuery: true (biên giới hạn)", () => {
    expect(describeSearchQuery({ q: "a".repeat(120) }, EMPTY).hasQuery).toBe(true);
  });
});

// ─── 3. Province filter + param city cũ (FD-1 — Task 2) ───────────────────────

describe("describeSearchQuery — province filter (spec §5.9, FD-1)", () => {
  it("province canonical hợp lệ → provinceFilter", () => {
    const plan = describeSearchQuery({ province: "ha-noi" }, EMPTY);
    expect(plan.provinceFilter).toBe("ha-noi");
  });

  it("province lạ → null (KHÔNG đoán mã)", () => {
    const plan = describeSearchQuery({ province: "atlantis" }, EMPTY);
    expect(plan.provinceFilter).toBe(null);
  });

  it("param city cũ 'Hà Nội' → provinceFilter ha-noi (FD-1 rule)", () => {
    const plan = describeSearchQuery({ city: "Hà Nội" }, EMPTY);
    expect(plan.provinceFilter).toBe("ha-noi");
  });

  it("param city cũ 'Bình Dương' → ho-chi-minh (merged legacy name AUTHORITATIVE — FD-1)", () => {
    const plan = describeSearchQuery({ city: "Bình Dương" }, EMPTY);
    expect(plan.provinceFilter).toBe("ho-chi-minh");
  });

  it("param city cũ 'Khác' → null (mọi khu vực — KHÔNG đoán)", () => {
    const plan = describeSearchQuery({ city: "Khác" }, EMPTY);
    expect(plan.provinceFilter).toBe(null);
  });

  it("param city cũ là tên quận/huyện → null (KHÔNG fabricate — spec §8.3)", () => {
    const plan = describeSearchQuery({ city: "Cầu Giấy" }, EMPTY);
    expect(plan.provinceFilter).toBe(null);
  });

  it("province canonical ĐÍCH thắng param city cũ (link mới ghi đè link cũ)", () => {
    const plan = describeSearchQuery({ province: "da-nang", city: "Hà Nội" }, EMPTY);
    expect(plan.provinceFilter).toBe("da-nang");
  });
});

// ─── 4. Review Focus 3 — KHÔNG boost location ngầm ────────────────────────────

describe("describeSearchQuery — KHÔNG priority-location boost (Review Focus 3)", () => {
  it("plan KHÔNG mang trường boost/relevance theo province (structural)", () => {
    const plan = describeSearchQuery({ q: "loa" }, EMPTY);
    // Cấu trúc kế hoạch đóng: đúng các trường plan khai báo, KHÔNG trường nào
    // mã hóa boost theo location (một trường boost lỡ thêm vào type sẽ lộ ở đây).
    expect(Object.keys(plan).sort()).toEqual([
      "brandIds",
      "brandSlug",
      "categorySlug",
      "condition",
      "exchangeOnly",
      "hasQuery",
      "maxPrice",
      "minPrice",
      "productModelIds",
      "provinceFilter",
      "sort",
      "statuses",
      "textVariants",
    ]);
  });

  it("không chọn province → provinceFilter null — KHÔNG có nguồn boost nào khác", () => {
    const plan = describeSearchQuery({ q: "loa" }, EMPTY);
    expect(plan.provinceFilter).toBe(null);
    // sort không mang location; textVariants không mang location
    expect(plan.sort).toBe("relevance");
  });
});

// ─── 5. Resolution ids + sort validation ──────────────────────────────────────

describe("describeSearchQuery — resolution ids + sort validation", () => {
  it("resolution brand/model ids chảy vào plan", () => {
    const res: SearchResolution = {
      textVariants: ["jbl"],
      brandIds: ["brand-1"],
      productModelIds: ["model-1"],
    };
    const plan = describeSearchQuery({ q: "JBL" }, res);
    expect(plan.brandIds).toEqual(["brand-1"]);
    expect(plan.productModelIds).toEqual(["model-1"]);
  });

  it("sort lạ → 'newest'", () => {
    const plan = describeSearchQuery({ q: "loa", sort: "weird" }, EMPTY);
    expect(plan.sort).toBe("newest");
  });

  it("sort vắng mặt + có query → 'relevance' (mặc định ranking textual-first — spec §5.7)", () => {
    expect(describeSearchQuery({ q: "loa" }, EMPTY).sort).toBe("relevance");
  });

  it("sort vắng mặt + browsing → 'newest'", () => {
    expect(describeSearchQuery({}, EMPTY).sort).toBe("newest");
  });

  it("'relevance' CHỈ khi hasQuery — browsing với sort=relevance → 'newest'", () => {
    expect(describeSearchQuery({ sort: "relevance" }, EMPTY).sort).toBe("newest");
  });

  it("sort hợp lệ khác giữ nguyên (giá tăng/giảm/xem nhiều)", () => {
    expect(describeSearchQuery({ q: "loa", sort: "price_asc" }, EMPTY).sort).toBe("price_asc");
    expect(describeSearchQuery({ sort: "price_desc" }, EMPTY).sort).toBe("price_desc");
    expect(describeSearchQuery({ sort: "popular" }, EMPTY).sort).toBe("popular");
    expect(describeSearchQuery({ sort: "newest" }, EMPTY).sort).toBe("newest");
  });
});

// ─── Facets "như hôm nay" ─────────────────────────────────────────────────────

describe("describeSearchQuery — facets giữ hành vi hôm nay", () => {
  it("condition hợp lệ → plan.condition; lạ → null", () => {
    expect(describeSearchQuery({ condition: "good" }, EMPTY).condition).toBe("good");
    expect(describeSearchQuery({ condition: "excellent" }, EMPTY).condition).toBe("excellent");
    expect(describeSearchQuery({ condition: "broken" }, EMPTY).condition).toBe(null);
    expect(describeSearchQuery({}, EMPTY).condition).toBe(null);
  });

  it("min/max > 0 → minPrice/maxPrice; 0/âm/rác → null", () => {
    expect(describeSearchQuery({ min: "500000", max: "2000000" }, EMPTY)).toMatchObject({
      minPrice: 500000,
      maxPrice: 2000000,
    });
    expect(describeSearchQuery({ min: "0" }, EMPTY).minPrice).toBe(null);
    expect(describeSearchQuery({ min: "-5" }, EMPTY).minPrice).toBe(null);
    expect(describeSearchQuery({ min: "abc" }, EMPTY).minPrice).toBe(null);
    expect(describeSearchQuery({}, EMPTY)).toMatchObject({ minPrice: null, maxPrice: null });
  });

  it("exchange=1 → exchangeOnly", () => {
    expect(describeSearchQuery({ exchange: "1" }, EMPTY).exchangeOnly).toBe(true);
    expect(describeSearchQuery({ exchange: "0" }, EMPTY).exchangeOnly).toBe(false);
    expect(describeSearchQuery({}, EMPTY).exchangeOnly).toBe(false);
  });

  it("category/brand slug đi vào plan THÔ (validate chống loaded row ở caller — S-9)", () => {
    const plan = describeSearchQuery({ category: "loa-thung-pa", brand: "jbl" }, EMPTY);
    expect(plan.categorySlug).toBe("loa-thung-pa");
    expect(plan.brandSlug).toBe("jbl");
  });

  it("statuses = SEARCHABLE_LISTING_STATUSES = ['approved']", () => {
    const plan = describeSearchQuery({}, EMPTY);
    expect(plan.statuses).toEqual(["approved"]);
    expect([...SEARCHABLE_LISTING_STATUSES]).toEqual(["approved"]);
  });
});

// ─── 6. S6 drift test — chỉ "approved" searchable, liệt kê TỪ CONTRACT ───────

describe("isListingSearchable — S6 drift test (liệt kê mọi listing_status từ contract)", () => {
  /** Mọi giá trị listing_status từ contract EMITTED (src/prisma/contract.json). */
  const contractListingStatuses = (() => {
    const contract = JSON.parse(read("src/prisma/contract.json")) as {
      domain: { namespaces: Record<string, { enum: Record<string, { members: Array<{ name: string; value: string }> }> }> };
    };
    return contract.domain.namespaces.public!.enum.listing_status!.members.map((m) => m.value);
  })();

  it("contract có ≥ 5 giá trị (sanity — walk không được im lặng pass)", () => {
    // draft/pending/approved/rejected/hidden/sold/removed/archived hiện có
    expect(contractListingStatuses.length).toBeGreaterThanOrEqual(5);
  });

  it("CHỈ 'approved' searchable — mọi giá trị khác KHÔNG (giá trị tương lai rò rỉ → FAIL)", () => {
    // Drift guard: một giá trị listing_status mới (vd 'archived', 'removed' đã
    // có, tương lai thêm gì nữa) mà lọt vào search sẽ sai ở ĐÂY — không phải ở
    // trang. isListingSearchable(v) === (v === "approved") với MỌI v từ contract.
    for (const value of contractListingStatuses) {
      expect(
        isListingSearchable(value),
        `listing_status '${value}' phải ${value === "approved" ? "" : "KHÔNG "}được searchable`,
      ).toBe(value === "approved");
    }
  });

  it("draft/pending/hidden/removed/archived KHÔNG bao giờ searchable (pin đích danh)", () => {
    expect(isListingSearchable("draft")).toBe(false);
    expect(isListingSearchable("pending")).toBe(false);
    expect(isListingSearchable("hidden")).toBe(false);
    expect(isListingSearchable("removed")).toBe(false);
    expect(isListingSearchable("archived")).toBe(false);
    expect(isListingSearchable("sold")).toBe(false);
    expect(isListingSearchable("rejected")).toBe(false);
    expect(isListingSearchable("approved")).toBe(true);
  });

  it("giá trị ngoài enum → KHÔNG searchable (fail closed)", () => {
    expect(isListingSearchable("")).toBe(false);
    expect(isListingSearchable("APPROVED")).toBe(false);
    expect(isListingSearchable("approved ")).toBe(false);
  });
});

// ─── 7. S8 — beta category slug từ Batch 4 allowlist ──────────────────────────

describe("BETA_SPEAKER_CATEGORY_SLUG — S8 (Batch 4 allowlist, KHÔNG fallback)", () => {
  it("= 'portable_bluetooth_speaker' — import từ BETA_PUBLICATION_CATEGORIES", () => {
    expect(BETA_SPEAKER_CATEGORY_SLUG).toBe("portable_bluetooth_speaker");
  });

  it("module KHÔNG chứa fallback 'loa-bluetooth' (S8 — xóa fallback cũ)", () => {
    const src = read("src/lib/search-query.ts");
    expect(src).not.toContain("loa-bluetooth");
  });
});

// ─── Source contract — module posture ─────────────────────────────────────────

describe("search-query.ts — source contract", () => {
  it("import \"server-only\" (module server thuần), KHÔNG \"use server\"", () => {
    const src = read("src/lib/search-query.ts");
    expect(src).toMatch(/import "server-only"/);
    expect(src).not.toMatch(/"use server"/);
  });

  it("language \"simple\" ở CẢ HAI phía match + rank (S-1 — invariant index === query)", () => {
    const src = read("src/lib/search-query.ts");
    // MỌI dòng fullTextMatches/fullTextRank (trên field proxy) đều mang
    // { language: "simple" } — bỏ qua dòng comment.
    const opLines = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /l\.searchTextNormalized\.fullText(?:Matches|Rank)\(/.test(l));
    expect(opLines.length).toBeGreaterThan(0);
    for (const line of opLines) {
      expect(line, `dòng FTS phải mang language simple: ${line}`).toContain('{ language: "simple" }');
    }
    // tsquery cũng simple (S-1: mismatch index/query language = sequential scan ngầm)
    expect(src).toMatch(/websearchToTsquery\([^\n]*\{ language: "simple" \}/);
    expect(src).not.toMatch(/\{ language: "english" \}/);
  });

  it("tsquery MỘT lần dùng cho match VÀ rank (S-2 — cùng biến tsq)", () => {
    const src = read("src/lib/search-query.ts");
    expect(src).toMatch(/websearchToTsquery\(/);
    expect(src).toMatch(/textVariants\.join\(" or "\)/);
  });
});
