import { createHmac } from "node:crypto";

import { hkdfKey } from "@/src/lib/hkdf";

/**
 * Manual account recovery — vocabulary + helpers thuần (Task E, founder
 * FD-R3 2026-10-13: production không có OTP provider → /recover không gửi
 * được mã; hand-set passwordHash bị cấm — two-person admin-assisted recovery
 * là đường chuẩn cho đến FD-R1).
 *
 * Plain module (KHÔNG "server-only" — pattern founding-seller-vocab.ts /
 * manual-contact-verification.ts): client component import được labels/caps;
 * hash helper chỉ gọi server-side (action) — hkdfKey đọc AUTH_SECRET lúc
 * CALL, không phải import time.
 *
 * PROVISIONAL (FD-3): mọi nhãn/tunable dưới đây là vocabulary cơ học —
 * founder review qua register (Task E note).
 *
 * TWO-PERSON RULE (enforce ở action, KHÔNG ở đây — mirror manual-contact-verification):
 *  - admin A (super/ops, account.recover_manual + step-up) mở request SAU KHI
 *    gọi điện tới số phone ĐÃ XÁC MINH của chủ tài khoản và user trả đúng
 *    ≥ 2/3 câu hỏi out-of-band;
 *  - admin B (≠ A, ≠ subject) approve/reject — KHÔNG BAO GIỜ một admin tự mở
 *    + tự duyệt;
 *  - approve: sinh reset token MỘT LẦN (30 phút), thu hồi MỌI session của
 *    subject trong cùng tx, hiển thị URL reset cho admin B MỘT LẦN (gửi
 *    out-of-band — phone/Zalo);
 *  - user tự đặt mật khẩu mới qua /recover/manual (cookie HttpOnly ngắn hạn —
 *    token rời URL ngay, pattern /invite/[token] Batch 7).
 *
 * phoneHash: HMAC-SHA256 hex của phone ĐÃ CHUẨN HÓA (normalizePhone của
 * Batch 2) qua hkdfKey với label RIÊNG "account-recovery-phone" —
 * domain-separated khỏi otp-hash/beta-invite-hash/ip-hash/
 * manual-contact-target. KHÔNG BAO GIỜ lưu giá trị thô (spec §4.8); approve
 * so lại hash + phoneVerifiedAtSnapshot của giá trị HIỆN TẠI — đổi giữa
 * request/approve → CONTACT_CHANGED (refuse).
 *
 * resetTokenHash: HMAC-SHA256 hex của token 256-bit qua hkdfKey với label
 * RIÊNG "account-recovery-reset-token" (pattern BetaInviteToken.tokenHash
 * Batch 7 / OtpCode.codeHash Batch 2) — token thô CHỈ tồn tại trong URL một
 * lần cho admin B, KHÔNG BAO GIỜ lưu/log/audit.
 */

// ─── Caps + tunables (PROVISIONAL — FD-3) ────────────────────────────────────

/**
 * Request hết hạn sau 24h (requestedAt + TTL → expiresAt). KHÔNG cron —
 * read-path coi row requested quá expiresAt là expired (cùng triết lý
 * OtpCode Batch 2 / ManualContactVerification Task A: TTL tính lúc đọc).
 */
export const MANUAL_RECOVERY_REQUEST_TTL_HOURS = 24;

/**
 * Reset token hết hạn sau 30 phút kể từ approval (decidedAt + TTL →
 * resetTokenExpiresAt). Token MỘT LẦN — consume CAS chặn cả quá hạn lẫn
 * dùng lại (founder FD-R3 2026-10-13).
 */
export const MANUAL_RECOVERY_RESET_TOKEN_TTL_MINUTES = 30;

/**
 * Rate limit MỘT bucket dùng chung request/approve/reject/cancel — per ADMIN
 * (§7.1): 20 thao tác / giờ / admin. PROVISIONAL (P5 precedent
 * MANUAL_CONTACT_ACTION_RATE). Hữu hạn (window trượt) — không khóa vĩnh viễn.
 */
export const MANUAL_RECOVERY_ACTION_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;

/**
 * 30 GET / 10 phút / IP cho landing /recover/manual/[token] (mirror
 * BETA_INVITE_LANDING_RATE Batch 7 corrections #13) — token-validity oracle
 * không giới hạn là lỗi; PROVISIONAL (P5).
 */
export const MANUAL_RECOVERY_LANDING_RATE = { limit: 30, windowMs: 10 * 60_000 } as const;

/**
 * 10 consume / 10 phút / IP (mirror RECOVERY_CONFIRM_RULE của self-service
 * recovery — spec §7.1) + per-token bucket riêng (xem consume action).
 * PROVISIONAL (P5).
 */
export const MANUAL_RECOVERY_CONSUME_RATE = { limit: 10, windowMs: 10 * 60_000 } as const;

// ─── Cookie + token mechanics (pattern /invite Batch 7 — corrections #7/#12/#35) ─

/**
 * Cookie mang reset token sau landing: `/recover/manual/[token]` GET set
 * MỘT LẦN, mọi request sau chỉ mang cookie — token KHÔNG BAO GIỜ rides trong
 * `next`/query/form. `path: "/recover/manual"` (corrections #35 precedent):
 * action POST đến `/recover/manual` nên path hẹp vẫn hoạt động và token
 * không đi kèm request khác.
 */
export const MANUAL_RECOVERY_COOKIE = "sp_manual_recovery";
/** TTL cookie (P5 — PROVISIONAL): 15 phút, đủ cho một phiên đặt mật khẩu. */
export const MANUAL_RECOVERY_COOKIE_MAX_AGE_SEC = 15 * 60;
/**
 * Path cookie — route handler SET và consume action DELETE phải dùng CÙNG
 * giá trị này (corrections #35 precedent: `cookies().delete(name)` mặc định
 * `Path=/` là MỘT cookie khác, không đụng được cookie path hẹp).
 */
export const MANUAL_RECOVERY_COOKIE_PATH = "/recover/manual";

/**
 * Token thô 256-bit (`randomBytes(32).toString("base64url")`) — đúng 43 ký tự
 * base64url không padding. Reject TRƯỚC mọi db call (corrections #12
 * precedent): giá trị cookie/path không khớp shape là garbage — không tốn
 * một query nào.
 */
export const MANUAL_RECOVERY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ─── Checks out-of-band (founder FD-R3 2026-10-13 — 2 trong 3 câu) ───────────

/**
 * Ba câu hỏi out-of-band admin A hỏi user TRÊN CUỘC GỌI tới số đã xác minh —
 * operator tick câu ĐÚNG (boolean), KHÔNG BAO GIỜ nhập câu trả lời. Key là
 * tên cột boolean trên AccountRecoveryRequest.
 */
export const MANUAL_RECOVERY_CHECKS = [
  "listing_title",
  "province",
  "registration_month",
] as const;
export type ManualRecoveryCheck = (typeof MANUAL_RECOVERY_CHECKS)[number];

/** Nhãn tiếng Việt cho form request (PROVISIONAL — FD-3). */
export const MANUAL_RECOVERY_CHECK_LABELS: Record<ManualRecoveryCheck, string> = {
  listing_title: "Tiêu đề một tin đăng của tài khoản",
  province: "Tỉnh/thành của tài khoản",
  registration_month: "Tháng đăng ký tài khoản",
};

// ─── Labels trạng thái (PROVISIONAL — FD-3) ──────────────────────────────────

/** Trạng thái request — mirror enum account_recovery_status của contract. */
export const MANUAL_RECOVERY_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "cancelled",
  "expired",
  "consumed",
] as const;
export type ManualRecoveryStatus = (typeof MANUAL_RECOVERY_STATUSES)[number];

/** Nhãn tiếng Việt hiển thị console (PROVISIONAL — FD-3). */
export const MANUAL_RECOVERY_STATUS_LABELS: Record<ManualRecoveryStatus, string> = {
  requested: "Đang chờ admin khác duyệt",
  approved: "Đã duyệt — link reset còn hiệu lực",
  rejected: "Bị từ chối",
  cancelled: "Đã hủy",
  expired: "Đã hết hạn",
  consumed: "Đã hoàn tất (mật khẩu mới)",
};

// ─── Hash helpers (server-side call only) ────────────────────────────────────

/**
 * HMAC-SHA256 hex 64 ký tự của phone ĐÃ CHUẨN HÓA qua
 * hkdfKey("account-recovery-phone") — label RIÊNG domain-separated. Thứ DUY
 * NHẤT được lưu trong AccountRecoveryRequest.phoneHash (KHÔNG bao giờ phone
 * thô — spec §4.8).
 */
export function accountRecoveryPhoneHash(normalizedPhone: string): string {
  return createHmac("sha256", hkdfKey("account-recovery-phone"))
    .update(normalizedPhone)
    .digest("hex");
}

/**
 * HMAC-SHA256 hex 64 ký tự của reset token thô qua
 * hkdfKey("account-recovery-reset-token") — label RIÊNG domain-separated.
 * Thứ DUY NHẤT được lưu trong AccountRecoveryRequest.resetTokenHash (cùng
 * pattern BetaInviteToken.tokenHash Batch 7 — token thô KHÔNG bao giờ lưu).
 */
export function accountRecoveryResetTokenHash(token: string): string {
  return createHmac("sha256", hkdfKey("account-recovery-reset-token"))
    .update(token)
    .digest("hex");
}
