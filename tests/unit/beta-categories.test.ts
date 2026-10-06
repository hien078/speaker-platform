/**
 * Beta category allowlist (Batch 4 Task 2 — spec §5.6.1) — unit tests.
 *
 * Server-owned category publication allowlist — KHÔNG env, KHÔNG client flag:
 *  - `BETA_PUBLICATION_CATEGORIES` đúng giá trị nguyên văn spec §5.6.1
 *    (`portable_bluetooth_speaker`) — đổi list là product decision, test pin.
 *  - `listingRegimeForCategorySlug`: slug ∈ allowlist → "beta"; mọi slug khác
 *    → "legacy" (regime derive thuần từ category — Legacy Migration Decisions).
 *  - `assertCategoryPublicationAllowed` (allowlist invariant — spec §5.6.1/§8):
 *      * tạo mới (không current) → target PHẢI ∈ allowlist;
 *      * đổi category chỉ được đổi INTO allowlist;
 *      * giữ nguyên category legacy = grandfathered (đi qua).
 *
 * Pure module — KHÔNG db trong import chain (beta-categories.ts là plain module
 * để seed script tsx import được — Batch 2 admin-mfa-key.ts precedent).
 */
import { describe, expect, it } from "vitest";
import {
  BETA_PUBLICATION_CATEGORIES,
  assertCategoryPublicationAllowed,
  listingRegimeForCategorySlug,
} from "@/src/lib/beta-categories";

const BETA_SLUG = "portable_bluetooth_speaker";
const LEGACY_SLUG = "loa-bluetooth"; // seed hiện có — A11: founder quyết, KHÔNG tự tắt
const OTHER_LEGACY_SLUG = "loa-thung-pa";

/** Gọi và bắt message — assertCategoryPublicationAllowed throw Error(code) typed. */
const expectCategoryError = (fn: () => void, code: string): void => {
  expect(fn).toThrowError(code);
};

// ─── 1. Allowlist constant — spec §5.6.1 verbatim ──────────────────────────────

describe("BETA_PUBLICATION_CATEGORIES — spec §5.6.1 verbatim", () => {
  it("is exactly [\"portable_bluetooth_speaker\"]", () => {
    expect(BETA_PUBLICATION_CATEGORIES).toEqual(["portable_bluetooth_speaker"]);
    expect(BETA_PUBLICATION_CATEGORIES).toHaveLength(1);
  });
});

// ─── 2. Regime derivation — thuần từ category slug ─────────────────────────────

describe("listingRegimeForCategorySlug", () => {
  it("beta slug → \"beta\"", () => {
    expect(listingRegimeForCategorySlug(BETA_SLUG)).toBe("beta");
  });

  it("mọi slug khác → \"legacy\" (kể cả slug legacy seed + slug bịa)", () => {
    expect(listingRegimeForCategorySlug(LEGACY_SLUG)).toBe("legacy");
    expect(listingRegimeForCategorySlug(OTHER_LEGACY_SLUG)).toBe("legacy");
    expect(listingRegimeForCategorySlug("")).toBe("legacy");
    expect(listingRegimeForCategorySlug("Portable_Bluetooth_Speaker")).toBe("legacy");
    expect(listingRegimeForCategorySlug("portable-bluetooth-speaker")).toBe("legacy");
  });
});

// ─── 3. Allowlist invariant — assertCategoryPublicationAllowed ────────────────

describe("assertCategoryPublicationAllowed — allowlist invariant (spec §5.6.1)", () => {
  it("tạo mới trong slug legacy → CATEGORY_NOT_PUBLICATION_ALLOWED", () => {
    expectCategoryError(
      () => assertCategoryPublicationAllowed({ targetSlug: LEGACY_SLUG }),
      "CATEGORY_NOT_PUBLICATION_ALLOWED",
    );
    expectCategoryError(
      () => assertCategoryPublicationAllowed({ targetSlug: OTHER_LEGACY_SLUG }),
      "CATEGORY_NOT_PUBLICATION_ALLOWED",
    );
  });

  it("tạo mới trong slug beta → passes", () => {
    expect(() =>
      assertCategoryPublicationAllowed({ targetSlug: BETA_SLUG }),
    ).not.toThrow();
  });

  it("đổi category legacy → legacy slug khác → CATEGORY_NOT_PUBLICATION_ALLOWED", () => {
    expectCategoryError(
      () =>
        assertCategoryPublicationAllowed({
          targetSlug: OTHER_LEGACY_SLUG,
          currentSlug: LEGACY_SLUG,
        }),
      "CATEGORY_NOT_PUBLICATION_ALLOWED",
    );
  });

  it("đổi category legacy → beta slug → passes (chỉ được đổi INTO allowlist)", () => {
    expect(() =>
      assertCategoryPublicationAllowed({
        targetSlug: BETA_SLUG,
        currentSlug: LEGACY_SLUG,
      }),
    ).not.toThrow();
  });

  it("giữ nguyên category legacy → passes (grandfathered)", () => {
    expect(() =>
      assertCategoryPublicationAllowed({
        targetSlug: LEGACY_SLUG,
        currentSlug: LEGACY_SLUG,
      }),
    ).not.toThrow();
  });

  it("giữ nguyên category beta → passes", () => {
    expect(() =>
      assertCategoryPublicationAllowed({
        targetSlug: BETA_SLUG,
        currentSlug: BETA_SLUG,
      }),
    ).not.toThrow();
  });

  it("current KHÔNG được mở đường cho target ngoài allowlist (current ≠ target)", () => {
    // current beta nhưng target legacy ≠ current → vẫn chặn (không có đường
    // "ra khỏi" allowlist qua category change)
    expectCategoryError(
      () =>
        assertCategoryPublicationAllowed({
          targetSlug: LEGACY_SLUG,
          currentSlug: BETA_SLUG,
        }),
      "CATEGORY_NOT_PUBLICATION_ALLOWED",
    );
  });
});
