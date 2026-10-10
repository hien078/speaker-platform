/**
 * CRON_SECRET auth — timing-safe, fail-closed.
 * Endpoint cron di chuyển tiền thật (escrow auto-release) phải:
 * - từ chối mọi request khi chưa cấu hình CRON_SECRET (fail closed)
 * - so sánh secret timing-safe (chống leak qua thời gian phản hồi)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verifyCronAuth } from "../../src/lib/cron-auth";

const SECRET = "unit-test-cron-secret";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/cron/auto-release", {
    method: "POST",
    headers,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyCronAuth", () => {
  it("fail closed: từ chối khi CRON_SECRET chưa cấu hình", () => {
    delete process.env.CRON_SECRET;
    expect(
      verifyCronAuth(makeRequest({ authorization: `Bearer ${SECRET}` })),
    ).toBe(false);
  });

  it("chấp nhận Bearer token đúng", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(
      verifyCronAuth(makeRequest({ authorization: `Bearer ${SECRET}` })),
    ).toBe(true);
  });

  it("từ chối token sai", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(
      verifyCronAuth(makeRequest({ authorization: "Bearer wrong-secret" })),
    ).toBe(false);
  });

  it("từ chối khi thiếu header", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(verifyCronAuth(makeRequest({}))).toBe(false);
  });

  it("từ chối header không phải Bearer", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(
      verifyCronAuth(makeRequest({ authorization: `Basic ${SECRET}` })),
    ).toBe(false);
    expect(
      verifyCronAuth(makeRequest({ "x-cron-secret": SECRET })),
    ).toBe(false);
  });

  it("từ chối token độ dài khác (không leak qua timing)", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(
      verifyCronAuth(makeRequest({ authorization: "Bearer short" })),
    ).toBe(false);
    expect(
      verifyCronAuth(
        makeRequest({ authorization: `Bearer ${SECRET}-longer-than-secret` }),
      ),
    ).toBe(false);
  });
});
