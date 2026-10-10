/**
 * Public "verified seller" badge (review fix Task 10 — spec §4.2/§8.2/§6.2)
 * — unit + source-contract tests.
 *
 * Legacy `User.isVerifiedSeller` bị ĐÓNG BĂNG từ Task 10 (workflow là
 * canonical): badge công khai đọc từ `SellerVerification.status === "verified"`
 * — revoked seller mất badge NGAY, seller verified mới (không có boolean
 * legacy) có badge. Copy nhãn dùng đúng câu §6.2.
 *
 *  1. Helper thuần: isVerifiedSellerStatus — chỉ "verified" là true.
 *  2. Nhãn §6.2 nguyên văn — không bảo đảm/đảm bảo/chứng nhận.
 *  3. Source contract (như finance-public-surface.test.ts): 3 trang badge
 *     công khai (listing detail / seller profile / profile) đọc
 *     SellerVerification status qua helper — KHÔNG còn isVerifiedSeller.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SELLER_VERIFIED_BADGE_LABEL,
  isVerifiedSellerStatus,
} from "@/src/lib/seller-verification-status";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── 1. Helper thuần ────────────────────────────────────────────────────────

describe("isVerifiedSellerStatus — chỉ status=verified được badge (spec §8.2)", () => {
  it("verified → true", () => {
    expect(isVerifiedSellerStatus("verified")).toBe(true);
  });

  it("mọi trạng thái khác → false (revoked mất badge NGAY)", () => {
    for (const status of ["pending", "rejected", "needs_review", "revoked", "not_started"]) {
      expect(isVerifiedSellerStatus(status), status).toBe(false);
    }
    expect(isVerifiedSellerStatus(null)).toBe(false);
    expect(isVerifiedSellerStatus(undefined)).toBe(false); // chưa có row workflow
  });
});

// ─── 2. Copy §6.2 ─────────────────────────────────────────────────────────────

describe("SELLER_VERIFIED_BADGE_LABEL — copy §6.2 nguyên văn, không bảo đảm", () => {
  it("đúng câu được phép của spec §6.2", () => {
    expect(SELLER_VERIFIED_BADGE_LABEL).toBe(
      "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.",
    );
  });

  it("KHÔNG chứa ngôn ngữ avoid-list §6.2", () => {
    expect(SELLER_VERIFIED_BADGE_LABEL).not.toMatch(/bảo đảm|đảm bảo|bảo vệ|chứng nhận/i);
  });
});

// ─── 3. Source contract — 3 trang badge đọc workflow, không đọc boolean ──────

describe("source contract — badge công khai đọc SellerVerification (spec §8.2)", () => {
  // Đọc boolean legacy = truy cập property `.isVerifiedSeller` (comment nhắc
  // TÊN không tính — regex chỉ match property access).
  const LEGACY_READ = /\.isVerifiedSeller\b/;

  it("listing detail: include sellerVerification.status + helper, KHÔNG đọc boolean legacy", () => {
    const src = read("app/listings/[slug]/page.tsx");
    expect(src).toContain("sellerVerification");
    expect(src).toContain("isVerifiedSellerStatus");
    expect(src).not.toMatch(LEGACY_READ);
  });

  it("seller profile: query SellerVerification + helper, KHÔNG đọc boolean legacy", () => {
    const src = read("app/seller/[id]/page.tsx");
    expect(src).toContain("SellerVerification");
    expect(src).toContain("isVerifiedSellerStatus");
    expect(src).not.toMatch(LEGACY_READ);
  });

  it("profile: query SellerVerification + helper, KHÔNG đọc boolean legacy", () => {
    const src = read("app/profile/page.tsx");
    expect(src).toContain("SellerVerification");
    expect(src).toContain("isVerifiedSellerStatus");
    expect(src).not.toMatch(LEGACY_READ);
  });

  it("nhãn hiển thị dùng §6.2 wording (label từ helper, không tự chế)", () => {
    for (const p of [
      "app/listings/[slug]/page.tsx",
      "app/seller/[id]/page.tsx",
      "app/profile/page.tsx",
    ]) {
      const src = read(p);
      expect(src, p).toContain("SELLER_VERIFIED_BADGE_LABEL");
    }
  });
});
