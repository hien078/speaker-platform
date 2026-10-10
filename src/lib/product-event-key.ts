/**
 * Key pseudonym DÀNH RIÊNG cho product telemetry — `PRODUCT_EVENT_PSEUDONYM_KEY`
 * (Batch 5 Task 6 — spec §4.8/§5.8, S-11).
 *
 * QUY TẮC (mirror src/lib/admin-mfa-key.ts của Batch 2 Task 8):
 * - Key là base64 của ĐÚNG 32 byte random (`openssl rand -base64 32`).
 * - KHÔNG BAO GIỜ derive từ AUTH_SECRET, KHÔNG dùng lại AUTH_SECRET — key
 *   pseudonym telemetry và key signing session độc lập: rotate AUTH_SECRET
 *   (đăng nhập lại toàn bộ) KHÔNG phá pseudonym/join analytics; rotate key này
 *   KHÔNG đụng session (S-11). Cũng KHÔNG dùng lại hkdfKey của src/lib/hkdf.ts
 *   (HKDF từ AUTH_SECRET — dùng cho OTP/ip/recovery-code hash).
 * - Server-only về mặt GIÁ TRỊ: KHÔNG NEXT_PUBLIC_*, KHÔNG log/in key ở bất kỳ
 *   môi trường nào (spec §4.8 — authentication secret).
 * - Thiếu/sai → typed error, KHÔNG fallback về key yếu/derive tự chế (fail closed
 *   tại emit: KHÔNG ghi row — xem src/lib/product-events.ts).
 *
 * Plain module (KHÔNG "server-only" — precedent src/lib/admin-mfa-key.ts):
 * module này phải import được từ offline script (tsx) và từ src/lib/env.ts
 * (validate fail-fast khi start) — không chỉ từ Next runtime.
 *
 * `productEventPseudonymKeyVersion()` = "1" — id của key ĐÃ GHI vào mỗi row
 * ProductEvent.pseudonymKeyVersion: phát hiện rotation (row v1 + key v2 →
 * join metric chéo phiên bản bị phá — RR-11; exclusion internal sống qua
 * row.isInternal nên KHÔNG phụ thuộc key, S-12).
 */
import { hkdfSync } from "node:crypto";

export const PRODUCT_EVENT_KEY_UNCONFIGURED = "PRODUCT_EVENT_KEY_UNCONFIGURED" as const;
export const PRODUCT_EVENT_KEY_INVALID = "PRODUCT_EVENT_KEY_INVALID" as const;

/** Base64 strict (RFC 4648 có padding) — Node decode lỏng lẻo, tự validate. */
const BASE64_STRICT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Độ dài byte bắt buộc — HMAC-SHA256 cần đúng 32 byte. */
const PRODUCT_EVENT_KEY_BYTES = 32;

/**
 * Salt HKDF cố định — domain-separate khỏi Batch 2 (`speaker-platform-otp-v1`):
 * cùng một info string ở hai salt khác nhau cho hai key nguồn khác nhau là
 * vô nghĩa; salt riêng + key nguồn riêng (S-11) là ranh giới thật.
 */
const HKDF_SALT = "speaker-platform-product-event-v1";

/** Version key hiện tại — ghi vào mỗi row (S-11); bump khi rotate key. */
const KEY_VERSION = "1";

/** Cache theo GIÁ TRỊ env (per process) — đổi env (test/rotate) → derive lại. */
let cached: { raw: string; key: Buffer } | null = null;

/**
 * Validate giá trị env có phải base64 của đúng 32 byte không — thuần, không
 * throw. Dùng chung bởi src/lib/env.ts (validateEnv — fail-fast khi start)
 * và test.
 */
export function isValidProductEventKeyEnv(raw: string): boolean {
  if (raw === "") return false;
  if (!BASE64_STRICT_RE.test(raw)) return false;
  return Buffer.from(raw, "base64").length === PRODUCT_EVENT_KEY_BYTES;
}

/**
 * Đọc + validate key pseudonym từ env. Typed errors (message KHÔNG chứa giá
 * trị key — spec §4.8):
 * - thiếu/rỗng → PRODUCT_EVENT_KEY_UNCONFIGURED
 * - không phải base64 / sai độ dài byte → PRODUCT_EVENT_KEY_INVALID
 *
 * Cache theo giá trị raw — cùng process không decode lặp mỗi lần emit.
 */
export function getProductEventPseudonymKey(): Buffer {
  const raw = process.env.PRODUCT_EVENT_PSEUDONYM_KEY;
  if (raw === undefined || raw === "") {
    throw new Error(
      `${PRODUCT_EVENT_KEY_UNCONFIGURED}: thiếu PRODUCT_EVENT_PSEUDONYM_KEY — sinh bằng ` +
        "`openssl rand -base64 32` (key dedicated cho telemetry pseudonym, KHÔNG dùng AUTH_SECRET)",
    );
  }
  if (cached !== null && cached.raw === raw) return cached.key;

  if (!BASE64_STRICT_RE.test(raw)) {
    throw new Error(
      `${PRODUCT_EVENT_KEY_INVALID}: phải là base64 chuẩn của đúng ${PRODUCT_EVENT_KEY_BYTES} byte — ` +
        "sinh bằng `openssl rand -base64 32`",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== PRODUCT_EVENT_KEY_BYTES) {
    throw new Error(
      `${PRODUCT_EVENT_KEY_INVALID}: giải mã ra ${key.length} byte thay vì ${PRODUCT_EVENT_KEY_BYTES} — ` +
        "phải là base64 của đúng 32 byte (`openssl rand -base64 32`)",
    );
  }
  cached = { raw, key };
  return key;
}

/** Version key đã ghi — "1"; bump khi rotate (mỗi row mang id của key đã ghi). */
export function productEventPseudonymKeyVersion(): string {
  return KEY_VERSION;
}

/**
 * Key 32-byte derive HKDF-SHA256 từ key dedicated với info string —
 * "product-event-actor" / "product-event-session" (domain separation giữa
 * hai loại pseudonym: cùng id người dùng ở hai info cho hai pseudonym khác
 * nhau, không join chéo). Cùng HKDF shape với helper Batch 2 nhưng NGUỒN key
 * khác (S-11 — không bao giờ AUTH_SECRET).
 */
export function productEventPseudonymKeyInfo(info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      getProductEventPseudonymKey(),
      Buffer.from(HKDF_SALT, "utf8"),
      Buffer.from(info, "utf8"),
      32,
    ),
  );
}
