/**
 * Listing submission schema (Batch 4 Task 2 — spec §5.6/§6.3) — unit tests.
 *
 * Ba regime schema (conditional-fields gate — Review Focus 3):
 *  - `betaListingSubmissionSchema` (regime "beta"): requiredness đầy đủ —
 *    brand + canonical model (§6.3 Step 1), inventoryContext (§5.6), condition,
 *    fulfillment ≥1 (§6.3 Step 4), provinceLevelCode ∈ 34 mã registry
 *    (isProvinceCode — FD-1) + locationDisplayName (§5.9), ≥1 ảnh (rule hiện có),
 *    free-text ≤ FREE_TEXT_MAX / description ≤ DESCRIPTION_MAX.
 *  - `legacyListingEditSchema` (regime "legacy"): CHỈ rule đang chạy trong
 *    createListingAction/updateListingAction hôm nay — không thêm (legacy
 *    listing giữ nguyên hành vi — Review Focus 5).
 *  - `draftListingSchema`: base requiredness (cột non-null hiện có + province
 *    — city derive từ province, item 12) + structured TUYỆN CHỌN + images 0..8.
 *
 * Pure test — provinces.ts/beta-categories.ts là plain module, KHÔNG db trong
 * import chain (không cần vi.mock server-only).
 */
import { describe, expect, it } from "vitest";
import { isProvinceCode, PROVINCE_CODES } from "@/src/lib/provinces";
import {
  DESCRIPTION_MAX,
  FOREIGN_ID_MAX,
  FREE_TEXT_MAX,
  LISTING_EDIT_RATE,
  LISTING_FULFILLMENT_METHODS,
  LISTING_MAX_IMAGES,
  LISTING_MUTATION_RATE,
  LOCATION_DISPLAY_MAX,
  PHOTO_CHECKLIST_SLOTS,
  betaListingSubmissionSchema,
  draftListingSchema,
  legacyListingEditSchema,
  validateListingSubmission,
  type ListingSubmissionInput,
} from "@/src/lib/listing-schema";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const UPLOAD_URL = "/uploads/00000000-0000-4000-8000-00000000000a.webp";

/** Input beta ĐỦ (mặc định) — case omit bỏ từng mảnh và expect code tương ứng. */
const betaInput = (over?: Partial<ListingSubmissionInput>): ListingSubmissionInput => ({
  title: "Loa JBL Charge 5 chính hãng",
  description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
  categoryId: "cat-beta-1",
  brandId: "brand-jbl",
  productModelId: "model-jbl-charge-5",
  condition: "good",
  price: 1_800_000,
  negotiable: false,
  inventoryContext: "used",
  includedAccessories: null,
  knownDefects: null,
  repairHistory: null,
  fulfillmentMethods: ["meetup"],
  provinceLevelCode: "ha-noi",
  locationDisplayName: "Khu vực Cầu Giấy",
  imageUrls: [UPLOAD_URL],
  imageSlots: ["front"],
  ...over,
});

/** Input legacy-shaped (không model, không structured fields). */
const legacyInput = (over?: Partial<ListingSubmissionInput>): ListingSubmissionInput => ({
  title: "Loa thùng bass cũ còn tốt",
  description: "Loa thùng bass 12 inch, còn mới 90%, nghe hay.",
  categoryId: "cat-legacy-1",
  brandId: null,
  productModelId: null,
  condition: "good",
  price: 4_500_000,
  negotiable: true,
  inventoryContext: null,
  includedAccessories: null,
  knownDefects: null,
  repairHistory: null,
  fulfillmentMethods: null,
  provinceLevelCode: null,
  locationDisplayName: null,
  imageUrls: ["/img/listings/loa-thung-1.svg"],
  ...over,
});

/** Input draft base (cột non-null + province; structured/images tùy chọn). */
const draftInput = (over?: Partial<ListingSubmissionInput>): ListingSubmissionInput => ({
  title: "Loa Marshall Emberton II like new",
  description: "Loa bluetooth nhỏ gọn, pin trâu, còn mới 95%.",
  categoryId: "cat-beta-1",
  brandId: null,
  productModelId: null,
  condition: "like_new",
  price: 2_400_000,
  negotiable: true,
  inventoryContext: null,
  includedAccessories: null,
  knownDefects: null,
  repairHistory: null,
  fulfillmentMethods: null,
  provinceLevelCode: "ho-chi-minh",
  locationDisplayName: null,
  imageUrls: [],
  ...over,
});

/** validateListingSubmission phải throw đúng Error("LISTING_VALIDATION_FAILED:<code>"). */
const expectValidationCode = (input: ListingSubmissionInput, code: string): void => {
  let caught: unknown;
  try {
    validateListingSubmission(input, "beta");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(`LISTING_VALIDATION_FAILED:${code}`);
};

// ─── 1. Non-invention pins — hằng số ──────────────────────────────────────────

describe("constants — non-invention pins (spec §5.6.3/§5.2/§7.1)", () => {
  it("PHOTO_CHECKLIST_SLOTS has exactly the 8 §5.6.3 slots (verbatim)", () => {
    expect(PHOTO_CHECKLIST_SLOTS).toEqual([
      "front",
      "back",
      "control_panel",
      "ports",
      "damage",
      "accessories",
      "box",
      "label_serial",
    ]);
    expect(PHOTO_CHECKLIST_SLOTS).toHaveLength(8);
  });

  it("LISTING_FULFILLMENT_METHODS — mapping §5.2 (recorded decision A7)", () => {
    expect(LISTING_FULFILLMENT_METHODS).toEqual([
      "meetup",
      "seller_delivery",
      "carrier",
      "other",
    ]);
  });

  it("rate constants (§7.1) — 20/h create/draft/submit, 60/h bucket chung edit", () => {
    expect(LISTING_MUTATION_RATE).toEqual({ limit: 20, windowMs: 60 * 60_000 });
    expect(LISTING_EDIT_RATE).toEqual({ limit: 60, windowMs: 60 * 60_000 });
  });

  it("text caps — FREE_TEXT_MAX 2000, DESCRIPTION_MAX 4000, LOCATION_DISPLAY_MAX 120, max 8 ảnh", () => {
    expect(FREE_TEXT_MAX).toBe(2_000);
    expect(DESCRIPTION_MAX).toBe(4_000);
    expect(LOCATION_DISPLAY_MAX).toBe(120);
    expect(LISTING_MAX_IMAGES).toBe(8);
  });
});

// ─── 2. Beta schema — requiredness đầy đủ (spec §6.3) ─────────────────────────

describe("betaListingSubmissionSchema — requiredness đầy đủ", () => {
  it("input đủ → passes (safeParse success + validateListingSubmission không throw)", () => {
    expect(betaListingSubmissionSchema.safeParse(betaInput()).success).toBe(true);
    expect(() => validateListingSubmission(betaInput(), "beta")).not.toThrow();
  });

  it("brand thiếu → BRAND_REQUIRED (§6.3 Step 1) — legacy cùng input passes", () => {
    expectValidationCode(betaInput({ brandId: null }), "BRAND_REQUIRED");
    expectValidationCode(betaInput({ brandId: "" }), "BRAND_REQUIRED");
    // conditional-fields gate: cùng input (không brand/model) passes dưới legacy
    expect(
      legacyListingEditSchema.safeParse(betaInput({ brandId: null, productModelId: null }))
        .success,
    ).toBe(true);
  });

  it("canonical model thiếu → MODEL_REQUIRED (§6.3 Step 1)", () => {
    expectValidationCode(betaInput({ productModelId: null }), "MODEL_REQUIRED");
    expectValidationCode(betaInput({ productModelId: "" }), "MODEL_REQUIRED");
  });

  it("inventoryContext thiếu/sai → INVENTORY_CONTEXT_REQUIRED / _INVALID (§5.6)", () => {
    expectValidationCode(betaInput({ inventoryContext: null }), "INVENTORY_CONTEXT_REQUIRED");
    expectValidationCode(betaInput({ inventoryContext: "refurbished" }), "INVENTORY_CONTEXT_INVALID");
  });

  it("condition thiếu/sai → CONDITION_REQUIRED / _INVALID (§6.3 Step 2)", () => {
    expectValidationCode(betaInput({ condition: "" }), "CONDITION_REQUIRED");
    expectValidationCode(betaInput({ condition: "95_percent" }), "CONDITION_INVALID");
  });

  it("fulfillment thiếu/rỗng → FULFILLMENT_REQUIRED; giá trị sai → FULFILLMENT_INVALID (§6.3 Step 4)", () => {
    expectValidationCode(betaInput({ fulfillmentMethods: null }), "FULFILLMENT_REQUIRED");
    expectValidationCode(betaInput({ fulfillmentMethods: [] }), "FULFILLMENT_REQUIRED");
    expectValidationCode(
      betaInput({ fulfillmentMethods: ["teleport"] }),
      "FULFILLMENT_INVALID",
    );
  });

  it("fulfillment trùng lặp → FULFILLMENT_DUPLICATE", () => {
    expectValidationCode(
      betaInput({ fulfillmentMethods: ["meetup", "meetup"] }),
      "FULFILLMENT_DUPLICATE",
    );
  });

  it("province thiếu → PROVINCE_REQUIRED; mã không thuộc 34 đơn vị → PROVINCE_INVALID (FD-1)", () => {
    expectValidationCode(betaInput({ provinceLevelCode: null }), "PROVINCE_REQUIRED");
    expectValidationCode(betaInput({ provinceLevelCode: "" }), "PROVINCE_REQUIRED");
    // "binh-duong" KHÔNG phải mã registry (Bình Dương đã sáp nhập TP.HCM —
    // chỉ resolve được qua legacyNames, không phải code)
    expectValidationCode(betaInput({ provinceLevelCode: "binh-duong" }), "PROVINCE_INVALID");
    expect(isProvinceCode("ha-noi")).toBe(true);
    expect(PROVINCE_CODES["ho-chi-minh"]).toBe("TP. Hồ Chí Minh");
  });

  it("locationDisplayName thiếu → LOCATION_DISPLAY_REQUIRED; quá 120 ký tự → _INVALID", () => {
    expectValidationCode(betaInput({ locationDisplayName: null }), "LOCATION_DISPLAY_REQUIRED");
    expectValidationCode(betaInput({ locationDisplayName: "" }), "LOCATION_DISPLAY_REQUIRED");
    expectValidationCode(
      betaInput({ locationDisplayName: "x".repeat(LOCATION_DISPLAY_MAX + 1) }),
      "LOCATION_DISPLAY_INVALID",
    );
  });

  it("ảnh: 0 ảnh → IMAGE_REQUIRED; > 8 → IMAGE_TOO_MANY; trùng URL → IMAGE_DUPLICATE", () => {
    expectValidationCode(betaInput({ imageUrls: [] }), "IMAGE_REQUIRED");
    expectValidationCode(
      betaInput({ imageUrls: Array.from({ length: 9 }, (_, i) => `${UPLOAD_URL}${i}`) }),
      "IMAGE_TOO_MANY",
    );
    expectValidationCode(
      betaInput({ imageUrls: [UPLOAD_URL, UPLOAD_URL] }),
      "IMAGE_DUPLICATE",
    );
  });

  it("imageSlots: giá trị ngoài PHOTO_CHECKLIST_SLOTS → IMAGE_SLOT_INVALID", () => {
    expectValidationCode(
      betaInput({ imageUrls: [UPLOAD_URL], imageSlots: ["warranty_card"] }),
      "IMAGE_SLOT_INVALID",
    );
  });

  it("imageSlots/images length mismatch → IMAGE_SLOT_MISMATCH", () => {
    expectValidationCode(
      betaInput({ imageUrls: [UPLOAD_URL], imageSlots: ["front", "back"] }),
      "IMAGE_SLOT_MISMATCH",
    );
    expectValidationCode(
      betaInput({ imageUrls: [UPLOAD_URL, `${UPLOAD_URL}2`], imageSlots: ["front"] }),
      "IMAGE_SLOT_MISMATCH",
    );
  });

  it("title 8–120 → TITLE_INVALID; description ≥20 ≤4000 → DESCRIPTION_INVALID", () => {
    expectValidationCode(betaInput({ title: "ngắn" }), "TITLE_INVALID");
    expectValidationCode(betaInput({ title: "x".repeat(121) }), "TITLE_INVALID");
    expectValidationCode(betaInput({ description: "ngắn" }), "DESCRIPTION_INVALID");
    expectValidationCode(
      betaInput({ description: "x".repeat(DESCRIPTION_MAX + 1) }),
      "DESCRIPTION_INVALID",
    );
  });

  it("b4-holistic round-3 — title KHÔNG có chữ/số nào (chỉ dấu câu/emoji/zero-width) → TITLE_INVALID (empty slug)", () => {
    // Title chỉ dấu câu/emoji bị slugify strip hết → slug '' → MỌI link
    // /listings/<slug> trỏ vào index; chặn tại schema là gate đúng.
    expectValidationCode(betaInput({ title: "!!!!!!!!" }), "TITLE_INVALID");
    expectValidationCode(betaInput({ title: "🎉✨🎵🔊🎧" }), "TITLE_INVALID");
    // zero-width (U+200B × 8) — trim() không bỏ, length pass 8, KHÔNG chữ/số
    expectValidationCode(betaInput({ title: "​".repeat(8) }), "TITLE_INVALID");
    // CJK CÓ chữ (\p{L}) → pass check (fallback listingSlug lo slug rỗng)
    expect(betaListingSubmissionSchema.safeParse(betaInput({ title: "蓝牙音箱很好用低音炮" })).success).toBe(true);
  });

  it("price ngoài 100.000₫–2 tỷ ₫ → PRICE_INVALID (giữ nguyên bound hiện tại)", () => {
    expectValidationCode(betaInput({ price: 99_000 }), "PRICE_INVALID");
    expectValidationCode(betaInput({ price: 2_000_000_001 }), "PRICE_INVALID");
    expectValidationCode(betaInput({ price: Number.NaN }), "PRICE_INVALID");
  });

  it("free-text quá FREE_TEXT_MAX → FREE_TEXT_INVALID", () => {
    expectValidationCode(
      betaInput({ includedAccessories: "x".repeat(FREE_TEXT_MAX + 1) }),
      "FREE_TEXT_INVALID",
    );
    expectValidationCode(
      betaInput({ knownDefects: "x".repeat(FREE_TEXT_MAX + 1) }),
      "FREE_TEXT_INVALID",
    );
    expectValidationCode(
      betaInput({ repairHistory: "x".repeat(FREE_TEXT_MAX + 1) }),
      "FREE_TEXT_INVALID",
    );
  });

  it("categoryId rỗng → CATEGORY_REQUIRED", () => {
    expectValidationCode(betaInput({ categoryId: "" }), "CATEGORY_REQUIRED");
  });
});

// ─── 3. Legacy schema — chỉ rule hiện có (Review Focus 5) ─────────────────────

describe("legacyListingEditSchema — chỉ validation hiện có (không thêm)", () => {
  it("input legacy-shaped (không model, không structured) → passes", () => {
    expect(legacyListingEditSchema.safeParse(legacyInput()).success).toBe(true);
    expect(() => validateListingSubmission(legacyInput(), "legacy")).not.toThrow();
  });

  it("vẫn enforce title 8–120", () => {
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ title: "ngắn" })).success,
    ).toBe(false);
    expect(() =>
      validateListingSubmission(legacyInput({ title: "ngắn" }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:TITLE_INVALID");
  });

  it("b4-holistic round-3 — condition=bogus → CONDITION_INVALID typed (KHÔNG 500 DB CHECK)", () => {
    // Trước fix: legacyListingEditSchema KHÔNG check condition → updateAll ghi
    // thẳng vào DB → CHECK violation rethrown → generic 500 thay vì typed code.
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ condition: "bogus" })).success,
    ).toBe(false);
    expect(() =>
      validateListingSubmission(legacyInput({ condition: "bogus" }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:CONDITION_INVALID");
  });

  it("vẫn enforce description ≥20", () => {
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ description: "ngắn" })).success,
    ).toBe(false);
  });

  it("vẫn enforce price bounds 100.000₫–2 tỷ ₫", () => {
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ price: 50_000 })).success,
    ).toBe(false);
  });

  it("vẫn enforce ≥1 ảnh", () => {
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ imageUrls: [] })).success,
    ).toBe(false);
    expect(() =>
      validateListingSubmission(legacyInput({ imageUrls: [] }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:IMAGE_REQUIRED");
  });

  it("KHÔNG đòi brand/model/province/structured (beta input thiếu các mảnh vẫn passes)", () => {
    // cùng input beta thiếu brand/model/province/fulfillment/inventory → legacy OK
    expect(
      legacyListingEditSchema.safeParse(
        betaInput({
          brandId: null,
          productModelId: null,
          inventoryContext: null,
          fulfillmentMethods: null,
          provinceLevelCode: null,
          locationDisplayName: null,
        }),
      ).success,
    ).toBe(true);
  });

  it("imageSlots sai giá trị / lệch độ dài vẫn bị chặn (field mới — defensive)", () => {
    expect(
      legacyListingEditSchema.safeParse(
        legacyInput({ imageUrls: ["/img/listings/a.svg"], imageSlots: ["front", "back"] }),
      ).success,
    ).toBe(false);
    expect(
      legacyListingEditSchema.safeParse(
        legacyInput({ imageUrls: ["/img/listings/a.svg"], imageSlots: ["warranty_card"] }),
      ).success,
    ).toBe(false);
  });
});

// ─── 3b. Legacy schema — structured fields validate-WHEN-PRESENT (review fix) ──

describe("legacyListingEditSchema — structured fields validate-when-present (review fix MEDIUM)", () => {
  // Base object type các field structured là z.string()/z.array UNBOUNDED —
  // legacy regime KHÔNG được phép lọt 1MB knownDefects / 50k fulfillment
  // entries / giá trị rác qua chúng (Task 4 write theo input đã parse).

  it("knownDefects 1MB → FREE_TEXT_INVALID (cap FREE_TEXT_MAX chạy cả legacy)", () => {
    expect(() =>
      validateListingSubmission(
        legacyInput({ knownDefects: "x".repeat(1024 * 1024) }),
        "legacy",
      ),
    ).toThrowError("LISTING_VALIDATION_FAILED:FREE_TEXT_INVALID");
  });

  it("includedAccessories / repairHistory quá FREE_TEXT_MAX → FREE_TEXT_INVALID (legacy)", () => {
    expect(() =>
      validateListingSubmission(
        legacyInput({ includedAccessories: "x".repeat(FREE_TEXT_MAX + 1) }),
        "legacy",
      ),
    ).toThrowError("LISTING_VALIDATION_FAILED:FREE_TEXT_INVALID");
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ repairHistory: "x".repeat(FREE_TEXT_MAX + 1) }))
        .success,
    ).toBe(false);
  });

  it("fulfillmentMethods 50.000 entries → FULFILLMENT_DUPLICATE (chỉ 4 giá trị hợp lệ — mảng bị bound ngầm)", () => {
    const fiftyK = Array.from({ length: 50_000 }, () => "meetup");
    expect(() =>
      validateListingSubmission(legacyInput({ fulfillmentMethods: fiftyK }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:FULFILLMENT_DUPLICATE");
  });

  it("fulfillmentMethods giá trị sai → FULFILLMENT_INVALID (legacy)", () => {
    expect(() =>
      validateListingSubmission(legacyInput({ fulfillmentMethods: ["teleport"] }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:FULFILLMENT_INVALID");
  });

  it("inventoryContext sai giá trị → INVENTORY_CONTEXT_INVALID (legacy — KHÔNG đòi presence)", () => {
    expect(() =>
      validateListingSubmission(legacyInput({ inventoryContext: "refurbished" }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:INVENTORY_CONTEXT_INVALID");
    // presence KHÔNG bắt buộc — null vẫn passes (grandfathered)
    expect(legacyListingEditSchema.safeParse(legacyInput({ inventoryContext: null })).success).toBe(
      true,
    );
  });

  it("provinceLevelCode sai giá trị → PROVINCE_INVALID (legacy — null vẫn passes)", () => {
    expect(() =>
      validateListingSubmission(legacyInput({ provinceLevelCode: "binh-duong" }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:PROVINCE_INVALID");
    expect(legacyListingEditSchema.safeParse(legacyInput()).success).toBe(true);
  });

  it("locationDisplayName quá LOCATION_DISPLAY_MAX → LOCATION_DISPLAY_INVALID (legacy)", () => {
    expect(() =>
      validateListingSubmission(
        legacyInput({ locationDisplayName: "x".repeat(LOCATION_DISPLAY_MAX + 1) }),
        "legacy",
      ),
    ).toThrowError("LISTING_VALIDATION_FAILED:LOCATION_DISPLAY_INVALID");
  });

  it("structured fields ĐẦY ĐỦ + HỢP LỆ → legacy vẫn passes (validate-when-present, KHÔNG reject-presence)", () => {
    expect(
      legacyListingEditSchema.safeParse(
        legacyInput({
          inventoryContext: "used",
          includedAccessories: "Sạc, cáp",
          knownDefects: "Trầy nhẹ",
          repairHistory: "Thay pin 2025",
          fulfillmentMethods: ["meetup", "carrier"],
          provinceLevelCode: "ha-noi",
          locationDisplayName: "Khu vực Cầu Giấy",
        }),
      ).success,
    ).toBe(true);
  });

  it("price ±Infinity → PRICE_INVALID cả legacy lẫn beta (base union cho qua — superRefine chặn)", () => {
    expect(() =>
      validateListingSubmission(legacyInput({ price: Number.POSITIVE_INFINITY }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:PRICE_INVALID");
    expect(() =>
      validateListingSubmission(legacyInput({ price: Number.NEGATIVE_INFINITY }), "legacy"),
    ).toThrowError("LISTING_VALIDATION_FAILED:PRICE_INVALID");
    expectValidationCode(betaInput({ price: Number.POSITIVE_INFINITY }), "PRICE_INVALID");
    expectValidationCode(betaInput({ price: Number.NEGATIVE_INFINITY }), "PRICE_INVALID");
  });
});

// ─── 3c. Legacy schema — L4: upper bounds (description/brandId/productModelId) ─

describe("legacyListingEditSchema — L4: upper bounds không thêm requiredness", () => {
  it("description quá DESCRIPTION_MAX → DESCRIPTION_INVALID (CÙNG bound với draft/beta — không chỉ ≥20)", () => {
    expect(() =>
      validateListingSubmission(
        legacyInput({ description: "x".repeat(DESCRIPTION_MAX + 1) }),
        "legacy",
      ),
    ).toThrowError("LISTING_VALIDATION_FAILED:DESCRIPTION_INVALID");
    // trong bound vẫn passes (≥20 ≤4000 — rule hiện có giữ nguyên)
    expect(
      legacyListingEditSchema.safeParse(legacyInput({ description: "x".repeat(DESCRIPTION_MAX) }))
        .success,
    ).toBe(true);
  });

  it("brandId quá FOREIGN_ID_MAX → BRAND_INVALID (khi CÓ — null/blank vẫn passes, KHÔNG required)", () => {
    expect(() =>
      validateListingSubmission(
        legacyInput({ brandId: "x".repeat(FOREIGN_ID_MAX + 1) }),
        "legacy",
      ),
    ).toThrowError("LISTING_VALIDATION_FAILED:BRAND_INVALID");
    // presence KHÔNG bắt buộc — null/blank grandfathered
    expect(legacyListingEditSchema.safeParse(legacyInput({ brandId: null })).success).toBe(true);
    expect(legacyListingEditSchema.safeParse(legacyInput({ brandId: "" })).success).toBe(true);
  });

  it("productModelId quá FOREIGN_ID_MAX → MODEL_INVALID (khi có)", () => {
    expect(() =>
      validateListingSubmission(
        legacyInput({ productModelId: "x".repeat(FOREIGN_ID_MAX + 1) }),
        "legacy",
      ),
    ).toThrowError("LISTING_VALIDATION_FAILED:MODEL_INVALID");
    expect(legacyListingEditSchema.safeParse(legacyInput({ productModelId: null })).success).toBe(
      true,
    );
  });

  it("cùng bound FOREIGN_ID_MAX cho draft + beta (parity — legacy KHÔNG chặt hơn draft)", () => {
    const overLong = "x".repeat(FOREIGN_ID_MAX + 1);
    expect(draftListingSchema.safeParse(draftInput({ brandId: overLong })).success).toBe(false);
    expect(
      betaListingSubmissionSchema.safeParse(betaInput({ brandId: overLong })).success,
    ).toBe(false);
    expect(
      draftListingSchema.safeParse(draftInput({ productModelId: overLong })).success,
    ).toBe(false);
    // trong bound (uuid 36 ký tự là thực tế) passes cả ba regime
    const uuid = "b".repeat(36);
    expect(draftListingSchema.safeParse(draftInput({ brandId: uuid })).success).toBe(true);
    expect(legacyListingEditSchema.safeParse(legacyInput({ brandId: uuid })).success).toBe(true);
    expect(
      betaListingSubmissionSchema.safeParse(betaInput({ brandId: uuid })).success,
    ).toBe(true);
  });
});

// ─── 4. Draft schema — base + structured tùy chọn (spec §4.4/§5.6.2) ───────────

describe("draftListingSchema — draft trước verification (spec §4.4)", () => {
  it("draft không model/không ảnh → passes (structured + images TUYỆN CHỌN)", () => {
    expect(draftListingSchema.safeParse(draftInput()).success).toBe(true);
  });

  it("draft đủ structured + ảnh → cũng passes", () => {
    expect(
      draftListingSchema.safeParse(
        draftInput({
          brandId: "brand-jbl",
          productModelId: "model-jbl-charge-5",
          inventoryContext: "new",
          fulfillmentMethods: ["meetup", "carrier"],
          locationDisplayName: "Khu vực Tây Hồ",
          imageUrls: [UPLOAD_URL],
          imageSlots: ["front"],
        }),
      ).success,
    ).toBe(true);
  });

  it("draft title sai → TITLE_INVALID; price sai → PRICE_INVALID (cột non-null)", () => {
    expect(draftListingSchema.safeParse(draftInput({ title: "ngắn" })).success).toBe(false);
    expect(draftListingSchema.safeParse(draftInput({ price: 1_000 })).success).toBe(false);
  });

  it("draft thiếu province → PROVINCE_REQUIRED (item 12 — city derive từ province)", () => {
    let caught: unknown;
    try {
      draftListingSchema.parse(draftInput({ provinceLevelCode: null }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const issues = (caught as { issues?: Array<{ message?: string }> }).issues ?? [];
    expect(issues.some((i) => i.message === "PROVINCE_REQUIRED")).toBe(true);
  });

  it("L3 — draft province SAI → PROVINCE_INVALID emit đúng MỘT lần (required ở checkProvince, value-check sống MỘT chỗ trong when-present)", () => {
    const messages = (input: ListingSubmissionInput): string[] => {
      const res = draftListingSchema.safeParse(input);
      return res.success ? [] : res.error.issues.map((i) => i.message);
    };
    // present-but-invalid: PROVINCE_INVALID đúng 1 lần, KHÔNG kèm PROVINCE_REQUIRED
    // (trước fix: checkProvince + checkStructuredWhenPresent cùng emit → 2 lần)
    const invalid = messages(draftInput({ provinceLevelCode: "binh-duong" }));
    expect(invalid.filter((m) => m === "PROVINCE_INVALID")).toHaveLength(1);
    expect(invalid).not.toContain("PROVINCE_REQUIRED");
    // thiếu: PROVINCE_REQUIRED đúng 1 lần, KHÔNG kèm PROVINCE_INVALID
    const missing = messages(draftInput({ provinceLevelCode: null }));
    expect(missing.filter((m) => m === "PROVINCE_REQUIRED")).toHaveLength(1);
    expect(missing).not.toContain("PROVINCE_INVALID");
    // parity: beta/legacy province sai cũng emit đúng MỘT lần
    const betaRes = betaListingSubmissionSchema.safeParse(
      betaInput({ provinceLevelCode: "binh-duong" }),
    );
    expect(
      betaRes.success ? [] : betaRes.error.issues.map((i) => i.message),
    ).toEqual(["PROVINCE_INVALID"]);
    const legacyRes = legacyListingEditSchema.safeParse(
      legacyInput({ provinceLevelCode: "binh-duong" }),
    );
    expect(
      legacyRes.success ? [] : legacyRes.error.issues.map((i) => i.message),
    ).toEqual(["PROVINCE_INVALID"]);
  });

  it("draft 0 ảnh hợp lệ; > 8 ảnh → IMAGE_TOO_MANY (0..8)", () => {
    expect(draftListingSchema.safeParse(draftInput({ imageUrls: [] })).success).toBe(true);
    expect(
      draftListingSchema.safeParse(
        draftInput({
          imageUrls: Array.from(
            { length: LISTING_MAX_IMAGES + 1 },
            (_, i) => `${UPLOAD_URL}${i}`,
          ),
        }),
      ).success,
    ).toBe(false);
  });

  it("draft imageSlots ngoài PHOTO_CHECKLIST_SLOTS → IMAGE_SLOT_INVALID", () => {
    expect(
      draftListingSchema.safeParse(
        draftInput({ imageUrls: [UPLOAD_URL], imageSlots: ["warranty_card"] }),
      ).success,
    ).toBe(false);
  });

  it("draft KHÔNG đòi ≥1 fulfillment (≥1 là rule của SUBMIT, không phải draft)", () => {
    expect(
      draftListingSchema.safeParse(draftInput({ fulfillmentMethods: [] })).success,
    ).toBe(true);
    expect(
      draftListingSchema.safeParse(draftInput({ fulfillmentMethods: null })).success,
    ).toBe(true);
  });
});

// ─── 5. validateListingSubmission — regime switch ─────────────────────────────

describe("validateListingSubmission — regime switch (conditional fields)", () => {
  it("cùng input thiếu structured: beta → LISTING_VALIDATION_FAILED:<code>; legacy → passes", () => {
    const missingStructured = betaInput({
      inventoryContext: null,
      fulfillmentMethods: null,
      locationDisplayName: null,
    });
    expect(() => validateListingSubmission(missingStructured, "beta")).toThrowError(
      "LISTING_VALIDATION_FAILED:INVENTORY_CONTEXT_REQUIRED",
    );
    expect(() => validateListingSubmission(missingStructured, "legacy")).not.toThrow();
  });

  it("throw là Error với message prefix LISTING_VALIDATION_FAILED: (code ổn định)", () => {
    let caught: unknown;
    try {
      validateListingSubmission(betaInput({ brandId: null }), "beta");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("LISTING_VALIDATION_FAILED:BRAND_REQUIRED");
  });

  it("wrapper legacy→beta full-validation: input ĐẦY ĐỦ hợp lệ passes CẢ HAI regime (Task 4 gọi wrapper)", () => {
    // Cùng một input đầy đủ (structured + brand/model + province) — beta
    // requiredness đầy đủ passes; legacy validate-when-present cũng passes
    // (structured hợp lệ không bị legacy từ chối).
    const full = betaInput();
    expect(() => validateListingSubmission(full, "beta")).not.toThrow();
    expect(() => validateListingSubmission(full, "legacy")).not.toThrow();

    // Cùng input thiếu structured: beta chặn (INVENTORY_CONTEXT_REQUIRED),
    // legacy bỏ qua requiredness nhưng VẪN validate giá trị khi có —
    // inventoryContext rác thì CẢ HAI regime đều chặn (typed code).
    const missing = betaInput({
      inventoryContext: null,
      fulfillmentMethods: null,
      locationDisplayName: null,
    });
    expect(() => validateListingSubmission(missing, "beta")).toThrowError(
      "LISTING_VALIDATION_FAILED:INVENTORY_CONTEXT_REQUIRED",
    );
    expect(() => validateListingSubmission(missing, "legacy")).not.toThrow();
    const garbage = betaInput({ inventoryContext: "refurbished" });
    expect(() => validateListingSubmission(garbage, "beta")).toThrowError(
      "LISTING_VALIDATION_FAILED:INVENTORY_CONTEXT_INVALID",
    );
    expect(() => validateListingSubmission(garbage, "legacy")).toThrowError(
      "LISTING_VALIDATION_FAILED:INVENTORY_CONTEXT_INVALID",
    );
  });
});
