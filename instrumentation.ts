/**
 * Next.js instrumentation — chạy MỘT lần khi server instance khởi tạo,
 * trước khi nhận request đầu tiên (docs: file-conventions/instrumentation).
 *
 * Việc duy nhất ở đây: validate production env FAIL-FAST.
 * Thiếu/sai key ở production → exit(1) ngay, server không bao giờ serve
 * request với cấu hình thiếu (ví dụ CRON_SECRET trống = endpoint cron
 * fail closed, nhưng AUTH_SECRET trống sẽ tạo session JWT rỗng).
 * Chỉ tên key được in ra — không bao giờ in giá trị (secret).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // chỉ chạy ở Node runtime

  const { validateEnv, formatEnvIssues } = await import("@/src/lib/env");
  const result = validateEnv(process.env);
  if (result.ok) return;

  const isProd = process.env.NODE_ENV === "production";
  const lines = [
    `ENV_VALIDATION_FAILED (${result.issues.length} issue):`,
    formatEnvIssues(result.issues),
  ].join("\n");

  if (isProd) {
    // Fail-fast: production không được phép start với env thiếu/sai
    console.error(lines);
    process.exit(1);
  }
  // Dev/test: cảnh báo nhưng không chặn (thiếu key khi dev là bình thường)
  console.warn(lines);
}
