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
 * rbac step-up) VÀ từ offline bootstrap script (tsx, Task 11). Task 11 đã tách
 * các dependency server-only sang plain module: hkdfKey → src/lib/hkdf.ts,
 * captureError → src/lib/observability-core.ts — chuỗi import của module này
 * resolve được ngoài React server bundle (script cũng import session-revoke.ts
 * thay vì session.ts; audit ghi trực tiếp qua db.orm như scripts/backfill-*.ts).
 *
 * Race-safety: mã khôi phục được "claim" bằng updateAll WHERE usedAt IS NULL —
 * 2 request đồng thời dùng cùng một mã → đúng 1 request thắng (spec §5.3
 * single-use; cùng pattern consume ATOMIC của otp.ts).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
// Review fix D1: import RELATIVE (KHÔNG alias `@/`) — chuỗi import của
// scripts/admin-bootstrap.ts phải chạy dưới tsx trong container migrate
// (Dockerfile stage migrate KHÔNG copy tsconfig.json → alias không resolve).
import { db } from "../prisma/db.client";
import { hkdfKey } from "./hkdf";
import { captureError } from "./observability-core";
import { generateTotpSecret, totpUri, verifyTotpStep } from "./totp";
import { adminMfaKeyId, getAdminMfaEncryptionKey } from "./admin-mfa-key";

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

/**
 * AES-256-GCM (12-byte IV random, 16-byte tag) với key dedicated từ env.
 * AAD = "v1:<keyId>:<userId>" (review fix #5) — ciphertext bị BIND vào row
 * user: copy envelope sang row AdminMfa của user khác → tag không khớp →
 * typed ADMIN_MFA_DECRYPT_FAILED. Envelope giữ nguyên format (AAD không nằm
 * trong envelope — nó là dữ liệu xác thực thêm, không phải bí mật).
 */
export function encryptTotpSecret(secretBase32: string, userId: string): string {
  const key = getAdminMfaEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`v1:${adminMfaKeyId(key)}:${userId}`, "utf8"));
  const ct = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${adminMfaKeyId(key)}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

/**
 * Giải mã envelope về base32 secret. Sai keyId so với key hiện tại → typed
 * ADMIN_MFA_KEY_MISMATCH (rotation detection — không corrupt im lặng); sai
 * userId (ciphertext bị chuyển row) hoặc tag không khớp (dữ liệu bị sửa) →
 * typed ADMIN_MFA_DECRYPT_FAILED.
 */
export function decryptTotpSecret(enc: string, userId: string): string {
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
  decipher.setAAD(Buffer.from(`v1:${currentKeyId}:${userId}`, "utf8"));
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      `${ADMIN_MFA_DECRYPT_FAILED}: AES-256-GCM tag không khớp — dữ liệu bị sửa, key sai, ` +
        "hoặc ciphertext bị chuyển sang row user khác (AAD bind theo userId)",
    );
  }
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Enroll MFA cho admin BÊN TRONG transaction truyền vào (review fix D5 — tách
 * từ enrollAdminMfa): caller (bootstrap script Task 11) gói enrollment + audit
 * "admin.bootstrap.mfa_enrolled" vào CÙNG MỘT tx — không bao giờ "đã enroll mà
 * không có audit". Sinh secret TOTP + 10 mã khôi phục, lưu secret ĐÃ MÃ HÓA +
 * hash mã khôi phục. Trả về `{ secretBase32, uri, recoveryCodes }` để caller in
 * MỘT LẦN — sau đó các giá trị thô này không còn tồn tại đâu ngoài authenticator.
 *
 * Refuse (trả null) khi: đã có AdminMfa cho user (reset qua bootstrap script —
 * không enroll đè) hoặc user không tồn tại (không row mồ côi).
 */
export async function enrollAdminMfaTx(
  tx: TxContext,
  userId: string,
): Promise<{
  secretBase32: string;
  uri: string;
  recoveryCodes: string[];
} | null> {
  const existing = await tx.orm.public.AdminMfa.first({ userId });
  if (existing) return null; // đã enroll — reset qua bootstrap script (Task 11)

  const user = await tx.orm.public.User.first({ id: userId });
  if (!user) return null; // không có user → không có gì để enroll (fail closed)

  const secretBase32 = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();

  const mfa = await tx.orm.public.AdminMfa.create({
    userId,
    totpSecretEnc: encryptTotpSecret(secretBase32, userId),
    // Enrollment chỉ diễn ra qua bootstrap offline tin cậy (Task 11): operator
    // nhận secret + mã khôi phục đúng MỘT LẦN — Batch 2 không có bước confirm
    // UI riêng, nên enrollment = confirmed. Login chỉ đọc sự TỒN TẠI row.
    totpConfirmedAt: new Date().toISOString(),
  });
  for (const code of recoveryCodes) {
    await tx.orm.public.AdminRecoveryCode.create({
      mfaId: mfa.id,
      codeHash: hashRecoveryCode(code),
      usedAt: null, // explicit — single-use: chưa dùng
    });
  }

  return {
    secretBase32,
    uri: totpUri(secretBase32, user.email, TOTP_ISSUER),
    recoveryCodes,
  };
}

/**
 * Enroll MFA trong MỘT transaction riêng (app path — Task 8 behavior GIỮ
 * NGUYÊN). Bootstrap script dùng enrollAdminMfaTx + audit trong tx của chính
 * nó (D5).
 */
export async function enrollAdminMfa(userId: string): Promise<{
  secretBase32: string;
  uri: string;
  recoveryCodes: string[];
} | null> {
  return db.transaction((tx) => enrollAdminMfaTx(tx, userId));
}

// ─── TOTP replay protection (RFC 6238 §5.2 — review fix #4) ──────────────────

/**
 * Time-step TOTP ĐÃ CHẤP NHẬN gần nhất của mỗi admin — mã của step đó (hoặc
 * step CŨ HƠN) không được chấp nhận lần hai (RFC 6238 §5.2: "the verifier must
 * reject a second attempt at the OTP of an already-accepted time step").
 *
 * In-process store (topology MỘT instance — cùng posture với src/lib/rate-limit.ts
 * và inbox dev của verification-delivery.ts; restart là mất → chấp nhận được vì
 * window chỉ ±60s). Durable/cross-instance cần cột additive AdminMfa.lastUsedStep
 * — KHÔNG làm schema change trong fix này (ghi nhận ở report cho Task 12/follow-up).
 * Bộ nhớ bounded: một entry/user (vài admin) — không cần dọn.
 */
const lastUsedTotpStep = new Map<string, number>();

/** Test seam — reset store giữa các case (cùng vai trò resetRateLimits). */
export function resetTotpReplayProtection(): void {
  lastUsedTotpStep.clear();
}

/**
 * Claim step cho user — true khi step CHƯA từng dùng (và mới hơn step đã dùng),
 * false khi là replay (step đã dùng hoặc cũ hơn — monotonic, không đi lùi được).
 */
function claimTotpStep(userId: string, step: number): boolean {
  const last = lastUsedTotpStep.get(userId);
  if (last !== undefined && last >= step) return false;
  lastUsedTotpStep.set(userId, step);
  return true;
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Xác thực mã MFA do admin nhập (login hoặc step-up). Trả về factor đã dùng:
 * - "totp" — mã TOTP hợp lệ (window ±1) VÀ chưa từng dùng ở step này
 *   (single-use per time step — RFC 6238 §5.2, review fix #4);
 * - "recovery_code" — mã khôi phục hợp lệ, ĐÁNH DẤU usedAt ngay (single-use,
 *   claim race-safe — 2 request đồng thời cùng một mã → đúng 1 thắng);
 * - null — sai mã / replay / chưa enroll / user không có MFA (fail closed).
 *
 * KHÔNG khóa tài khoản sau N lần sai ở đây — brute force do rate limit của
 * action/guard lo (auth:mfa + stepup:mfa, spec §7.2), lockout vĩnh viễn là
 * rủi ro ngược (spec §5.4.2 tránh khóa admin vĩnh viễn).
 *
 * Sai key mã hóa (rotate thiếu reset): TOTP path fail closed nhưng KHÔNG throw
 * ra caller — captureError typed KHÔNG chứa secret (review minor: ops thấy sai
 * key thay vì im lặng) rồi fall through sang mã khôi phục để admin còn đường
 * vào mà re-enroll (chống lockout vĩnh viễn).
 */
export async function verifyAdminMfaCode(
  userId: string,
  code: string,
): Promise<"totp" | "recovery_code" | null> {
  const mfa = await db.orm.public.AdminMfa.first({ userId });
  if (!mfa) return null;

  const trimmed = code.trim();
  if (trimmed === "") return null;

  // 1) TOTP — secret giải mã từ envelope (AAD bind theo userId của row);
  //    mọi lỗi giải mã → captureError (typed, secret-free) + fail closed.
  let totpStep: number | null = null;
  try {
    totpStep = verifyTotpStep(decryptTotpSecret(mfa.totpSecretEnc, userId), trimmed);
  } catch (e) {
    captureError("admin-mfa", e);
    totpStep = null;
  }
  if (totpStep !== null) {
    // Single-use per (userId, timeStep) — replay cùng mã/chuyển lùi step → null
    if (!claimTotpStep(userId, totpStep)) return null;
    return "totp";
  }

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
