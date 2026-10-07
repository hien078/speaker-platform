/**
 * Listing submission schema (Batch 4 Task 2 — spec §5.6/§6.3) — zod + constants.
 *
 * PLAIN MODULE (B2 — Next 16 "use server" chỉ export async function nên
 * `export const` rate constants/schemas sống ở đây, KHÔNG phải trong action):
 * KHÔNG "server-only", KHÔNG import db — import được bởi client-side tooling
 * và script tsx. Client form KHÔNG import module này (spec §4.5 — categories/
 * labels/slots/provinces đến từ props của server page); đây là ranh giới
 * validation server-side.
 *
 * Ba regime schema (conditional-fields gate — Review Focus 3):
 *  - `betaListingSubmissionSchema` (regime "beta"): requiredness đầy đủ theo
 *    spec §6.3 — brand + canonical model (Step 1), inventoryContext (§5.6),
 *    condition, fulfillment ≥1 (Step 4), provinceLevelCode ∈ 34 mã registry
 *    (isProvinceCode — FD-1) + locationDisplayName (§5.9), ≥1 ảnh (rule hiện
 *    có), free-text ≤ FREE_TEXT_MAX, description ≤ DESCRIPTION_MAX.
 *  - `legacyListingEditSchema` (regime "legacy"): CHỈ rule đang chạy trong
 *    createListingAction/updateListingAction hôm nay (title 8–120, description
 *    ≥20, price bounds, ≥1 ảnh) — KHÔNG thêm requiredness (legacy listing giữ
 *    nguyên hành vi, spec §8/§8.3 — Review Focus 5); NHƯNG structured fields
 *    MỚI được validate-WHEN-PRESENT (review fix MEDIUM — xem
 *    checkStructuredWhenPresent) vì base object type chúng unbounded.
 *  - `draftListingSchema`: base requiredness (cột NON-NULL hiện có của Listing
 *    + province — city derive từ province, item 12) + structured TUYỆN CHỌN +
 *    images 0..8 (≥1 ảnh là rule của SUBMIT, không phải của draft).
 *
 * Mã lỗi ổn định (throw Error("LISTING_VALIDATION_FAILED:<code>") qua
 * validateListingSubmission) — KHÔNG free text tuỳ ý; code dùng cho test +
 * redirect ?error= + audit reason.
 *
 * Location (spec §4.7/§5.6): locationDisplayName capped ≤120, KHÔNG detect
 * "địa chỉ nhà riêng" bằng validation (không thể validate tin cậy — guidance
 * sống ở UI copy, Task 5). KHÔNG có price suggestion/estimation (§13.6/§13.7).
 */
import { z } from "zod";
import { isProvinceCode } from "@/src/lib/provinces";
import type { ListingRegime } from "@/src/lib/beta-categories";

// ─── Constants (spec §5.2/§5.6.3/§7.1 — non-invention pins) ───────────────────

/** Mapping từ §5.2 (Deal fulfillment methods) — recorded decision A7. */
export const LISTING_FULFILLMENT_METHODS = [
  "meetup",
  "seller_delivery",
  "carrier",
  "other",
] as const;
export type ListingFulfillmentMethod = (typeof LISTING_FULFILLMENT_METHODS)[number];

/** §5.6.3 verbatim — 8 slot, KHÔNG thêm/bớt (spec §4.11 non-invention). */
export const PHOTO_CHECKLIST_SLOTS = [
  "front",
  "back",
  "control_panel",
  "ports",
  "damage",
  "accessories",
  "box",
  "label_serial",
] as const;
export type PhotoChecklistSlot = (typeof PHOTO_CHECKLIST_SLOTS)[number];

/** 20/h/user — create/draft/submit (§7.1 "listing mutation"). */
export const LISTING_MUTATION_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;

/** 60/h/user — bucket CHUNG `listing:mutation:<userId>` cho update/toggle/delete (§7.1). */
export const LISTING_EDIT_RATE = { limit: 60, windowMs: 60 * 60_000 } as const;

/** includedAccessories/knownDefects/repairHistory — bound chống unbounded rows. */
export const FREE_TEXT_MAX = 2_000;

/** description — bound chống unbounded rows (validation addition của Batch 4). */
export const DESCRIPTION_MAX = 4_000;

/**
 * brandId/productModelId — bound chiều dài FK (L4 — review fix 2): Brand.id /
 * ProductModel.id là uuid() 36 ký tự, 64 = headroom cho format id khác (cuid
 * 25, ulid 26). Chống unbounded id string vào Listing.brandId/productModelId
 * write path; áp validate-WHEN-PRESENT cho CẢ BA regime (cùng limits — legacy
 * KHÔNG chặt hơn draft), KHÔNG thêm requiredness.
 */
export const FOREIGN_ID_MAX = 64;

/** locationDisplayName — hiển thị thô, KHÔNG phải địa chỉ nhà riêng (spec §5.6). */
export const LOCATION_DISPLAY_MAX = 120;

/** Tối đa 8 ảnh — rule hiện có của createListingAction ("Tối đa 8 ảnh"). */
export const LISTING_MAX_IMAGES = 8;

/** Price bounds — copy nguyên validation hiện tại, KHÔNG siết (no invented pricing policy). */
const PRICE_MIN = 100_000;
const PRICE_MAX = 2_000_000_000;

/**
 * Giá trị enum `product_condition` (contract.prisma) — mirror cho zod enum
 * (labels hiển thị sống ở src/lib/constants.ts CONDITION_LABELS).
 */
export const PRODUCT_CONDITIONS = [
  "new",
  "open_box",
  "like_new",
  "excellent",
  "good",
  "fair",
  "refurbished",
  "for_parts",
] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

/** Giá trị enum `inventory_context` (Batch 4 migration — spec §5.6). */
export const INVENTORY_CONTEXTS = ["new", "open_box", "used"] as const;
export type InventoryContext = (typeof INVENTORY_CONTEXTS)[number];

// ─── Input type ────────────────────────────────────────────────────────────────

export type ListingSubmissionInput = {
  title: string;
  description: string;
  categoryId: string;
  brandId?: string | null;
  productModelId?: string | null;
  condition: string;
  price: number;
  negotiable: boolean;
  inventoryContext?: string | null;
  includedAccessories?: string | null;
  knownDefects?: string | null;
  repairHistory?: string | null;
  fulfillmentMethods?: string[] | null;
  provinceLevelCode?: string | null;
  locationDisplayName?: string | null;
  imageUrls: string[];
  imageSlots?: (string | null)[];
};

// ─── Schema building blocks ───────────────────────────────────────────────────

/**
 * Base object — types LỎNG (requiredness/semantic checks sống ở superRefine
 * để code lỗi ổn định + thứ tự deterministic). Type-mismatch (programming error
 * của caller) fail với zod message chuẩn — fail closed.
 *
 * price: zod 4 `z.number()` REJECT NaN/±Infinity ngay ở base parse (message
 * zod chuẩn, không phải code ổn định) — nhưng action hôm nay chuyển
 * `Number(formData.get("price"))` nên NaN/±Infinity là input NGƯỜI DÙNG thật,
 * và rule hiện tại (`!Number.isFinite(price)` → "Giá từ 100.000₫…") phải ra
 * PRICE_INVALID. Union dưới cho non-finite đi TỚI superRefine (checkPrice).
 */
const priceBase = z.union([z.number(), z.nan(), z.literal(Infinity), z.literal(-Infinity)]);

const listingBaseObject = z.object({
  title: z.string(),
  description: z.string(),
  categoryId: z.string(),
  brandId: z.string().optional().nullable(),
  productModelId: z.string().optional().nullable(),
  condition: z.string(),
  price: priceBase,
  negotiable: z.boolean(),
  inventoryContext: z.string().optional().nullable(),
  includedAccessories: z.string().optional().nullable(),
  knownDefects: z.string().optional().nullable(),
  repairHistory: z.string().optional().nullable(),
  fulfillmentMethods: z.array(z.string()).optional().nullable(),
  provinceLevelCode: z.string().optional().nullable(),
  locationDisplayName: z.string().optional().nullable(),
  imageUrls: z.array(z.string()),
  imageSlots: z.array(z.string().nullable()).optional(),
});

type ListingBase = z.infer<typeof listingBaseObject>;
type RefineCtx = z.RefinementCtx;

/**
 * Blank check — type guard: true branch = null/undefined/empty (missing),
 * else branch narrowing về `string` (giá trị có nội dung) cho các check sau.
 */
const isBlank = (v: string | null | undefined): v is null | undefined =>
  v === null || v === undefined || v.trim().length === 0;

/** issue helper — message LÀ typed code (ổn định cho test/audit/redirect). */
const issue = (ctx: RefineCtx, path: string, message: string): void => {
  ctx.addIssue({ code: "custom", path: [path], message });
};

/** Rule CHUNG của cả 3 regime: title 8–120 (rule hiện có). */
const checkTitle = (v: ListingBase, ctx: RefineCtx): void => {
  if (v.title.length < 8 || v.title.length > 120) issue(ctx, "title", "TITLE_INVALID");
  // b4-holistic round-3 (LOW — empty slug): title phải có ÍT NHẤT một chữ cái
  // hoặc SỐ (\p{L}\p{N} — Unicode, bao gồm CJK). Title chỉ dấu câu/emoji/
  // zero-width ("!!!!!!!!", U+200B×8) slugify thành '' → trang chi tiết không
  // bao giờ mở được (xem listingSlug fallback); chặn tại schema là gate đúng.
  // (CJK vẫn pass check này nhưng slugify strip — fallback listingSlug lo phần đó.)
  if (!/[\p{L}\p{N}]/u.test(v.title)) issue(ctx, "title", "TITLE_INVALID");
};

/** Rule CHUNG: price bounds 100.000₫–2 tỷ ₫ (giữ nguyên — KHÔNG siết). */
const checkPrice = (v: ListingBase, ctx: RefineCtx): void => {
  if (!Number.isFinite(v.price) || v.price < PRICE_MIN || v.price > PRICE_MAX) {
    issue(ctx, "price", "PRICE_INVALID");
  }
};

/** Rule CHUNG: categoryId non-empty (tồn tại + allowlist do publication layer). */
const checkCategory = (v: ListingBase, ctx: RefineCtx): void => {
  if (isBlank(v.categoryId)) issue(ctx, "categoryId", "CATEGORY_REQUIRED");
};

/** Rule CHUNG: imageSlots (khi có) đúng độ dài + giá trị ∈ 8 slot §5.6.3. */
const checkSlots = (v: ListingBase, ctx: RefineCtx): void => {
  if (v.imageSlots === undefined) return;
  if (v.imageSlots.length !== v.imageUrls.length) {
    issue(ctx, "imageSlots", "IMAGE_SLOT_MISMATCH");
    return;
  }
  for (const slot of v.imageSlots) {
    if (slot !== null && !(PHOTO_CHECKLIST_SLOTS as readonly string[]).includes(slot)) {
      issue(ctx, "imageSlots", "IMAGE_SLOT_INVALID");
      return;
    }
  }
};

/** Rule CHUNG: url trùng lặp → IMAGE_DUPLICATE. */
const checkImageDuplicates = (v: ListingBase, ctx: RefineCtx): void => {
  if (new Set(v.imageUrls).size !== v.imageUrls.length) {
    issue(ctx, "imageUrls", "IMAGE_DUPLICATE");
  }
};

/** Rule CHUNG: ≤ 8 ảnh (rule hiện có của create) — b4-holistic-2: upper bound
 *  này được grandfather (bỏ qua) trên transition không đổi content của row
 *  legacy hợp lệ dưới luật cũ (grandfatherStoredBounds). */
const checkImageCount = (v: ListingBase, ctx: RefineCtx, grandfatherUpper = false): void => {
  if (!grandfatherUpper && v.imageUrls.length > LISTING_MAX_IMAGES) {
    issue(ctx, "imageUrls", "IMAGE_TOO_MANY");
  }
};

/** Rule beta/draft: description ≥20 (≤ DESCRIPTION_MAX — bound chống unbounded rows).
 *  b4-holistic-2: upper bound được grandfather (bỏ qua) khi
 *  grandfatherStoredBounds — LOWER bound (≥20) KHÔNG bao giờ bỏ. */
const checkDescription = (v: ListingBase, ctx: RefineCtx, grandfatherUpper = false): void => {
  if (v.description.length < 20 || (!grandfatherUpper && v.description.length > DESCRIPTION_MAX)) {
    issue(ctx, "description", "DESCRIPTION_INVALID");
  }
};

/** Rule beta/draft: condition ∈ product_condition (cột non-null của Listing). */
const checkCondition = (v: ListingBase, ctx: RefineCtx): void => {
  if (isBlank(v.condition)) {
    issue(ctx, "condition", "CONDITION_REQUIRED");
  } else if (!(PRODUCT_CONDITIONS as readonly string[]).includes(v.condition)) {
    issue(ctx, "condition", "CONDITION_INVALID");
  }
};

/**
 * Rule beta/draft: province BẮT BUỘC (FD-1) — requiredness riêng (L3: draft gọi
 * hàm NÀY, value-check sống MỘT chỗ trong checkStructuredWhenPresent nên
 * PROVINCE_INVALID không bị emit hai lần).
 */
const checkProvinceRequired = (v: ListingBase, ctx: RefineCtx): void => {
  if (isBlank(v.provinceLevelCode)) {
    issue(ctx, "provinceLevelCode", "PROVINCE_REQUIRED");
  }
};

/** Value-check province khi CÓ — shared legacy/draft (L3: emit đúng MỘT lần). */
const checkProvinceValue = (v: ListingBase, ctx: RefineCtx): void => {
  if (!isBlank(v.provinceLevelCode) && !isProvinceCode(v.provinceLevelCode)) {
    issue(ctx, "provinceLevelCode", "PROVINCE_INVALID");
  }
};

/** Rule beta: province ∈ 34 mã registry (FD-1) — required + value (một chỗ). */
const checkProvince = (v: ListingBase, ctx: RefineCtx): void => {
  checkProvinceRequired(v, ctx);
  checkProvinceValue(v, ctx);
};

/**
 * Rule CHUNG (L4 — validate-WHEN-PRESENT): brandId/productModelId là FK tới
 * Brand/ProductModel (uuid() 36 ký tự) — bound chiều dài khi CÓ, KHÔNG thêm
 * requiredness (legacy grandfathered; draft tùy chọn; beta required riêng).
 * Chống unbounded id string vào Listing.brandId/productModelId write path.
 */
const checkForeignIds = (v: ListingBase, ctx: RefineCtx): void => {
  if (!isBlank(v.brandId) && v.brandId.length > FOREIGN_ID_MAX) {
    issue(ctx, "brandId", "BRAND_INVALID");
  }
  if (!isBlank(v.productModelId) && v.productModelId.length > FOREIGN_ID_MAX) {
    issue(ctx, "productModelId", "MODEL_INVALID");
  }
};

/** Rule beta: structured free-text ≤ FREE_TEXT_MAX (khi có). */
const checkFreeTexts = (v: ListingBase, ctx: RefineCtx): void => {
  const fields: Array<[string, string | null | undefined]> = [
    ["includedAccessories", v.includedAccessories],
    ["knownDefects", v.knownDefects],
    ["repairHistory", v.repairHistory],
  ];
  for (const [field, value] of fields) {
    if (value !== null && value !== undefined && value.length > FREE_TEXT_MAX) {
      issue(ctx, field, "FREE_TEXT_INVALID");
    }
  }
};

/** Rule beta: fulfillment ≥1 + giá trị hợp lệ + không trùng (§6.3 Step 4). */
const checkFulfillment = (v: ListingBase, ctx: RefineCtx): void => {
  const methods = v.fulfillmentMethods ?? null;
  if (methods === null || methods.length === 0) {
    issue(ctx, "fulfillmentMethods", "FULFILLMENT_REQUIRED");
    return;
  }
  for (const m of methods) {
    if (!(LISTING_FULFILLMENT_METHODS as readonly string[]).includes(m)) {
      issue(ctx, "fulfillmentMethods", "FULFILLMENT_INVALID");
      return;
    }
  }
  if (new Set(methods).size !== methods.length) {
    issue(ctx, "fulfillmentMethods", "FULFILLMENT_DUPLICATE");
  }
};

/** Rule beta: inventoryContext ∈ inventory_context (§5.6). */
const checkInventoryContext = (v: ListingBase, ctx: RefineCtx): void => {
  if (isBlank(v.inventoryContext)) {
    issue(ctx, "inventoryContext", "INVENTORY_CONTEXT_REQUIRED");
  } else if (!(INVENTORY_CONTEXTS as readonly string[]).includes(v.inventoryContext)) {
    issue(ctx, "inventoryContext", "INVENTORY_CONTEXT_INVALID");
  }
};

/** Rule beta: locationDisplayName (§5.9) — capped, KHÔNG detect địa chỉ nhà. */
const checkLocationDisplay = (v: ListingBase, ctx: RefineCtx): void => {
  if (isBlank(v.locationDisplayName)) {
    issue(ctx, "locationDisplayName", "LOCATION_DISPLAY_REQUIRED");
  } else if (v.locationDisplayName.length > LOCATION_DISPLAY_MAX) {
    issue(ctx, "locationDisplayName", "LOCATION_DISPLAY_INVALID");
  }
};

/**
 * Rule draft + legacy (validate-WHEN-PRESENT): structured fields CHỈ validate
 * GIÁ TRỊ khi seller cung cấp — presence KHÔNG bắt buộc (draft tùy chọn theo
 * spec §4.4; legacy grandfathered theo spec §8/§8.3).
 *
 * Review fix (Task 2 MEDIUM): base object type các field này là
 * z.string()/z.array UNBOUNDED — legacy regime KHÔNG được phép lọt 1MB
 * knownDefects / 50k fulfillment entries / giá trị rác qua chúng (Task 4 write
 * theo input đã parse). Cùng bộ check cho cả hai regime — KHÔNG thêm
 * requiredness mới cho legacy (chỉ value-check khi có).
 *
 * L3 (review fix 2): value-check province sống Ở ĐÂY (một chỗ) — draft gọi
 * checkProvinceRequired riêng nên PROVINCE_INVALID không bị emit hai lần.
 * L4 (review fix 2): brandId/productModelId bound FOREIGN_ID_MAX khi có.
 */
const checkStructuredWhenPresent = (v: ListingBase, ctx: RefineCtx): void => {
  // brandId/productModelId — bound FK khi có (L4)
  checkForeignIds(v, ctx);
  // inventoryContext — giá trị ∈ inventory_context khi có (§5.6)
  if (!isBlank(v.inventoryContext) &&
      !(INVENTORY_CONTEXTS as readonly string[]).includes(v.inventoryContext)) {
    issue(ctx, "inventoryContext", "INVENTORY_CONTEXT_INVALID");
  }
  // free-text ≤ FREE_TEXT_MAX (chống unbounded rows)
  checkFreeTexts(v, ctx);
  // fulfillment — giá trị hợp lệ + không trùng khi có (§5.2/A7); mảng bị bound
  // ngầm: chỉ 4 giá trị hợp lệ tồn tại nên >4 entry chắc chắn trùng
  const methods = v.fulfillmentMethods ?? null;
  if (methods !== null && methods.length > 0) {
    for (const m of methods) {
      if (!(LISTING_FULFILLMENT_METHODS as readonly string[]).includes(m)) {
        issue(ctx, "fulfillmentMethods", "FULFILLMENT_INVALID");
        break;
      }
    }
    if (new Set(methods).size !== methods.length) {
      issue(ctx, "fulfillmentMethods", "FULFILLMENT_DUPLICATE");
    }
  }
  // province — mã ∈ 34 registry (FD-1) khi có (value-check MỘT chỗ — L3)
  checkProvinceValue(v, ctx);
  // locationDisplayName — capped khi có (§5.9)
  if (!isBlank(v.locationDisplayName) &&
      v.locationDisplayName.length > LOCATION_DISPLAY_MAX) {
    issue(ctx, "locationDisplayName", "LOCATION_DISPLAY_INVALID");
  }
};

// ─── Ba regime schema ─────────────────────────────────────────────────────────

/**
 * b4-holistic-2 (CONFIRMED LOW — legacy bounds): option của regime schema.
 * `grandfatherStoredBounds: true` bỏ qua ĐÚNG HAI upper bound lưu-trữ
 * (description ≤ DESCRIPTION_MAX, ảnh ≤ LISTING_MAX_IMAGES) — cho row legacy
 * HỢP LỆ DƯỚI LUẬT CŨ (pre-Batch-4 update KHÔNG cap ảnh/KHÔNG upper bound
 * description) trên transition KHÔNG đổi content (toggle hidden→approved|
 * pending, admin approve — input từ DB row). MỌI lower bound (description ≥20,
 * ≥1 ảnh) + requiredness + mọi check khác GIỮ NGUYÊN. Đường formData
 * (create/draft/submit/update) KHÔNG bao giờ set — edit nào cũng buộc seller
 * vào compliance (spec §8/§8.3 legacy giữ nguyên hành vi, KHÔNG kẹt mãi mãi).
 */
export type ValidateListingSubmissionOptions = {
  grandfatherStoredBounds?: boolean;
};

/**
 * Regime "beta" — requiredness đầy đủ (spec §6.3). Thứ tự check cố định:
 * title → description → price → category → condition → brand → model →
 * brand/model bound (L4) → inventoryContext → free-text → fulfillment →
 * province → location → images.
 */
const buildBetaListingSubmissionSchema = (
  opts: ValidateListingSubmissionOptions = {},
): z.ZodType<ListingSubmissionInput> =>
  listingBaseObject.superRefine((v, ctx) => {
    checkTitle(v, ctx);
    checkDescription(v, ctx, opts.grandfatherStoredBounds === true);
    checkPrice(v, ctx);
    checkCategory(v, ctx);
    checkCondition(v, ctx);
    if (isBlank(v.brandId)) issue(ctx, "brandId", "BRAND_REQUIRED");
    if (isBlank(v.productModelId)) issue(ctx, "productModelId", "MODEL_REQUIRED");
    checkForeignIds(v, ctx); // L4 — bound FK, cùng limits với draft/legacy
    checkInventoryContext(v, ctx);
    checkFreeTexts(v, ctx);
    checkFulfillment(v, ctx);
    checkProvince(v, ctx);
    checkLocationDisplay(v, ctx);
    if (v.imageUrls.length === 0) issue(ctx, "imageUrls", "IMAGE_REQUIRED");
    checkImageCount(v, ctx, opts.grandfatherStoredBounds === true);
    checkImageDuplicates(v, ctx);
    checkSlots(v, ctx);
  });

/** Schema beta mặc định (KHÔNG grandfather) — pin bởi listing-schema.test.ts. */
export const betaListingSubmissionSchema: z.ZodType<ListingSubmissionInput> =
  buildBetaListingSubmissionSchema();

/**
 * Regime "legacy" — CHỈ rule đang chạy trong createListingAction/
 * updateListingAction hôm nay (title 8–120, description ≥20, price bounds,
 * ≥1 ảnh, ≤8 ảnh): KHÔNG đòi brand/model/structured/province (grandfathered —
 * legacy listing giữ nguyên hành vi, spec §8/§8.3). imageSlots là field MỚI
 * (Batch 4) nên defensive check độ dài/giá trị vẫn chạy.
 *
 * Review fix (MEDIUM): structured fields MỚI (inventoryContext/free-text/
 * fulfillment/province/location) được validate-WHEN-PRESENT — cùng bộ check
 * như draft (checkStructuredWhenPresent): giá trị sai → typed code, KHÔNG có
 * → bỏ qua. Base object type chúng là z.string()/z.array unbounded nên nếu
 * legacy bỏ qua hoàn toàn, 1MB knownDefects / 50k fulfillment entries lọt
 * qua → unbounded rows. KHÔNG thêm requiredness (legacy giữ nguyên hành vi).
 *
 * L4 (review fix 2): description ≤ DESCRIPTION_MAX (CÙNG bound draft/beta —
 * checkDescription) + brandId/productModelId ≤ FOREIGN_ID_MAX khi có — upper
 * bounds KHÔNG thêm requiredness gì mới. b4-holistic-2: hai upper bound này
 * grandfather được (ValidateListingSubmissionOptions).
 */
const buildLegacyListingEditSchema = (
  opts: ValidateListingSubmissionOptions = {},
): z.ZodType<ListingSubmissionInput> =>
  listingBaseObject.superRefine((v, ctx) => {
    checkTitle(v, ctx);
    // L4: ≥20 (rule hiện có) + ≤ DESCRIPTION_MAX — cùng checkDescription
    // draft/beta dùng, cùng code DESCRIPTION_INVALID.
    checkDescription(v, ctx, opts.grandfatherStoredBounds === true);
    checkPrice(v, ctx);
    checkCategory(v, ctx);
    checkStructuredWhenPresent(v, ctx);
    if (v.imageUrls.length === 0) issue(ctx, "imageUrls", "IMAGE_REQUIRED");
    checkImageCount(v, ctx, opts.grandfatherStoredBounds === true);
    checkImageDuplicates(v, ctx);
    checkSlots(v, ctx);
  });

/** Schema legacy mặc định (KHÔNG grandfather) — pin bởi listing-schema.test.ts. */
export const legacyListingEditSchema: z.ZodType<ListingSubmissionInput> =
  buildLegacyListingEditSchema();

/**
 * Draft (spec §4.4/§5.6.2 — draft được phép TRƯỚC verification): base
 * requiredness (cột non-null hiện có: title/description/price/condition/
 * category) + province (city derive từ province — item 12, KHÔNG có fallback
 * độc lập) + structured TUYỆN CHỌN + images 0..8 (≥1 ảnh là rule của SUBMIT).
 */
export const draftListingSchema: z.ZodType<ListingSubmissionInput> =
  listingBaseObject.superRefine((v, ctx) => {
    checkTitle(v, ctx);
    checkDescription(v, ctx);
    checkPrice(v, ctx);
    checkCategory(v, ctx);
    checkCondition(v, ctx);
    // L3: requiredness ở đây (PROVINCE_REQUIRED); VALUE-check sống MỘT chỗ
    // trong checkStructuredWhenPresent — không emit PROVINCE_INVALID hai lần.
    checkProvinceRequired(v, ctx);
    // structured TUYỆN CHỌN — validate GIÁ TRỊ khi seller cung cấp (cùng bộ
    // check với legacy — checkStructuredWhenPresent)
    checkStructuredWhenPresent(v, ctx);
    checkImageCount(v, ctx);
    checkImageDuplicates(v, ctx);
    checkSlots(v, ctx);
  });

// ─── Regime switch ─────────────────────────────────────────────────────────────

/**
 * Validate submission theo regime — throw Error("LISTING_VALIDATION_FAILED:<code>")
 * với code ĐẦU TIÊN sai (thứ tự deterministic của schema). Fail closed: mọi
 * input không hợp lệ bị chặn trước khi action write bất kỳ row nào.
 *
 * b4-holistic-2: opts.grandfatherStoredBounds — CHỈ cho transition KHÔNG đổi
 * content với input TỪ DB ROW (toggle hidden→approved|pending, admin approve);
 * đường formData KHÔNG bao giờ truyền (xem ValidateListingSubmissionOptions).
 */
export function validateListingSubmission(
  input: ListingSubmissionInput,
  regime: ListingRegime,
  opts: ValidateListingSubmissionOptions = {},
): void {
  const schema =
    regime === "beta"
      ? buildBetaListingSubmissionSchema(opts)
      : buildLegacyListingEditSchema(opts);
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0]?.message ?? "SCHEMA_INVALID";
    throw new Error(`LISTING_VALIDATION_FAILED:${first}`);
  }
}
