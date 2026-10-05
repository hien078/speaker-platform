/**
 * Dữ liệu "Gợi ý mẫu loa secondhand đáng tìm" — ràng buộc tính trung thực:
 * - đúng 8 mẫu, model & đường dẫn ảnh không trùng nhau; đúng 6 thương hiệu
 * - ảnh chỉ WebP project-local (/img/secondhand-models/), file tồn tại,
 *   giải mã đúng 960×720 WebP (contain — không crop nội dung ảnh)
 * - thư mục asset commit đúng 8 file WebP, không file thừa
 * - link tìm kiếm nội bộ /listings?q=… — không HTTPS, không nguồn ngoài
 * - source component có disclaimer trung thực, không tham chiếu public/uploads
 * - KHÔNG chứa trường giá/tồn kho/tình trạng/thông số (không phải tin rao bán)
 * - alt mô tả ảnh tham khảo, nêu đúng thương hiệu + model
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { SECONDHAND_MODELS } from "../../src/components/secondhand-models";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
const assetDir = publicDir + "/img/secondhand-models";
const componentPath = fileURLToPath(
  new URL("../../src/components/secondhand-models.tsx", import.meta.url),
);
const pagePath = fileURLToPath(new URL("../../app/page.tsx", import.meta.url));

/** Trường thương mại cấm — đây là gợi ý tham khảo, không phải tin rao bán */
const FORBIDDEN_KEYS = [
  "price",
  "stock",
  "quantity",
  "sale",
  "discount",
  "promo",
  "condition",
  "warranty",
  "specs",
  "sourceUrl",
] as const;

/** Source component bỏ qua doc comment — comment được phép NÓI "không X" */
async function componentCode(): Promise<string> {
  const source = await readFile(componentPath, "utf8");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("SECONDHAND_MODELS — tổng thể 8 mẫu, 6 thương hiệu", () => {
  it("có đúng 8 mẫu", () => {
    expect(SECONDHAND_MODELS).toHaveLength(8);
  });

  it("model không trùng nhau", () => {
    const models = SECONDHAND_MODELS.map((m) => m.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it("đường dẫn ảnh không trùng nhau", () => {
    const srcs = SECONDHAND_MODELS.map((m) => m.image.src);
    expect(new Set(srcs).size).toBe(srcs.length);
  });

  it("có đúng 6 thương hiệu, không rỗng", () => {
    const brands = SECONDHAND_MODELS.map((m) => m.brand);
    expect(new Set(brands).size).toBe(6);
    for (const brand of brands) {
      expect(brand.trim()).not.toBe("");
    }
  });

  it("mỗi mẫu có brand/model/category và query tìm kiếm không rỗng", () => {
    for (const m of SECONDHAND_MODELS) {
      expect(m.brand.trim()).not.toBe("");
      expect(m.model.trim()).not.toBe("");
      expect(m.category.trim()).not.toBe("");
      expect(m.query.trim()).not.toBe("");
    }
  });
});

describe("ảnh — chỉ WebP project-local, tồn tại, giải mã 960×720", () => {
  it("chỉ tham chiếu WebP nội bộ /img/secondhand-models/, file tồn tại", () => {
    for (const m of SECONDHAND_MODELS) {
      expect(m.image.src).toMatch(/^\/img\/secondhand-models\/[a-z0-9-]+\.webp$/);
      expect(m.image.src).not.toMatch(/^https?:\/\//);
      expect(existsSync(publicDir + m.image.src)).toBe(true);
    }
  });

  it("khai báo width/height đúng 960×720 để tránh layout shift", () => {
    for (const m of SECONDHAND_MODELS) {
      expect(m.image.width).toBe(960);
      expect(m.image.height).toBe(720);
    }
  });

  it("giải mã đúng định dạng WebP 960×720 (contain, không crop)", async () => {
    for (const m of SECONDHAND_MODELS) {
      const meta = await sharp(publicDir + m.image.src).metadata();
      expect(meta.format, m.image.src).toBe("webp");
      expect(meta.width, m.image.src).toBe(960);
      expect(meta.height, m.image.src).toBe(720);
    }
  });

  it("thư mục asset commit đúng 8 file WebP, không file thừa", () => {
    const files = readdirSync(assetDir).sort();
    expect(files).toHaveLength(8);
    for (const f of files) {
      expect(f).toMatch(/\.webp$/);
    }
    const referenced = SECONDHAND_MODELS.map((m) =>
      m.image.src.replace("/img/secondhand-models/", ""),
    ).sort();
    expect(files).toEqual(referenced);
  });
});

describe("tính trung thực — không phải tin rao bán, không nguồn ngoài", () => {
  it("không chứa trường giá/tồn kho/tình trạng/thông số/nguồn ngoài", () => {
    for (const m of SECONDHAND_MODELS) {
      const keys = Object.keys(m);
      for (const k of FORBIDDEN_KEYS) {
        expect(keys, `${m.model}: cấm trường "${k}"`).not.toContain(k);
      }
    }
  });

  it("không giá trị nào chứa URL HTTPS — chỉ tìm kiếm nội bộ", () => {
    for (const m of SECONDHAND_MODELS) {
      const values = [m.brand, m.model, m.category, m.query, m.alt, m.image.src];
      for (const v of values) {
        expect(v, `${m.model}: "${v}"`).not.toMatch(/^https?:\/\//);
      }
    }
  });

  it("alt mô tả ảnh tham khảo và nêu đúng thương hiệu + model", () => {
    for (const m of SECONDHAND_MODELS) {
      expect(m.alt).toMatch(/^Ảnh tham khảo/);
      expect(m.alt).toContain(m.brand);
      expect(m.alt).toContain(m.model);
    }
  });
});

describe("source component — disclaimer trung thực, không JS client", () => {
  it("chứa disclaimer: gợi ý secondhand, ảnh tham khảo, không phải tin đang bán", async () => {
    // source có thể xuống dòng giữa câu — chuẩn hoá whitespace trước khi so
    const flat = (await readFile(componentPath, "utf8")).replace(/\s+/g, " ");
    expect(flat).toContain("secondhand");
    expect(flat).toContain("ảnh tham khảo");
    expect(flat).toContain("không phải tin đang bán");
    expect(flat).toContain("không giá");
    expect(flat).toContain("không tồn kho");
  });

  it("link tìm kiếm là nội bộ /listings?q=, không HTTPS, không public/uploads", async () => {
    const source = await readFile(componentPath, "utf8");
    expect(source).toContain("href={`/listings?q=${encodeURIComponent(");
    expect(source).not.toContain("public/uploads");
    expect(source).not.toContain("/uploads/");
    expect(source).not.toMatch(/https:\/\//);
  });

  it("server component thuần — không directive client, handler, carousel, hiệu ứng", async () => {
    const code = await componentCode();
    expect(code.trimStart().startsWith('"use client"')).toBe(false);
    expect(code).not.toContain("carousel");
    expect(code).not.toContain("backdrop-filter");
    expect(code).not.toMatch(/animate-\w/);
    expect(code).not.toMatch(/transition-\w/);
    for (const clientSignal of [
      "useState",
      "useEffect",
      "useRef",
      "onClick",
      "onChange",
      "onLoad",
      "onError",
      "onMouse",
      "addEventListener",
    ]) {
      expect(code, `không được có ${clientSignal}`).not.toContain(clientSignal);
    }
  });

  it("dùng next/image lazy + sizes phản hồi cho khung ảnh 4:3", async () => {
    const code = await componentCode();
    expect(code).toContain('loading="lazy"');
    expect(code).toContain("sizes=");
    expect(code).toContain("aspect-[4/3]");
  });
});

describe("vị trí trên trang chủ", () => {
  it("section đứng TRƯỚC FeaturedSpeakersSection trong app/page.tsx", async () => {
    const page = await readFile(pagePath, "utf8");
    const secondhand = page.indexOf("<SecondhandModelsSection />");
    const featured = page.indexOf("<FeaturedSpeakersSection />");
    expect(secondhand).toBeGreaterThan(-1);
    expect(featured).toBeGreaterThan(-1);
    expect(secondhand).toBeLessThan(featured);
  });
});
