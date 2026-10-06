/**
 * Search normalization (Batch 5 Task 3 — spec §5.7) — unit tests.
 *
 * Module THUẦN (src/lib/search-normalize.ts): không db, không server-only —
 * test trực tiếp. Đây là CỔNG diacritic của batch:
 *  - B5: đ/Đ KHÔNG có canonical decomposition (NFD không tách được) — phải
 *    replace riêng, "đỏ" → "do" là test tải trọng;
 *  - B6: spacing variants CHỈ ở ranh giới chữ↔số (spec §5.7 examples
 *    "charge4"/"charge 4", "emberton2"/"emberton 2") — KHÔNG sinh biến thể
 *    chữ↔chữ ("soundlink"↔"sound link" là việc của compact matching ở Task 5);
 *  - spec §5.8.1: exclusion "malformed query" — blank / > 120 ký tự / control
 *    chars (isMalformedQuery — query hợp lệ mới được tính search metrics).
 */
import { describe, expect, it } from "vitest";
import {
  compactForm,
  isMalformedQuery,
  normalizeSearchText,
  spacingVariants,
  stripDiacritics,
} from "@/src/lib/search-normalize";

// ─── stripDiacritics — NFD + bỏ combining marks + đ/Đ riêng (B5) ───────────────

describe("stripDiacritics", () => {
  it("bỏ dấu tiếng Việt qua canonical decomposition (NFD + \\p{Mn})", () => {
    expect(stripDiacritics("Đà Nẵng")).toBe("Da Nang");
    expect(stripDiacritics("Hà Nội")).toBe("Ha Noi");
    expect(stripDiacritics("Thừa Thiên Huế")).toBe("Thua Thien Hue");
    expect(stripDiacritics("Điện Biên")).toBe("Dien Bien");
  });

  it("đ/Đ KHÔNG có canonical decomposition — replace riêng (B5)", () => {
    // NFD không tách được đ (U+0111) — nếu quên replace riêng thì "đỏ" → "đo"
    expect(stripDiacritics("đỏ")).toBe("do");
    expect(stripDiacritics("Đà Nẵng đỏ")).toBe("Da Nang do");
  });

  it("giữ nguyên hoa/thường — lowercase là việc của normalizeSearchText", () => {
    expect(stripDiacritics("loa")).toBe("loa");
    expect(stripDiacritics("LOA")).toBe("LOA");
  });

  it("input đã ở dạng NFD (macOS decomposed) cho output giống dạng NFC", () => {
    // So sánh qua chuẩn hóa: precomposed "ệ" và decomposed "e+marks" cùng output
    expect(stripDiacritics("ệ".normalize("NFD"))).toBe(stripDiacritics("ệ"));
    expect(stripDiacritics("ệ".normalize("NFD"))).toBe("e");
    expect(stripDiacritics("Đà Nẵng".normalize("NFD"))).toBe("Da Nang");
  });
});

// ─── normalizeSearchText — strip + lowercase + collapse khoảng trắng ─────────

describe("normalizeSearchText", () => {
  it("strip + lowercase + collapse khoảng trắng + trim", () => {
    expect(normalizeSearchText("  LOA  JBL   Charge 4 ")).toBe("loa jbl charge 4");
    expect(normalizeSearchText("JBL Flip 6")).toBe("jbl flip 6");
  });

  it("chuỗi rỗng → rỗng", () => {
    expect(normalizeSearchText("")).toBe("");
  });

  it("chỉ khoảng trắng → rỗng", () => {
    expect(normalizeSearchText("    ")).toBe("");
  });

  it("kết hợp dấu + hoa + khoảng trắng thừa", () => {
    expect(normalizeSearchText("  LOA  ĐỒ CHƠI  ")).toBe("loa do choi");
  });
});

// ─── spacingVariants — CHỮ↔SỐ (B6 — không sinh biến thể chữ↔chữ) ──────────────

describe("spacingVariants", () => {
  it("các ví dụ spec §5.7 nguyên văn — ranh giới chữ↔số", () => {
    expect(spacingVariants("charge4")).toEqual(["charge4", "charge 4"]);
    expect(spacingVariants("charge 4")).toEqual(["charge 4", "charge4"]);
    expect(spacingVariants("emberton2")).toEqual(["emberton2", "emberton 2"]);
    expect(spacingVariants("emberton 2")).toEqual(["emberton 2", "emberton2"]);
  });

  it("không có ranh giới chữ↔số → MỘT phần tử (chính nó)", () => {
    expect(spacingVariants("jbl")).toEqual(["jbl"]);
  });

  it("'soundlink' KHÔNG sinh biến thể chữ↔chữ (B6 — việc đó của compact matching Task 5)", () => {
    expect(spacingVariants("soundlink")).toEqual(["soundlink"]);
    expect(spacingVariants("sound link")).toEqual(["sound link"]);
  });

  it("nhiều ranh giới → một biến thể MỖI ranh giới, dedup, gốc đứng đầu", () => {
    // "jbl charge4 flip6" có 3 ranh giới chữ↔số (CHỮ↔SỐ không phân biệt thứ tự):
    //   e|4 kề trực tiếp (chữ→số) → chèn khoảng trắng;
    //   p|6 kề trực tiếp (chữ→số) → chèn khoảng trắng;
    //   4␣f cách một khoảng trắng (số→chữ) → bỏ khoảng trắng đó.
    expect(spacingVariants("jbl charge4 flip6")).toEqual([
      "jbl charge4 flip6",
      "jbl charge 4 flip6",
      "jbl charge4 flip 6",
      "jbl charge4flip6",
    ]);
  });
});

// ─── compactForm — bỏ toàn bộ khoảng trắng (cho compact matching Task 5) ─────

describe("compactForm", () => {
  it("bỏ toàn bộ khoảng trắng", () => {
    expect(compactForm("sound link")).toBe("soundlink");
    expect(compactForm("charge 4")).toBe("charge4");
  });

  it("không có khoảng trắng → no-op", () => {
    expect(compactForm("jbl")).toBe("jbl");
  });
});

// ─── isMalformedQuery — exclusion "malformed query" (spec §5.8.1) ─────────────

describe("isMalformedQuery", () => {
  it("blank sau trim → malformed", () => {
    expect(isMalformedQuery("")).toBe(true);
    expect(isMalformedQuery("   ")).toBe(true);
  });

  it("dài hơn 120 ký tự → malformed; đúng 120 → hợp lệ", () => {
    expect(isMalformedQuery("a".repeat(121))).toBe(true);
    expect(isMalformedQuery("a".repeat(120))).toBe(false);
  });

  it("chứa control chars → malformed", () => {
    expect(isMalformedQuery("loa\u0000")).toBe(true);
    expect(isMalformedQuery("loa\u001b[31m")).toBe(true);
    expect(isMalformedQuery("loa\u007f")).toBe(true);
  });

  it("query thường → hợp lệ", () => {
    expect(isMalformedQuery("loa jbl")).toBe(false);
    expect(isMalformedQuery("Loa JBL Charge 4")).toBe(false);
  });
});
