/**
 * Financial shutdown — route/webhook/cron/return-page denial
 * (plan Task 3, spec §4.1: provider callback + cron không làm việc vận hành
 * khi tài chính tắt; §5.1: payment API/webhook/cron từ chối operational work).
 *
 * Yêu cầu cho từng entry point khi FINANCIAL_FEATURES_ENABLED tắt (mặc định):
 *  - POST /api/payments/momo/create   → 503 {error:"FINANCIAL_FEATURES_DISABLED"}
 *    TRƯỚC khi đọc Order/ExchangeOffer và trước khi tạo provider request;
 *  - POST /api/payments/momo/ipn      → 503 typed code — payload provider HỢP LỆ
 *    (đã ký đúng) cũng không được parse-then-mutate: không markEscrowPaid/
 *    markExchangeTopupPaid, không đọc Order để đối chiếu tiền;
 *  - GET  /payments/momo/return       → không mutate escrow, KHÔNG redirect vào
 *    flow finance sống (spec §5.1: safely redirect or unavailable);
 *  - POST /api/cron/auto-release      → 503 {ok:false,error:"FINANCIAL_FEATURES_DISABLED"}
 *    sau fail-closed CRON_SECRET/auth (không leak trạng thái finance cho caller
 *    chưa xác thực), TRƯỚC processAutoReleases — không payout/ledger.
 *
 * Db/auth/rate-limit/escrow/helpers bị mock spy ném lỗi khi bị chạm — thiếu
 * guard thì route trả về lỗi spy/500 thay vì typed denial → test đỏ ngay.
 * momo giữ bản thật (importOriginal) để verify chữ ký THẬT trong payload test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const dbState = vi.hoisted(() => ({ strict: true }));

vi.mock("@/src/prisma/db.client", () => {
  const CHAIN = ["where", "include", "select", "orderBy", "limit"] as const;
  const TERMINAL = [
    "first", "create", "update", "updateAll", "updateAndCount",
    "delete", "deleteAll", "all", "count", "aggregate",
  ] as const;
  type Spy = ReturnType<typeof vi.fn>;
  const makeModel = (name: string): Record<string, Spy> => {
    const obj: Record<string, Spy> = {};
    for (const m of [...CHAIN, ...TERMINAL]) {
      obj[m] = vi.fn(() => {
        if (dbState.strict) {
          throw new Error(`DB_TOUCHED_WHILE_FINANCE_DISABLED: ${name}.${m}`);
        }
        if ((CHAIN as readonly string[]).includes(m)) return obj; // chainable
        switch (m) {
          case "first": return null;
          case "all": return [];
          case "aggregate": return { total: 0, c: 0 };
          case "create": return { id: `mock-${name}` };
          case "updateAll": case "updateAndCount": return [];
          case "count": return 0;
          default: return undefined;
        }
      });
    }
    return obj;
  };
  const MODELS = [
    "User", "Listing", "Cart", "CartItem", "Order", "OrderItem", "Payment",
    "Payout", "WithdrawRequest", "LedgerEntry", "Dispute", "OrderStatusHistory",
    "ExchangeOffer", "Offer", "Conversation", "Category", "PlatformSetting",
    "Notification", "AdminAuditLog", "PriceHistory",
  ];
  const orm = {
    public: Object.fromEntries(MODELS.map((n) => [n, makeModel(n)])),
  };
  const db = {
    orm,
    transaction: vi.fn((cb: (tx: unknown) => unknown) => {
      if (dbState.strict) {
        throw new Error("DB_TRANSACTION_WHILE_FINANCE_DISABLED");
      }
      return cb(db);
    }),
  };
  return { db };
});

vi.mock("@/src/lib/auth", () => ({
  requireUser: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/src/lib/rate-limit", () => ({
  rateLimitRequest: vi.fn(),
  resetRateLimits: vi.fn(),
}));
vi.mock("@/src/lib/escrow", () => ({
  markEscrowPaid: vi.fn(),
  markExchangeTopupPaid: vi.fn(),
}));
vi.mock("@/src/lib/actions/helpers", () => ({
  processAutoReleases: vi.fn(),
  getOrCreateCart: vi.fn(),
  recordStatusChange: vi.fn(),
  getAutoReleaseDays: vi.fn(),
  audit: vi.fn(),
}));
// momo giữ bản THẬT (verify chữ ký thật) — chỉ bọc createMomoPayment bằng spy
vi.mock("@/src/lib/momo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/momo")>();
  return { ...actual, createMomoPayment: vi.fn(actual.createMomoPayment) };
});

import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { rateLimitRequest } from "@/src/lib/rate-limit";
import { markEscrowPaid, markExchangeTopupPaid } from "@/src/lib/escrow";
import { processAutoReleases } from "@/src/lib/actions/helpers";
import { createMomoPayment, buildCallbackRawSignature, type MomoCallbackBody } from "@/src/lib/momo";
import { redirect } from "next/navigation";

import { POST as momoCreatePost } from "../../app/api/payments/momo/create/route";
import { POST as momoIpnPost } from "../../app/api/payments/momo/ipn/route";
import { POST as cronAutoReleasePost } from "../../app/api/cron/auto-release/route";
import MomoReturnPage from "../../app/payments/momo/return/page";

const getCurrentUserMock = vi.mocked(getCurrentUser);
const rateLimitMock = vi.mocked(rateLimitRequest);
const markEscrowPaidMock = vi.mocked(markEscrowPaid);
const markExchangeTopupPaidMock = vi.mocked(markExchangeTopupPaid);
const processAutoReleasesMock = vi.mocked(processAutoReleases);
const createMomoPaymentMock = vi.mocked(createMomoPayment);
const redirectMock = vi.mocked(redirect);

const TEST_ACCESS_KEY = "shutdown-test-access-key";
const TEST_SECRET_KEY = "shutdown-test-secret-key";
const CRON_SECRET = "shutdown-test-cron-secret";

function modelSpy(model: string, method: string) {
  const models = (db as unknown as {
    orm: { public: Record<string, Record<string, ReturnType<typeof vi.fn>>> };
  }).orm.public;
  return models[model]![method]!;
}

function sign(body: MomoCallbackBody, accessKey: string, secretKey: string): string {
  return createHmac("sha256", secretKey)
    .update(buildCallbackRawSignature(body, accessKey))
    .digest("hex");
}

const ORDER_CALLBACK: MomoCallbackBody = {
  partnerCode: "MOMO",
  orderId: "ORDER-order-1",
  requestId: "REQ-1",
  amount: 150_000,
  transId: 999,
  resultCode: 0,
  message: "Successful",
  payType: "creditCard",
  responseTime: 1_700_000_000_000,
  extraData: "",
  orderInfo: "LoaViet escrow",
};

const EXOFFER_CALLBACK: MomoCallbackBody = {
  ...ORDER_CALLBACK,
  orderId: "EXOFFER-offer-1",
  amount: 200_000,
};

function ipnRequest(payload: MomoCallbackBody): Request {
  return new Request("http://localhost:3000/api/payments/momo/ipn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function momoCreateRequest(payload: unknown): Request {
  return new Request("http://localhost:3000/api/payments/momo/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function cronRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/cron/auto-release", {
    method: "POST",
    headers,
  });
}

/** Gọi return page với query params (page là server component async). */
const returnPage = MomoReturnPage as unknown as (
  props: { searchParams: Promise<Record<string, string>> },
) => Promise<never>;

function returnSearchParams(body: MomoCallbackBody): Record<string, string> {
  return {
    partnerCode: body.partnerCode ?? "",
    orderId: body.orderId ?? "",
    requestId: body.requestId ?? "",
    amount: String(body.amount ?? ""),
    transId: String(body.transId ?? ""),
    resultCode: String(body.resultCode ?? ""),
    message: body.message ?? "",
    payType: body.payType ?? "",
    responseTime: String(body.responseTime ?? ""),
    extraData: body.extraData ?? "",
    orderInfo: body.orderInfo ?? "",
    signature: sign(body, TEST_ACCESS_KEY, TEST_SECRET_KEY),
  };
}

beforeEach(() => {
  // Mặc định test: tài chính TẮT (bỏ trống env = false — spec §5.1)
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
  vi.stubEnv("MOMO_PARTNER_CODE", "MOMO");
  vi.stubEnv("MOMO_ACCESS_KEY", TEST_ACCESS_KEY);
  vi.stubEnv("MOMO_SECRET_KEY", TEST_SECRET_KEY);
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  dbState.strict = true;

  getCurrentUserMock.mockReset().mockResolvedValue({
    id: "buyer-1",
    email: "buyer@t.est",
    name: "Buyer",
    role: "buyer",
    avatarUrl: null,
    isVerifiedSeller: false,
    // Batch 2 Task 2: SessionUser thêm adminRole + sessionId (bắt buộc)
    adminRole: null,
    sessionId: "sess-fixture",
  });
  rateLimitMock.mockReset().mockResolvedValue(null); // không limit — limited = null
  markEscrowPaidMock.mockReset().mockResolvedValue(true);
  markExchangeTopupPaidMock.mockReset().mockResolvedValue(true);
  processAutoReleasesMock.mockReset().mockResolvedValue(0);
  redirectMock.mockReset().mockImplementation(() => {
    throw new Error("NEXT_REDIRECT_REACHED");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/payments/momo/create — deny khi tài chính tắt", () => {
  it("503 typed denial TRƯỚC auth/rate-limit/đọc Order — không tạo provider request", async () => {
    const res = await momoCreatePost(momoCreateRequest({ orderId: "order-1" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("FINANCIAL_FEATURES_DISABLED");
    expect(getCurrentUserMock).not.toHaveBeenCalled(); // deny trước auth
    expect(rateLimitMock).not.toHaveBeenCalled(); // deny trước rate limit
    expect(modelSpy("Order", "first")).not.toHaveBeenCalled(); // không đọc đơn
    expect(createMomoPaymentMock).not.toHaveBeenCalled(); // không gọi cổng
  });

  it("tương tự với exchange top-up — không đọc ExchangeOffer", async () => {
    const res = await momoCreatePost(momoCreateRequest({ exchangeOfferId: "offer-1" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("FINANCIAL_FEATURES_DISABLED");
    expect(modelSpy("ExchangeOffer", "first")).not.toHaveBeenCalled();
    expect(createMomoPaymentMock).not.toHaveBeenCalled();
  });

  it("finance BẬT (dev/test) → ranh giới mở: đi qua assert tới đọc Order như cũ", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    dbState.strict = false; // Order.first → null → 404 NOT_FOUND (path legacy)
    const res = await momoCreatePost(momoCreateRequest({ orderId: "order-1" }));
    expect(res.status).toBe(404);
    expect(modelSpy("Order", "first")).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/payments/momo/ipn — webhook deny khi tài chính tắt", () => {
  it("payload ký HỢP LỆ (ORDER) → 503 typed denial, không parse-then-mutate", async () => {
    const res = await momoIpnPost(
      ipnRequest({ ...ORDER_CALLBACK, signature: sign(ORDER_CALLBACK, TEST_ACCESS_KEY, TEST_SECRET_KEY) }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("FINANCIAL_FEATURES_DISABLED");
    expect(rateLimitMock).not.toHaveBeenCalled(); // deny trước rate limit
    expect(modelSpy("Order", "first")).not.toHaveBeenCalled(); // không đọc đối chiếu tiền
    expect(markEscrowPaidMock).not.toHaveBeenCalled(); // KHÔNG mutate escrow
    expect(markExchangeTopupPaidMock).not.toHaveBeenCalled();
  });

  it("payload ký HỢP LỆ (EXOFFER) → typed denial, không markExchangeTopupPaid", async () => {
    const res = await momoIpnPost(
      ipnRequest({ ...EXOFFER_CALLBACK, signature: sign(EXOFFER_CALLBACK, TEST_ACCESS_KEY, TEST_SECRET_KEY) }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("FINANCIAL_FEATURES_DISABLED");
    expect(modelSpy("ExchangeOffer", "first")).not.toHaveBeenCalled();
    expect(markExchangeTopupPaidMock).not.toHaveBeenCalled();
  });

  it("finance BẬT (dev/test) → đi qua assert, verify chữ ký + đọc Order như cũ", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    dbState.strict = false; // Order.first → null → 204 amount-mismatch (path legacy)
    const res = await momoIpnPost(
      ipnRequest({ ...ORDER_CALLBACK, signature: sign(ORDER_CALLBACK, TEST_ACCESS_KEY, TEST_SECRET_KEY) }),
    );
    expect(res.status).toBe(204);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(modelSpy("Order", "first")).toHaveBeenCalledTimes(1);
    expect(markEscrowPaidMock).not.toHaveBeenCalled(); // amount mismatch → bỏ qua
  });
});

describe("GET /payments/momo/return — return URL deny khi tài chính tắt", () => {
  it("query ký HỢP LỆ (ORDER) → throw typed denial, KHÔNG mutate escrow, KHÔNG redirect", async () => {
    await expect(
      returnPage({ searchParams: Promise.resolve(returnSearchParams(ORDER_CALLBACK)) }),
    ).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);
    expect(markEscrowPaidMock).not.toHaveBeenCalled();
    expect(markExchangeTopupPaidMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled(); // không redirect vào flow finance
  });

  it("query ký HỢP LỆ (EXOFFER) → typed denial, không markExchangeTopupPaid", async () => {
    await expect(
      returnPage({ searchParams: Promise.resolve(returnSearchParams(EXOFFER_CALLBACK)) }),
    ).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);
    expect(markExchangeTopupPaidMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("finance BẬT (dev/test) → verify + markEscrowPaid + redirect như cũ (legacy giữ nguyên)", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    await expect(
      returnPage({ searchParams: Promise.resolve(returnSearchParams(ORDER_CALLBACK)) }),
    ).rejects.toThrowError(/NEXT_REDIRECT_REACHED/); // redirect() throw — hành vi Next
    expect(markEscrowPaidMock).toHaveBeenCalledWith("order-1", "MOMO-999", "momo");
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-1?paid=1");
  });
});

describe("POST /api/cron/auto-release — cron deny khi tài chính tắt", () => {
  it("secret ĐÚNG + disabled → 503 typed denial, KHÔNG chạy processAutoReleases", async () => {
    const res = await cronAutoReleasePost(
      cronRequest({ authorization: `Bearer ${CRON_SECRET}` }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "FINANCIAL_FEATURES_DISABLED" });
    expect(processAutoReleasesMock).not.toHaveBeenCalled(); // không payout/ledger
  });

  it("secret SAI + disabled → 401 TRƯỚC finance denial (fail-closed auth giữ nguyên)", async () => {
    const res = await cronAutoReleasePost(
      cronRequest({ authorization: "Bearer wrong-secret" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "UNAUTHORIZED" });
    expect(processAutoReleasesMock).not.toHaveBeenCalled();
  });

  it("thiếu CRON_SECRET + disabled → 503 CRON_SECRET_NOT_CONFIGURED (fail closed)", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const res = await cronAutoReleasePost(cronRequest({}));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "CRON_SECRET_NOT_CONFIGURED" });
    expect(processAutoReleasesMock).not.toHaveBeenCalled();
  });

  it("finance BẬT (dev/test) + secret đúng → chạy processAutoReleases như cũ", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    processAutoReleasesMock.mockResolvedValue(3);
    const res = await cronAutoReleasePost(
      cronRequest({ authorization: `Bearer ${CRON_SECRET}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; released: number };
    expect(body).toEqual({ ok: true, released: 3 });
    expect(processAutoReleasesMock).toHaveBeenCalledTimes(1);
  });
});
