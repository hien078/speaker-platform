import "server-only";

import { db } from "@/src/prisma/db.client";
import {
  compactForm,
  normalizeSearchText,
  spacingVariants,
} from "@/src/lib/search-normalize";

/**
 * Alias resolution (Batch 5 Task 5 — spec §5.7) — giải query thô thành
 * structured ids cho search (Task 7 `src/lib/search-query.ts`). Mechanism
 * sống ở đây; CONTENT của `SearchAlias` thuộc Batch 4 seed / Batch 8
 * model-seed review (A7) — seed offline `scripts/seed-search-aliases.ts`
 * (S9) chỉ nhận content founder cung cấp.
 *
 * Matching (B6/S-3) — WHOLE-QUERY equality, KHÔNG phải token-subset, KHÔNG
 * prefix (prefix match `tsquery\`${token}:*\`` là biến thể optional của
 * Task 7 — quyết định BỎ qua: giữ resolution tối thiểu, ghi ở report):
 *   1. EXACT: normalizeSearchText(query) === SearchAlias.alias → target ids
 *      (alias lưu DẠNG CHUẨN HÓA — seed chuẩn hóa trước khi ghi).
 *   2. SPACING: mỗi spacingVariants(q) (ranh giới chữ↔số, Task 3) === alias.
 *   3. COMPACT (B6): compactForm(q) === compactForm(alias) — đóng kín khoảng
 *      trống chữ↔chữ mà spacingVariants cố tình không sinh: ví dụ soundlink↔
 *      "sound link" của spec §5.7 sống Ở ĐÂY.
 *   4. FALLBACK CATALOG (S-3): whole-query equality (exact/spacing/compact)
 *      của TOÀN BỘ query chuẩn hóa (hoặc một variant) với Brand.name /
 *      ProductModel.name (approved) → ids. KHÔNG OR toàn bộ brand listings
 *      khi query gọi tên một model — chỉ id của chính brand/model được gọi
 *      tên; model pending KHÔNG resolve (SEARCHABLE_MODEL_STATUSES).
 *
 * corrections #16: mergeModelAction (Batch 4 `src/lib/actions/catalog.ts`)
 * set status=merged + mergedIntoId NHƯNG KHÔNG viết lại alias — alias có thể
 * trỏ model đã chết. Resolution FOLLOW mergedIntoId (chuỗi merge, guard
 * vòng) và model CUỐI PHẢI approved — model pending / merged không còn đích
 * → KHÔNG resolve (filter to approved). (FK SearchAlias→ProductModel đã
 * onDelete: Cascade từ Task 1 — alias trỏ id đã bị xoá là rác đã dọn.)
 *
 * spec §4.8: query là FREE TEXT — resolution KHÔNG trả về query thô (chỉ
 * textVariants CHUẨN HÓA cho tsquery của Task 7), KHÔNG log query/alias.
 *
 * Scale (P0 beta): bảng alias là content founder-reviewed (A7), catalog nhỏ
 * — load toàn bộ per search chấp nhận được (cùng ghi chú ở fallback catalog);
 * ghi chú scale cho post-beta review nằm ở verification doc của Task 11.
 */

/** Fallback catalog chỉ duyệt model approved (seam cho Batch 4 — S-3). */
export const SEARCHABLE_MODEL_STATUSES = ["approved"] as const;

export type SearchResolution = {
  /** Dạng chuẩn hóa + spacing variants chữ↔số — build MỘT tsquery OR-joined (Task 7). */
  textVariants: string[];
  /** Id brand từ SearchAlias(target=brand) + fallback catalog match. */
  brandIds: string[];
  /** Id model từ SearchAlias(target=model) + fallback catalog match. */
  productModelIds: string[];
};

/** Query rỗng/blank → resolution rỗng (browsing — Task 7 gate malformed query). */
const EMPTY_RESOLUTION: SearchResolution = {
  textVariants: [],
  brandIds: [],
  productModelIds: [],
};

/**
 * Whole-query equality (S-3): candidate (alias/catalog name) khớp query khi
 * dạng CHUẨN HÓA của nó bằng dạng chuẩn hóa của query, bằng MỘT spacing
 * variant, hoặc compact form hai bên bằng nhau (B6). KHÔNG token-subset,
 * KHÔNG prefix — candidate rỗng sau chuẩn hóa không bao giờ khớp.
 */
function matchesWholeQuery(
  candidate: string,
  normalized: string,
  variants: readonly string[],
  compact: string,
): boolean {
  const candidateNormalized = normalizeSearchText(candidate);
  if (candidateNormalized === "") return false;
  if (candidateNormalized === normalized) return true;
  if (variants.includes(candidateNormalized)) return true;
  return compactForm(candidateNormalized) === compact;
}

/**
 * corrections #16 — alias trỏ model có thể đã bị merge: follow mergedIntoId
 * (chuỗi, guard vòng bằng seen-set) cho tới model sống; model cuối PHẢI
 * approved mới resolve (filter to approved — model pending/merged-chết
 * không có listing nào tìm được nữa). Trả về id các model GỐC approved.
 */
async function resolveCanonicalModelIds(modelIds: Iterable<string>): Promise<string[]> {
  const resolved: string[] = [];
  let frontier = [...new Set(modelIds)];
  const seen = new Set<string>(frontier);
  while (frontier.length > 0) {
    const rows = await db.orm.public.ProductModel.where((m) => m.id.in(frontier)).all();
    frontier = [];
    for (const row of rows) {
      if (row.status === "approved") {
        resolved.push(row.id);
      } else if (row.status === "merged" && row.mergedIntoId !== null && !seen.has(row.mergedIntoId)) {
        seen.add(row.mergedIntoId);
        frontier.push(row.mergedIntoId);
      }
    }
  }
  return resolved;
}

/**
 * Giải query thô → structured ids (spec §5.7). KHÔNG trả về/persist query
 * text (spec §4.8 — query là free text; textVariants là dạng ĐÃ CHUẨN HÓA
 * cho tsquery của Task 7). Query blank → resolution rỗng, KHÔNG đụng db.
 */
export async function resolveSearchQuery(rawQuery: string): Promise<SearchResolution> {
  const normalized = normalizeSearchText(rawQuery);
  if (normalized === "") return { ...EMPTY_RESOLUTION };

  const variants = spacingVariants(normalized);
  const compact = compactForm(normalized);

  const brandIds = new Set<string>();
  const productModelIds = new Set<string>();
  const aliasModelIds = new Set<string>();

  // 1–3: alias matching (exact + spacing + compact — B6). Bảng alias là
  // content founder-reviewed (A7/S9) — nhỏ ở beta scale, load toàn bộ per
  // search (compact/spacing matching tính trong TS, query builder không
  // express được compactForm).
  const aliases = await db.orm.public.SearchAlias.all();
  for (const row of aliases) {
    if (!matchesWholeQuery(row.alias, normalized, variants, compact)) continue;
    if (row.target === "brand" && row.brandId !== null) {
      brandIds.add(row.brandId);
    } else if (row.target === "model" && row.productModelId !== null) {
      aliasModelIds.add(row.productModelId);
    }
  }

  // 4: fallback catalog (S-3) — whole-query equality với Brand.name +
  // ProductModel.name (approved). P0 catalog nhỏ; per-search load chấp nhận
  // được ở beta scale (chuẩn hóa/compact trong TS — cùng lý do như alias).
  const brands = await db.orm.public.Brand.all();
  for (const brand of brands) {
    if (matchesWholeQuery(brand.name, normalized, variants, compact)) {
      brandIds.add(brand.id);
    }
  }
  const models = await db.orm.public.ProductModel
    .where((m) => m.status.in([...SEARCHABLE_MODEL_STATUSES]))
    .all();
  for (const model of models) {
    if (matchesWholeQuery(model.name, normalized, variants, compact)) {
      productModelIds.add(model.id);
    }
  }

  // corrections #16: id model từ alias → canonical (follow mergedIntoId,
  // filter approved) — fallback catalog đã lọc approved từ đầu.
  for (const id of await resolveCanonicalModelIds(aliasModelIds)) {
    productModelIds.add(id);
  }

  return {
    textVariants: variants,
    brandIds: [...brandIds],
    productModelIds: [...productModelIds],
  };
}
