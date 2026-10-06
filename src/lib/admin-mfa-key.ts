/**
 * Key mã hóa AdminMfa DÀNH RIÊNG — `ADMIN_MFA_ENCRYPTION_KEY` (Batch 2 Task 8).
 *
 * QUY TẮC (Global Constraints / spec §5.3):
 * - Key là base64 của ĐÚNG 32 byte random (`openssl rand -base64 32`) — AES-256.
 * - KHÔNG BAO GIỜ derive từ AUTH_SECRET, KHÔNG BAO GIỜ dùng lại AUTH_SECRET —
 *   key MFA và key signing session phải độc lập (đổi cái này không phá cái kia).
 * - Server-only về mặt giá trị: KHÔNG NEXT_PUBLIC_*, KHÔNG log/in key ở bất kỳ
 *   môi trường nào (spec §4.8 — authentication secret).
 * - Thiếu/sai → typed error, KHÔNG fallback về key yếu/derive tự chế (fail closed).
 *
 * Plain module (KHÔNG "server-only" — precedent src/lib/actions/helpers.ts):
 * module này phải import được từ offline bootstrap script (tsx, Task 11) và từ
 * src/lib/env.ts (validate fail-fast khi start) — không chỉ từ Next runtime.
 *
 * `adminMfaKeyId` = 8 hex đầu của sha256(key) — định danh KHÔNG bí mật, ghi vào
 * envelope "v1:<keyId>:..." để phát hiện sai key khi rotate (decrypt bằng key
 * khác → typed ADMIN_MFA_KEY_MISMATCH, không phải corrupt im lặng — xem
 * src/lib/admin-mfa.ts + runbook Task 11).
 */
import { createHash } from "node:crypto";

export const ADMIN_MFA_KEY_UNCONFIGURED = "ADMIN_MFA_KEY_UNCONFIGURED" as const;
export const ADMIN_MFA_KEY_INVALID = "ADMIN_MFA_KEY_INVALID" as const;

/** Base64 strict (chuẩn RFC 4648 với padding) — Node decode lỏng lẻo, tự validate. */
const BASE64_STRICT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Độ dài byte bắt buộc — AES-256 cần đúng 32 byte. */
const ADMIN_MFA_KEY_BYTES = 32;

/** Cache theo GIÁ TRỊ env (per process) — đổi env (test/rotate) → derive lại. */
let cached: { raw: string; key: Buffer } | null = null;

/**
 * Validate giá trị env có phải base64 của đúng 32 byte không — thuần, không throw.
 * Dùng chung bởi src/lib/env.ts (validateEnv — fail-fast khi start) và test.
 */
export function isValidAdminMfaKeyEnv(raw: string): boolean {
  if (raw === "") return false;
  if (!BASE64_STRICT_RE.test(raw)) return false;
  return Buffer.from(raw, "base64").length === ADMIN_MFA_KEY_BYTES;
}

/**
 * Đọc + validate key mã hóa MFA từ env. Typed errors (message KHÔNG chứa giá trị
 * key — spec §4.8):
 * - thiếu/rỗng → ADMIN_MFA_KEY_UNCONFIGURED
 * - không phải base64 / sai độ dài byte → ADMIN_MFA_KEY_INVALID
 *
 * Cache theo giá trị raw — cùng process không decode lặp mỗi lần verify.
 */
export function getAdminMfaEncryptionKey(): Buffer {
  const raw = process.env.ADMIN_MFA_ENCRYPTION_KEY;
  if (raw === undefined || raw === "") {
    throw new Error(
      `${ADMIN_MFA_KEY_UNCONFIGURED}: thiếu ADMIN_MFA_ENCRYPTION_KEY — sinh bằng ` +
        "`openssl rand -base64 32` (key dedicated cho MFA, KHÔNG dùng AUTH_SECRET)",
    );
  }
  if (cached !== null && cached.raw === raw) return cached.key;

  if (!BASE64_STRICT_RE.test(raw)) {
    throw new Error(
      `${ADMIN_MFA_KEY_INVALID}: phải là base64 chuẩn của đúng ${ADMIN_MFA_KEY_BYTES} byte — ` +
        "sinh bằng `openssl rand -base64 32`",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== ADMIN_MFA_KEY_BYTES) {
    throw new Error(
      `${ADMIN_MFA_KEY_INVALID}: giải mã ra ${key.length} byte thay vì ${ADMIN_MFA_KEY_BYTES} — ` +
        "phải là base64 của đúng 32 byte (`openssl rand -base64 32`)",
    );
  }
  cached = { raw, key };
  return key;
}

/** Định danh KHÔNG bí mật của key — 8 hex đầu của sha256(key). */
export function adminMfaKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
