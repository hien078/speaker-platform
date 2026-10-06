/**
 * Beta category publication allowlist (Batch 4 Task 2 — spec §5.6.1) —
 * server-owned constant, KHÔNG env, KHÔNG client flag.
 *
 * PLAIN MODULE (FD-1 precedent — Batch 2 admin-mfa-key.ts): KHÔNG import db,
 * KHÔNG "server-only" — seed script offline (scripts/seed-beta-catalog.ts,
 * Task 7) import được dưới tsx. Client component KHÔNG import module này
 * (spec §4.5 — allowlist là backend enforcement, form chỉ nhận props).
 *
 * Allowlist invariant (Legacy Migration Decisions — spec §8/§5.6.1):
 *  - KHÔNG listing nào được TẠO trong (hoặc CHUYỂN vào) category ngoài
 *    allowlist; listing giữ nguyên category legacy thì grandfathered.
 *  - Regime validation derive THUẦN TỪ category slug: beta ⇒ full structured
 *    validation; legacy ⇒ chỉ rule hiện có. Category change chỉ được INTO
 *    allowlist (và khi đó full beta validation chạy trên toàn bộ input).
 *
 * Giá trị nguyên văn spec §5.6.1 (`portable_bluetooth_speaker` — snake_case,
 * KHÔNG qua slugify() — slugify strip "_" và làm hỏng khóa; A11). Thêm category
 * beta công khai khác = explicit product decision (spec §5.6.1) — đổi list là
 * đổi product, test pin giá trị.
 */

/** Spec §5.6.1 verbatim — khóa theo Category.slug. */
export const BETA_PUBLICATION_CATEGORIES = ["portable_bluetooth_speaker"] as const;

export type BetaPublicationCategory = (typeof BETA_PUBLICATION_CATEGORIES)[number];

const BETA_SLUG_SET: ReadonlySet<string> = new Set(BETA_PUBLICATION_CATEGORIES);

/**
 * Regime validation của một category (spec §5.6/§8):
 *  - "beta"  ⇒ full structured validation (brand/model/structured/province/…);
 *  - "legacy" ⇒ chỉ rule hiện có của createListingAction/updateListingAction
 *    (grandfathered — legacy listing giữ nguyên hành vi, Review Focus 5).
 */
export type ListingRegime = "beta" | "legacy";

/** slug ∈ BETA_PUBLICATION_CATEGORIES → "beta"; mọi slug khác → "legacy". */
export function listingRegimeForCategorySlug(slug: string): ListingRegime {
  return BETA_SLUG_SET.has(slug) ? "beta" : "legacy";
}

export type CategoryPublicationInput = {
  /** Category slug ĐÍCH (từ DB row — KHÔNG tin formData cho giá trị gate). */
  targetSlug: string;
  /** Category slug HIỆN TẠI của listing (từ DB row); undefined khi tạo mới. */
  currentSlug?: string;
};

/**
 * Allowlist invariant (spec §5.6.1 — throw Error("CATEGORY_NOT_PUBLICATION_ALLOWED")):
 *  - target ∉ allowlist && target !== current → throw;
 *  - tạo mới (không current) → target PHẢI ∈ allowlist;
 *  - đổi category chỉ được đổi INTO allowlist;
 *  - giữ nguyên category legacy (target === current) → grandfathered, passes.
 */
export function assertCategoryPublicationAllowed(
  input: CategoryPublicationInput,
): void {
  const allowed =
    BETA_SLUG_SET.has(input.targetSlug) ||
    (input.currentSlug !== undefined && input.targetSlug === input.currentSlug);
  if (!allowed) {
    throw new Error("CATEGORY_NOT_PUBLICATION_ALLOWED");
  }
}
