import "server-only";
import { createHmac, hkdfSync, randomInt } from "node:crypto";
import { db } from "@/src/prisma/db.client";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { getOtpDeliveryAdapter } from "@/src/lib/verification-delivery";

/**
 * OTP core (Batch 2 Task 3 — spec §5.3): hashed at rest, single-use, short-lived,
 * attempt-limited, resend-limited, rate-limited, enumeration-safe (caller actions
 * Task 6/7), invalidated after successful use — và KHÔNG BAO GIỜ ghi mã thô ra
 * log/analytics ở BẤT KỲ môi trường nào (spec §4.8; không có console adapter,
 * không dev-log mã — Review Focus 1).
 *
 * Thiết kế:
 * - Mã 6 chữ số từ crypto.randomInt(0, 1_000_000) zero-padded — CSPRNG, không
 *   Math.random.
 * - DB chỉ lưu HMAC-SHA256 keyed bằng hkdfKey("otp-hash") — key derive HKDF từ
 *   AUTH_SECRET (xem hkdfKey). KHÔNG lưu mã thô.
 * - Binding ĐẦY ĐỦ: mã chỉ hợp lệ cho đúng (userId, purpose, channel, target)
 *   — mã của người khác/channel khác không verify được.
 * - requestOtp: cooldown 60s (resend-limited) → per-target rate limit 3 mã /
 *   10 phút → tạo row → gửi qua adapter → delivery fail thì DELETE row +
 *   typed OTP_DELIVERY_UNAVAILABLE (không mã mồ côi; production fail-closed
 *   cho tới khi có provider thật — Ambiguities A1).
 * - verifyOtp: chỉ row MỚI NHẤT của (userId,purpose,channel,target) được verify;
 *   hết hạn → OTP_EXPIRED; quá 5 lần sai → OTP_MAX_ATTEMPTS; consume ATOMIC
 *   (updateAll WHERE consumedAt IS NULL — 0 row = đã ai đó dùng, concurrent
 *   double-verify đóng).
 *
 * Module KHÔNG log gì cả (kể cả error path) — mọi log của caller phải tuân
 * spec §4.8. hkdfKey dùng chung cho Task 5 (ip-hash) + Task 8
 * (recovery-code-hash); KHÔNG dùng cho mã hóa AdminMfa — key đó là
 * ADMIN_MFA_ENCRYPTION_KEY riêng (Task 8), không derive từ AUTH_SECRET.
 */

export type OtpPurpose = "email_verification" | "phone_verification" | "password_recovery";
export type OtpChannel = "email" | "phone";

/** TTL mã OTP (spec §5.3 "short-lived"). */
export const OTP_TTL_MINUTES = 10;
/** Số lần thử sai tối đa trước khi khóa (spec §5.3 "attempt-limited"). */
export const OTP_MAX_ATTEMPTS = 5;
/** Cooldown giữa 2 lần gửi mã (spec §5.3 "resend-limited"). */
export const OTP_RESEND_COOLDOWN_SEC = 60;
/** 3 mã / 10 phút / (userId,purpose,target) (spec §5.3 "rate-limited"). */
export const OTP_PER_TARGET_RULE = { limit: 3, windowMs: 10 * 60_000 };

export type OtpRequestResult =
  | { ok: true; resendAfterSec: number }
  | { ok: false; code: "OTP_RATE_LIMITED"; retryAfterSec: number }
  | { ok: false; code: "OTP_DELIVERY_UNAVAILABLE" };

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; code: "OTP_NOT_FOUND" | "OTP_EXPIRED" | "OTP_MAX_ATTEMPTS" };

// ─── HKDF + hash helpers ──────────────────────────────────────────────────────

/** Salt HKDF cố định — domain-separate các info key của platform. */
const HKDF_SALT = "speaker-platform-otp-v1";

/**
 * Key 32-byte derive HKDF-SHA256 từ AUTH_SECRET — MỘT helper dùng chung cho OTP
 * hash ("otp-hash"), ip hash ("ip-hash" — Task 5), recovery-code hash
 * ("recovery-code-hash" — Task 8). KHÔNG dùng cho mã hóa AdminMfa — key đó là
 * ADMIN_MFA_ENCRYPTION_KEY riêng (Task 8), không bao giờ derive từ AUTH_SECRET.
 *
 * AUTH_SECRET do src/lib/env.ts validate fail-fast khi start (bắt buộc mọi môi
 * trường, ≥ 32 ký tự) — thiếu key là lỗi cấu hình, không phải path runtime.
 */
export function hkdfKey(info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(process.env.AUTH_SECRET!, "utf8"),
      Buffer.from(HKDF_SALT, "utf8"),
      Buffer.from(info, "utf8"),
      32,
    ),
  );
}

/** HMAC-SHA256 hex của mã — thứ duy nhất được lưu trong DB. */
const otpCodeHash = (code: string): string =>
  createHmac("sha256", hkdfKey("otp-hash")).update(code).digest("hex");

// ─── Chuẩn hóa target ─────────────────────────────────────────────────────────

/** Email: trim + lowercase — dạng chuẩn lưu DB + so khớp binding. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const PHONE_VN_RE = /^0\d{9,10}$/;

/**
 * Số điện thoại VN: bỏ khoảng cách/dấu chấm, +84 → 0, validate /^0\d{9,10}$/ —
 * throw khi sai format (caller bắt để trả lỗi nhập liệu, không phải im lặng
 * trim thành số rác rồi gửi mã đi đâu đó).
 */
export function normalizePhone(raw: string): string {
  const cleaned = raw.replaceAll(" ", "").replaceAll(".", "");
  const normalized = cleaned.startsWith("+84") ? `0${cleaned.slice(3)}` : cleaned;
  if (!PHONE_VN_RE.test(normalized)) {
    throw new Error(
      `INVALID_PHONE_FORMAT: "${raw}" không phải số điện thoại VN hợp lệ (0xxxxxxxxx | 0xxxxxxxxxx)`,
    );
  }
  return normalized;
}

// ─── requestOtp ───────────────────────────────────────────────────────────────

/**
 * Sinh + gửi OTP cho (userId, purpose, channel, target). Target phải ĐÃ chuẩn hóa
 * (normalizeEmail/normalizePhone) — binding lưu đúng chuỗi này.
 *
 * Thứ tự chặn: cooldown 60s (resend-limited) → per-target 3 mã/10 phút
 * (rate-limited) → tạo row → adapter.sendOtp. Delivery fail → DELETE row +
 * OTP_DELIVERY_UNAVAILABLE (fail closed — không để mã mồ côi không ai nhận).
 * KHÔNG log mã ở bất kỳ path nào (spec §4.8).
 */
export async function requestOtp(params: {
  userId: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
  target: string;
}): Promise<OtpRequestResult> {
  const { userId, purpose, channel, target } = params;

  // 1) Cooldown: row mới nhất của (userId,purpose,target) còn trẻ hơn 60s → chặn
  //    (không tốn hit rate limit — cooldown là ranh giới đầu).
  const latest = await db.orm.public.OtpCode.where({ userId, purpose, target })
    .orderBy((o) => o.createdAt.desc())
    .first();
  if (latest) {
    const ageMs = Date.now() - Date.parse(latest.createdAt);
    if (ageMs < OTP_RESEND_COOLDOWN_SEC * 1_000) {
      const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_SEC * 1_000 - ageMs) / 1_000);
      return { ok: false, code: "OTP_RATE_LIMITED", retryAfterSec: Math.max(1, waitSec) };
    }
  }

  // 2) Per-target rate limit: 3 mã / 10 phút / (userId,purpose,target).
  const decision = checkRateLimit(`otp:${userId}:${purpose}:${target}`, OTP_PER_TARGET_RULE);
  if (!decision.allowed) {
    return { ok: false, code: "OTP_RATE_LIMITED", retryAfterSec: decision.retryAfterSec };
  }

  // 3) Sinh mã + tạo row (hash only). attempts/consumedAt explicit cho rõ ràng.
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const row = await db.orm.public.OtpCode.create({
    userId,
    purpose,
    channel,
    target,
    codeHash: otpCodeHash(code),
    attempts: 0,
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
    consumedAt: null,
  });

  // 4) Gửi qua adapter. Throw → DELETE row (mã chưa tới tay ai thì không tồn tại)
  //    + typed fail-closed. KHÔNG log error của provider (message có thể chứa mã).
  try {
    await getOtpDeliveryAdapter().sendOtp({ to: target, code, purpose, channel });
  } catch {
    await db.orm.public.OtpCode.where({ id: row.id }).delete();
    return { ok: false, code: "OTP_DELIVERY_UNAVAILABLE" };
  }

  return { ok: true, resendAfterSec: OTP_RESEND_COOLDOWN_SEC };
}

// ─── verifyOtp ────────────────────────────────────────────────────────────────

/**
 * Xác thực mã do người dùng nhập cho (userId, purpose, channel, target).
 * Chỉ row MỚI NHẤT của tuple đó được xét (mã cũ không dùng lại được sau resend).
 *
 * Thứ tự: không có row / đã consume → OTP_NOT_FOUND; hết hạn → OTP_EXPIRED;
 * đã khóa (attempts ≥ 5) → OTP_MAX_ATTEMPTS; sai mã → attempts += 1 (đến ngưỡng
 * thì trả OTP_MAX_ATTEMPTS); đúng mã → consume ATOMIC — updateAll WHERE
 * consumedAt IS NULL, 0 row nghĩa là một request song song đã consume trước
 * → OTP_NOT_FOUND (đóng concurrent double-verify, spec §5.3 single-use).
 */
export async function verifyOtp(params: {
  userId: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
  target: string;
  code: string;
}): Promise<OtpVerifyResult> {
  const { userId, purpose, channel, target, code } = params;

  const row = await db.orm.public.OtpCode.where({ userId, purpose, channel, target })
    .orderBy((o) => o.createdAt.desc())
    .first();
  if (!row) return { ok: false, code: "OTP_NOT_FOUND" };
  // single-use: mã đã consume là chết hẳn — không đếm attempts, không báo expired
  if (row.consumedAt !== null) return { ok: false, code: "OTP_NOT_FOUND" };
  if (Date.parse(row.expiresAt) <= Date.now()) return { ok: false, code: "OTP_EXPIRED" };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, code: "OTP_MAX_ATTEMPTS" };

  if (otpCodeHash(code) !== row.codeHash) {
    // Sai mã → tăng attempts. Đến ngưỡng → khóa ngay (lần sai thứ OTP_MAX_ATTEMPTS
    // trả OTP_MAX_ATTEMPTS); các lần sau bị chặn ở check trên.
    const attempts = row.attempts + 1;
    await db.orm.public.OtpCode.where({ id: row.id }).updateAll({ attempts });
    return attempts >= OTP_MAX_ATTEMPTS
      ? { ok: false, code: "OTP_MAX_ATTEMPTS" }
      : { ok: false, code: "OTP_NOT_FOUND" };
  }

  // Đúng mã → consume ATOMIC: chỉ row chưa consumed mới được set consumedAt.
  // 0 row updated = request song song đã consume trước → single-use giữ vững.
  const consumed = await db.orm.public.OtpCode.where({ id: row.id })
    .where((o) => o.consumedAt.isNull())
    .updateAll({ consumedAt: new Date().toISOString() });
  if (consumed.length === 0) return { ok: false, code: "OTP_NOT_FOUND" };

  return { ok: true };
}
