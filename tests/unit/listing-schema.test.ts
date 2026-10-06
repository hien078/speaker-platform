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
});
