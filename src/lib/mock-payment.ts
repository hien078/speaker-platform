import "server-only";

/**
 * Guard cho các server action "mock payment" (mô phỏng cổng trả về thành công).
 *
 * Tiền thật không bao giờ được "mô phỏng": ở production mọi luồng thanh toán
 * phải đi qua cổng thật (MoMo) với chữ ký IPN được verify. Next.js docs
 * (server-actions): mọi server action là entry point công khai — render-time
 * gating (ẩn nút trong UI) KHÔNG phải ranh giới bảo mật, nên guard phải nằm
 * ở server, đầu tiên trong action.
 */
export function assertMockPaymentsAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MOCK_PAYMENT_DISABLED_IN_PRODUCTION: mock payment actions are dev/test only. " +
        "Configure MoMo (MOMO_PARTNER_CODE, MOMO_ACCESS_KEY, MOMO_SECRET_KEY) and pay via the real gateway.",
    );
  }
}
