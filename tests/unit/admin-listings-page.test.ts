/**
 * Admin review surface — structured fields + workflow badge (Batch 4 Task 6 —
 * spec §5.6/§5.6.1/§5.6.3, §8.2) — source-contract tests.
 *
 * /admin/listings là nơi moderator duyệt tin: card phải hiển thị ĐỦ trường
 * structured (spec §5.6) để quyết định duyệt/từ chối trên thông tin thật,
 * phân biệt regime beta (allowlist §5.6.1) vs legacy (grandfathered), và badge
 * "đã xác minh" của seller phải đọc WORKFLOW SỐNG (SellerVerification.status
 * — spec §8.2, Batch 2 review fix) chứ không phải boolean legacy
 * `isVerifiedSeller` đã đóng băng (revoked seller phải mất badge NGAY).
 *
 * Source contract (như seller-verified-badge.test.ts): đọc source page,
 * assert cấu trúc — KHÔNG jsdom. Guard server-side (FORBIDDEN trước db read)
 * đã có tests/unit/admin-listings-guard.test.ts; guard action approve/reject
 * assert ở rbac.test.ts + publication-gate.test.ts.
 *
 * Label maps (INVENTORY_CONTEXT_LABELS/…) sống cục bộ trong page vì Task 5
 * (chủ sở hữu src/lib/constants.ts) chạy song song trong batch — xem comment
 * trong page; test chỉ pin TÊN được dùng, không pin vị trí định nghĩa.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");
const PAGE = "app/admin/listings/page.tsx";

// ─── Structured fields (spec §5.6) ───────────────────────────────────────────

describe("admin listings review card — structured fields (spec §5.6)", () => {
  it("render các trường structured: nguồn hàng, phụ kiện, lỗi đã biết, lịch sử sửa, giao hàng, vị trí, slot ảnh", () => {
    const src = read(PAGE);
    expect(src).toContain("INVENTORY_CONTEXT_LABELS");
    expect(src).toContain("knownDefects");
    expect(src).toContain("repairHistory");
    expect(src).toContain("includedAccessories");
    expect(src).toContain("FULFILLMENT_METHOD_LABELS");
    expect(src).toContain("locationDisplayName");
    expect(src).toContain("PHOTO_CHECKLIST_SLOT_LABELS");
  });

  it("vị trí canonical: locationDisplayName + tỉnh từ registry FD-1 (PROVINCE_CODES)", () => {
    const src = read(PAGE);
    expect(src).toContain("PROVINCE_CODES");
    expect(src).toContain("provinceLevelCode");
  });

  it("model chuẩn render thành link /models/<slug>", () => {
    expect(read(PAGE)).toContain("/models/");
  });

  it("legacy NULL → em-dash (spec §8.3 — không backfill, hiển thị '—')", () => {
    expect(read(PAGE)).toContain("—");
  });
});

// ─── Beta vs legacy category badge (spec §5.6.1) ─────────────────────────────

describe("admin listings review card — badge regime category (spec §5.6.1)", () => {
  it("phân biệt allowlist (beta) vs legacy qua regime Task 2 + render 2 nhãn", () => {
    const src = read(PAGE);
    expect(src).toContain("listingRegimeForCategorySlug");
    expect(src).toContain("Danh mục beta");
    expect(src).toContain("Danh mục legacy");
  });
});

// ─── Seller badge đọc WORKFLOW (spec §8.2 — Batch 2 review fix) ───────────────

describe("admin listings review card — seller badge đọc SellerVerification (spec §8.2)", () => {
  it("include sellerVerification.status + isVerifiedSellerStatus, KHÔNG đọc boolean legacy", () => {
    const src = read(PAGE);
    expect(src).toContain("sellerVerification");
    expect(src).toContain("isVerifiedSellerStatus");
    // Đọc boolean legacy = truy cập property `.isVerifiedSeller` (comment nhắc
    // TÊN không tính — regex chỉ match property access; `isVerifiedSellerStatus`
    // không match vì không có `.` trước và không có \b giữa "r"/"S").
    expect(src).not.toMatch(/\.isVerifiedSeller\b/);
  });
});

// ─── Gallery — MỌI ảnh + caption slot (spec §5.6.3) ───────────────────────────

describe("admin listings review card — gallery mọi ảnh + caption slot (spec §5.6.3)", () => {
  it("images include KHÔNG .limit(1) + select checklistSlot", () => {
    const src = read(PAGE);
    expect(src).not.toContain(".limit(1)");
    expect(src).toMatch(/include\("images",[\s\S]*?checklistSlot/);
  });

  it("render mọi ảnh (map) — gallery không cắt ở ảnh đầu", () => {
    expect(read(PAGE)).toMatch(/images\.map\(/);
  });
});

// ─── Guard + PII + copy trung tính (spec §4.5/§4.8/§4.2) ─────────────────────

describe("admin listings review card — guard + PII (spec §4.5/§4.8)", () => {
  it("giữ guard Batch 2 requireCapability(\"listing.moderate\")", () => {
    expect(read(PAGE)).toContain('requireCapability("listing.moderate")');
  });

  it("seller email render như hiện tại (không THÊM PII — không phone)", () => {
    const src = read(PAGE);
    expect(src).toContain("email");
    expect(src).not.toContain("phone");
  });

  it("KHÔNG dangerouslySetInnerHTML (stored XSS qua listing)", () => {
    expect(read(PAGE)).not.toContain("dangerouslySetInnerHTML");
  });

  it("copy trung tính — không ngôn ngữ bảo đảm (spec §4.2)", () => {
    expect(read(PAGE)).not.toMatch(/đảm bảo|bảo đảm|guarantee/i);
  });
});
