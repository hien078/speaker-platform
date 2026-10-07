/**
 * Admin review surface — structured fields + workflow badge (Batch 4 Task 6 —
 * spec §5.6/§5.6.1/§5.6.3, §8.2) — source-contract tests (TIGHTENED — review
 * fix M1).
 *
 * /admin/listings là nơi moderator duyệt tin: card phải hiển thị ĐỦ trường
 * structured (spec §5.6) để quyết định duyệt/từ chối trên thông tin thật,
 * phân biệt regime beta (allowlist §5.6.1) vs legacy (grandfathered), và badge
 * "đã xác minh" của seller phải đọc WORKFLOW SỐNG (SellerVerification.status
 * — spec §8.2, Batch 2 review fix) chứ không phải boolean legacy
 * `isVerifiedSeller` đã đóng băng (revoked seller phải mất badge NGAY).
 *
 * Review fix M1: source-string test bare (`toContain("INVENTORY_CONTEXT_LABELS")`,
 * `toContain("—")`…) match CẢ comment — badge điều kiện ĐẢO NGỢC, map rỗng,
 * field bị xóa vẫn xanh hết. HÀNH VI (moderator THẤY gì) chuyển sang RENDER
 * tests trong tests/unit/admin-listings-guard.test.ts (textOf/srcsOf/hrefsOf
 * harness trên element tree thật). File này chỉ giữ source-contract KHÔNG thể
 * thỏa bởi comment: usage-shaped regex (indexing/call site), absence contract
 * (KHÔNG boolean legacy, KHÔNG XSS sink, KHÔNG PII mới), include shape, typed
 * maps (L1).
 *
 * Guard server-side (FORBIDDEN trước db read) + render hành vi: guard file.
 * Guard action approve/reject assert ở rbac.test.ts + publication-gate.test.ts.
 *
 * Label maps (INVENTORY_CONTEXT_LABELS/…) sống cục bộ trong page vì Task 5
 * (chủ sở hữu src/lib/constants.ts) chạy song song trong batch — xem comment
 * trong page; test pin map TYPED theo union Task 2 (L1), không pin vị trí
 * định nghĩa.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");
const PAGE = "app/admin/listings/page.tsx";

// ─── Structured fields (spec §5.6) — typed maps + usage call sites ──────────

describe("admin listings review card — structured fields (spec §5.6)", () => {
  it("label maps: MỘT nguồn constants.ts, TYPED theo union Task 2 (L1) — thiếu key fail typecheck", () => {
    const src = read(PAGE);
    // page KHÔNG định nghĩa lại map — import từ constants (seller + moderator cùng nhãn)
    expect(src).not.toMatch(/const (INVENTORY_CONTEXT|FULFILLMENT_METHOD|PHOTO_CHECKLIST_SLOT)_LABELS/);
    expect(src).toMatch(/PHOTO_CHECKLIST_SLOT_LABELS,[\s\S]*\} from "@\/src\/lib\/constants"/);
    const constants = read("src/lib/constants.ts");
    expect(constants).toMatch(/INVENTORY_CONTEXT_LABELS: Record<InventoryContext, string>/);
    expect(constants).toMatch(/FULFILLMENT_METHOD_LABELS: Record<ListingFulfillmentMethod, string>/);
    expect(constants).toMatch(/PHOTO_CHECKLIST_SLOT_LABELS: Record<PhotoChecklistSlot, string>/);
    expect(constants).toMatch(/import type \{ InventoryContext, ListingFulfillmentMethod, PhotoChecklistSlot \} from "@\/src\/lib\/listing-schema"/);
  });

  it("lookup qua Object.hasOwn + raw fallback (L4) — call site, không tên trong comment", () => {
    const src = read(PAGE);
    expect(src).toMatch(/labelOrRaw\(INVENTORY_CONTEXT_LABELS, l\.inventoryContext\)/);
    expect(src).toMatch(/labelOrRaw\(FULFILLMENT_METHOD_LABELS, m\)/);
    expect(src).toMatch(/labelOrRaw\(PHOTO_CHECKLIST_SLOT_LABELS, img\.checklistSlot\)/);
    expect(src).toMatch(/Object\.hasOwn\(PROVINCE_CODES, l\.provinceLevelCode\)/);
  });

  it("structured free-text qua orDash (NULL legacy → '—') — call site từng field", () => {
    const src = read(PAGE);
    expect(src).toMatch(/orDash\(l\.includedAccessories\)/);
    expect(src).toMatch(/orDash\(l\.knownDefects\)/);
    expect(src).toMatch(/orDash\(l\.repairHistory\)/);
    expect(src).toMatch(/l\.locationDisplayName/);
  });

  it("b4-holistic round-3 — KHÔNG line-clamp: moderator đọc TOÀN VĂN description/free-text trước khi duyệt", () => {
    // Trước fix: line-clamp-1/line-clamp-2 che dòng 3+ (số điện thoại/Zalo giấu
    // dưới phần clamp) — moderator duyệt content KHÔNG bao giờ thấy. Sau fix:
    // whitespace-pre-wrap + break-words + max-h cuộn (không cắt).
    const src = read(PAGE);
    expect(src).not.toMatch(/line-clamp-\d/);
    expect(src).toMatch(/max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed/);
    expect(src.match(/max-h-40 overflow-y-auto whitespace-pre-wrap break-words/g)?.length).toBe(3);
  });
});

// ─── Beta vs legacy category badge (spec §5.6.1) — usage call ────────────────

describe("admin listings review card — badge regime category (spec §5.6.1)", () => {
  it("regime derive qua listingRegimeForCategorySlug (Task 2) trên slug DB row", () => {
    expect(read(PAGE)).toMatch(/listingRegimeForCategorySlug\(l\.category!\.slug\)/);
  });
});

// ─── Seller badge đọc WORKFLOW (spec §8.2 — Batch 2 review fix) ───────────────

describe("admin listings review card — seller badge đọc SellerVerification (spec §8.2)", () => {
  it("isVerifiedSellerStatus gọi trên sellerVerification.status — KHÔNG đọc boolean legacy", () => {
    const src = read(PAGE);
    expect(src).toMatch(/isVerifiedSellerStatus\(l\.seller!\.sellerVerification\?\.status\)/);
    // Đọc boolean legacy = truy cập property `.isVerifiedSeller` (comment nhắc
    // TÊN không tính — regex chỉ match property access; `isVerifiedSellerStatus`
    // không match vì không có `.` trước và không có \b giữa "r"/"S").
    expect(src).not.toMatch(/\.isVerifiedSeller\b/);
  });
});

// ─── Gallery — mọi ảnh + caption slot + cap (spec §5.6.3 + L2) ──────────────

describe("admin listings review card — gallery mọi ảnh + caption slot (spec §5.6.3)", () => {
  it("images include: select checklistSlot + orderBy sortOrder + cap 12 (L2), KHÔNG cắt ảnh đầu", () => {
    const src = read(PAGE);
    expect(src).toMatch(
      /include\("images", \(i\) =>\s*i\.select\("id", "url", "checklistSlot"\)\s*\.orderBy\(\(img\) => img\.sortOrder\.asc\(\)\)\s*\.limit\(12\)/,
    );
    expect(src).not.toContain(".limit(1)");
  });
});

// ─── Ảnh an toàn (M2) — reuse validator Task 2, placeholder cho url lạ ──────

describe("admin listings review card — img src same-origin (M2 — review fix)", () => {
  it("reuse ATTACHED_IMAGE_PATH_PATTERN (listing-images.ts) + chặn '..' — import, KHÔNG copy local", () => {
    const src = read(PAGE);
    expect(src).toMatch(/from "@\/src\/lib\/listing-images"/);
    expect(src).toMatch(/ATTACHED_IMAGE_PATH_PATTERN\.test\(url\) && !url\.includes\("\.\."\)/);
  });

  it("url bị chặn → placeholder text, KHÔNG link tới nó", () => {
    const src = read(PAGE);
    expect(src).toContain("URL ảnh không hợp lệ");
  });
});

// ─── Model chuẩn (L3) — status select + badge chưa canonical ─────────────────

describe("admin listings review card — model chuẩn status (L3 — review fix)", () => {
  it("select ProductModel.status + badge khi status !== 'approved' (enum model_status)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/m\.select\("name", "slug", "status"\)/);
    expect(src).toMatch(/l\.productModel\.status !== "approved"/);
  });
});

// ─── Query (L5) — draft seller-private, loại khỏi mọi tab ─────────────────────

describe("admin listings page — query loại draft (L5 — spec §4.4)", () => {
  it("mọi listing query của page loại status 'draft'", () => {
    expect(read(PAGE)).toMatch(/l\.status\.neq\("draft"\)/);
  });
});

// ─── Guard + PII + copy trung tính (spec §4.5/§4.8/§4.2) ─────────────────────

describe("admin listings review card — guard + PII (spec §4.5/§4.8)", () => {
  it("giữ guard Batch 2 requireCapability(\"listing.moderate\")", () => {
    expect(read(PAGE)).toContain('requireCapability("listing.moderate")');
  });

  it("seller email render như hiện tại (không THÊM PII — không phone)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/s\.select\("name", "email"\)/);
    expect(src).not.toContain("phone");
  });

  it("KHÔNG dangerouslySetInnerHTML (stored XSS qua listing)", () => {
    expect(read(PAGE)).not.toContain("dangerouslySetInnerHTML");
  });

  it("copy trung tính — không ngôn ngữ bảo đảm (spec §4.2)", () => {
    expect(read(PAGE)).not.toMatch(/đảm bảo|bảo đảm|guarantee/i);
  });
});
