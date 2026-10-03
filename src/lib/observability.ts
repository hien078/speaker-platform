import "server-only";

/**
 * Seam báo lỗi/log vendor-neutral — MỘT chỗ để đổi backend sau này.
 *
 * Hiện tại: ghi 1 dòng JSON có cấu trúc ra stderr (docker compose logs
 * đọc được, grep được theo scope). Không phụ thuộc tài khoản ngoài.
 *
 * Cổng tích hợp ngoài (Sentry/GlitchTip/OTel): thay phần thân
 * captureError bằng client tương ứng — chữ ký không đổi, các call-site
 * (cron, upload, payment, rate-limit) không phải sửa. Quyết định gắn
 * nhà cung cấp nào là lựa chọn deploy-time, không hardcode ở đây.
 */
export function captureError(
  scope: string,
  error: unknown,
  meta?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: "error",
    scope,
    error: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof Error && error.stack) line.stack = error.stack;
  if (meta) Object.assign(line, meta);
  console.error(JSON.stringify(line));
}

/** Log sự kiện có cấu trúc (không phải lỗi) — cùng seam, level info */
export function captureEvent(
  scope: string,
  event: string,
  meta?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: "info",
    scope,
    event,
  };
  if (meta) Object.assign(line, meta);
  console.log(JSON.stringify(line));
}
