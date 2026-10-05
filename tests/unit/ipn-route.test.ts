/**
 * POST /api/payments/momo/ipn — hardening route handler.
 * Test các path KHÔNG đụng DB (400/401 xảy ra trước mọi query):
 * - body không phải JSON → 400 (không để throw thành 500 unhandled)
 * - chữ ký sai / thiếu → 401
 * - chưa cấu hình MoMo → 401 (fail closed, không verify bằng credential fallback)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

import { POST } from "../../app/api/payments/momo/ipn/route";
import { buildCallbackRawSignature, type MomoCallbackBody } from "../../src/lib/momo";

const TEST_ACCESS_KEY = "ipn-test-access-key";
const TEST_SECRET_KEY = "ipn-test-secret-key";

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

function sign(body: MomoCallbackBody, accessKey: string, secretKey: string): string {
  return createHmac("sha256", secretKey)
    .update(buildCallbackRawSignature(body, accessKey))
    .digest("hex");
}

function ipnRequest(payload: unknown): Request {
  return new Request("http://localhost/api/payments/momo/ipn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.stubEnv("MOMO_PARTNER_CODE", "MOMO");
  vi.stubEnv("MOMO_ACCESS_KEY", TEST_ACCESS_KEY);
  vi.stubEnv("MOMO_SECRET_KEY", TEST_SECRET_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/payments/momo/ipn", () => {
  it("body không phải JSON → 400 (không thành 500 unhandled)", async () => {
    const res = await POST(ipnRequest("not-json{{{"));
    expect(res.status).toBe(400);
  });

  it("body là JSON array → 400", async () => {
    const res = await POST(ipnRequest([1, 2, 3]));
    expect(res.status).toBe(400);
  });

  it("chữ ký sai → 401", async () => {
    const res = await POST(ipnRequest({ ...validBody, signature: "deadbeef" }));
    expect(res.status).toBe(401);
  });

  it("thiếu chữ ký → 401", async () => {
    const res = await POST(ipnRequest(validBody));
    expect(res.status).toBe(401);
  });

  it("chữ ký đúng nhưng bị sửa amount → 401 (HMAC không khớp)", async () => {
    const signature = sign(validBody, TEST_ACCESS_KEY, TEST_SECRET_KEY);
    const res = await POST(
      ipnRequest({ ...validBody, amount: 1, signature }), // sửa tiền sau khi ký
    );
    expect(res.status).toBe(401);
  });

  it("chưa cấu hình MoMo → 401 (fail closed — không verify được gì)", async () => {
    delete process.env.MOMO_PARTNER_CODE;
    delete process.env.MOMO_ACCESS_KEY;
    delete process.env.MOMO_SECRET_KEY;
    const signature = sign(validBody, TEST_ACCESS_KEY, TEST_SECRET_KEY);
    const res = await POST(ipnRequest({ ...validBody, signature }));
    expect(res.status).toBe(401);
  });
});
