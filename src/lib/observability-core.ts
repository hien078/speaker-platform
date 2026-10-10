/**
 * Seam báo lỗi/log vendor-neutral — THÂN THẬT của captureError/captureEvent
 * (Batch 2 Task 11 tách từ src/lib/observability.ts).
 *
 * Plain module (KHÔNG "server-only"): src/lib/admin-mfa.ts (enrollAdminMfa/
 * verifyAdminMfaCode — import được từ offline bootstrap script Task 11) cần
 * captureError ở path giải mã sai key; observability.ts giữ "server-only" làm
 * mặt public cho app (chống import nhầm vào client component) và re-export
 * từ đây. Hành vi GIỮ NGUYÊN — chỉ chuyển chỗ ở.
 *
 * Hiện tại: ghi 1 dòng JSON có cấu trúc ra stderr (docker compose logs đọc
 * được, grep được theo scope). Không phụ thuộc tài khoản ngoài.
 *
 * Cổng tích hợp ngoài (Sentry/GlitchTip/OTel): thay phần thân captureError —
 * chữ ký không đổi, các call-site không phải sửa. Quyết định gắn nhà cung cấp
 * nào là lựa chọn deploy-time, không hardcode ở đây.
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
