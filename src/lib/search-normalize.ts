/**
 * Chuẩn hóa text tìm kiếm (Batch 5 Task 3 — spec §5.7) — module THUẦN.
 *
 * Không import db, không "server-only", không dependency — chỉ `node:string`
 * + regex. Đơn nguồn duy nhất của việc chuẩn hóa: cột derived
 * `Listing.searchTextNormalized` (Task 4), khớp alias `SearchAlias` (Task 5)
 * và query search (Task 7) đều qua CÁC HÀM Ở ĐÂY — byte-identical giữa dev DB,
 * scratch container và production (quyết định không dùng `unaccent`/`pg_trgm`
 * — Global Constraints của plan Batch 5).
 *
 * Ngôn ngữ full-text là "simple" ở CẢ HAI phía index + query (S-1): text đã
 * được chuẩn hóa sẵn ở đây (lowercase, không dấu) nên `english` stopword/
 * stemmer chỉ làm hỏng ("loa do" mất "do" — token là âm tiết tiếng Việt
 * bình thường). Việc khớp diacritic KHÔNG dựa vào Postgres — mọi phía đều
 * qua stripDiacritics/normalizeSearchText.
 *
 * B5: đ/Đ KHÔNG có canonical decomposition — NFD không tách được, phải
 * replace riêng (nếu quên thì "đỏ" → "đo", search "do" không bao giờ khớp).
 *
 * B6: spacing variants CHỈ sinh ở ranh giới CHỮ↔SỐ (spec §5.7 examples
 * "charge4"/"charge 4", "emberton2"/"emberton 2"). KHÔNG sinh biến thể
 * chữ↔chữ — "soundlink"↔"sound link" cần từ điển, việc đó thuộc compact
 * matching của resolveSearchQuery (Task 5, src/lib/search-resolve.ts).
 *
 * isMalformedQuery: exclusion "malformed query" của spec §5.8.1 — query
 * blank/malformed không bao giờ được tính là search session (không emit,
 * không rate limit — Task 7).
 */

// ─── stripDiacritics ───────────────────────────────────────────────────────────

/**
 * Bỏ dấu tiếng Việt: NFD → bỏ combining marks (Unicode \p{Mn}) → đ→d / Đ→D
 * (B5 — đ/Đ không có canonical decomposition, NFD không tách được) → NFC.
 * Giữ nguyên hoa/thường — lowercase là việc của normalizeSearchText.
 * "Đà Nẵng đỏ" → "Da Nang do".
 */
export function stripDiacritics(input: string): string {
  return (
    input
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .normalize("NFC")
  );
}

// ─── normalizeSearchText ──────────────────────────────────────────────────────

/**
 * Dạng chuẩn hóa để lưu/so khớp: stripDiacritics + lowercase + collapse khoảng
 * trắng + trim. "  LOA  JBL   Charge 4 " → "loa jbl charge 4".
 */
export function normalizeSearchText(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ─── spacingVariants ───────────────────────────────────────────────────────────

const LETTER_CHAR = /\p{L}/u;
const DIGIT_CHAR = /\p{Nd}/u;

/**
 * Biến thể spacing ở ranh giới CHỮ↔SỐ của chuỗi ĐÃ chuẩn hóa (spec §5.7):
 * "charge4" → ["charge4", "charge 4"]; "charge 4" → ["charge 4", "charge4"];
 * "emberton2" → ["emberton2", "emberton 2"]; "emberton 2" → ["emberton 2", "emberton2"].
 *
 * MỖI ranh giới chữ↔số (kể cả số↔chữ) sinh MỘT biến thể: kề trực tiếp → chèn
 * khoảng trắng; cách nhau một khoảng trắng → bỏ khoảng trắng đó. Ranh giới
 * chữ↔chữ KHÔNG được đụng tới (B6) — "soundlink" → ["soundlink"].
 * Dedup, giữ nguyên chuỗi gốc đứng đầu.
 */
export function spacingVariants(normalized: string): string[] {
  const variants: string[] = [normalized];
  const seen = new Set(variants);
  const push = (variant: string): void => {
    if (!seen.has(variant)) {
      seen.add(variant);
      variants.push(variant);
    }
  };

  // Ranh giới chữ↔số KỀ TRỰC TIẾP → chèn khoảng trắng vào giữa.
  for (let i = 1; i < normalized.length; i++) {
    const prev = normalized[i - 1];
    const cur = normalized[i];
    const letterThenDigit = LETTER_CHAR.test(prev) && DIGIT_CHAR.test(cur);
    const digitThenLetter = DIGIT_CHAR.test(prev) && LETTER_CHAR.test(cur);
    if (letterThenDigit || digitThenLetter) {
      push(normalized.slice(0, i) + " " + normalized.slice(i));
    }
  }

  // Ranh giới chữ↔số CÁCH MỘT KHOẢNG TRẮNG → bỏ khoảng trắng đó.
  for (let i = 2; i < normalized.length; i++) {
    const before = normalized[i - 2];
    const space = normalized[i - 1];
    const after = normalized[i];
    if (space !== " ") continue;
    const letterThenDigit = LETTER_CHAR.test(before) && DIGIT_CHAR.test(after);
    const digitThenLetter = DIGIT_CHAR.test(before) && LETTER_CHAR.test(after);
    if (letterThenDigit || digitThenLetter) {
      push(normalized.slice(0, i - 1) + normalized.slice(i));
    }
  }

  return variants;
}

// ─── compactForm ───────────────────────────────────────────────────────────────

/**
 * Dạng bỏ toàn bộ khoảng trắng — "sound link" → "soundlink" — cho compact
 * matching ở Task 5 (B6: đóng kín khoảng trống chữ↔chữ mà spacingVariants
 * cố tình không sinh).
 */
export function compactForm(normalized: string): string {
  return normalized.replace(/\s+/g, "");
}

// ─── isMalformedQuery ───────────────────────────────────────────────────────────

/** Giới hạn chiều dài query (spec §5.8.1 exclusion "malformed query"). */
const MAX_QUERY_LENGTH = 120;

/** Control chars C0 + DEL — không bao giờ hợp lệ trong query text. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Query có bị coi là malformed không (spec §5.8.1): blank sau trim, dài hơn
 * 120 ký tự, hoặc chứa control chars. Query malformed KHÔNG phải search
 * session — không emit telemetry, không rate limit (Task 7).
 */
export function isMalformedQuery(raw: string): boolean {
  if (raw.trim() === "") return true;
  if (raw.length > MAX_QUERY_LENGTH) return true;
  return CONTROL_CHARS.test(raw);
}
