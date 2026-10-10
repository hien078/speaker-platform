import "server-only";
import { captureEvent } from "@/src/lib/observability";
import type { OtpChannel, OtpPurpose } from "@/src/lib/otp";

/**
 * OTP delivery adapter seam (Batch 2 Task 3 — spec §5.3 "Provider integrations
 * sit behind adapters" + "Development may use a non-production testing adapter"
 * + "Production refuses to start verification delivery if required
 * real-provider configuration is invalid").
 *
 * Chọn adapter theo NODE_ENV ONLY — không env flag riêng, không input nào từ
 * client điều khiển được (cùng posture với src/lib/financial-features.ts):
 *
 * - NODE_ENV !== "production" → in-memory adapter: sendOtp lưu mã vào inbox
 *   module-level (Map theo `${channel}:${to}:${purpose}`) — KHÔNG BAO GIỜ
 *   console.log/in mã (spec §4.8 áp dụng CẢ dev/test — không có console
 *   adapter, không dev-log mã). sendSecurityNotice lưu vào inbox notice tương tự.
 * - NODE_ENV === "production" → fail-closed adapter: sendOtp throw typed
 *   OTP_DELIVERY_UNAVAILABLE (spec §5.3 production refuses delivery — cho tới
 *   khi có provider thật, xem Ambiguities A1: đó là điều kiện beta-launch,
 *   không phải lỗi batch).
 *
 * TOPOLOGY (giống src/lib/rate-limit.ts): inbox là Map module-level trong MỘT
 * process — không chia sẻ giữa nhiều instance/host, restart là mất. Đúng cho
 * deployment 1 container duy nhất; đây là adapter DEV/TEST nên chấp nhận được —
 * production không bao giờ dùng inbox này (fail-closed).
 *
 * KHÔNG log gì chứa mã/target ở mọi path (spec §4.8). sendSecurityNotice là
 * fail-open duy nhất (spec §5.3.1 "when feasible"): KHÔNG throw, log qua
 * captureEvent chỉ channel + subjectKey — không body, không target.
 */

export type OtpDeliveryParams = {
  to: string;
  code: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
};

export type SecurityNoticeParams = {
  to: string;
  channel: OtpChannel;
  subjectKey: string;
};

export interface OtpDeliveryAdapter {
  readonly name: string;
  /** Gửi mã OTP — KHÔNG log mã thô ở bất kỳ môi trường nào (spec §4.8). */
  sendOtp(params: OtpDeliveryParams): Promise<void>;
  /**
   * Thông báo bảo mật sau thay đổi nhạy cảm (spec §5.3.1 "when feasible") —
   * fail-open CÓ log: không bao giờ throw, không bao giờ log body/target.
   */
  sendSecurityNotice(params: SecurityNoticeParams): Promise<void>;
}

// ─── Typed error codes ────────────────────────────────────────────────────────

export const OTP_DELIVERY_UNAVAILABLE = "OTP_DELIVERY_UNAVAILABLE" as const;
export const DEV_OTP_INBOX_UNAVAILABLE = "DEV_OTP_INBOX_UNAVAILABLE" as const;

// ─── In-memory inbox (dev/test ONLY — xem topology note đầu file) ─────────────

/** `${channel}:${to}:${purpose}` → mã cuối cùng "gửi" cho tuple đó. */
const devOtpInbox = new Map<string, string>();
/** `${channel}:${to}` → notice cuối (không có seam đọc — chỉ để dev inspect). */
const devNoticeInbox = new Map<string, { channel: OtpChannel; subjectKey: string; at: string }>();

const otpInboxKey = (channel: OtpChannel, to: string, purpose: OtpPurpose): string =>
  `${channel}:${to}:${purpose}`;

// ─── In-memory adapter (dev/test) ─────────────────────────────────────────────

const inMemoryAdapter: OtpDeliveryAdapter = {
  name: "in-memory",
  async sendOtp({ to, code, purpose, channel }) {
    // Lưu inbox — KHÔNG log. Đây là "delivery" dev/test duy nhất: mã nằm trong
    // process, seam peekDevOtpInbox đọc ra cho test + route dev curl.
    devOtpInbox.set(otpInboxKey(channel, to, purpose), code);
  },
  async sendSecurityNotice({ to, channel, subjectKey }) {
    // Fail-open: notice không bao giờ làm hỏng flow chính. Lưu inbox tương tự
    // sendOtp + log event KHÔNG chứa target/body (spec §4.8 — không raw email/phone).
    devNoticeInbox.set(`${channel}:${to}`, { channel, subjectKey, at: new Date().toISOString() });
    captureEvent("otp-delivery", "security_notice_stored_dev_inbox", { channel, subjectKey });
  },
};

// ─── Fail-closed adapter (production) ─────────────────────────────────────────

const failClosedAdapter: OtpDeliveryAdapter = {
  name: "fail-closed",
  async sendOtp() {
    // Typed fail-closed (spec §5.3): production TỪ CHỐI delivery cho tới khi có
    // provider thật. Message nêu đủ prerequisite còn thiếu (Ambiguities A1 —
    // điều kiện beta-launch, ghi trong runbook) — và KHÔNG chứa mã thô.
    throw new Error(
      `${OTP_DELIVERY_UNAVAILABLE}: production chưa cấu hình nhà cung cấp email/SMS thật ` +
        "phía sau OtpDeliveryAdapter — cần chọn + cấu hình provider (điều kiện beta-launch, " +
        "xem Ambiguities A1 / runbook) trước khi bật gửi mã. Không có fallback in-memory ở production.",
    );
  },
  async sendSecurityNotice({ channel, subjectKey }) {
    // Fail-open (spec §5.3.1 "when feasible"): không provider → không thể gửi,
    // nhưng KHÔNG throw — flow đổi danh tính của user vẫn tiếp tục. Log KHÔNG
    // chứa target/body (spec §4.8 — không raw email/phone, không notice content).
    captureEvent("otp-delivery", "security_notice_undelivered", { channel, subjectKey });
  },
};

// ─── Selection + seam ──────────────────────────────────────────────────────────

/**
 * Adapter hiện tại — chọn theo NODE_ENV tại CALL time (không phải load time,
 * để test stub được). KHÔNG có env flag riêng: không surface nào (UI/query/
 * cookie/header) đổi được adapter production.
 */
export function getOtpDeliveryAdapter(): OtpDeliveryAdapter {
  return process.env.NODE_ENV === "production" ? failClosedAdapter : inMemoryAdapter;
}

/**
 * Seam truy xuất dev/test: trả mã CUỐI cho (channel,target,purpose) từ inbox
 * in-memory. Production → throw typed DEV_OTP_INBOX_UNAVAILABLE — seam
 * unreachable by construction (route dev trả 404 TRƯỚC khi gọi hàm này).
 * KHÔNG log.
 */
export function peekDevOtpInbox(
  target: string,
  purpose: OtpPurpose,
  channel: OtpChannel,
): string | null {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${DEV_OTP_INBOX_UNAVAILABLE}: dev OTP inbox không tồn tại ở production — ` +
        "seam chỉ dành cho dev/test (NODE_ENV !== \"production\").",
    );
  }
  return devOtpInbox.get(otpInboxKey(channel, target, purpose)) ?? null;
}
