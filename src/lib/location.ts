/**
 * Location module (Batch 5 Task 2 — spec §5.9/§5.9.1/§8.3/§4.7, FD-1).
 *
 * Registry là của Batch 2 Task 10 — src/lib/provinces.ts (FD-1: 34 đơn vị
 * cấp tỉnh per NQ 202/2025/QH15, nguồn founder-approved
 * /tmp/loaviet/provinces-34.md). Module này CHỈ import (read-only) —
 * KHÔNG tạo/sửa/duplicate registry; nếu export shape khác thì adapt import
 * (nội dung 34 đơn vị là contract — corrections item 1: tên thật là
 * isProvinceCode / PROVINCE_CODES / resolveLegacyProvince).
 *
 * resolveLegacyLocation DELEGATE resolveLegacyProvince (corrections item 1 —
 * KHÔNG private normalizer riêng): FD-1 rule (NFC + trim + case-fold +
 * diacritic-insensitive kể cả đ/Đ + collapse khoảng trắng + strip prefix
 * "Tỉnh"/"TP."/"Thành phố") sống MỘT chỗ trong registry; module này chỉ bọc
 * kết quả thành shape { provinceLevelCode, source } cho backfill + action.
 * "Khác", tên quận/huyện, typo → unresolved (fail closed — spec §8.3
 * "Uncertain legacy location mappings must not be fabricated").
 *
 * PLAIN MODULE: KHÔNG "server-only", KHÔNG import db — import được bởi
 * server action, page, client component lẫn script tsx offline
 * (scripts/backfill-listing-location.ts).
 *
 * Trung tính ngôn ngữ (spec §4.7): priority beta market là nhãn
 * operational/acquisition ONLY — location KHÔNG bao giờ là tín hiệu tin
 * cậy; betaMarketLabel() dùng "Khu vực beta trọng điểm".
 */
import { resolveLegacyProvince } from "@/src/lib/provinces";

// Re-export cho tiện — TÊN THEO MODULE Batch 2 shipped (corrections item 1:
// plan viết isValidProvinceCode/provinceName nhưng module thật export
// isProvinceCode/PROVINCE_CODES — adapt import, KHÔNG đổi tên registry).
export { isProvinceCode, PROVINCE_CODES, resolveLegacyProvince } from "@/src/lib/provinces";

/** Hà Nội — primary beta market (spec §5.9.1 — slug code theo registry FD-1). */
export const BETA_PRIMARY_MARKET_PROVINCE = "ha-noi";

/** TP. Hồ Chí Minh — secondary market (spec §5.9.1). */
export const BETA_SECONDARY_MARKET_PROVINCE = "ho-chi-minh";

/**
 * Kết quả resolve legacy free-text → canonical (spec §5.9 + §8.3):
 *  - legacy_mapped: khớp TÊN legacy chính xác trong bảng merger AUTHORITATIVE
 *    của registry (NQ 202/2025/QH15 — áp nguồn founder, KHÔNG đoán);
 *  - unresolved: "Khác"/quận/huyện/typo/giá trị ngoài bảng — KHÔNG bịa phép ghép.
 */
export type LegacyLocationResolution =
  | { provinceLevelCode: string; source: "legacy_mapped" }
  | { provinceLevelCode: null; source: "unresolved" };

/**
 * FD-1 rule (nguyên văn đáy /tmp/loaviet/provinces-34.md): legacy free-text
 * city/province maps to a new unit ONLY khi nó bằng — sau NFC + trim +
 * case-fold + diacritic-insensitive compare, và đã strip các tiền tố phổ biến
 * "Tỉnh"/"TP."/"Thành phố" — MỘT trong các legacy unit names của registry
 * (merged-legacy-units list là AUTHORITATIVE per NQ 202/2025/QH15 —
 * "Bình Dương" → ho-chi-minh là áp nguồn của founder, KHÔNG phải đoán).
 * KHÔNG so khớp displayName; KHÔNG hand-author bảng per-city.
 *
 * Delegation (corrections item 1): toàn bộ normalize/so khớp sống trong
 * resolveLegacyProvince của registry — hàm này KHÔNG có normalizer riêng.
 */
export function resolveLegacyLocation(
  legacyCity: string | null | undefined,
): LegacyLocationResolution {
  if (legacyCity == null) return { provinceLevelCode: null, source: "unresolved" };
  const code = resolveLegacyProvince(legacyCity);
  return code == null
    ? { provinceLevelCode: null, source: "unresolved" }
    : { provinceLevelCode: code, source: "legacy_mapped" };
}

/**
 * Nhãn trung tính cho khu vực beta trọng điểm — spec §4.7/§5.9.1:
 * "Khu vực beta trọng điểm", KHÔNG BAO GIỜ ngôn ngữ tin cậy/bảo chứng cho
 * location (location alone is not a trust signal).
 */
export function betaMarketLabel(): string {
  return "Khu vực beta trọng điểm";
}
