/**
 * Sell pages + buyer listing detail + CITIES refresh (Batch 4 Task 5) —
 * source-contract trên pages/components (import kéo db + server actions —
 * đọc source là bằng chứng ổn định) + behavioral trên constants (plain module).
 *
 * Hợp đồng (plan Task 5 Step 1):
 *  1. app/sell/new: chỉ category allowlist (lọc server-side theo
 *     BETA_PUBLICATION_CATEGORIES — spec §5.6.1), truyền verification check
 *     (Batch 2 checkSellerPublicationRequirements) cho bước 7, build
 *     photoSlots/fulfillmentMethods từ PHOTO_CHECKLIST_SLOTS/LISTING_FULFILLMENT_METHODS.
 *  2. app/sell/[id]/edit: regime switch theo category slug (.include("category"))
 *     — beta → PortableListingForm, legacy → ListingForm (grandfathered);
 *     draft có form Gửi duyệt (submitListingAction) — KHÔNG updateListingAction;
 *     banner ?error= có message CONCURRENT_CHANGE (parallel note).
 *  3. app/sell/my: draft có form Gửi duyệt (submitListingAction); label/badge
 *     `archived` qua constants (R8 — `removed` từ Batch 3, giữ nguyên).
 *  4. app/listings/[slug]: render structured fields cho buyer (NULL → section
 *     vắng); legacy `user.role === "admin"` read gate GIỮ NGUYÊN (follow-up
 *     recorded — không đổi trong batch này).
 *  5. CITIES refresh (FD-1): 34 displayName chuẩn của registry + "Khác" —
 *     không còn tên stale pre-merger (Bình Dương/Thừa Thiên Huế vắng;
 *     Huế/TP. Hồ Chí Minh có mặt) — /listings filter khớp city của listing beta.
 *  6. listing-form + profile-form: stored city ngoài CITIES → option riêng
 *     (KHÔNG rewrite im lặng khi edit — item 11).
 *  7. app/models/[slug]: giữ card "Mẫu giá thu thập" (sample-size context
 *     §13.6/§5.8.2), KHÔNG thêm claim authoritative.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVINCES } from "@/src/lib/provinces";
import {
  CITIES,
  LISTING_STATUS_LABELS,
  LISTING_STATUS_BADGE,
  INVENTORY_CONTEXT_LABELS,
  FULFILLMENT_METHOD_LABELS,
  PHOTO_CHECKLIST_SLOT_LABELS,
} from "@/src/lib/constants";
import {
  PHOTO_CHECKLIST_SLOTS,
  LISTING_FULFILLMENT_METHODS,
} from "@/src/lib/listing-schema";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const sellNew = read("app/sell/new/page.tsx");
const sellEdit = read("app/sell/[id]/edit/page.tsx");
const sellMy = read("app/sell/my/page.tsx");
const listingDetail = read("app/listings/[slug]/page.tsx");
const listingForm = read("src/components/listing-form.tsx");
const profileForm = read("src/components/profile-form.tsx");
const modelPage = read("app/models/[slug]/page.tsx");

// ─── 1. app/sell/new — allowlist + verification + props gốc ────────────────────

describe("app/sell/new — chỉ category allowlist (spec §5.6.1)", () => {
  it("query categories bị lọc server-side theo BETA_PUBLICATION_CATEGORIES", () => {
    expect(sellNew).toContain("BETA_PUBLICATION_CATEGORIES");
    expect(sellNew).toMatch(/\.filter\(\(c\) =>[\s\S]{0,120}BETA_PUBLICATION_CATEGORIES/);
    expect(sellNew).toContain("PortableListingForm");
  });

  it("truyền verification check cho bước 7 (Batch 2 — đọc FRESH từ DB)", () => {
    expect(sellNew).toContain("checkSellerPublicationRequirements");
    expect(sellNew).toMatch(
      /verification=\{\{ ok: verification\.ok, missing: verification\.missing \}\}/,
    );
    // nhãn yêu cầu từ Batch 2 (server-side import — client form nhận props)
    expect(sellNew).toContain("SELLER_PUBLICATION_REQUIREMENT_LABELS");
  });

  it("photoSlots/fulfillmentMethods build từ PHOTO_CHECKLIST_SLOTS/LISTING_FULFILLMENT_METHODS", () => {
    expect(PHOTO_CHECKLIST_SLOTS).toHaveLength(8);
    expect(LISTING_FULFILLMENT_METHODS).toHaveLength(4);
    expect(sellNew).toContain("PHOTO_CHECKLIST_SLOTS.map");
    expect(sellNew).toContain("LISTING_FULFILLMENT_METHODS.map");
    // provinces từ registry 34 đơn vị (FD-1) — KHÔNG định nghĩa lại
    expect(sellNew).toContain("PROVINCES.map");
  });
});

// ─── 2. app/sell/[id]/edit — regime switch + draft flow ────────────────────────

describe("app/sell/[id]/edit — regime switch theo category slug", () => {
  it('.include("category") để đọc slug + switch listingRegimeForCategorySlug', () => {
    expect(sellEdit).toContain(`.include("category"`);
    expect(sellEdit).toContain("listingRegimeForCategorySlug");
  });

  it("beta → PortableListingForm; legacy → ListingForm (grandfathered)", () => {
    expect(sellEdit).toContain("PortableListingForm");
    expect(sellEdit).toContain("ListingForm");
    expect(sellEdit).toMatch(/regime === "beta"[\s\S]{0,400}PortableListingForm/);
  });

  it("draft: form Gửi duyệt dùng submitListingAction (KHÔNG updateListingAction cho draft)", () => {
    expect(sellEdit).toContain("submitListingAction");
    expect(sellEdit).toMatch(/status === "draft"[\s\S]{0,400}submitListingAction/);
  });

  it("banner ?error= có message tiếng Việt cho CONCURRENT_CHANGE (parallel note)", () => {
    expect(sellEdit).toContain("CONCURRENT_CHANGE");
  });

  it("cũng truyền verification + props beta cho PortableListingForm", () => {
    expect(sellEdit).toContain("checkSellerPublicationRequirements");
    expect(sellEdit).toContain("PHOTO_CHECKLIST_SLOTS.map");
  });
});

// ─── 3. app/sell/my — draft submit + archived label ────────────────────────────

describe("app/sell/my — draft submit + archived label (R8)", () => {
  it("render form Gửi duyệt (submitListingAction) cho draft", () => {
    expect(sellMy).toContain("submitListingAction");
    expect(sellMy).toMatch(/l\.status === "draft"/);
  });

  it("label/badge archived qua constants (removed từ Batch 3 — giữ nguyên)", () => {
    expect(LISTING_STATUS_LABELS.archived).toBe("Đã lưu trữ");
    expect(LISTING_STATUS_BADGE.archived).toBeTruthy();
    expect(LISTING_STATUS_LABELS.removed).toBeTruthy();
    expect(sellMy).toContain("LISTING_STATUS_LABELS");
    expect(sellMy).toContain("LISTING_STATUS_BADGE");
  });
});

// ─── 4. app/listings/[slug] — structured fields cho buyer (spec §5.6) ──────────

describe("app/listings/[slug] — structured fields cho buyer", () => {
  it("render inventory context / defects / repair / accessories / fulfillment / location", () => {
    expect(listingDetail).toContain("INVENTORY_CONTEXT_LABELS");
    expect(listingDetail).toContain("listing.knownDefects");
    expect(listingDetail).toContain("listing.repairHistory");
    expect(listingDetail).toContain("listing.includedAccessories");
    expect(listingDetail).toContain("FULFILLMENT_METHOD_LABELS");
    expect(listingDetail).toContain("listing.fulfillmentMethods");
    expect(listingDetail).toContain("listing.locationDisplayName");
  });

  it("NULL → section vắng (conditional render — KHÔNG text 'null'/placeholder)", () => {
    expect(listingDetail).toMatch(/listing\.knownDefects != null/);
    expect(listingDetail).toMatch(/listing\.inventoryContext != null/);
    expect(listingDetail).toMatch(/listing\.repairHistory != null/);
    expect(listingDetail).toMatch(/listing\.includedAccessories != null/);
  });

  it("legacy role read gate GIỮ NGUYÊN (follow-up recorded — không đổi batch này)", () => {
    expect(listingDetail).toContain(`user?.role !== "admin"`);
  });
});

// ─── 5. CITIES refresh (FD-1) + label maps mới ──────────────────────────────────

describe("CITIES refresh (FD-1 — 34 đơn vị NQ 202/2025/QH15)", () => {
  it("34 displayName chuẩn của registry + 'Khác', đúng thứ tự registry", () => {
    expect(CITIES).toEqual([...PROVINCES.map((p) => p.displayName), "Khác"]);
    expect(CITIES).toHaveLength(35);
  });

  it("KHÔNG còn tên stale pre-merger; Huế + TP. Hồ Chí Minh có mặt", () => {
    expect(CITIES).not.toContain("Bình Dương");
    expect(CITIES).not.toContain("Thừa Thiên Huế");
    expect(CITIES).toContain("Huế");
    expect(CITIES).toContain("TP. Hồ Chí Minh");
  });

  it("label maps mới đủ đúng khóa (PROVISIONAL — founder content, Batch 8 register)", () => {
    expect(Object.keys(INVENTORY_CONTEXT_LABELS).sort()).toEqual(["new", "open_box", "used"]);
    expect(Object.keys(FULFILLMENT_METHOD_LABELS).sort()).toEqual([
      "carrier",
      "meetup",
      "other",
      "seller_delivery",
    ]);
    expect(Object.keys(PHOTO_CHECKLIST_SLOT_LABELS).sort()).toEqual([...PHOTO_CHECKLIST_SLOTS].sort());
  });
});

// ─── 6. Legacy select guard (item 11 — stored city KHÔNG bị rewrite im lặng) ───

describe("legacy select guard — stored city ngoài CITIES (item 11)", () => {
  it("listing-form render option riêng cho stored city không nằm trong CITIES", () => {
    expect(listingForm).toMatch(/!cities\.includes\(/);
    expect(listingForm).toMatch(/extraCity/);
  });

  it("profile-form render option riêng cho stored profile city", () => {
    expect(profileForm).toMatch(/!CITIES\.includes\(/);
  });
});

// ─── 7. app/models/[slug] — price context neutrality ───────────────────────────

describe("app/models/[slug] — price context (§13.6/§5.8.2)", () => {
  it("giữ card 'Mẫu giá thu thập' (sample-size context), KHÔNG thêm claim authoritative", () => {
    expect(modelPage).toContain("Mẫu giá thu thập");
    expect(modelPage).not.toContain("giá thị trường chuẩn");
  });
});
