/**
 * Guard cho các server action "mock payment".
 * Next.js 16 docs: mọi server action là entry point công khai —
 * render-time gating (ẩn nút trong UI) KHÔNG phải ranh giới bảo mật.
 * Ở production, mock payment phải fail loud.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertMockPaymentsAllowed } from "../../src/lib/mock-payment";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertMockPaymentsAllowed", () => {
  it("không throw ngoài production (development / test)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertMockPaymentsAllowed()).not.toThrow();
    vi.stubEnv("NODE_ENV", "test");
    expect(() => assertMockPaymentsAllowed()).not.toThrow();
  });

  it("throw ở production — mock payment không bao giờ được chạy với tiền thật", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertMockPaymentsAllowed()).toThrowError(
      /MOCK_PAYMENT_DISABLED_IN_PRODUCTION/,
    );
  });
});
