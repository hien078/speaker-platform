/**
 * MoMo Payment Gateway v2 — unit tests.
 * Yêu cầu: không fallback credential hardcode; fail loud khi chưa cấu hình;
 * verify chữ ký callback đúng theo tài liệu MoMo v2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

import {
  buildCallbackRawSignature,
  createMomoPayment,
  momoConfig,
  verifyMomoCallback,
  type MomoCallbackBody,
} from "../../src/lib/momo";

const TEST_ACCESS_KEY = "unit-test-access-key";
const TEST_SECRET_KEY = "unit-test-secret-key";

function signBody(
  body: MomoCallbackBody,
  accessKey: string,
  secretKey: string,
): string {
  return createHmac("sha256", secretKey)
    .update(buildCallbackRawSignature(body, accessKey))
    .digest("hex");
}

const validBody: MomoCallbackBody = {
  partnerCode: "MOMO",
  orderId: "ORDER-00000000-0000-0000-0000-000000000000",
  requestId: "REQ-1",
  amount: 150000,
  transId: 999,
  resultCode: 0,
  message: "Successful",
  payType: "creditCard",
  responseTime: 1700000000000,
  extraData: "",
  orderInfo: "LoaViet escrow",
};

beforeEach(() => {
  // Bật tài chính NGÔI LẬP cho bộ legacy (plan Task 3): createMomoPayment có
  // defense-in-depth assert — hành vi tắt mặc định được test riêng ở
  // tests/unit/financial-shutdown-routes.test.ts + financial-shutdown-actions.test.ts
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
  vi.stubEnv("MOMO_PARTNER_CODE", "MOMO");
  vi.stubEnv("MOMO_ACCESS_KEY", TEST_ACCESS_KEY);
  vi.stubEnv("MOMO_SECRET_KEY", TEST_SECRET_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("momoConfig", () => {
  it("đọc credentials từ env", () => {
    expect(momoConfig()).toMatchObject({
      partnerCode: "MOMO",
      accessKey: TEST_ACCESS_KEY,
      secretKey: TEST_SECRET_KEY,
    });
  });

  it("KHÔNG fallback sang credential test hardcode khi env trống", () => {
    delete process.env.MOMO_PARTNER_CODE;
    delete process.env.MOMO_ACCESS_KEY;
    delete process.env.MOMO_SECRET_KEY;
    const cfg = momoConfig();
    expect(cfg.partnerCode).toBeUndefined();
    expect(cfg.accessKey).toBeUndefined();
    expect(cfg.secretKey).toBeUndefined();
  });
});

describe("createMomoPayment", () => {
  it("fail loud (MOMO_NOT_CONFIGURED) khi chưa cấu hình — không gọi cổng", async () => {
    delete process.env.MOMO_PARTNER_CODE;
    delete process.env.MOMO_ACCESS_KEY;
    delete process.env.MOMO_SECRET_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createMomoPayment({
        orderId: "ORDER-1",
        amount: 100000,
        orderInfo: "test",
        redirectUrl: "http://localhost:3000/payments/momo/return",
        ipnUrl: "http://localhost:3000/api/payments/momo/ipn",
      }),
    ).rejects.toThrowError(/MOMO_NOT_CONFIGURED/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verifyMomoCallback", () => {
  it("chấp nhận callback ký đúng", () => {
    const body: MomoCallbackBody = {
      ...validBody,
      signature: signBody(validBody, TEST_ACCESS_KEY, TEST_SECRET_KEY),
    };
    expect(verifyMomoCallback(body)).toBe(true);
  });

  it("từ chối callback bị sửa tiền (amount mismatch)", () => {
    const signature = signBody(validBody, TEST_ACCESS_KEY, TEST_SECRET_KEY);
    const tampered: MomoCallbackBody = { ...validBody, amount: 1, signature };
    expect(verifyMomoCallback(tampered)).toBe(false);
  });

  it("từ chối callback thiếu chữ ký", () => {
    // validBody không có trường signature → verify phải từ chối
    expect(verifyMomoCallback(validBody)).toBe(false);
  });

  it("từ chối mọi callback khi MoMo chưa cấu hình — không verify bằng credential fallback", () => {
    delete process.env.MOMO_PARTNER_CODE;
    delete process.env.MOMO_ACCESS_KEY;
    delete process.env.MOMO_SECRET_KEY;
    const body: MomoCallbackBody = { ...validBody, signature: "deadbeef" };
    expect(verifyMomoCallback(body)).toBe(false);
  });

  it("từ chối signature rác (không hex) — không throw, timing-safe path an toàn", () => {
    const body: MomoCallbackBody = { ...validBody, signature: "zzzz-not-hex!!" };
    expect(verifyMomoCallback(body)).toBe(false);
  });

  it("từ chối signature đúng dạng nhưng sai độ dài", () => {
    const body: MomoCallbackBody = { ...validBody, signature: "abc123" };
    expect(verifyMomoCallback(body)).toBe(false);
  });

  it("chấp nhận signature hex uppercase (MoMo gửi lowercase — hex parse không phân biệt hoa)", () => {
    const signature = signBody(validBody, TEST_ACCESS_KEY, TEST_SECRET_KEY).toUpperCase();
    expect(verifyMomoCallback({ ...validBody, signature })).toBe(true);
  });
});
