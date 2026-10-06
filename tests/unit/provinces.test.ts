/**
 * Canonical provincial units (FD-1 — founder decision 2026-10-06) — unit tests.
 *
 * Nguồn FOUNDER-APPROVED: 34 đơn vị hành chính cấp tỉnh hiệu lực 2025-07-01
 * theo Nghị quyết 202/2025/QH15 (bảng /tmp/loaviet/provinces-34.md — NQ gốc +
 * URL nguồn ghi ở header src/lib/provinces.ts). Danh sách 63 tỉnh cũ KHÔNG dùng.
 *
 * Hợp đồng (FD-1):
 *  1. Đúng 34 mã, duy nhất; đúng 6 thành phố trực thuộc trung ương (kind).
 *  2. MỌI tên legacy (pre-2025) ánh xạ về đơn vị mới của nó — bảng merger là
 *     authoritative (NQ 202/2025/QH15), không đoán.
 *  3. Quy tắc resolve: NFC + trim + case-fold + so sánh KHÔNG dấu (kể cả đ/Đ),
 *     bỏ prefix "Tỉnh"/"TP."/"Thành phố"; CHỈ khớp TÊN legacy chính xác —
 *     "Khác", tên quận/huyện, typo → null (fail closed, không bịa phép ghép).
 *  4. "Thừa Thiên Huế" KHÔNG nằm trong bảng → null (tên cũ của đơn vị Huế không
 *     được liệt kê làm legacy name — chỉ "Huế" khớp).
 */
import { describe, expect, it } from "vitest";
import {
  PROVINCES,
  PROVINCE_CODES,
  isProvinceCode,
  resolveLegacyProvince,
} from "@/src/lib/provinces";

// ─── 1. Kích thước & cấu trúc registry ────────────────────────────────────────

describe("PROVINCES — 34 đơn vị theo NQ 202/2025/QH15", () => {
  it("đúng 34 mã, mã duy nhất", () => {
    expect(PROVINCES).toHaveLength(34);
    const codes = PROVINCES.map((p) => p.code);
    expect(new Set(codes).size).toBe(34);
  });

  it("đúng 6 thành phố trực thuộc trung ương (kind=thanh_pho), 28 tỉnh", () => {
    const thanhPho = PROVINCES.filter((p) => p.kind === "thanh_pho");
    const tinh = PROVINCES.filter((p) => p.kind === "tinh");
    expect(thanhPho).toHaveLength(6);
    expect(tinh).toHaveLength(28);
    expect(thanhPho.map((p) => p.code).sort()).toEqual(
      ["can-tho", "da-nang", "hai-phong", "ha-noi", "ho-chi-minh", "hue"].sort(),
    );
  });

  it("mỗi đơn vị có displayName + ít nhất 1 legacy name (chính nó)", () => {
    for (const p of PROVINCES) {
      expect(p.displayName.trim()).not.toBe("");
      expect(p.legacyNames.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("PROVINCE_CODES — mã → tên hiển thị", () => {
  it("34 mục code → displayName", () => {
    expect(Object.keys(PROVINCE_CODES)).toHaveLength(34);
    expect(PROVINCE_CODES["ha-noi"]).toBe("Hà Nội");
    expect(PROVINCE_CODES["ho-chi-minh"]).toBe("TP. Hồ Chí Minh");
    expect(PROVINCE_CODES["hue"]).toBe("Huế");
    for (const p of PROVINCES) {
      expect(PROVINCE_CODES[p.code]).toBe(p.displayName);
    }
  });
});

describe("isProvinceCode", () => {
  it("true cho cả 34 mã, false cho giá trị khác", () => {
    for (const p of PROVINCES) expect(isProvinceCode(p.code)).toBe(true);
    expect(isProvinceCode("Thừa Thiên Huế")).toBe(false); // tên, không phải mã
    expect(isProvinceCode("hanoi")).toBe(false); // thiếu dấu gạch
    expect(isProvinceCode("")).toBe(false);
    expect(isProvinceCode("63")).toBe(false); // mã số cũ không tồn tại
  });
});

// ─── 2. Mọi legacy name ánh xạ về đơn vị mới (bảng merger authoritative) ────

describe("resolveLegacyProvince — mọi legacy name → đơn vị mới", () => {
  it("mỗi legacy name trong registry giải về đúng mã đơn vị mới", () => {
    for (const p of PROVINCES) {
      for (const name of p.legacyNames) {
        expect(resolveLegacyProvince(name), `${name} → ${p.code}`).toBe(p.code);
      }
    }
  });

  it("các ca merger tiêu biểu (FD-1)", () => {
    expect(resolveLegacyProvince("Bình Dương")).toBe("ho-chi-minh");
    expect(resolveLegacyProvince("Bà Rịa - Vũng Tàu")).toBe("ho-chi-minh");
    expect(resolveLegacyProvince("TP. Hồ Chí Minh")).toBe("ho-chi-minh");
    expect(resolveLegacyProvince("Hà Giang")).toBe("tuyen-quang");
    expect(resolveLegacyProvince("Hải Dương")).toBe("hai-phong");
    expect(resolveLegacyProvince("Quảng Nam")).toBe("da-nang");
    expect(resolveLegacyProvince("Bình Phước")).toBe("dong-nai");
    expect(resolveLegacyProvince("Hậu Giang")).toBe("can-tho");
    expect(resolveLegacyProvince("Kiên Giang")).toBe("an-giang");
    expect(resolveLegacyProvince("Thái Bình")).toBe("hung-yen");
  });

  it("đơn vị không sắp xếp lại giải bằng chính tên nó", () => {
    expect(resolveLegacyProvince("Huế")).toBe("hue");
    expect(resolveLegacyProvince("Hà Nội")).toBe("ha-noi");
    expect(resolveLegacyProvince("Nghệ An")).toBe("nghe-an");
  });
});

// ─── 3. Quy tắc chuẩn hóa (NFC + trim + case-fold + không dấu + prefix) ───────

describe("resolveLegacyProvince — chuẩn hóa đầu vào", () => {
  it("trim + NFC + collapse khoảng trắng", () => {
    expect(resolveLegacyProvince("  Hà Nội  ")).toBe("ha-noi");
    expect(resolveLegacyProvince("Hà  Giang")).toBe("tuyen-quang");
  });

  it("case-fold (viết thường toàn bộ)", () => {
    expect(resolveLegacyProvince("hà nội")).toBe("ha-noi");
    expect(resolveLegacyProvince("ĐÀ NẴNG")).toBe("da-nang");
  });

  it("không dấu (kể cả đ/Đ — NFD không tách được đ)", () => {
    expect(resolveLegacyProvince("Ha Noi")).toBe("ha-noi");
    expect(resolveLegacyProvince("TP. Ho Chi Minh")).toBe("ho-chi-minh");
    expect(resolveLegacyProvince("Dak Lak")).toBe("dak-lak");
    expect(resolveLegacyProvince("Dien Bien")).toBe("dien-bien");
    expect(resolveLegacyProvince("Can Tho")).toBe("can-tho");
  });

  it("bỏ prefix 'Tỉnh' / 'TP.' / 'Thành phố' (không dấu, không phân biệt hoa)", () => {
    expect(resolveLegacyProvince("Tỉnh Nghệ An")).toBe("nghe-an");
    expect(resolveLegacyProvince("Tinh Nghe An")).toBe("nghe-an"); // prefix không dấu
    expect(resolveLegacyProvince("Thành phố Huế")).toBe("hue");
    expect(resolveLegacyProvince("thanh pho Hue")).toBe("hue");
    expect(resolveLegacyProvince("TP. Hồ Chí Minh")).toBe("ho-chi-minh");
    expect(resolveLegacyProvince("tp. ho chi minh")).toBe("ho-chi-minh");
  });
});

// ─── 4. Fail closed — không bịa phép ghép (spec §8.3: không fabricate) ────────

describe("resolveLegacyProvince — không khớp → null (fail closed)", () => {
  it("'Thừa Thiên Huế' KHÔNG nằm trong bảng legacy → null (FD-1)", () => {
    // Tên gọi cũ của đơn vị Huế không được liệt kê — chỉ "Huế" khớp
    expect(resolveLegacyProvince("Thừa Thiên Huế")).toBeNull();
    expect(resolveLegacyProvince("Thua Thien Hue")).toBeNull();
  });

  it("'Khác' + giá trị tự do khác → null", () => {
    expect(resolveLegacyProvince("Khác")).toBeNull();
    expect(resolveLegacyProvince("Khac")).toBeNull();
    expect(resolveLegacyProvince("khác (nước ngoài)")).toBeNull();
  });

  it("tên quận/huyện (cấp dưới) → null", () => {
    expect(resolveLegacyProvince("Quận 1")).toBeNull();
    expect(resolveLegacyProvince("Thủ Đức")).toBeNull();
    expect(resolveLegacyProvince("Huyện Châu Thành")).toBeNull();
    expect(resolveLegacyProvince("Phường 12")).toBeNull();
  });

  it("typo / rỗng → null (lưu ý: sai/khuyết dấu vẫn khớp — quy tắc là DIACRITIC-INSENSITIVE)", () => {
    expect(resolveLegacyProvince("Ha Noii")).toBeNull();
    expect(resolveLegacyProvince("Hà Nôi")).toBe("ha-noi"); // sai kiểu dấu — vẫn khớp (không dấu)
    expect(resolveLegacyProvince("")).toBeNull();
    expect(resolveLegacyProvince("   ")).toBeNull();
    expect(resolveLegacyProvince("Tỉnh")).toBeNull(); // chỉ prefix
    expect(resolveLegacyProvince("TP.")).toBeNull();
  });

  it("mã slug canonical KHÔNG là legacy name → null (chỉ tên khớp)", () => {
    expect(resolveLegacyProvince("ha-noi")).toBeNull();
    expect(resolveLegacyProvince("ho-chi-minh")).toBeNull();
  });
});
