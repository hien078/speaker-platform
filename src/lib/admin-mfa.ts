/**
 * Admin MFA — TOTP + mã khôi phục dùng một lần (Batch 2 Task 8, spec §5.3/§5.4.2).
 *
 * MFA admin = TOTP (window ±1) + 10 mã khôi phục single-use. SMS KHÔNG bao giờ
 * là factor admin (spec §5.3) — không có code path nào ở đây gửi tin nhắn.
 *
 * Bảo mật dữ liệu:
 * - TOTP secret: mã hóa AES-256-GCM bằng key DÀNH RIÊNG
 *   `ADMIN_MFA_ENCRYPTION_KEY` (src/lib/admin-mfa-key.ts — KHÔNG derive từ
 *   AUTH_SECRET). Envelope versioned "v1:<keyId>:<base64(iv ‖ tag ‖ ct)>" —
 *   keyId (8 hex đầu sha256(key), KHÔNG bí mật) làm rotation an toàn: decrypt
 *   bằng key khác → typed ADMIN_MFA_KEY_MISMATCH, không bao giờ corrupt im lặng.
 * - Mã khôi phục: CHỈ lưu HMAC-SHA256 hex với hkdfKey("recovery-code-hash") —
 *   helper HKDF chia sẻ của src/lib/otp.ts (Task 3, derive từ AUTH_SECRET —
 *   keyed hash, không phải mã hóa). Mã thô chỉ tồn tại trong giá trị trả về
 *   của enrollAdminMfa (in MỘT LẦN cho operator — Task 11 bootstrap).
 * - KHÔNG log secret/mã ở bất kỳ path nào (spec §4.8 — mọi môi trường).
 *
 * Plain module (KHÔNG "use server" — không thành endpoint công khai; precedent
 * src/lib/actions/helpers.ts): import được từ server action (loginAction,
 * rbac step-up) VÀ từ offline bootstrap script (Task 11). Lưu ý topology: module
 * này import hkdfKey từ src/lib/otp.ts (có "server-only") — bootstrap script
 * chạy tsx cần resolve được "server-only" (Task 11 lo cùng một cơ chế cho
 * session.ts/audit-event.ts mà nó cũng phải import).
 *
 * Race-safety: mã khôi phục được "claim" bằng updateAll WHERE usedAt IS NULL —
 * 2 request đồng thời dùng cùng một mã → đúng 1 request thắng (spec §5.3
 * single-use; cùng pattern consume ATOMIC của otp.ts).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { db } from "@/src/prisma/db.client";
import { hkdfKey } from "@/src/lib/otp";
import { generateTotpSecret, totpUri, verifyTotp } from "@/src/lib/totp";
import { adminMfaKeyId, getAdminMfaEncryptionKey } from "@/src/lib/admin-mfa-key";

export const RECOVERY_CODE_COUNT = 10;

export const ADMIN_MFA_KEY_MISMATCH = "ADMIN_MFA_KEY_MISMATCH" as const;
export const ADMIN_MFA_ENVELOPE_INVALID = "ADMIN_MFA_ENVELOPE_INVALID" as const;
export const ADMIN_MFA_DECRYPT_FAILED = "ADMIN_MFA_DECRYPT_FAILED" as const;

/** Issuer trong URI otpauth:// — tên nền tảng hiển thị trong authenticator. */
const TOTP_ISSUER = "LoaViet";

/**
 * Alphabet 32 ký tự không nhầm lẫn — không I/O/0/1 (mã "XXXX-XXXX" đọc lại được
 * khỏi giấy/điện thoại). 32 ký tự → mỗi byte random map đều vào 1 ký tự (256 % 32
 * === 0, không modulo bias).
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ─── Mã khôi phục ─────────────────────────────────────────────────────────────

/** Sinh 10 mã khôi phục "XXXX-XXXX" từ crypto.randomBytes (CSPRNG). */
export function generateRecoveryCodes(): string[] {
  const one = (): string => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]!);
    return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
  };
  return Array.from({ length: RECOVERY_CODE_COUNT }, one);
}

/**
 * Chuẩn hóa input mã khôi phục về dạng canonical "XXXX-XXXX": trim + uppercase
 * + bỏ khoảng trắng/gạch nối. Sai độ dài → trả nguyên input (hash không bao giờ
 * khớp — fail closed, không "đoán bớt/thêm" ký tự).
 */
function normalizeRecoveryCodeInput(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replaceAll(" ", "").replaceAll("-", "");
  if (cleaned.length !== 8) return raw;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

/** HMAC-SHA256 hex của mã khôi phục — thứ DUY NHẤT được lưu DB. */
export function hashRecoveryCode(code: string): string {
  return createHmac("sha256", hkdfKey("recovery-code-hash")).update(code).digest("hex");
}

// ─── Mã hóa TOTP secret — envelope v1:<keyId>:<base64(iv ‖ tag ‖ ct)> ──────────

/** AES-256-GCM (12-byte IV random, 16-byte tag) với key dedicated từ env. */
export function encryptTotpSecret(secretBase32: string): string {
  const key = getAdminMfaEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${adminMfaKeyId(key)}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

/**
 * Giải mã envelope về base32 secret. Sai keyId so với key hiện tại → typed
 * ADMIN_MFA_KEY_MISMATCH (rotation detection — không corrupt im lặng); tag
 * không khớp (dữ liệu bị sửa) → typed ADMIN_MFA_DECRYPT_FAILED.
 */
export function decryptTotpSecret(enc: string): string {
  const parts = enc.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error(
      `${ADMIN_MFA_ENVELOPE_INVALID}: envelope phải là "v1:<keyId>:<base64(iv‖tag‖ct)>"`,
    );
  }
  const [, encKeyId, payloadB64] = parts;

  const key = getAdminMfaEncryptionKey();
  const currentKeyId = adminMfaKeyId(key);
  if (encKeyId !== currentKeyId) {
    throw new Error(
      `${ADMIN_MFA_KEY_MISMATCH}: envelope keyId ${encKeyId} ≠ key hiện tại ${currentKeyId} — ` +
        "secret được mã hóa bằng ADMIN_MFA_ENCRYPTION_KEY khác (rotate key? chạy mfa-reset + " +
        "mfa-enroll lại cho từng admin — xem runbook)",
    );
  }

  const payload = Buffer.from(payloadB64!, "base64");
  if (payload.length < 12 + 16) {
    throw new Error(
      `${ADMIN_MFA_ENVELOPE_INVALID}: payload ngắn hơn iv(12) + tag(16) byte — dữ liệu hỏng`,
    );
  }
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ct = payload.subarray(28);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      `${ADMIN_MFA_DECRYPT_FAILED}: AES-256-GCM tag không khớp — dữ liệu bị sửa hoặc key sai`,
    );
  }
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

/**
 * Enroll MFA cho admin: sinh secret TOTP + 10 mã khôi phục, lưu secret ĐÃ MÃ HÓA
 * + hash mã khôi phục. Trả về `{ secretBase32, uri, recoveryCodes }` để caller
 * (bootstrap script Task 11) in MỘT LẦN — sau đó các giá trị thô này không còn
 * tồn tại đâu ngoài authenticator của admin.
 *
 * Refuse (trả null) khi: đã có AdminMfa cho user (reset qua bootstrap script,
 * Task 11 — không enroll đè) hoặc user không tồn tại (không row mồ côi).
 *
 * Atomic trong transaction: AdminMfa + 10 AdminRecoveryCode cùng nhau — không
 * enroll "nửa vời" (mã đã sinh mà row thiếu → mã mồ côi không ai dùng được).
 */
export async function enrollAdminMfa(userId: string): Promise<{
  secretBase32: string;
  uri: string;
  recoveryCodes: string[];
} | null> {
  const existing = await db.orm.public.AdminMfa.first({ userId });
  if (existing) return null; // đã enroll — reset qua bootstrap script (Task 11)

  const user = await db.orm.public.User.first({ id: userId });
  if (!user) return null; // không có user → không có gì để enroll (fail closed)

  const secretBase32 = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const nowIso = new Date().toISOString();

  await db.transaction(async (tx) => {
    const mfa = await tx.orm.public.AdminMfa.create({
      userId,
      totpSecretEnc: encryptTotpSecret(secretBase32),
      // Enrollment chỉ diễn ra qua bootstrap offline tin cậy (Task 11): operator
      // nhận secret + mã khôi phục đúng MỘT LẦN — Batch 2 không có bước confirm
      // UI riêng, nên enrollment = confirmed. Login chỉ đọc sự TỒN TẠI row.
      totpConfirmedAt: nowIso,
    });
    for (const code of recoveryCodes) {
      await tx.orm.public.AdminRecoveryCode.create({
        mfaId: mfa.id,
        codeHash: hashRecoveryCode(code),
        usedAt: null, // explicit — single-use: chưa dùng
      });
    }
  });

  return {
    secretBase32,
    uri: totpUri(secretBase32, user.email, TOTP_ISSUER),
    recoveryCodes,
  };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Xác thực mã MFA do admin nhập (login hoặc step-up). Trả về factor đã dùng:
 * - "totp" — mã TOTP hợp lệ (window ±1);
 * - "recovery_code" — mã khôi phục hợp lệ, ĐÁNH DẤU usedAt ngay (single-use,
 *   claim race-safe — 2 request đồng thời cùng một mã → đúng 1 thắng);
 * - null — sai mã / chưa enroll / user không có MFA (fail closed).
 *
 * KHÔNG khóa tài khoản sau N lần sai ở đây — brute force do rate limit của
 * action (auth:mfa, 10/10 phút/IP) lo (spec §7.2), lockout vĩnh viễn là rủi ro
 * ngược (spec §5.4.2 tránh khóa admin vĩnh viễn).
 *
 * Sai key mã hóa (rotate thiếu reset): TOTP path fail closed nhưng KHÔNG throw
 * — fall through sang mã khôi phục để admin còn đường vào mà re-enroll
 * (chống lockout vĩnh viễn; sai key được phát hiện qua typed error của
 * decryptTotpSecret ở nơi khác + runbook).
 */
export async function verifyAdminMfaCode(
  userId: string,
  code: string,
): Promise<"totp" | "recovery_code" | null> {
  const mfa = await db.orm.public.AdminMfa.first({ userId });
  if (!mfa) return null;

  const trimmed = code.trim();
  if (trimmed === "") return null;

  // 1) TOTP — secret giải mã từ envelope; mọi lỗi giải mã → fail closed (false)
  let totpOk = false;
  try {
    totpOk = verifyTotp(decryptTotpSecret(mfa.totpSecretEnc), trimmed);
  } catch {
    totpOk = false;
  }
  if (totpOk) return "totp";

  // 2) Mã khôi phục — tìm hash khớp CHƯA dùng, rồi claim ATOMIC single-use.
  const codeHash = hashRecoveryCode(normalizeRecoveryCodeInput(trimmed));
  const candidate = await db.orm.public.AdminRecoveryCode
    .where({ mfaId: mfa.id, codeHash })
    .where((c) => c.usedAt.isNull())
    .first();
  if (!candidate) return null;

  const claimed = await db.orm.public.AdminRecoveryCode
    .where({ id: candidate.id })
    .where((c) => c.usedAt.isNull())
    .updateAll({ usedAt: new Date().toISOString() });
  if (claimed.length === 0) return null; // request song song đã dùng mã này

  return "recovery_code";
}
