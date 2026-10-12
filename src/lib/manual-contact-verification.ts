import { createHmac } from "node:crypto";

import { hkdfKey } from "@/src/lib/hkdf";

/**
 * Manual contact verification — vocabulary + helpers thuần (zero-cost launch
 * Task A, founder 2026-10-12: FD-R1/FD-R29 — chưa có paid OTP provider;
 * two-person manual contact verification thay block psql runbook §6).
 *
 * Plain module (KHÔNG "server-only" — pattern founding-seller-vocab.ts):
 * client component import được labels/caps; hash helper chỉ gọi server-side
 * (action) — hkdfKey đọc AUTH_SECRET lúc CALL, không phải import time.
 *
 * PROVISIONAL (FD-3): mọi nhãn/tunable dưới đây là vocabulary cơ học —
 * founder review qua Batch 8 register (zero-cost launch Task A note).
 *
 * Two-person rule (enforce ở action, KHÔNG ở đây):
 *  - admin A (super/ops, contact.verify_manual + step-up) mở request sau khi
 *    liên hệ out-of-band (gọi điện/gặp mặt/video) với chủ tài khoản;
 *  - admin B (≠ A, ≠ subject) approve/reject sau khi tự xác nhận;
 *  - KHÔNG bao giờ một admin tự mở + tự duyệt liên hệ của chính mình.
 *
 * targetHash: HMAC-SHA256 hex của giá trị ĐÃ CHUẨN HÓA
 * (normalizeEmail/normalizePhone của Batch 2) qua hkdfKey với label RIÊNG
 * "manual-contact-target" — domain-separated khỏi otp-hash/beta-invite-hash/
 * ip-hash. KHÔNG BAO GIỜ lưu giá trị thô (spec §4.8); decide so lại hash của
 * giá trị HIỆN TẠI — đổi giữa request/decide → CONTACT_CHANGED (refuse).
 */

// ─── Caps + tunables (PROVISIONAL — FD-3) ────────────────────────────────────

/** Note ≤ 1000 ký tự — validate ở action (form maxLength chỉ convenience). */
export const MANUAL_CONTACT_NOTE_MAX_LENGTH = 1_000;

/**
 * Request hết hạn sau 24h (requestedAt + TTL → expiresAt). KHÔNG cron —
 * read-path coi row requested quá expiresAt là expired (cùng triết lý
 * OtpCode Batch 2: TTL tính lúc đọc).
 */
export const MANUAL_CONTACT_REQUEST_TTL_HOURS = 24;

/**
 * Rate limit MỘT bucket dùng chung request/decide/cancel — per ADMIN
 * (§7.1): 20 thao tác / giờ / admin. PROVISIONAL (P5 precedent
 * FOUNDING_SELLER_INVITE_RATE). Hữu hạn (window trượt) — không khóa vĩnh viễn.
 */
export const MANUAL_CONTACT_ACTION_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;

// ─── Enums (mirror contract.prisma — manual_contact_*) ───────────────────────

export const MANUAL_CONTACT_CHANNELS = ["email", "phone"] as const;
export type ManualContactChannel = (typeof MANUAL_CONTACT_CHANNELS)[number];

export const MANUAL_CONTACT_METHODS = [
  "phone_call",
  "in_person",
  "video_call",
  "other",
] as const;
export type ManualContactMethod = (typeof MANUAL_CONTACT_METHODS)[number];

// ─── Labels tiếng Việt (PROVISIONAL — FD-3, mechanics only §4.2) ─────────────

/** Nhãn kênh — console hiển thị (PROVISIONAL FD-3). */
export const MANUAL_CONTACT_CHANNEL_LABELS: Record<ManualContactChannel, string> = {
  email: "Email",
  phone: "Số điện thoại",
};

/** Nhãn cách xác nhận out-of-band (PROVISIONAL FD-3). */
export const MANUAL_CONTACT_METHOD_LABELS: Record<ManualContactMethod, string> = {
  phone_call: "Gọi điện",
  in_person: "Gặp trực tiếp",
  video_call: "Gọi video",
  other: "Khác",
};

// ─── Hash helper (server-side call only) ──────────────────────────────────────

/**
 * HMAC-SHA256 hex 64 ký tự của giá trị ĐÃ CHUẨN HÓA qua
 * hkdfKey("manual-contact-target") — label RIÊNG domain-separated.
 * Thứ DUY NHẤT được lưu trong ManualContactVerification.targetHash
 * (cùng pattern OtpCode.codeHash Batch 2 / BetaInviteToken.tokenHash Batch 7).
 */
export function manualContactTargetHash(normalizedValue: string): string {
  return createHmac("sha256", hkdfKey("manual-contact-target"))
    .update(normalizedValue)
    .digest("hex");
}
