/**
 * Canonical provincial units of Vietnam — 34 đơn vị hành chính cấp tỉnh,
 * hiệu lực 2025-07-01 (FD-1 — founder decision 2026-10-06).
 *
 * Nguồn FOUNDER-APPROVED: Nghị quyết 202/2025/QH15 của Quốc hội (12/6/2025) —
 * sắp xếp đơn vị hành chính cấp tỉnh, bỏ cấp huyện:
 * https://baochinhphu.vn/nghi-quyet-cua-quoc-hoi-ve-sap-xep-don-vi-hanh-chinh-cap-tinh-102250612191145158.htm
 * 34 đơn vị = 28 tỉnh + 6 thành phố trực thuộc trung ương. Danh sách 63
 * tỉnh/thành cũ KHÔNG được dùng nữa (founder: "the obsolete 63-province list
 * must not be used").
 *
 * Plain module (FD-1): KHÔNG import db, KHÔNG "server-only" — import được bởi
 * cả client component (select tỉnh ở form seller) lẫn script tsx offline.
 *
 * Mã: slug ổn định (ha-noi, ho-chi-minh…) — mã số chính thức chưa công bố
 * should not be fabricated (spec §8.3 không bịa); có thể thêm sau từ nguồn
 * authoritative.
 *
 * Legacy mapping (FD-1 — authoritative, không đoán): tên đơn vị cấp tỉnh
 * TRƯỚC 2025 ánh xạ về đơn vị mới CHỈ khi khớp TÊN CHÍNH XÁC trong bảng
 * legacyNames (danh sách merger theo NQ 202/2025/QH15). "Khác", tên quận/huyện,
 * typo → null (fail closed — spec §8.3 "không fabricate uncertain matches").
 */

export type ProvinceKind = "thanh_pho" | "tinh";

export type Province = {
  /** Slug ổn định — định danh canonical của đơn vị. */
  code: string;
  /** Tên hiển thị chính thức (dạng có dấu). */
  displayName: string;
  /** thanh_pho = thành phố trực thuộc trung ương; tinh = tỉnh. */
  kind: ProvinceKind;
  /** Tên các đơn vị cấp tỉnh TRƯỚC sáp nhập (pre-2025) ánh xạ về đơn vị này. */
  legacyNames: readonly string[];
};

/**
 * 34 đơn vị — đúng bảng provinces-34.md (founder-approved):
 * 11 đơn vị không sắp xếp lại (legacyNames = chính nó) + 23 đơn vị hợp nhất.
 */
export const PROVINCES: readonly Province[] = [
  // ─── Không sắp xếp lại (11) ───
  { code: "ha-noi", displayName: "Hà Nội", kind: "thanh_pho", legacyNames: ["Hà Nội"] },
  { code: "hue", displayName: "Huế", kind: "thanh_pho", legacyNames: ["Huế"] },
  { code: "cao-bang", displayName: "Cao Bằng", kind: "tinh", legacyNames: ["Cao Bằng"] },
  { code: "dien-bien", displayName: "Điện Biên", kind: "tinh", legacyNames: ["Điện Biên"] },
  { code: "ha-tinh", displayName: "Hà Tĩnh", kind: "tinh", legacyNames: ["Hà Tĩnh"] },
  { code: "lai-chau", displayName: "Lai Châu", kind: "tinh", legacyNames: ["Lai Châu"] },
  { code: "lang-son", displayName: "Lạng Sơn", kind: "tinh", legacyNames: ["Lạng Sơn"] },
  { code: "nghe-an", displayName: "Nghệ An", kind: "tinh", legacyNames: ["Nghệ An"] },
  { code: "quang-ninh", displayName: "Quảng Ninh", kind: "tinh", legacyNames: ["Quảng Ninh"] },
  { code: "thanh-hoa", displayName: "Thanh Hóa", kind: "tinh", legacyNames: ["Thanh Hóa"] },
  { code: "son-la", displayName: "Sơn La", kind: "tinh", legacyNames: ["Sơn La"] },
  // ─── Hợp nhất (23) — legacy (pre-2025) → đơn vị mới ───
  { code: "tuyen-quang", displayName: "Tuyên Quang", kind: "tinh", legacyNames: ["Hà Giang", "Tuyên Quang"] },
  { code: "lao-cai", displayName: "Lào Cai", kind: "tinh", legacyNames: ["Yên Bái", "Lào Cai"] },
  { code: "thai-nguyen", displayName: "Thái Nguyên", kind: "tinh", legacyNames: ["Bắc Kạn", "Thái Nguyên"] },
  { code: "phu-tho", displayName: "Phú Thọ", kind: "tinh", legacyNames: ["Vĩnh Phúc", "Hòa Bình", "Phú Thọ"] },
  { code: "bac-ninh", displayName: "Bắc Ninh", kind: "tinh", legacyNames: ["Bắc Giang", "Bắc Ninh"] },
  { code: "hung-yen", displayName: "Hưng Yên", kind: "tinh", legacyNames: ["Thái Bình", "Hưng Yên"] },
  { code: "hai-phong", displayName: "Hải Phòng", kind: "thanh_pho", legacyNames: ["Hải Phòng", "Hải Dương"] },
  { code: "ninh-binh", displayName: "Ninh Bình", kind: "tinh", legacyNames: ["Hà Nam", "Nam Định", "Ninh Bình"] },
  { code: "quang-tri", displayName: "Quảng Trị", kind: "tinh", legacyNames: ["Quảng Bình", "Quảng Trị"] },
  { code: "da-nang", displayName: "Đà Nẵng", kind: "thanh_pho", legacyNames: ["Đà Nẵng", "Quảng Nam"] },
  { code: "quang-ngai", displayName: "Quảng Ngãi", kind: "tinh", legacyNames: ["Kon Tum", "Quảng Ngãi"] },
  { code: "gia-lai", displayName: "Gia Lai", kind: "tinh", legacyNames: ["Bình Định", "Gia Lai"] },
  { code: "khanh-hoa", displayName: "Khánh Hòa", kind: "tinh", legacyNames: ["Ninh Thuận", "Khánh Hòa"] },
  { code: "lam-dong", displayName: "Lâm Đồng", kind: "tinh", legacyNames: ["Đắk Nông", "Bình Thuận", "Lâm Đồng"] },
  { code: "dak-lak", displayName: "Đắk Lắk", kind: "tinh", legacyNames: ["Phú Yên", "Đắk Lắk"] },
  { code: "ho-chi-minh", displayName: "TP. Hồ Chí Minh", kind: "thanh_pho", legacyNames: ["TP. Hồ Chí Minh", "Bà Rịa - Vũng Tàu", "Bình Dương"] },
  { code: "dong-nai", displayName: "Đồng Nai", kind: "tinh", legacyNames: ["Bình Phước", "Đồng Nai"] },
  { code: "tay-ninh", displayName: "Tây Ninh", kind: "tinh", legacyNames: ["Long An", "Tây Ninh"] },
  { code: "can-tho", displayName: "Cần Thơ", kind: "thanh_pho", legacyNames: ["Cần Thơ", "Sóc Trăng", "Hậu Giang"] },
  { code: "vinh-long", displayName: "Vĩnh Long", kind: "tinh", legacyNames: ["Bến Tre", "Trà Vinh", "Vĩnh Long"] },
  { code: "dong-thap", displayName: "Đồng Tháp", kind: "tinh", legacyNames: ["Tiền Giang", "Đồng Tháp"] },
  { code: "ca-mau", displayName: "Cà Mau", kind: "tinh", legacyNames: ["Bạc Liêu", "Cà Mau"] },
  { code: "an-giang", displayName: "An Giang", kind: "tinh", legacyNames: ["Kiên Giang", "An Giang"] },
] as const satisfies readonly Province[];

/** Mã → tên hiển thị (34 mục). */
export const PROVINCE_CODES: Record<string, string> = Object.fromEntries(
  PROVINCES.map((p) => [p.code, p.displayName]),
);

const PROVINCE_CODE_SET: ReadonlySet<string> = new Set(PROVINCES.map((p) => p.code));

/** Đơn vị có phải mã canonical không (34 mã hiện hành)? */
export function isProvinceCode(code: string): boolean {
  return PROVINCE_CODE_SET.has(code);
}

// ─── Legacy mapping (FD-1) ────────────────────────────────────────────────────

/**
 * Chuẩn hóa tên để so sánh diacritic-insensitive: NFC + trim + case-fold +
 * bỏ dấu (NFD strip combining marks) + đ/Đ → d (NFD KHÔNG tách được đ) +
 * collapse khoảng trắng + chuẩn hóa khoảng trắng quanh dấu gạch ("A - B" ==
 * "A-B") + bỏ prefix hành chính "Thành phố"/"Tỉnh"/"TP."/"TP" (dạng không dấu,
 * lặp tới ổn định — "TP" không dấu chấm cũng là prefix phổ biến).
 */
function foldProvinceName(raw: string): string {
  let s = raw
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-");

  // Bỏ prefix hành chính — fold của "Thành phố"/"Tỉnh"/"TP."/"TP" (kèm tùy chọn
  // khoảng trắng theo sau). Lặp: "Thành phố Tỉnh X" không tồn tại nhưng vòng
  // lặp giữ quy tắc tổng quát và vô hại với dữ liệu thật.
  const prefixes = ["thanh pho", "tinh", "tp.", "tp"] as const;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (!s.startsWith(prefix)) continue;
      const rest = s.slice(prefix.length);
      if (rest === "" || rest.startsWith(" ")) {
        s = rest.replace(/^ /, "");
        changed = true;
      }
    }
  }
  return s;
}

/** Index fold(legacyName) → mã đơn vị mới (dựng một lần ở module scope). */
const LEGACY_INDEX: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>();
  for (const p of PROVINCES) {
    for (const name of p.legacyNames) {
      const key = foldProvinceName(name);
      if (!index.has(key)) index.set(key, p.code);
    }
  }
  return index;
})();

/**
 * Ánh xạ giá trị tỉnh/thành free-text TRƯỚC 2025 về mã đơn vị mới (FD-1).
 *
 * CHỈ khớp TÊN CHÍNH XÁC (sau chuẩn hóa foldProvinceName) với một legacy name
 * trong bảng — danh sách merger authoritative theo NQ 202/2025/QH15, không
 * đoán. "Khác", tên quận/huyện, typo, giá trị rỗng → null (fail closed —
 * spec §8.3 "Uncertain legacy location mappings must not be fabricated").
 */
export function resolveLegacyProvince(raw: string): string | null {
  const key = foldProvinceName(raw);
  if (key === "") return null;
  return LEGACY_INDEX.get(key) ?? null;
}
