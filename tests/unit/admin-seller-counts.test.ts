/**
 * Seller-verification review signal "Số tin đăng" + admin /admin/users listing
 * count (b4-holistic-2 — CONFIRMED LOW "counts now include drafts, which
 * applicants can inflate without any seller gate") — source-contract tests.
 *
 * Trước fix: `Listing.where({ sellerId }).aggregate(count())` đếm MỌI status —
 * Batch 4 mở draft cho user CHƯA verification (saveListingDraftAction không
 * seller gate) → applicant stack 20 draft/giờ (LISTING_MUTATION_RATE) làm tín
 * hiệu "Số tin đăng: N" đọc như hoạt động listing thật dù KHÔI row nào qua
 * publication gate.
 *
 * Sau fix (recorded decision — chọn phương án "second aggregate" mà finding
 * khuyến nghị: một chồng draft từ applicant LÀ tín hiệu review hữu ích):
 *  - SỐ CHÍNH đếm status ≠ draft (những row đã qua gate/review);
 *  - SỐ NHÁP đếm riêng status = draft, hiển thị cạnh nhau ("Tin nháp: M" /
 *    "(+M nháp)") — reviewer đối chiếu thay vì đọc N bị thổi phồng.
 *
 * Pattern: usage-shaped regex (admin-listings-page.test.ts) — KHÔNG thỏa bởi
 * comment; absence contract: KHÔNG còn aggregate đếm MỌI status cho tín hiệu này.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const VERIFICATION_PAGE = "app/admin/seller-verification/page.tsx";
const USERS_PAGE = "app/admin/users/page.tsx";

// ─── /admin/seller-verification — tín hiệu §5.3.3 checklist ──────────────────

describe("admin seller-verification — 'Số tin đăng' tách draft (b4-holistic-2 LOW)", () => {
  it("số CHÍNH đếm status ≠ draft (neq trên field op — KHÔNG đếm MỌI status)", () => {
    const src = read(VERIFICATION_PAGE);
    expect(src).toMatch(
      /db\.orm\.public\.Listing\.where\(\{ sellerId: userId \}\)\.where\(\(l\) => l\.status\.neq\("draft"\)\)\.aggregate/,
    );
  });

  it("số NHÁP đếm riêng status = draft — second aggregate", () => {
    const src = read(VERIFICATION_PAGE);
    expect(src).toMatch(
      /db\.orm\.public\.Listing\.where\(\{ sellerId: userId, status: "draft" \}\)\.aggregate/,
    );
  });

  it("render CẢ HAI tín hiệu: 'Số tin đăng' (non-draft) + 'Tin nháp' (draft) — usage call site", () => {
    const src = read(VERIFICATION_PAGE);
    expect(src).toMatch(/Số tin đăng: <b>\{signals\.listingCount\}<\/b>/);
    expect(src).toMatch(/Tin nháp: <b>\{signals\.draftCount\}<\/b>/);
  });

  it("KHÔNG còn aggregate đếm MỌI status cho tín hiệu review (absence contract)", () => {
    const src = read(VERIFICATION_PAGE);
    // Trước fix: `.where({ sellerId: userId }).aggregate(...)` — không filter status
    expect(src).not.toMatch(/db\.orm\.public\.Listing\.where\(\{ sellerId: userId \}\)\.aggregate/);
  });
});

// ─── /admin/users — cột "Tin đăng" ────────────────────────────────────────────

describe("admin users — cột 'Tin đăng' tách draft (b4-holistic-2 LOW)", () => {
  it("số CHÍNH đếm status ≠ draft (neq field op)", () => {
    const src = read(USERS_PAGE);
    expect(src).toMatch(
      /db\.orm\.public\.Listing\.where\(\{ sellerId: u\.id \}\)\.where\(\(l\) => l\.status\.neq\("draft"\)\)\.aggregate/,
    );
  });

  it("số NHÁP đếm riêng status = draft — second aggregate", () => {
    const src = read(USERS_PAGE);
    expect(src).toMatch(
      /db\.orm\.public\.Listing\.where\(\{ sellerId: u\.id, status: "draft" \}\)\.aggregate/,
    );
  });

  it("render số nháp kèm số chính ((+M nháp) — usage call site)", () => {
    const src = read(USERS_PAGE);
    expect(src).toMatch(/u\.draftCount > 0/);
    expect(src).toMatch(/\(\+\{u\.draftCount\} nháp\)/);
  });

  it("cột hiển thị số NON-DRAFT (KHÔNG phải tổng bị thổi phồng) — usage call site", () => {
    const src = read(USERS_PAGE);
    expect(src).toMatch(/<td className="text-sm">\s*\{u\.listingCount\}/);
  });

  it("KHÔNG còn aggregate đếm MỌI status cho cột này (absence contract)", () => {
    const src = read(USERS_PAGE);
    expect(src).not.toMatch(/db\.orm\.public\.Listing\.where\(\{ sellerId: u\.id \}\)\.aggregate/);
  });
});
