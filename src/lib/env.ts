import "server-only";

/**
 * Production env validation — fail-fast khi server start (gọi từ instrumentation.ts).
 *
 * Nguyên tắc:
 * - Chỉ báo TÊN key thiếu/sai + lý do — KHÔNG bao giờ in giá trị (secret).
 * - Fail-fast: production thiếu/sai key → process.exit(1) ngay tại register(),
 *   trước khi nhận request đầu tiên. Không biến lỗi thành cảnh báo ở production.
 * - Dev/test: cùng bộ check nhưng chỉ warn (thiếu key khi dev là bình thường).
 */

export type EnvIssue = { key: string; problem: string };

export type EnvValidationResult =
  | { ok: true; issues: never[] }
  | { ok: false; issues: EnvIssue[] };

/** Các key bắt buộc ở production */
const REQUIRED_KEYS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "CRON_SECRET",
] as const;

const isProduction = (env: NodeJS.ProcessEnv): boolean =>
  env.NODE_ENV === "production";

/**
 * Validate env — thuần, không throw, không in giá trị.
 * Trả về danh sách issue (tên key + lý do) để caller quyết định exit hay warn.
 */
export function validateEnv(env: NodeJS.ProcessEnv): EnvValidationResult {
  const issues: EnvIssue[] = [];
  const reported = new Set<string>();
  const prod = isProduction(env);

  const requireKey = (key: string, test?: (v: string) => boolean, problem?: string) => {
    if (reported.has(key)) return; // một key chỉ báo 1 lần (lý do đầu tiên)
    const v = env[key];
    if (v === undefined || v === "") {
      issues.push({ key, problem: "thiếu (chưa đặt trong .env)" });
      reported.add(key);
      return;
    }
    if (test && !test(v)) {
      issues.push({ key, problem: problem ?? "giá trị không hợp lệ" });
      reported.add(key);
    }
  };

  // ─── Bắt buộc mọi môi trường chạy server ───
  requireKey(
    "DATABASE_URL",
    (v) => v.startsWith("postgresql://") || v.startsWith("postgres://"),
    "phải là URL postgresql:// (Prisma 8 postgres façade)",
  );
  requireKey(
    "AUTH_SECRET",
    (v) => v.length >= 32,
    "quá ngắn — sinh bằng: openssl rand -hex 32 (≥ 32 ký tự)",
  );

  // ─── Chỉ enforce đầy đủ ở production (dev có thể chưa cần cron/MoMo) ───
  if (prod) {
    for (const key of REQUIRED_KEYS) {
      if (key === "DATABASE_URL" || key === "AUTH_SECRET") continue; // đã check
      requireKey(key);
    }
    requireKey(
      "NEXT_PUBLIC_APP_URL",
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === "https:" || u.protocol === "http:";
        } catch {
          return false;
        }
      },
      "phải là URL http(s) hợp lệ — MoMo redirect/IPN cần URL công khai",
    );
    requireKey(
      "CRON_SECRET",
      (v) => v.length >= 16,
      "quá ngắn — sinh bằng: openssl rand -hex 32",
    );
  }

  // ─── Có set thì phải hợp lệ (mọi môi trường) ───
  const trust = env.TRUST_PROXY_HEADERS;
  if (trust !== undefined && trust !== "" && trust !== "true" && trust !== "false") {
    issues.push({ key: "TRUST_PROXY_HEADERS", problem: 'chỉ nhận "true" | "false"' });
  }

  const days = env.ESCROW_AUTO_RELEASE_DAYS;
  if (days !== undefined && days !== "") {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      issues.push({ key: "ESCROW_AUTO_RELEASE_DAYS", problem: "phải là số nguyên 1–30 (ngày)" });
    }
  }

  // ─── Finance capability (private beta shutdown) ───
  // FINANCIAL_FEATURES_ENABLED: server-only, mặc định/bỏ trống = false.
  // Strict: chỉ literal "true" | "false" — malformed fail validation,
  // không bao giờ thành truthy (xem src/lib/financial-features.ts).
  // Production (môi trường private beta) phải "false": nền tảng không
  // giữ tiền trong giai đoạn beta → set "true" là lỗi cấu hình fail-fast.
  const finance = env.FINANCIAL_FEATURES_ENABLED;
  if (finance !== undefined && finance !== "") {
    if (finance !== "true" && finance !== "false") {
      issues.push({
        key: "FINANCIAL_FEATURES_ENABLED",
        problem: 'chỉ nhận "true" | "false" (bỏ trống = false)',
      });
    } else if (prod && finance === "true") {
      issues.push({
        key: "FINANCIAL_FEATURES_ENABLED",
        problem:
          'private beta: phải là "false" ở production — nền tảng không giữ tiền trong giai đoạn beta',
      });
    }
  }

  // ─── MoMo: cấu hình "nửa vời" là sai — hoặc đủ 3 key hoặc không key nào ───
  const momoKeys = ["MOMO_PARTNER_CODE", "MOMO_ACCESS_KEY", "MOMO_SECRET_KEY"] as const;
  const setCount = momoKeys.filter((k) => env[k] !== undefined && env[k] !== "").length;
  if (setCount > 0 && setCount < momoKeys.length) {
    for (const k of momoKeys) {
      if (env[k] === undefined || env[k] === "") {
        issues.push({
          key: k,
          problem: "MoMo cấu hình nửa vời — đủ 3 key (PARTNER_CODE, ACCESS_KEY, SECRET_KEY) hoặc bỏ trống hết",
        });
      }
    }
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

/** In issues ra stderr — chỉ tên key + lý do, không in giá trị. */
export function formatEnvIssues(issues: EnvIssue[]): string {
  return issues.map((i) => `  ✗ ${i.key}: ${i.problem}`).join("\n");
}
