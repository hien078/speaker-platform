import "server-only";

/**
 * Ranh giới tài chính do server sở hữu — private beta shutdown (spec §5.1).
 *
 * Mọi entry point tài chính (server action, route, webhook, cron, thư viện
 * mutation) phải gọi assertFinancialFeaturesEnabled() TRƯỚC khi đọc trạng
 * thái vận hành hoặc mutate dữ liệu (spec §4.1 "no money path": checkout,
 * payment, escrow, wallet, withdraw, payout, commission, dispute, cron…).
 *
 * Nguyên tắc (spec §4.10 — không có escape hatch):
 * - Chỉ đọc biến env server FINANCIAL_FEATURES_ENABLED. KHÔNG đọc query
 *   param, cookie, header, request body hay state client nào.
 * - Mặc định (bỏ trống) = TẮT. Private beta: PHẢI giữ "false".
 * - Parse strict: chỉ literal "true" mới bật; mọi giá trị khác (kể cả
 *   malformed như "TRUE"/"yes"/"1") = false, không bao giờ truthy.
 *   Malformed bị validateEnv (src/lib/env.ts) báo ngay khi start.
 * - Production (môi trường private beta) LUÔN tắt, kể cả khi env set
 *   "true" — validateEnv fail-fast cấu hình đó ngay khi server start;
 *   check ở đây là defense-in-depth cho mọi caller không qua validate.
 * - Không biến NEXT_PUBLIC_* nào điều khiển được (NEXT_PUBLIC_* bị inline
 *   vào bundle client — không phải ranh giới tin cậy).
 * - Đây KHÔNG phải admin toggle P0: không có surface nào (UI/query/cookie/
 *   body) được phép bật tài chính; chỉ operator đổi env server + restart.
 */
export const FINANCIAL_FEATURES_DISABLED = "FINANCIAL_FEATURES_DISABLED" as const;

/** true chỉ khi env server set đúng literal "true" NGOÀI production. */
export function financialFeaturesEnabled(): boolean {
  // Private beta chạy ở production → hard-off, bất kể giá trị env.
  if (process.env.NODE_ENV === "production") return false;
  // Strict: chỉ literal "true" (đúng ký tự, không trim) mới bật.
  return process.env.FINANCIAL_FEATURES_ENABLED === "true";
}

/**
 * Throw với mã ổn định FINANCIAL_FEATURES_DISABLED khi tài chính bị tắt.
 * Đặt ở đầu (outermost) mọi entry point tài chính, trước mọi read/mutation.
 */
export function assertFinancialFeaturesEnabled(): void {
  if (!financialFeaturesEnabled()) {
    throw new Error(
      `${FINANCIAL_FEATURES_DISABLED}: các tính năng tài chính (escrow, thanh toán, ví, rút tiền, hoa hồng) đang tắt trong private beta. ` +
        "Không có đường bật từ client/query/cookie/header — xem FINANCIAL_FEATURES_ENABLED (server-only).",
    );
  }
}
