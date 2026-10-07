/**
 * Location module (Batch 5 Task 2 — spec §5.9/§5.9.1/§8.3/§4.7, FD-1) — unit tests.
 *
 * Hợp đồng (plan Task 2 Step 1 + corrections 2026-10-08 items 1–2):
 *  - resolveLegacyLocation thực thi FD-1 rule qua resolveLegacyProvince của
 *    registry (src/lib/provinces.ts — Batch 2 Task 10 sở hữu; KHÔNG private
 *    normalizer riêng — corrections item 1): NFC + trim + case-fold +
 *    diacritic-insensitive (kể cả đ/Đ) + collapse khoảng trắng + strip prefix
 *    "Tỉnh"/"TP."/""Thành phố"" — CHỈ khớp TÊN legacy chính xác trong bảng
 *    merger AUTHORITATIVE (NQ 202/2025/QH15). "Khác", tên quận/huyện, typo →
 *    unresolved (fail closed — spec §8.3 "không fabricate").
 *  - Drift guard CITIES (corrections item 2): sau Batch 4 Task 5,
 *    CITIES = [...PROVINCES.map(displayName), "Khác"] — MỌI entry trừ "Khác"
 *    phải map về ĐÚNG mã của chính nó; tên legacy của đơn vị đã sáp nhập
 *    (Bình Dương, Hải Dương, …) nằm ở bảng RIÊNG.
 *  - "Thừa Thiên Huế" → unresolved (registry KHÔNG liệt kê tên cũ của Huế —
 *    tests/unit/provinces.test.ts:15 pin null) — KHOẢNG TRỐNG DATA của
 *    registry (founder-approved source không có tên này), ghi nhận cho Batch 8
 *    Founder Decision Register; KHÔNG patch registry (corrections item 1).
 *  - location.ts là module Batch 5: import registry, KHÔNG bảng tỉnh inline
 *    (FD-1 — nội dung 34 đơn vị là contract của Batch 2 Task 10).
 *  - betaMarketLabel trung tính — spec §4.7: KHÔNG bao giờ ngôn ngữ
 *    an toàn/bảo đảm/đảm bảo/guarantee cho location.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Registry override — chứng minh DELEGATION (không có bảng riêng) ──────────
// Khi override ≠ null: resolveLegacyProvince của registry bị thay bằng fixture
// 1 đơn vị — resolveLegacyLocation phải theo fixture (tên thật → unresolved),
// chứng minh location.ts KHÔNG mang bảng tỉnh riêng (FD-1).

const registryOverride = vi.hoisted(() => ({
  resolve: null as null | ((raw: string) => string | null),
}));

vi.mock("@/src/lib/provinces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/provinces")>();
  return {
    ...actual,
    resolveLegacyProvince: (raw: string): string | null =>
      registryOverride.resolve ? registryOverride.resolve(raw) : actual.resolveLegacyProvince(raw),
  };
});

import { CITIES } from "@/src/lib/constants";
import { PROVINCES } from "@/src/lib/provinces";
import {
  BETA_PRIMARY_MARKET_PROVINCE,
  BETA_SECONDARY_MARKET_PROVINCE,
  betaMarketLabel,
  isProvinceCode,
  PROVINCE_CODES as PROVINCE_CODES_REEXPORT,
  resolveLegacyLocation,
} from "@/src/lib/location";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(`${root}/${p}`, "utf8");

const UNRESOLVED = { provinceLevelCode: null, source: "unresolved" } as const;

// ─── 1. Drift guard CITIES (corrections item 2) ───────────────────────────────

describe("resolveLegacyLocation — drift guard: MỌI entry CITIES map qua FD-1 rule", () => {
  it("mỗi entry CITIES (trừ 'Khác') map về ĐÚNG mã của chính nó (displayName ∈ legacyNames)", () => {
    for (const entry of CITIES) {
      if (entry === "Khác") continue;
      const own = PROVINCES.find((p) => p.displayName === entry);
      // CITIES derive THẲNG TỪ registry (Batch 4 Task 5) — entry lạ = drift
      expect(own, `CITIES entry '${entry}' phải là displayName của một đơn vị registry`).toBeTruthy();
      expect(resolveLegacyLocation(entry)).toEqual({
        provinceLevelCode: own!.code,
        source: "legacy_mapped",
      });
    }
  });

  it("'Khác' → unresolved (fail closed — KHÔNG đoán)", () => {
    expect(resolveLegacyLocation("Khác")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Khac")).toEqual(UNRESOLVED); // không dấu — vẫn không khớp tên nào
  });

  it("thêm CITIES entry không resolve qua rule → test fail (drift guard)", () => {
    // Mọi entry đã được loop ở trên; guard này pin ý nghĩa: một entry mới không
    // nằm trong legacy names của registry sẽ fail loop đầu — không cần thêm gì.
    const resolvable = CITIES.filter((c) => c !== "Khác");
    expect(resolvable.length).toBeGreaterThan(0);
  });
});

// ─── 2. Bảng case tiêu biểu (plan Task 2 Step 1 — bỏ "Thừa Thiên Huế"→hue) ───

describe("resolveLegacyLocation — bảng case FD-1 (registry authoritative)", () => {
  it.each([
    ["Hà Nội", "ha-noi"],
    ["TP. Hồ Chí Minh", "ho-chi-minh"], // prefix stripped + diacritic-insensitive
    ["Đà Nẵng", "da-nang"],
    ["Hải Phòng", "hai-phong"],
    ["Cần Thơ", "can-tho"],
    ["Đồng Nai", "dong-nai"],
    ["Khánh Hòa", "khanh-hoa"],
    ["Lâm Đồng", "lam-dong"],
    ["Nghệ An", "nghe-an"],
    ["Quảng Ninh", "quang-ninh"],
  ])("'%s' → %s (legacy_mapped)", (raw, code) => {
    expect(resolveLegacyLocation(raw)).toEqual({ provinceLevelCode: code, source: "legacy_mapped" });
  });

  it("tên legacy của đơn vị ĐÃ SÁP NHẬP (không phải displayName) map về đơn vị mới (bảng RIÊNG — corrections item 2)", () => {
    expect(resolveLegacyLocation("Bình Dương")).toEqual({
      provinceLevelCode: "ho-chi-minh",
      source: "legacy_mapped",
    }); // FD-1 — merged legacy name, authoritative per NQ 202/2025/QH15
    expect(resolveLegacyLocation("Hải Dương")).toEqual({
      provinceLevelCode: "hai-phong",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("Quảng Nam")).toEqual({
      provinceLevelCode: "da-nang",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("Thái Bình")).toEqual({
      provinceLevelCode: "hung-yen",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("Hà Giang")).toEqual({
      provinceLevelCode: "tuyen-quang",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("Bà Rịa - Vũng Tàu")).toEqual({
      provinceLevelCode: "ho-chi-minh",
      source: "legacy_mapped",
    });
  });
});

// ─── 3. Fail closed — không khớp → unresolved (spec §8.3) ─────────────────────

describe("resolveLegacyLocation — không authoritative → unresolved", () => {
  it("tên quận/huyện/phường (cấp dưới tỉnh) → unresolved", () => {
    expect(resolveLegacyLocation("Quận 1")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Thủ Đức")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Huyện Châu Thành")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Phường 12")).toEqual(UNRESOLVED);
  });

  it("typo → unresolved; null/rỗng → unresolved", () => {
    expect(resolveLegacyLocation("Ha Noii")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation(null)).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation(undefined)).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("   ")).toEqual(UNRESOLVED);
  });

  it("viết tắt/tên NGOÀI bảng founder-approved → unresolved THEO THIẾT KẾ (FD-1 — không bịa thêm)", () => {
    expect(resolveLegacyLocation("HCM")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("TP.HCM")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Sài Gòn")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Sai Gon")).toEqual(UNRESOLVED);
  });

  it("'Thừa Thiên Huế' → unresolved — registry không liệt kê tên cũ của Huế (FOUNDER DATA GAP — Batch 8 register, corrections item 1)", () => {
    // Tên gọi pre-2025 của đơn vị Huế không nằm trong legacyNames của registry
    // (chỉ "Huế" khớp — tests/unit/provinces.test.ts:15 pin null). Khoảng trống
    // data này thuộc Batch 2 Task 10's registry — ghi nhận cho Batch 8 Founder
    // Decision Register, KHÔNG patch registry ở đây.
    expect(resolveLegacyLocation("Thừa Thiên Huế")).toEqual(UNRESOLVED);
    expect(resolveLegacyLocation("Thua Thien Hue")).toEqual(UNRESOLVED);
  });
});

// ─── 4. Chuẩn hóa đầu vào (theo registry — corrections item 1) ────────────────

describe("resolveLegacyLocation — chuẩn hóa theo registry (NFC/trim/case-fold/đ/prefix)", () => {
  it("trailing whitespace → vẫn map (NFC + trim — B7)", () => {
    expect(resolveLegacyLocation("Hà Nội ")).toEqual({
      provinceLevelCode: "ha-noi",
      source: "legacy_mapped",
    });
  });

  it("internal double space → vẫn map (registry collapse khoảng trắng — provinces.ts foldProvinceName, corrections item 1)", () => {
    // Plan gốc đòi unresolved ở case này — corrections item 1 OVERRIDE theo
    // registry thật: foldProvinceName collapse \s+ → " " nên "Hà  Nội" khớp.
    expect(resolveLegacyLocation("Hà  Nội")).toEqual({
      provinceLevelCode: "ha-noi",
      source: "legacy_mapped",
    });
  });

  it("case-fold + diacritic-insensitive (kể cả đ/Đ)", () => {
    expect(resolveLegacyLocation("hà nội")).toEqual({
      provinceLevelCode: "ha-noi",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("Ha Noi")).toEqual({
      provinceLevelCode: "ha-noi",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("ĐÀ NẴNG")).toEqual({
      provinceLevelCode: "da-nang",
      source: "legacy_mapped",
    });
  });

  it("prefix 'Tỉnh'/'Thành phố'/'TP.'/'TP' stripped (kèm dạng không dấu)", () => {
    expect(resolveLegacyLocation("Tỉnh Hà Nội")).toEqual({
      provinceLevelCode: "ha-noi",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("Thành phố Đà Nẵng")).toEqual({
      provinceLevelCode: "da-nang",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("TP Hồ Chí Minh")).toEqual({
      provinceLevelCode: "ho-chi-minh",
      source: "legacy_mapped",
    });
    expect(resolveLegacyLocation("thanh pho Hue")).toEqual({
      provinceLevelCode: "hue",
      source: "legacy_mapped",
    });
  });
});

// ─── 5. Re-export registry helpers (tên theo module Batch 2 shipped) ─────────

describe("re-export registry helpers (corrections item 1 — tên thật của Batch 2)", () => {
  it("isProvinceCode: 34 mã true; giá trị lạ false", () => {
    expect(isProvinceCode("ha-noi")).toBe(true);
    expect(isProvinceCode("khong-ton-tai")).toBe(false);
    expect(isProvinceCode("")).toBe(false);
    expect(isProvinceCode("Thừa Thiên Huế")).toBe(false); // tên, không phải mã
    for (const p of PROVINCES) expect(isProvinceCode(p.code)).toBe(true);
  });

  it("PROVINCE_CODES round-trip theo registry fixture (34 mục)", () => {
    expect(Object.keys(PROVINCE_CODES_REEXPORT)).toHaveLength(34);
    for (const p of PROVINCES) {
      expect(PROVINCE_CODES_REEXPORT[p.code]).toBe(p.displayName);
    }
  });
});

// ─── 6. Beta market (spec §5.9.1) + trung tính ngôn ngữ (spec §4.7) ───────────

describe("beta market constants + label (spec §5.9.1/§4.7)", () => {
  it("primary = ha-noi, secondary = ho-chi-minh — mã registry hợp lệ", () => {
    expect(BETA_PRIMARY_MARKET_PROVINCE).toBe("ha-noi");
    expect(BETA_SECONDARY_MARKET_PROVINCE).toBe("ho-chi-minh");
    expect(isProvinceCode(BETA_PRIMARY_MARKET_PROVINCE)).toBe(true);
    expect(isProvinceCode(BETA_SECONDARY_MARKET_PROVINCE)).toBe(true);
  });

  it("betaMarketLabel() = 'Khu vực beta trọng điểm' — nhãn operational/acquisition (spec §5.9.1)", () => {
    expect(betaMarketLabel()).toBe("Khu vực beta trọng điểm");
  });

  it("source module KHÔNG chứa trust wording cho location (spec §4.7 — source contract)", () => {
    const src = read("src/lib/location.ts");
    expect(src).not.toMatch(/an toàn|bảo đảm|đảm bảo|guarantee/i);
  });
});

// ─── 7. Source contract — registry là của Batch 2 Task 10 (FD-1) ──────────────

describe("location.ts — FD-1: registry thuộc Batch 2 Task 10, chỉ import", () => {
  it("import từ @/src/lib/provinces — KHÔNG bảng tỉnh inline", () => {
    const src = read("src/lib/location.ts");
    expect(src).toMatch(/from "@\/src\/lib\/provinces"/);
    // KHÔNG copy nội dung registry vào CODE của module Batch 5 — comment doc
    // được phép trích dẫn rule (FD-1 nguyên văn), CODE thì không.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/\/\/.*$/gm, ""); // line comments
    expect(code).not.toMatch(/legacyNames/);
    for (const name of ["Hà Nội", "TP. Hồ Chí Minh", "Đà Nẵng", "Bình Dương", "Cần Thơ", "Huế"]) {
      expect(code).not.toContain(`"${name}"`);
    }
  });

  it("resolveLegacyLocation DELEGATE resolveLegacyProvince — override registry bằng fixture 1 đơn vị", () => {
    registryOverride.resolve = (raw) => (raw === "Fixture A" ? "fixture-a" : null);
    try {
      // fixture resolve → resolution theo fixture
      expect(resolveLegacyLocation("Fixture A")).toEqual({
        provinceLevelCode: "fixture-a",
        source: "legacy_mapped",
      });
      // tên THẬT không còn resolve (registry bị thay bằng fixture) — nếu
      // location.ts có bảng riêng thì "Hà Nội" vẫn phải map → fail ở đây
      expect(resolveLegacyLocation("Hà Nội")).toEqual(UNRESOLVED);
      expect(resolveLegacyLocation("TP. Hồ Chí Minh")).toEqual(UNRESOLVED);
    } finally {
      registryOverride.resolve = null;
    }
  });
});
