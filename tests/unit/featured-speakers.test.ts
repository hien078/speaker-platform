/**
 * Dữ liệu "Mẫu loa nổi bật" — ràng buộc tính trung thực:
 * - mỗi mẫu có brand/model/type + 3–4 thông số tham khảo
 * - ảnh phải là WebP project-local (đã tối ưu), file phải tồn tại
 * - alt nói rõ ảnh minh họa AI
 * - nguồn thông số phải là HTTPS trang chính hãng
 * - KHÔNG chứa trường giá/tồn kho/khuyến mại (không phải tin rao bán)
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FEATURED_SPEAKERS } from "../../src/components/featured-speakers";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));

describe("FEATURED_SPEAKERS", () => {
  it("có 4 mẫu loa", () => {
    expect(FEATURED_SPEAKERS).toHaveLength(4);
  });

  it("mỗi mẫu có brand/model/type và query tìm kiếm không rỗng", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.brand.trim()).not.toBe("");
      expect(s.model.trim()).not.toBe("");
      expect(s.type.trim()).not.toBe("");
      expect(s.query.trim()).not.toBe("");
    }
  });

  it("mỗi mẫu có 3–4 thông số tham khảo, không rỗng", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.specs.length).toBeGreaterThanOrEqual(3);
      expect(s.specs.length).toBeLessThanOrEqual(4);
      for (const spec of s.specs) {
        expect(spec.trim()).not.toBe("");
      }
    }
  });

  it("chỉ tham chiếu ảnh WebP project-local và file tồn tại", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.image.src).toMatch(/^\/img\/featured\/[a-z0-9-]+\.webp$/);
      expect(s.image.src).not.toMatch(/\.png$/i);
      expect(existsSync(publicDir + s.image.src)).toBe(true);
    }
  });

  it("alt nói rõ đây là ảnh minh họa AI", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.alt).toMatch(/^Ảnh minh họa AI/);
      expect(s.alt).toContain(s.model);
    }
  });

  it("nguồn thông số là HTTPS và có nhãn hiển thị", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.sourceUrl).toMatch(/^https:\/\//);
      expect(s.sourceLabel.trim()).not.toBe("");
    }
  });

  it("không chứa trường giá/tồn kho/khuyến mại (không phải tin rao bán)", () => {
    const forbidden = ["price", "stock", "quantity", "sale", "discount", "promo"] as const;
    for (const s of FEATURED_SPEAKERS) {
      const keys = Object.keys(s);
      for (const k of forbidden) {
        expect(keys).not.toContain(k);
      }
    }
  });
});
