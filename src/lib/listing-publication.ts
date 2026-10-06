/**
 * Listing publication wrapper (Batch 4 Task 2 — spec §5.6.1/§5.6/§4.4) — HAI hàm
 * xuất, mọi publication transition dùng chung (extend Batch 2 gate — KHÔNG
 * duplicate; R6: Batch 3 thêm `account_not_suspended` vào
 * seller-verification-policy.ts thì wrapper tự kế thừa).
 *
 * Server-only domain module (KHÔNG "use server" — không phải action). Client
 * component KHÔNG BAO GIỜ import (db + gate). Trust boundary (Global
 * Constraints): `currentCategorySlug` (và mọi trường gate) luôn từ DB row —
 * caller đọc listing.categoryId → Category; targetSlug resolve từ DB theo
 * input.categoryId (KHÔNG tin formData cho giá trị gate).
 *
 * Thứ tự cố định (throw code ĐẦU TIÊN sai):
 *  - `assertListingPublishable`:  seller → [content: category → schema →
 *    model → images] — dùng bởi create/submit/update-into-pending/toggle
 *    hidden→approved (Task 4).
 *  - `assertListingContentValid`: category → schema → model → images — dùng
 *    bởi non-transition update (item 1: update không chuyển trạng thái vẫn
 *    validate content).
 *  - `checkListingPublication`: KHÔNG throw — dùng BỞI approveListingAction
 *    (DUY NHẤT — một cơ chế một consumer, tránh mơ hồ) để build
 *    { sellerMissing, listingIssues } cho audit hai reason tách bạch
 *    (publication_requirements_unmet + missing=… / listing_content_invalid +
 *    issues=… — Task 4).
 *
 * PII (spec §4.8): mọi code lỗi là typed code — KHÔNG free text/PII trong
 * AuditEvent.detail (redactDetail ở caller).
 */
import "server-only";
import { db } from "@/src/prisma/db.client";
import {
  assertCategoryPublicationAllowed,
  listingRegimeForCategorySlug,
  type ListingRegime,
} from "@/src/lib/beta-categories";
import {
  validateListingSubmission,
  type ListingSubmissionInput,
} from "@/src/lib/listing-schema";
import { assertListingImagesOwned } from "@/src/lib/listing-images";
import {
  assertSellerPublicationAllowed,
  checkSellerPublicationRequirements,
  type SellerPublicationRequirement,
} from "@/src/lib/seller-verification-policy";

export type ListingPublicationInput = ListingSubmissionInput & {
  sellerId: string;
  listingId?: string;
  /** Category slug HIỆN TẠI của listing (từ DB row — KHÔNG formData). */
  currentCategorySlug?: string;
};

export type ListingPublicationCheck = {
  ok: boolean;
  /** Từ Batch 2 checkSellerPublicationRequirements (8 yêu cầu — R6 inherit). */
  sellerMissing: SellerPublicationRequirement[];
  /** LISTING_VALIDATION_FAILED / CATEGORY_* / MODEL_* / IMAGE_* codes. */
  listingIssues: string[];
};

/** Typed code của một error publication (message LÀ code — KHÔNG PII). */
const codeOf = (e: unknown): string => {
  if (e instanceof Error && e.message.length > 0) return e.message;
  return "UNKNOWN";
};

// ─── Canonical model — B4 DB check (spec §6.3 Step 1) ──────────────────────────

export type CanonicalModelInput = {
  productModelId?: string | null;
  brandId?: string | null;
  categoryId: string;
  regime: ListingRegime;
};

/**
 * Canonical model DB check (B4 — không chỉ zod presence): productModelId cung
 * cấp → ProductModel row PHẢI tồn tại + status "approved" (pending/merged →
 * MODEL_INVALID); brandId cung cấp → model.brandId PHẢI = brandId (sai →
 * MODEL_BRAND_MISMATCH); regime "beta" → model.categoryId PHẢI = categoryId
 * (category beta — sai → MODEL_INVALID). Regime "legacy": model check chỉ khi
 * seller cung cấp productModelId (tùy chọn như hôm nay — KHÔNG so category).
 */
export async function assertCanonicalModelValid(
  input: CanonicalModelInput,
): Promise<void> {
  const modelId = input.productModelId ?? null;
  if (modelId === null || modelId.length === 0) return; // legacy optional; beta required do schema

  const model = await db.orm.public.ProductModel.first({ id: modelId });
  if (model === null || model.status !== "approved") {
    throw new Error("MODEL_INVALID");
  }
  if (input.brandId !== null && input.brandId !== undefined && input.brandId.length > 0) {
    if (model.brandId !== input.brandId) {
      throw new Error("MODEL_BRAND_MISMATCH");
    }
  }
  if (input.regime === "beta" && model.categoryId !== input.categoryId) {
    throw new Error("MODEL_INVALID");
  }
}

// ─── Content validity — category → schema → model → images ─────────────────────

/**
 * Chạy TẤT CẢ content stage và thu code lỗi từng stage (thứ tự cố định:
 * category → schema → model → images). Dùng chung bởi bản throw
 * (assertListingContentValid — code đầu tiên) và bản non-throw
 * (checkListingPublication — đầy đủ cho audit).
 */
const collectListingContentIssues = async (
  input: ListingPublicationInput,
): Promise<string[]> => {
  const issues: string[] = [];

  // (1) category — target slug resolve TỪ DB theo input.categoryId (trust
  //     boundary: KHÔNG tin formData cho slug); allowlist invariant.
  let regime: ListingRegime | null = null;
  try {
    const category = await db.orm.public.Category.first({ id: input.categoryId });
    if (category === null) throw new Error("CATEGORY_NOT_FOUND");
    assertCategoryPublicationAllowed({
      targetSlug: category.slug,
      currentSlug: input.currentCategorySlug,
    });
    regime = listingRegimeForCategorySlug(category.slug);
  } catch (e) {
    issues.push(codeOf(e));
  }

  // (2) schema theo regime của target slug; (3) model; (4) images — chỉ chạy
  //     khi category resolve được regime (category sai đã được thu ở trên).
  if (regime !== null) {
    try {
      validateListingSubmission(input, regime);
    } catch (e) {
      issues.push(codeOf(e));
    }
    try {
      await assertCanonicalModelValid({
        productModelId: input.productModelId,
        brandId: input.brandId,
        categoryId: input.categoryId,
        regime,
      });
    } catch (e) {
      issues.push(codeOf(e));
    }
    try {
      await assertListingImagesOwned({
        sellerId: input.sellerId,
        listingId: input.listingId,
        imageUrls: input.imageUrls,
        imageSlots: input.imageSlots,
      });
    } catch (e) {
      issues.push(codeOf(e));
    }
  }

  return issues;
};

/**
 * Content validity (category allowlist + regime schema + canonical-model DB
 * check + image ownership) — throw code ĐẦU TIÊN sai. Dùng bởi non-transition
 * update (item 1) và bên trong assertListingPublishable.
 */
export async function assertListingContentValid(
  input: ListingPublicationInput,
): Promise<void> {
  const issues = await collectListingContentIssues(input);
  if (issues.length > 0) {
    throw new Error(issues[0]!);
  }
}

/**
 * Non-throwing — dùng BỞI approveListingAction (duy nhất) để build danh sách
 * thiếu cho audit (reason publication_requirements_unmet + missing=… khi
 * seller thiếu; listing_content_invalid + issues=… khi content sai — Task 4).
 * Seller gate qua Batch 2 checkSellerPublicationRequirements (đọc FRESH từ DB).
 */
export async function checkListingPublication(
  input: ListingPublicationInput,
): Promise<ListingPublicationCheck> {
  const sellerCheck = await checkSellerPublicationRequirements(input.sellerId);
  const listingIssues = await collectListingContentIssues(input);
  return {
    ok: sellerCheck.missing.length === 0 && listingIssues.length === 0,
    sellerMissing: sellerCheck.missing,
    listingIssues,
  };
}

// ─── Full publication gate — seller → content ─────────────────────────────────

/**
 * = Batch 2 `assertSellerPublicationAllowed` (Seller Verification Policy v1 —
 * 8 yêu cầu incl. Batch 3 `account_not_suspended`, inheritable per R6; beta
 * cohort; đọc FRESH từ DB) + `assertListingContentValid`. Throw code đầu tiên
 * sai — thứ tự cố định: seller → category → schema → model → images. Dùng bởi
 * create/submit/update-into-pending/toggle hidden→approved (Task 4).
 */
export async function assertListingPublishable(
  input: ListingPublicationInput,
): Promise<void> {
  await assertSellerPublicationAllowed(input.sellerId);
  await assertListingContentValid(input);
}
