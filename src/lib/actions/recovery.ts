"use server";

/**
 * Account recovery (Batch 2 Task 7 — spec §7.7, §7.2, §5.3) — đặt lại mật khẩu
 * qua OTP gửi tới MỘT kênh ĐÃ XÁC MINH, enumeration-safe ở mọi phản hồi.
 *
 * Nguyên tắc (plan Task 7 + spec §7.7 "prevent account enumeration"):
 * - MỘT thông báo trung tính duy nhất (RECOVERY_SENT_MESSAGE) cho MỌI outcome
 *   của request: có/không khớp tài khoản, kênh chưa xác minh, cooldown OTP,
 *   per-target limit, delivery fail — byte-đối-byte như nhau, kẻ dò không
 *   phân biệt được gì cả. (Constant KHÔNG export — file "use server" chỉ
 *   export được async function; test pin bằng so sánh giữa các outcome.)
 * - Confirm: mọi failure (identifier không khớp, sai/hết hạn/dùng lại/khóa vì
 *   quá lần thử/bị chặn theo identifier) COLLAPSE về cùng một lỗi — confirm
 *   không thành oracle enumeration.
 * - Tra user theo email/số phone NHƯNG chỉ khớp kênh ĐÃ XÁC MINH
 *   (emailVerifiedAt/phoneVerifiedAt != null) — recovery qua kênh chưa xác
 *   minh là vector chiếm tài khoản (SIM tái sử dụng, email cũ — spec §5.3.1).
 *   Kênh gửi = kênh của identifier: mất email → nhập phone → mã tới phone
 *   (lost-email path) và ngược lại (lost-phone path).
 * - TIMING (review fix #2, spec §7.2/§7.7): matched-path work (requestOtp +
 *   audit — DB writes, sau này là network call provider thật) KHÔNG được
 *   await trong response — nếu không, identifier có thật trả chậm/throw còn
 *   identifier lạ trả nhanh = oracle tồn tại. `after()` từ next/server
 *   schedule work post-response; mọi throw bên trong được captureError
 *   (không PII) — response trung tính không phụ thuộc delivery/audit/db.
 * - Rate limit: request 5/10 phút/IP (plan Task 7) + confirm 10/10 phút/IP
 *   (spec §7.1) + PER-IDENTIFIER confirm 5/10 phút keyed bằng HMAC hash của
 *   identifier chuẩn hóa (review fix #4, spec §7.1 "target resource" — chống
 *   brute-force MỘT tài khoản từ nhiều IP; hash để không lưu identifier thô
 *   trong limiter, spec §4.8; trả CÙNG lỗi collapsed) + per-identifier limit
 *   của OTP core (3 mã/10 phút/(userId,purpose,target)).
 * - Completion (review fix #3, Review Focus 3): MẬT KHẨU MỚI + thu hồi MỌI
 *   session trong CÙNG MỘT db.transaction (revokeAllUserSessionsTx) — hai
 *   statement rời để lại mật khẩu mới + session cũ còn tác quyền nếu thất bại
 *   giữa chừng. KHÔNG exceptSessionId: session hiện tại (nếu có) cũng chết,
 *   session tạo TRƯỚC reset không còn tác quyền (stale-session reuse, spec §7.2).
 * - Security notice (review fix #1, spec §5.3.1/§7.7 "notify previous
 *   verified channels"): gửi tới MỌI kênh ĐÃ XÁC MINH của user (không chỉ
 *   kênh vừa dùng) — kẻ chiếm SIM/email đang giữ kênh đó, kênh còn lại của
 *   nạn nhân phải được báo. Fail-open, KHÔNG PII trong log.
 * - Audit "user.recovery_requested"/"user.recovery_completed" (Task 5 registry)
 *   + notify in-app — fail-open CÓ Ý THỨC: trạng thái audit/notice hỏng không
 *   được thành oracle enumeration (matched path phải trả đúng như unknown path).
 * - KHÔNG log identifier thô (email/phone), mã OTP, mật khẩu ở bất kỳ path nào
 *   (spec §4.8) — lỗi được captureError với meta KHÔNG PII.
 */

import { createHmac } from "node:crypto";
import { after } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { hashPassword } from "@/src/lib/auth";
import { revokeAllUserSessionsTx } from "@/src/lib/session";
import {
  hkdfKey,
  normalizeEmail,
  normalizePhone,
  requestOtp,
  verifyOtp,
  type OtpChannel,
} from "@/src/lib/otp";
import { auditEvent } from "@/src/lib/audit-event";
import { getOtpDeliveryAdapter } from "@/src/lib/verification-delivery";
import { checkRateLimit, clientIpFromHeaders, type RateLimitRule } from "@/src/lib/rate-limit";
import { captureError } from "@/src/lib/observability";
import { notify } from "@/src/lib/notify";

export type RecoveryFormState = { error?: string; success?: string };

/** 5 request / 10 phút / IP — plan Task 7 (IP rate limit riêng cho request). */
const RECOVERY_REQUEST_RULE: RateLimitRule = { limit: 5, windowMs: 10 * 60_000 };
/** 10 confirm / 10 phút / IP — spec §7.1 (OTP verify endpoint cũng rate limit). */
const RECOVERY_CONFIRM_RULE: RateLimitRule = { limit: 10, windowMs: 10 * 60_000 };
/**
 * 5 confirm / 10 phút / IDENTIFIER (review fix #4, spec §7.1 "target resource")
 * — chống brute-force mã trên MỘT tài khoản từ nhiều IP (per-IP không chặn
 * được việc đó). 5 = OTP_MAX_ATTEMPTS: sau 5 lần thử sai thì mã đó đã khóa
 * anyway; limit này chặn việc MUA MÃ MỚI rồi thử tiếp trên cùng identifier.
 */
const RECOVERY_CONFIRM_PER_IDENTIFIER_RULE: RateLimitRule = { limit: 5, windowMs: 10 * 60_000 };

/**
 * Thông báo trung tính DUY NHẤT (spec §7.7 chống enumeration) — mọi outcome của
 * request trả đúng chuỗi này. KHÔNG export ("use server" chỉ export được async
 * function); KHÔNG chứa identifier/mọi thứ động theo tài khoản.
 */
const RECOVERY_SENT_MESSAGE =
  "Nếu thông tin bạn nhập khớp với một kênh đã xác minh của tài khoản, mã đặt lại mật khẩu đã được gửi. Vui lòng kiểm tra email hoặc tin nhắn.";

/**
 * Lỗi collapsed của confirm — identifier không khớp, sai mã, hết hạn, dùng lại,
 * khóa vì quá lần thử, bị chặn theo identifier → CÙNG chuỗi (spec §7.7).
 */
const RECOVERY_CODE_INVALID_MESSAGE =
  "Mã không đúng hoặc đã hết hạn. Vui lòng kiểm tra lại hoặc yêu cầu mã mới.";

/** Lỗi nhập liệu identifier — fixed message, KHÔNG chứa raw input (spec §4.8). */
const IDENTIFIER_INVALID_MESSAGE = "Vui lòng nhập email hoặc số điện thoại hợp lệ.";

/** Thông báo hoàn tất — mọi phiên đã thu hồi, đăng nhập lại bằng mật khẩu mới. */
const RECOVERY_COMPLETED_MESSAGE =
  "Đặt lại mật khẩu thành công. Mọi phiên đăng nhập đã được thu hồi — vui lòng đăng nhập bằng mật khẩu mới.";

// ─── Rate limit (fail open — limiter lỗi không chặn người dùng, như auth.ts) ──

async function recoveryRateLimited(
  scope: string,
  rule: RateLimitRule,
): Promise<RecoveryFormState | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const decision = checkRateLimit(`${scope}:${ip}`, rule);
    if (decision.allowed) return null;
    return { error: `Quá nhiều lần thử — chờ ${decision.retryAfterSec} giây rồi thử lại.` };
  } catch {
    return null;
  }
}

// ─── Identifier: email HOẶC phone VN — sai dạng → lỗi nhập liệu trước tra cứu ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ParsedIdentifier = { channel: OtpChannel; target: string };

/**
 * Phân loại identifier: email (có "@", đúng dạng) HOẶC phone VN (normalizePhone
 * — bỏ khoảng cách/dấu chấm, +84→0). Sai cả hai → null → lỗi nhập liệu TRƯỚC
 * khi tra cứu db (không tốn lookup). KHÔNG log raw input ở path nào (spec §4.8).
 */
function parseIdentifier(raw: string): ParsedIdentifier | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("@")) {
    return EMAIL_RE.test(value) ? { channel: "email", target: normalizeEmail(value) } : null;
  }
  try {
    return { channel: "phone", target: normalizePhone(value) };
  } catch {
    return null; // INVALID_PHONE_FORMAT — message cố định, không raw input
  }
}

/**
 * Khóa bucket per-identifier cho limiter — HMAC-SHA256 keyed (hkdfKey
 * "recovery-identifier-hash") của identifier CHUẨN HÓA: limiter in-memory
 * KHÔNG giữ email/phone thô trong key (spec §4.8); keyed hash không đảo
 * ngược được và đồng nhất trong process.
 */
function identifierBucketKey(channel: OtpChannel, target: string): string {
  return createHmac("sha256", hkdfKey("recovery-identifier-hash"))
    .update(`${channel}:${target}`)
    .digest("hex");
}

/** User row tối giản cho recovery — đủ id + trạng thái/kênh đã xác minh cho notice. */
type RecoveryUser = {
  id: string;
  email: string;
  phone: string | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
};

/**
 * Tra user theo identifier NHƯNG chỉ khớp kênh ĐÃ XÁC MINH — email unique nên
 * phone là nơi có thể trùng chuỗi; verified-phone uniqueness do Task 6 giữ
 * (collision re-check lúc verify), residual race đã ghi nhận trong batch doc.
 */
async function findUserByVerifiedIdentifier(
  channel: OtpChannel,
  target: string,
): Promise<RecoveryUser | null> {
  if (channel === "email") {
    return db.orm.public.User.where({ email: target })
      .where((u) => u.emailVerifiedAt.isNotNull())
      .first();
  }
  return db.orm.public.User.where({ phone: target })
    .where((u) => u.phoneVerifiedAt.isNotNull())
    .first();
}

// ─── Bước 1: yêu cầu mã đặt lại ────────────────────────────────────────────────

export async function requestPasswordRecoveryAction(
  _prev: RecoveryFormState,
  formData: FormData,
): Promise<RecoveryFormState> {
  // 1) IP rate limit — 5/10 phút/IP, tiêu tốn cho MỌI request (kể cả identifier
  //    không khớp — bucket theo IP, không theo identifier, không leak existence).
  const limited = await recoveryRateLimited("recovery:request", RECOVERY_REQUEST_RULE);
  if (limited) return limited;

  // 2) Định dạng — email HOẶC phone VN. Sai cả hai → lỗi nhập liệu TRƯỚC tra cứu.
  const parsed = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!parsed) return { error: IDENTIFIER_INVALID_MESSAGE };
  const { channel, target } = parsed;

  // 3) Tra user — CHỈ khớp kênh ĐÃ XÁC MINH (emailVerifiedAt/phoneVerifiedAt).
  //    Cả hai path đều trả sau đúng MỘT db query — không khác biệt timing.
  const user = await findUserByVerifiedIdentifier(channel, target);

  // 4) Không khớp → cùng thông báo trung tính, KHÔNG OTP (budget IP đã tốn ở bước 1 —
  //    kẻ dò identifier lạ không mua được thêm budget cho identifier thật).
  if (!user) return { success: RECOVERY_SENT_MESSAGE };

  // 5) Có user → requestOtp(password_recovery, kênh của identifier) + audit —
  //    KHÔNG await: schedule post-response qua after() (review fix #2). Nếu
  //    await thì identifier có thật trả chậm hơn identifier lạ (DB writes +
  //    network provider) = oracle tồn tại qua timing; và mọi throw của
  //    requestOtp/audit sẽ thành server error trên matched path trong khi
  //    unknown path vẫn trung tính = oracle tồn tại qua error. after() + catch
  //    trong callback đóng cả hai (spec §7.2/§7.7).
  after(async () => {
    try {
      // Mọi error code (cooldown, per-target limit, delivery fail) COLLAPSE —
      // callback không đổi response đã trả; audit ghi reason typed tương ứng.
      const result = await requestOtp({
        userId: user.id,
        purpose: "password_recovery",
        channel,
        target,
      });
      try {
        await auditEvent({
          actorId: user.id,
          subjectId: user.id,
          action: "user.recovery_requested",
          resourceType: "User",
          resourceId: user.id,
          reason: result.ok ? "otp_sent" : result.code,
          detail: `channel=${channel}`, // channel là LOẠI kênh — không phải email/phone thô
        });
      } catch (e) {
        captureError("recovery", e, { action: "user.recovery_requested" });
      }
    } catch (e) {
      // requestOtp throw (db/provider) — KHÔNG thành oracle: response trung tính
      // đã trả; lỗi được ghi với meta KHÔNG PII (spec §4.8).
      captureError("recovery", e, { action: "user.recovery_requested" });
    }
  });

  return { success: RECOVERY_SENT_MESSAGE };
}

// ─── Bước 2: nhập mã + mật khẩu mới ───────────────────────────────────────────

const confirmSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Mã gồm 6 chữ số"),
  newPassword: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự").max(100, "Mật khẩu tối đa 100 ký tự"),
});

export async function confirmPasswordRecoveryAction(
  _prev: RecoveryFormState,
  formData: FormData,
): Promise<RecoveryFormState> {
  // 1) IP rate limit riêng cho confirm (spec §7.1 — OTP verify endpoint).
  const limited = await recoveryRateLimited("recovery:confirm", RECOVERY_CONFIRM_RULE);
  if (limited) return limited;

  // 2) Định dạng identifier — sai dạng → lỗi nhập liệu trước tra cứu.
  const parsed = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!parsed) return { error: IDENTIFIER_INVALID_MESSAGE };
  const { channel, target } = parsed;

  // 3) Per-identifier limit (review fix #4, spec §7.1 "target resource") —
  //    keyed bằng HMAC hash của identifier chuẩn hóa (không lưu identifier thô
  //    trong limiter, spec §4.8). Trả CÙNG lỗi collapsed như sai mã: kẻ dò
  //    không phân biệt "identifier bị khóa" vs "mã sai" (spec §7.7). Fail open.
  try {
    const decision = checkRateLimit(
      `recovery:confirm-id:${identifierBucketKey(channel, target)}`,
      RECOVERY_CONFIRM_PER_IDENTIFIER_RULE,
    );
    if (!decision.allowed) return { error: RECOVERY_CODE_INVALID_MESSAGE };
  } catch {
    /* limiter lỗi → không chặn */
  }

  // 4) Validate mã + mật khẩu mới (sau bucket identifier — mọi attempt chống
  //    MỘT tài khoản đều phải đếm, kể cả attempt malformed).
  const creds = confirmSchema.safeParse({
    code: String(formData.get("code") ?? "").trim(),
    newPassword: String(formData.get("newPassword") ?? ""),
  });
  if (!creds.success) {
    return { error: creds.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  }
  const { code, newPassword } = creds.data;

  // 5) Tra user theo kênh ĐÃ XÁC MINH — không khớp → CÙNG lỗi collapsed với sai mã
  //    (không phân biệt "không có tài khoản" vs "mã sai" — spec §7.7). Chặn
  //    TRƯỚC verifyOtp: mã hợp lệ của kênh chưa xác minh không dùng được.
  const user = await findUserByVerifiedIdentifier(channel, target);
  if (!user) return { error: RECOVERY_CODE_INVALID_MESSAGE };

  // 6) verifyOtp — mọi failure code (OTP_NOT_FOUND/OTP_EXPIRED/OTP_MAX_ATTEMPTS)
  //    collapse về CÙNG lỗi (không leak "có mã nhưng hết hạn" — spec §7.7).
  const verified = await verifyOtp({
    userId: user.id,
    purpose: "password_recovery",
    channel,
    target,
    code,
  });
  if (!verified.ok) return { error: RECOVERY_CODE_INVALID_MESSAGE };

  // 7) Mật khẩu mới + thu hồi MỌI session trong CÙNG transaction (review fix #3,
  //    Review Focus 3): hai statement rời → thất bại giữa chừng để lại mật khẩu
  //    mới + session cũ còn tác quyền. hashPassword NGOÀI tx (bcrypt chậm —
  //    không giữ tx). revokeAllUserSessionsTx KHÔNG exceptSessionId: session
  //    hiện tại (nếu có) cũng chết — stale-session reuse sau recovery đóng.
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.orm.public.User.where({ id: user.id }).updateAll({ passwordHash });
    await revokeAllUserSessionsTx(tx, user.id, "password_recovery");
  });

  // 8) Audit + notify + security notice — fail-open: completion không phụ thuộc
  //    bảng audit/hệ thống notice (và trạng thái hỏng không thành oracle enumeration).
  try {
    await auditEvent({
      actorId: user.id,
      subjectId: user.id,
      action: "user.recovery_completed",
      resourceType: "User",
      resourceId: user.id,
      reason: "verified_channel_otp",
      detail: `channel=${channel}`,
    });
  } catch (e) {
    captureError("recovery", e, { action: "user.recovery_completed" });
  }
  try {
    await notify(
      user.id,
      "security",
      "Mật khẩu đã được đặt lại",
      "Bạn vừa đặt lại mật khẩu qua mã xác minh. Mọi phiên đăng nhập đã được thu hồi. Nếu không phải bạn, hãy liên hệ hỗ trợ ngay.",
      "/login",
    );
  } catch (e) {
    captureError("recovery", e, { action: "recovery_completed_notify" });
  }

  // 9) Security notice tới MỌI kênh ĐÃ XÁC MINH của user (review fix #1, spec
  //    §5.3.1/§7.7) — KHÔNG chỉ kênh vừa dùng: kẻ chiếm SIM/email đang giữ
  //    kênh đó, kênh còn lại của nạn nhân phải được báo để phát hiện chiếm tài
  //    khoản. Dùng identifier ĐÃ CHUẨN HÓA từ DB; fail-open từng kênh.
  const verifiedNotices: Array<{ to: string; channel: OtpChannel }> = [];
  if (user.emailVerifiedAt !== null) {
    verifiedNotices.push({ to: normalizeEmail(user.email), channel: "email" });
  }
  if (user.phoneVerifiedAt !== null && user.phone !== null) {
    try {
      verifiedNotices.push({ to: normalizePhone(user.phone), channel: "phone" });
    } catch {
      // phone lưu dạng không normalize được → bỏ kênh này (fail-open, KHÔNG log raw)
    }
  }
  for (const notice of verifiedNotices) {
    try {
      // Adapter tự fail-open (sendSecurityNotice không throw, KHÔNG log
      // body/target — spec §4.8).
      await getOtpDeliveryAdapter().sendSecurityNotice({
        to: notice.to,
        channel: notice.channel,
        subjectKey: "password_reset",
      });
    } catch {
      // belt & suspenders — notice không bao giờ chặn completion
    }
  }

  return { success: RECOVERY_COMPLETED_MESSAGE };
}
