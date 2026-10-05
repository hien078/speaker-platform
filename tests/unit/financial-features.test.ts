/**
 * Shared server-owned finance capability — ranh giới tắt tài chính (plan Task 2).
 *
 * Spec §4.1 (no money path), §4.10 (no finance escape hatch), §5.1:
 * - mặc định (bỏ trống) = TẮT;
 * - parse strict: chỉ literal "true" mới bật, mọi giá trị khác = false;
 * - "true" chỉ có hiệu lực NGOÀI production (private beta chạy ở production
 *   → luôn tắt, kể cả khi env set "true");
 * - malformed không bao giờ thành truthy (validateEnv báo key — xem env.test.ts);
 * - assertFinancialFeaturesEnabled() throw với mã ổn định FINANCIAL_FEATURES_DISABLED;
 * - KHÔNG biến NEXT_PUBLIC_* nào điều khiển được (client không có escape hatch).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  FINANCIAL_FEATURES_DISABLED,
  assertFinancialFeaturesEnabled,
  financialFeaturesEnabled,
} from "../../src/lib/financial-features";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("financialFeaturesEnabled — parse strict, mặc định tắt", () => {
  it("bỏ trống (omitted) → false", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
    expect(financialFeaturesEnabled()).toBe(false);
  });

  it('literal "false" → false', () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "false");
    expect(financialFeaturesEnabled()).toBe(false);
  });

  it('literal "true" → true NGOÀI production (dev/test)', () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    expect(financialFeaturesEnabled()).toBe(true);

    vi.stubEnv("NODE_ENV", "test");
    expect(financialFeaturesEnabled()).toBe(true);
  });

  it('literal "true" ở production → false (private beta: luôn tắt)', () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    expect(financialFeaturesEnabled()).toBe(false);
  });

  it("giá trị malformed → false (không bao giờ thành truthy)", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const bad of ["TRUE", "True", "yes", "1", "on", " true", "true "]) {
      vi.stubEnv("FINANCIAL_FEATURES_ENABLED", bad);
      expect(financialFeaturesEnabled()).toBe(false);
    }
  });

  it("không biến NEXT_PUBLIC_* nào điều khiển được khả năng này", () => {
    vi.stubEnv("NODE_ENV", "development");
    // biến server bỏ trống → mặc định tắt, kể cả khi client flag set "true"
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
    vi.stubEnv("NEXT_PUBLIC_FINANCIAL_FEATURES_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_FINANCIAL_FEATURES", "true");
    expect(financialFeaturesEnabled()).toBe(false);
  });
});

describe("assertFinancialFeaturesEnabled — mã lỗi ổn định", () => {
  it("throw error bắt đầu bằng mã FINANCIAL_FEATURES_DISABLED khi tắt", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
    expect(() => assertFinancialFeaturesEnabled()).toThrowError(
      new RegExp(`^${FINANCIAL_FEATURES_DISABLED}\\b`),
    );
  });

  it("không throw khi bật (dev/test)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    expect(() => assertFinancialFeaturesEnabled()).not.toThrow();
  });

  it("throw ở production kể cả khi env set literal true (beta luôn tắt)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    expect(() => assertFinancialFeaturesEnabled()).toThrowError(
      new RegExp(`^${FINANCIAL_FEATURES_DISABLED}\\b`),
    );
  });

  it("mã lỗi là literal ổn định để type-check ở nơi gọi", () => {
    expect(FINANCIAL_FEATURES_DISABLED).toBe("FINANCIAL_FEATURES_DISABLED");
  });
});
