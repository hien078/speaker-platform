/**
 * POST /api/cron/auto-release — escrow auto-release cron endpoint.
 * Yêu cầu: fail closed khi chưa cấu hình CRON_SECRET (503), 401 khi sai
 * secret, 200 + released count khi hợp lệ, 500 khi processAutoReleases lỗi.
 * Idempotent: processAutoReleases chỉ xử lý đơn shipped quá hạn — chạy
 * lại không giải ngân lại đơn đã xử lý.
 *
 * Private beta (plan Task 3): tài chính TẮT MẶC ĐỊNH → correct-secret bị
 * typed denial 503 FINANCIAL_FEATURES_DISABLED, không chạy giải ngân.
 * Bộ legacy bên dưới bật tài chính NGÔI LẬP để vẫn chứng minh auth/idempotency;
 * hành vi tắt mặc định có test riêng ở financial-shutdown-routes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/actions/helpers", () => ({
  processAutoReleases: vi.fn(),
}));

import { POST } from "../../app/api/cron/auto-release/route";
import { processAutoReleases } from "@/src/lib/actions/helpers";

const SECRET = "unit-test-cron-secret";
const mockedProcessAutoReleases = vi.mocked(processAutoReleases);

function makeRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/cron/auto-release", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  // Bật tài chính NGÔI LẬP cho các case legacy (auth/idempotency/500) —
  // case tắt mặc định override bên dưới bằng stubEnv undefined.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/cron/auto-release", () => {
  it("503 khi CRON_SECRET chưa cấu hình — không chạy giải ngân", async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(503);
    expect(mockedProcessAutoReleases).not.toHaveBeenCalled();
  });

  it("401 khi thiếu/sai Bearer token — không chạy giải ngân", async () => {
    const cases: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }];
    for (const headers of cases) {
      const res = await POST(makeRequest(headers));
      expect(res.status).toBe(401);
    }
    expect(mockedProcessAutoReleases).not.toHaveBeenCalled();
  });

  it("503 FINANCIAL_FEATURES_DISABLED khi token đúng nhưng tài chính tắt (mặc định beta)", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined); // mặc định = tắt
    const res = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "FINANCIAL_FEATURES_DISABLED" });
    expect(mockedProcessAutoReleases).not.toHaveBeenCalled(); // không payout/ledger
  });

  it("200 + released count khi token đúng (tài chính bật — legacy)", async () => {
    mockedProcessAutoReleases.mockResolvedValue(3);
    const res = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; released: number };
    expect(body).toEqual({ ok: true, released: 3 });
    expect(mockedProcessAutoReleases).toHaveBeenCalledTimes(1);
  });

  it("200 với released=0 khi không có đơn quá hạn (idempotent, tài chính bật)", async () => {
    mockedProcessAutoReleases.mockResolvedValue(0);
    const res = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; released: number };
    expect(body).toEqual({ ok: true, released: 0 });
  });

  it("500 khi processAutoReleases throw — scheduler sẽ thử lại lần sau (tài chính bật)", async () => {
    mockedProcessAutoReleases.mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "AUTO_RELEASE_FAILED" });
  });
});
