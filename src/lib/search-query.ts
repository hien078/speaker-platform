import "server-only";

import { or } from "@prisma/orm-postgres/orm-client";
import { websearchToTsquery } from "@prisma/orm-postgres/target/full-text";
import { db } from "@/src/prisma/db.client";
import { BETA_PUBLICATION_CATEGORIES } from "@/src/lib/beta-categories";
import { isProvinceCode } from "@/src/lib/provinces";
import { resolveLegacyLocation } from "@/src/lib/location";
import { isMalformedQuery, normalizeSearchText, spacingVariants } from "@/src/lib/search-normalize";
import type { SearchResolution } from "@/src/lib/search-resolve";

/**
 * Search query plan (Batch 5 Task 7 — spec §5.7/§5.9/§4.7) — seam publication-state
 * duy nhất của search (S6) + plan thuần cho page + integration test.
 *
 * SEAM S6: tập trạng thái searchable sống Ở ĐÂY — `SEARCHABLE_LISTING_STATUSES`
 * = ["approved"]. Batch 3 đã quyết định suspended sellers GIỮ listing live
 * (B3 A2) → KHÔNG suspension filter. Drift test (tests/unit/search-query.test.ts)
 * liệt kê MỌI giá trị listing_status TỪ CONTRACT EMITTED và assert chỉ
 * "approved" searchable — giá trị tương lai (archived/removed/…) rò rỉ vào
 * search sẽ FAIL ở đó, không phải ở trang.
 *
 * Ranking (spec §5.7): 1. textual relevance → 2. valid/published status (FILTER
 * — statuses, không phải rank), 3. listing quality (seam Batch 4 — KHÔNG rank
 * ở đây, ghi chú thôi), 4. freshness (createdAt desc tiebreak), 5. explicit buyer
 * location preference (provinceFilter — filter tường minh, KHÔNG boost ngầm).
 * Priority beta location KHÔNG nhận automatic relevance boost khi buyer chưa
 * chọn (spec §5.7 rule 5 + §4.7) — Review Focus 3: plan KHÔNG mang trường boost
 * nào theo province (structural — test pin keys của plan).
 *
 * S-1: language "simple" ở CẢ HAI phía index (contract) + query (tsquery +
 * fullTextMatches/fullTextRank) — english stopword/stemmer làm hỏng text tiếng
 * Việt đã pre-normalize ("loa do" mất "do"); mismatch index/query language là
 * sequential scan NGẦM. S-2: MỘT tsquery OR-joined từ textVariants dùng cho CẢ
 * match VÀ rank.
 *
 * Facets "như hôm nay" (plan): category (active, theo slug), brand (theo slug),
 * condition (enum contract), province (canonical — unresolved legacy rows chỉ
 * hiện ở "all locations"), price, exchange. Trường `brandSlug` là facet brand
 * select theo slug — plan Task 7 liệt kê facet brand "như hôm nay" nhưng type
 * sketch thiếu trường; bổ sung ở đây (không phải resolution ids — đó là arm
 * query-text).
 */

/** SEAM (S6) — tập trạng thái searchable. Drift test pin từ contract. */
export const SEARCHABLE_LISTING_STATUSES = ["approved"] as const;

/** Giá trị listing_status searchable (hiện chỉ "approved" — drift test pin). */
export type SearchableListingStatus = (typeof SEARCHABLE_LISTING_STATUSES)[number];

/** status ∈ SEARCHABLE_LISTING_STATUSES? (fail closed — giá trị lạ → false). */
export function isListingSearchable(status: string): boolean {
  return (SEARCHABLE_LISTING_STATUSES as readonly string[]).includes(status);
}

/**
 * S8: slug category beta từ Batch 4 allowlist (BETA_PUBLICATION_CATEGORIES) —
 * "portable_bluetooth_speaker"; slug category cũ đã XÓA (không còn fallback).
 */
export const BETA_SPEAKER_CATEGORY_SLUG = BETA_PUBLICATION_CATEGORIES[0];

/** Giá trị product_condition của contract (src/prisma/contract.prisma). */
type ProductConditionValue =
  | "new"
  | "open_box"
  | "like_new"
  | "excellent"
  | "good"
  | "fair"
  | "refurbished"
  | "for_parts";

/** Validate facet condition theo enum contract. */
const CONDITION_VALUES = [
  "new",
  "open_box",
  "like_new",
  "excellent",
  "good",
  "fair",
  "refurbished",
  "for_parts",
] as const satisfies readonly ProductConditionValue[];

/** Sort hợp lệ của search (ListingSort hôm nay + "relevance" — spec §5.7). */
const SORT_VALUES = ["newest", "price_asc", "price_desc", "popular", "relevance"] as const;

/** Params thô từ URL (searchParams page — giá trị string). */
export type SearchQueryParams = {
  q?: string;
  category?: string;
  brand?: string;
  condition?: string;
  province?: string;
  /** Link legacy (Batch ≤4 dùng ?city=) — map qua FD-1 rule, KHÔNG exact-match text. */
  city?: string;
  min?: string;
  max?: string;
  exchange?: string;
  sort?: string;
};

export type SearchQueryPlan = {
  /** S6 — filter trạng thái (chỉ "approved"). */
  statuses: readonly SearchableListingStatus[];
  /** Dạng chuẩn hóa + spacing variants chữ↔số — build MỘT tsquery OR-joined (S-2). */
  textVariants: string[];
  /** Id brand từ resolution (alias + fallback catalog — Task 5). */
  brandIds: string[];
  /** Id model từ resolution (Task 5). */
  productModelIds: string[];
  /**
   * Mã tỉnh canonical khi buyer CHỌN (explicit preference — spec §5.7 rule 5).
   * Param `city` cũ map qua FD-1 rule (resolveLegacyLocation — Task 2): mapped →
   * code; unmapped → null (mọi khu vực — KHÔNG đoán). KHÔNG có trường boost nào
   * theo province (Review Focus 3 — structural).
   */
  provinceFilter: string | null;
  /** Facet category theo slug (validate chống Category row active ở runSearchQuery). */
  categorySlug: string | null;
  /** Facet brand select theo slug (facet "như hôm nay" — plan thiếu trường, bổ sung). */
  brandSlug: string | null;
  /** Facet condition (enum contract — đã validate). */
  condition: ProductConditionValue | null;
  minPrice: number | null;
  maxPrice: number | null;
  exchangeOnly: boolean;
  sort: "newest" | "price_asc" | "price_desc" | "popular" | "relevance";
  /** Query hợp lệ (không blank/malformed) — false = browsing (loại khỏi metrics). */
  hasQuery: boolean;
};

/**
 * Params thô → plan (PURE — không db, unit test trực tiếp).
 * `resolution` từ Task 5 (resolveSearchQuery) — brand/model IDS chảy vào plan
 * (arm query-text). textVariants được DERIVE TỪ CHÍNH query qua module Task 3
 * (đơn nguồn chuẩn hóa — byte-identical với resolution.textVariants của cùng
 * query) thay vì copy từ resolution: plan luôn nhất quán với q của nó, một
 * resolution lệch không thể làm hỏng arm text.
 * Query malformed/blank → hasQuery: false + textVariants rỗng (browsing —
 * exclusion "malformed query" cấu trúc, spec §5.8.1: không emit, không rate limit).
 */
export function describeSearchQuery(
  params: SearchQueryParams,
  resolution: SearchResolution,
): SearchQueryPlan {
  const rawQ = params.q ?? "";
  const hasQuery = !isMalformedQuery(rawQ);

  // Chuẩn hóa + spacing variants chữ↔số TỪ CHÍNH query (Task 3 — S-2);
  // query malformed/blank → browsing, KHÔNG arm text/id.
  const textVariants = hasQuery ? spacingVariants(normalizeSearchText(rawQ)) : [];
  const brandIds = hasQuery ? resolution.brandIds : [];
  const productModelIds = hasQuery ? resolution.productModelIds : [];

  // Province: param canonical thắng; param city cũ (link legacy) map qua FD-1
  // rule — resolveLegacyLocation của Task 2 (bọc resolveLegacyProvince của
  // registry — MỘT nguồn rule). Mapped → code; unmapped → null (mọi khu vực —
  // KHÔNG đoán, spec §8.3).
  let provinceFilter: string | null = null;
  if (params.province !== undefined && isProvinceCode(params.province)) {
    provinceFilter = params.province;
  } else if (params.city !== undefined && params.city !== "") {
    const resolved = resolveLegacyLocation(params.city);
    if (resolved.source === "legacy_mapped") provinceFilter = resolved.provinceLevelCode;
  }

  const condition =
    params.condition !== undefined && (CONDITION_VALUES as readonly ProductConditionValue[]).includes(params.condition as ProductConditionValue)
      ? (params.condition as ProductConditionValue)
      : null;

  const minPrice = params.min !== undefined && Number(params.min) > 0 ? Number(params.min) : null;
  const maxPrice = params.max !== undefined && Number(params.max) > 0 ? Number(params.max) : null;

  // Sort: "relevance" CHỈ khi hasQuery; giá trị lạ → "newest"; vắng → mặc định
  // (query → "relevance" — ranking textual-first spec §5.7; browsing → "newest").
  let sort: SearchQueryPlan["sort"];
  if (params.sort !== undefined && params.sort !== "") {
    if (params.sort === "relevance") {
      sort = hasQuery ? "relevance" : "newest";
    } else if ((SORT_VALUES as readonly string[]).includes(params.sort)) {
      sort = params.sort as SearchQueryPlan["sort"];
    } else {
      sort = "newest"; // giá trị lạ → newest (KHÔNG relevance ngầm)
    }
  } else {
    sort = hasQuery ? "relevance" : "newest";
  }

  return {
    statuses: SEARCHABLE_LISTING_STATUSES,
    textVariants,
    brandIds,
    productModelIds,
    provinceFilter,
    categorySlug: params.category !== undefined && params.category !== "" ? params.category : null,
    brandSlug: params.brand !== undefined && params.brand !== "" ? params.brand : null,
    condition,
    minPrice,
    maxPrice,
    exchangeOnly: params.exchange === "1",
    sort,
    hasQuery,
  };
}

// ─── runSearchQuery — db (integration test + page) ────────────────────────────

/** Row kết quả search — shape ListingCard tiêu thụ (+ provinceLevelCode). */
export type SearchListingRow = {
  id: string;
  slug: string;
  title: string;
  price: number;
  condition: string;
  city: string;
  status: string;
  viewCount: number;
  acceptExchange: boolean;
  negotiable: boolean;
  provinceLevelCode: string | null;
  images: { url: string }[];
  category: { name: string } | null;
  brand: { name: string } | null;
};

/**
 * CHẠY plan trên db (S-2 ORM form). Facets "như hôm nay": category (active,
 * theo slug — slug lạ → KHÔNG filter), brand (theo slug), condition, province
 * (canonical — unresolved legacy rows chỉ hiện ở "all locations"), price,
 * exchange. hasQuery → OR(fullTextMatches(searchTextNormalized, tsq),
 * brandId ∈ resolution.brandIds, productModelId ∈ resolution.productModelIds)
 * — id arm tìm listing mà TEXT không mang query (alias-resolved).
 * Order: sort "relevance" (chỉ có thể khi hasQuery) → fullTextRank(tsq) desc rồi
 * createdAt desc (spec §5.7 ranking 1 + 4; status là filter, quality là seam
 * Batch 4 ghi chú ở đầu module); else 4 sort hiện có.
 */
export async function runSearchQuery(plan: SearchQueryPlan): Promise<{
  listings: SearchListingRow[];
  resultCount: number;
}> {
  let listQuery = db.orm.public.Listing
    .select(
      "id", "title", "slug", "price", "condition", "city", "status",
      "viewCount", "acceptExchange", "negotiable", "provinceLevelCode",
    )
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name"))
    .include("brand", (b) => b.select("name"))
    // S-6 seam: trạng thái searchable (chỉ approved — drift test pin)
    .where((l) => l.status.in([...plan.statuses]));

  // Facets — validate slug chống DB row (trust boundary: slug từ URL là input).
  if (plan.categorySlug !== null) {
    const category = await db.orm.public.Category
      .where({ slug: plan.categorySlug, isActive: true })
      .first();
    if (category !== null) listQuery = listQuery.where({ categoryId: category.id });
  }
  if (plan.brandSlug !== null) {
    const brand = await db.orm.public.Brand.first({ slug: plan.brandSlug });
    if (brand !== null) listQuery = listQuery.where({ brandId: brand.id });
  }
  if (plan.condition !== null) listQuery = listQuery.where({ condition: plan.condition });
  if (plan.provinceFilter !== null) {
    listQuery = listQuery.where({ provinceLevelCode: plan.provinceFilter });
  }
  if (plan.exchangeOnly) listQuery = listQuery.where({ acceptExchange: true });
  if (plan.minPrice !== null) listQuery = listQuery.where((l) => l.price.gte(plan.minPrice!));
  if (plan.maxPrice !== null) listQuery = listQuery.where((l) => l.price.lte(plan.maxPrice!));

  // S-2: MỘT tsquery OR-joined từ textVariants — dùng cho CẢ match VÀ rank.
  // S-1: language "simple" hai phía (index contract === query — pin "loa do").
  const tsq = plan.hasQuery
    ? websearchToTsquery(plan.textVariants.join(" or "), { language: "simple" })
    : null;

  if (plan.hasQuery && tsq !== null) {
    listQuery = listQuery.where((l) =>
      or(
        l.searchTextNormalized.fullTextMatches(tsq, { language: "simple" }),
        ...(plan.brandIds.length > 0 ? [l.brandId.in(plan.brandIds)] : []),
        ...(plan.productModelIds.length > 0 ? [l.productModelId.in(plan.productModelIds)] : []),
      ),
    );
  }

  switch (plan.sort) {
    case "relevance":
      if (tsq !== null) {
        // textual relevance trước, freshness tiebreak (spec §5.7 ranking 1 + 4)
        listQuery = listQuery.orderBy([
          (l) => l.searchTextNormalized.fullTextRank(tsq, { language: "simple" }).desc(),
          (l) => l.createdAt.desc(),
        ]);
        break;
      }
      // sort relevance không thể có khi !hasQuery (describeSearchQuery đã chặn) —
      // plan tay thiếu textVariants → fallback freshness (fail closed về sort cũ)
      listQuery = listQuery.orderBy((l) => l.createdAt.desc());
      break;
    case "price_asc":
      listQuery = listQuery.orderBy((l) => l.price.asc());
      break;
    case "price_desc":
      listQuery = listQuery.orderBy((l) => l.price.desc());
      break;
    case "popular":
      listQuery = listQuery.orderBy((l) => l.viewCount.desc());
      break;
    default:
      listQuery = listQuery.orderBy((l) => l.createdAt.desc());
      break;
  }

  const listings = (await listQuery.limit(60).all()) as SearchListingRow[];
  // resultCount = số kết quả trang hiển thị (limit 60 — cùng con số trang render
  // hôm nay; zero-result ⟺ tổng 0 nên recovery/metrics không sai lệch).
  return { listings, resultCount: listings.length };
}
