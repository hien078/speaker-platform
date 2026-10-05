/**
 * Dữ liệu "Mẫu loa nổi bật" (nhóm theo thương hiệu) — ràng buộc tính trung thực:
 * - 8 nhóm thương hiệu đúng thứ tự, 19 mẫu loa tổng cộng
 * - JBL / Harman Kardon / Bose: đúng 3 mẫu; các nhóm còn lại: đúng 2 mẫu
 * - mỗi mẫu có model/type + 3–4 thông số tham khảo từ nhà sản xuất
 * - ảnh phải là WebP project-local (đã tối ưu), file phải tồn tại, đường dẫn duy nhất
 * - alt nói rõ ảnh minh họa AI
 * - nguồn thông số phải là HTTPS trang chính hãng
 * - KHÔNG chứa trường giá/tồn kho/khuyến mại (không phải tin rao bán)
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FEATURED_BRANDS, FEATURED_SPEAKERS } from "../../src/components/featured-speakers";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));

/** Thứ tự thương hiệu bắt buộc trên trang chủ */
const BRAND_ORDER = [
  "JBL",
  "Harman Kardon",
  "Bose",
  "Sony",
  "Marshall",
  "Klipsch",
  "Yamaha",
  "Electro-Voice",
] as const;

const THREE_CARD_BRANDS = ["JBL", "Harman Kardon", "Bose"] as const;

describe("FEATURED_BRANDS — nhóm thương hiệu", () => {
  it("có đúng 8 nhóm thương hiệu, đúng thứ tự yêu cầu", () => {
    expect(FEATURED_BRANDS).toHaveLength(8);
    expect(FEATURED_BRANDS.map((g) => g.brand)).toEqual([...BRAND_ORDER]);
  });

  it("JBL, Harman Kardon và Bose có đúng 3 mẫu mỗi nhóm", () => {
    for (const brand of THREE_CARD_BRANDS) {
      const group = FEATURED_BRANDS.find((g) => g.brand === brand);
      expect(group).toBeDefined();
      expect(group!.speakers).toHaveLength(3);
    }
  });

  it("mỗi nhóm còn lại có đúng 2 mẫu", () => {
    for (const group of FEATURED_BRANDS) {
      if ((THREE_CARD_BRANDS as readonly string[]).includes(group.brand)) continue;
      expect(group.speakers, group.brand).toHaveLength(2);
    }
  });

  it("slug nhóm không trùng nhau và không rỗng", () => {
    const slugs = FEATURED_BRANDS.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug.trim()).not.toBe("");
    }
  });
});

describe("FEATURED_SPEAKERS — tổng thể 19 mẫu", () => {
  it("có đúng 19 mẫu loa tổng cộng", () => {
    expect(FEATURED_SPEAKERS).toHaveLength(19);
    expect(FEATURED_BRANDS.reduce((n, g) => n + g.speakers.length, 0)).toBe(19);
  });

  it("model không trùng nhau", () => {
    const models = FEATURED_SPEAKERS.map((s) => s.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it("đường dẫn ảnh không trùng nhau", () => {
    const srcs = FEATURED_SPEAKERS.map((s) => s.image.src);
    expect(new Set(srcs).size).toBe(srcs.length);
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

  it("khai báo width/height ảnh đúng tỉ lệ 4:3 để tránh layout shift", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.image.width).toBe(1000);
      expect(s.image.height).toBe(750);
    }
  });

  it("alt nói rõ đây là ảnh minh họa AI và nêu đúng model", () => {
    for (const s of FEATURED_SPEAKERS) {
      expect(s.alt).toMatch(/^Ảnh minh họa AI/);
      expect(s.alt).toContain(s.brand);
      expect(s.alt).toContain(s.model);
    }
  });

  it("nguồn thông số là HTTPS chính hãng và có nhãn hiển thị", () => {
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
    for (const g of FEATURED_BRANDS) {
      const keys = Object.keys(g);
      for (const k of forbidden) {
        expect(keys).not.toContain(k);
      }
    }
  });
});
