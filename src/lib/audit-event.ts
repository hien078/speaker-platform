import "server-only";
import { createHmac } from "node:crypto";
import { db } from "@/src/prisma/db.client";
import { hkdfKey } from "@/src/lib/otp";
import { clientIpFromHeaders } from "@/src/lib/rate-limit";

/**
 * Audit event foundation (Batch 2 Task 5 — spec §4.6 Auditability).
 *
 * Mọi action privileged/security-sensitive ghi AuditEvent: actor, action,
 * resource, reason, timestamp (createdAt default), request/security context
 * (ipHash + sessionId), policy version nơi phù hợp.
 *
 * Action-name registry (dot-namespaced — dùng chung Tasks 6–11, KHÔNG tự chế tên):
 *   user.email_verified, user.phone_verified, user.password_changed,
 *   user.email_changed, user.phone_changed, user.recovery_requested,
 *   user.recovery_completed, session.revoked, session.revoked_all,
 *   admin.mfa_enrolled, admin.mfa_reset, admin.mfa_recovery_code_used,
 *   admin.step_up, admin.role_set, seller_profile.declared,
 *   seller_verification.submitted, seller_verification.reviewed,
 *   seller_verification.backfill, beta_cohort.membership_set,
 *   listing.approved, listing.rejected, listing.approve_blocked.
 *   (review fix Task 8): admin.login — login admin thành công sau MFA
 *   (reason = factor "totp"|"recovery_code"); admin.mfa_failed — lần sai mã
 *   MFA ở login/step-up (reason typed theo surface, KHÔNG chứa mã thô).
 *   (Task 9): admin.mfa_recovery_codes_regenerated — admin tự sinh lại 10 mã
 *   khôi phục của chính mình sau khi verify mã MFA (reason = factor
 *   "totp"|"recovery_code", detail count — KHÔNG chứa mã thô); ghi qua
 *   auditEventTx TRONG cùng transaction xoá/tạo mã (audit fail → rollback).
 *   (Task 10 review fix M2): seller_verification.declaration_changed — seller
 *   đổi khai báo (sellerType/tỉnh) khi verification đã verified → row chuyển
 *   needs_review (CAS) + audit trong cùng tx (reason typed
 *   identity_information_inconsistent, detail decision=needs_review).
 *
 * QUY TẮC PII (spec §4.8 — enforced bằng review + Task 12 scan):
 * `detail` KHÔNG bao giờ chứa email/phone thô, mã OTP, password, hay
 * authentication secret — caller chịu trách nhiệm từ đầu. `redactDetail` là
 * belt-and-braces cho caller (mask email/phone/OTP-shape); auditEvent lưu
 * detail VERBATIM — không auto-redact (caller quyết định nội dung, helper
 * chỉ là công cụ phòng xa).
 *
 * ipHash: HMAC-SHA256(ip, hkdfKey("ip-hash")) — keyed hash từ AUTH_SECRET
 * (cùng helper HKDF với OTP hash — Task 3), KHÔNG bao giờ lưu IP thô
 * (spec §4.8). Không có request context (offline script / cron) → null —
 * event VẪN ĐƯỢC GHI (không mất audit vì thiếu request).
 *
 * Fail-open có ý thức: lỗi ghi audit KHÔNG làm fail hành động chính ở
 * auditEvent — caller quyết định await hay fire-and-forget; caller muốn
 * atomic thì dùng auditEventTx trong cùng transaction.
 */

export type AuditEventInput = {
  /** null = system/offline script. */
  actorId?: string | null;
  subjectId?: string | null;
  /** dot-namespaced — xem registry ở đầu module. */
  action: string;
  resourceType?: string;
  resourceId?: string;
  /** typed reason code — không prose tự chế. */
  reason?: string;
  policyVersion?: string;
  sessionId?: string;
  /** KHÔNG chứa PII thô/OTP/secret (spec §4.8) — xem redactDetail. */
  detail?: string;
};

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** IP client → HMAC hex — KHÔNG bao giờ IP thô (spec §4.8). */
async function currentIpHash(): Promise<string | null> {
  try {
    // Dynamic import: offline script (tsx, không Next runtime) import được
    // module này mà không cần request context — headers() throw → catch → null.
    const { headers } = await import("next/headers");
    const h = await headers();
    const ip = clientIpFromHeaders(h);
    return createHmac("sha256", hkdfKey("ip-hash")).update(ip).digest("hex");
  } catch {
    return null; // offline script / không có request context
  }
}

/** Input → row đầy đủ (null rõ ràng, không để undefined lọt vào DB). */
function toRow(input: AuditEventInput, ipHash: string | null) {
  return {
    actorId: input.actorId ?? null,
    subjectId: input.subjectId ?? null,
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    reason: input.reason ?? null,
    policyVersion: input.policyVersion ?? null,
    sessionId: input.sessionId ?? null,
    detail: input.detail ?? null,
    ipHash,
  };
}

/** Ghi audit event (ngoài transaction — không chặn hành động chính). */
export async function auditEvent(input: AuditEventInput): Promise<void> {
  await db.orm.public.AuditEvent.create(toRow(input, await currentIpHash()));
}

/** Ghi audit event BÊN TRONG transaction truyền vào — sống chết cùng tx chính. */
export async function auditEventTx(tx: TxContext, input: AuditEventInput): Promise<void> {
  await tx.orm.public.AuditEvent.create(toRow(input, await currentIpHash()));
}

// ─── Belt-and-braces cho caller (spec §4.8) ───────────────────────────────────

/** Email thô — local@domain có dot trong domain. */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Phone VN compact: 0xxxxxxxxx | 0xxxxxxxxxx | +84xxxxxxxxx. */
const PHONE_VN_RE = /(?:\+84|0)\d{8,10}/g;
/** Chuỗi 6 chữ số đứng riêng — hình mã OTP (mask thừa an toàn hơn thiếu). */
const OTP_RE = /\b\d{6}\b/g;

/**
 * Mask email/phone/OTP-shape trong chuỗi detail — belt-and-braces cho caller
 * (quy ước PII do review + Task 12 scan enforce, không phải helper này).
 *
 * Over-redaction là hướng an toàn: chuỗi 6 chữ số khác (vd. đoạn mã đơn
 * SP-260101) cũng bị mask — chấp nhận, vì detail không được phép là nơi
 * giữ bí mật; mất đọc được của một đoạn text vẫn an toàn hơn lộ OTP.
 */
export function redactDetail(value: string): string {
  return value
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(PHONE_VN_RE, "[REDACTED_PHONE]")
    .replace(OTP_RE, "[REDACTED_OTP]");
}
