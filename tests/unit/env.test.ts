/**
 * Production env validation — fail-fast, chỉ báo tên key, không in secret.
 * Yêu cầu (docs/deployment.md §8):
 * - production thiếu key bắt buộc → validateEnv báo đúng tên key
 * - giá trị SAI (URL không hợp lệ, secret quá ngắn) → báo key + lý do
 * - MoMo nửa vời → báo key thiếu trong bộ 3
 * - thông báo KHÔNG chứa giá trị env
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { formatEnvIssues, validateEnv } from "../../src/lib/env";

/** Env "đầy đủ hợp lệ" làm baseline — mỗi case override 1 thứ */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    AUTH_SECRET: "a".repeat(64),
    NEXT_PUBLIC_APP_URL: "https://loaviet.vn",
    CRON_SECRET: "b".repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("validateEnv — production", () => {
  it("pass khi đầy đủ + hợp lệ", () => {
    expect(validateEnv(baseEnv())).toEqual({ ok: true, issues: [] });
  });

  it("báo đúng TÊN key thiếu — không in giá trị", () => {
    const result = validateEnv(baseEnv({ CRON_SECRET: undefined }));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { key: "CRON_SECRET", problem: "thiếu (chưa đặt trong .env)" },
    ]);
  });

  it("báo nhiều key thiếu cùng lúc", () => {
    const result = validateEnv(
      baseEnv({ DATABASE_URL: undefined, AUTH_SECRET: undefined, CRON_SECRET: "" }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.key)).toEqual([
      "DATABASE_URL",
      "AUTH_SECRET",
      "CRON_SECRET",
    ]);
  });

  it("DATABASE_URL không phải postgres URL → báo key + lý do", () => {
    const result = validateEnv(baseEnv({ DATABASE_URL: "mysql://x/y" }));
    expect(result.issues).toContainEqual({
      key: "DATABASE_URL",
      problem: "phải là URL postgresql:// (Prisma 8 postgres façade)",
    });
  });

  it("AUTH_SECRET quá ngắn → báo key (không in secret)", () => {
    const result = validateEnv(baseEnv({ AUTH_SECRET: "short" }));
    expect(result.issues).toContainEqual({
      key: "AUTH_SECRET",
      problem: "quá ngắn — sinh bằng: openssl rand -hex 32 (≥ 32 ký tự)",
    });
    // thông báo không chứa giá trị secret
    expect(JSON.stringify(result.issues)).not.toContain('"short"');
  });

  it("NEXT_PUBLIC_APP_URL không phải URL → báo key", () => {
    const result = validateEnv(baseEnv({ NEXT_PUBLIC_APP_URL: "khong-phai-url" }));
    expect(result.issues.map((i) => i.key)).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("CRON_SECRET quá ngắn ở production → báo key", () => {
    const result = validateEnv(baseEnv({ CRON_SECRET: "abc" }));
    expect(result.issues.map((i) => i.key)).toContain("CRON_SECRET");
  });
});

describe("validateEnv — dev/test khoan dung", () => {
  it("dev thiếu CRON_SECRET/NEXT_PUBLIC_APP_URL → vẫn OK (chỉ production mới bắt buộc)", () => {
    const result = validateEnv(
      baseEnv({ NODE_ENV: "development", CRON_SECRET: undefined, NEXT_PUBLIC_APP_URL: undefined }),
    );
    expect(result.ok).toBe(true);
  });

  it("dev nhưng DATABASE_URL/AUTH_SECRET thiếu vẫn phải báo", () => {
    const result = validateEnv(
      baseEnv({ NODE_ENV: "development", DATABASE_URL: undefined, AUTH_SECRET: undefined }),
    );
    expect(result.issues.map((i) => i.key)).toEqual(["DATABASE_URL", "AUTH_SECRET"]);
  });
});

describe("validateEnv — key tuỳ chọn có set thì phải hợp lệ", () => {
  it("TRUST_PROXY_HEADERS giá trị lạ → báo key", () => {
    const result = validateEnv(baseEnv({ TRUST_PROXY_HEADERS: "yes" }));
    expect(result.issues).toContainEqual({
      key: "TRUST_PROXY_HEADERS",
      problem: 'chỉ nhận "true" | "false"',
    });
  });

  it("TRUST_PROXY_HEADERS=true/false hợp lệ", () => {
    expect(validateEnv(baseEnv({ TRUST_PROXY_HEADERS: "true" })).ok).toBe(true);
    expect(validateEnv(baseEnv({ TRUST_PROXY_HEADERS: "false" })).ok).toBe(true);
  });

  it("ESCROW_AUTO_RELEASE_DAYS=0 / 31 / lẻ → báo key", () => {
    for (const bad of ["0", "31", "7.5", "abc"]) {
      const result = validateEnv(baseEnv({ ESCROW_AUTO_RELEASE_DAYS: bad }));
      expect(result.issues.map((i) => i.key)).toContain("ESCROW_AUTO_RELEASE_DAYS");
    }
    expect(validateEnv(baseEnv({ ESCROW_AUTO_RELEASE_DAYS: "14" })).ok).toBe(true);
  });
});

describe("validateEnv — FINANCIAL_FEATURES_ENABLED (ranh giới tài chính private beta)", () => {
  it("bỏ trống → OK (mặc định false — private beta tắt tài chính)", () => {
    expect(validateEnv(baseEnv({ FINANCIAL_FEATURES_ENABLED: undefined })).ok).toBe(true);
  });

  it('literal "false" → OK', () => {
    expect(validateEnv(baseEnv({ FINANCIAL_FEATURES_ENABLED: "false" })).ok).toBe(true);
  });

  it('literal "true" NGOÀI production → OK (chỉ dev/test chạy thuật toán legacy)', () => {
    expect(
      validateEnv(baseEnv({ NODE_ENV: "development", FINANCIAL_FEATURES_ENABLED: "true" })).ok,
    ).toBe(true);
    expect(
      validateEnv(baseEnv({ NODE_ENV: "test", FINANCIAL_FEATURES_ENABLED: "true" })).ok,
    ).toBe(true);
  });

  it('literal "true" ở production → báo key (private beta phải giữ false)', () => {
    const result = validateEnv(baseEnv({ FINANCIAL_FEATURES_ENABLED: "true" }));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        key: "FINANCIAL_FEATURES_ENABLED",
        problem:
          'private beta: phải là "false" ở production — nền tảng không giữ tiền trong giai đoạn beta',
      },
    ]);
  });

  it("giá trị malformed → báo key (strict, không bao giờ thành truthy)", () => {
    for (const bad of ["TRUE", "True", "yes", "1", " true", "true "]) {
      const result = validateEnv(baseEnv({ FINANCIAL_FEATURES_ENABLED: bad }));
      expect(result.issues).toContainEqual({
        key: "FINANCIAL_FEATURES_ENABLED",
        problem: 'chỉ nhận "true" | "false" (bỏ trống = false)',
      });
    }
  });
});

describe("validateEnv — MoMo nửa vời", () => {
  it("thiếu 1 trong 3 key MoMo → báo đủ các key còn thiếu", () => {
    const result = validateEnv(
      baseEnv({ MOMO_PARTNER_CODE: "MOMO", MOMO_ACCESS_KEY: "ak" /* thiếu SECRET_KEY */ }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.key)).toEqual(["MOMO_SECRET_KEY"]);
  });

  it("bỏ trống cả 3 key MoMo → OK (MoMo là tuỳ chọn, thiếu thì createMomoPayment fail loud)", () => {
    expect(validateEnv(baseEnv()).ok).toBe(true);
  });

  it("đủ 3 key MoMo → OK", () => {
    const result = validateEnv(
      baseEnv({
        MOMO_PARTNER_CODE: "MOMO",
        MOMO_ACCESS_KEY: "ak",
        MOMO_SECRET_KEY: "sk",
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("formatEnvIssues — không leak giá trị", () => {
  it("output chỉ chứa tên key + lý do, không chứa giá trị env", () => {
    const secretValue = "super-secret-value-should-not-appear";
    const result = validateEnv(baseEnv({ AUTH_SECRET: "x" }));
    expect(result.ok).toBe(false);
    const text = formatEnvIssues(result.issues);
    expect(text).toContain("AUTH_SECRET");
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain('"x"');
  });
});
