/**
 * OTP core — unit tests (plan Task 3, spec §5.3: hashed, single-use, short-lived,
 * attempt-limited, resend-limited, rate-limited, target-bound, KHÔNG BAO GIỜ log
 * mã thô — spec §4.8 áp dụng ở MỌI môi trường).
 *
 * Cơ chế mock: `server-only` + `@/src/prisma/db.client` (in-memory OtpCode store)
 * + `@/src/lib/verification-delivery` (adapter spy điều khiển được) — cùng phong
 * cách session.test.ts / finance tests. Rate limiter GIỮ BẢN THẬT (checkRateLimit
 * từ src/lib/rate-limit.ts — reset qua resetRateLimits) vì plan yêu cầu tiêu thụ
 * đúng limiter đó.
 *
 * Hợp đồng (plan Task 3 Step 1):
 *  1. requestOtp lưu HMAC hash (64-hex, ≠ mã thô, = HMAC-SHA256 với hkdfKey
 *     "otp-hash"), expiresAt = now + 10 phút, binding đủ (userId,purpose,channel,target).
 *  2. Resend cooldown 60s: request thứ hai trong 60s → OTP_RATE_LIMITED với
 *     retryAfterSec — adapter spy gọi ĐÚNG 1 lần (không gửi mã thứ hai).
 *  3. Per-target limit 3 mã / 10 phút: request thứ 4 → OTP_RATE_LIMITED.
 *  4. verifyOtp đúng mã → ok, row consumed (consumedAt set).
 *  5. Single-use: dùng lại mã đã verify → OTP_NOT_FOUND (spec §5.3 "invalidated
 *     after successful use").
 *  6. Sai mã tăng attempts; lần sai thứ 5 → OTP_MAX_ATTEMPTS; các lần sau fail
 *     luôn (kể cả mã ĐÚNG).
 *  7. Hết hạn (10 phút) → OTP_EXPIRED.
 *  8. Mã của target/purpose/user/channel khác không verify (binding).
 *  9. requestOtp/verifyOtp KHÔNG bao giờ emit mã thô (Review Focus 1): spy
 *     console.log/error/warn/info/debug, captureEvent — không argument nào chứa mã.
 * 10. normalizePhone chuẩn hóa +84→0, bỏ khoảng cách/dấu chấm; sai format throw
 *     với message CỐ ĐỊNH không chứa raw input (PII — spec §4.8).
 * 11. Delivery fail → row bị DELETE + OTP_DELIVERY_UNAVAILABLE (không mã mồ côi).
 * 12. (fix) Race-safe attempt limit (spec §5.3 attempt-limited, §7.2 OTP brute
 *     force): N guess sai đồng thời KHÔNG thể cost < OTP_MAX_ATTEMPTS; chạm
 *     ngưỡng → mã ĐÚNG cũng bị chặn; N guess đúng đồng thời consume đúng 1 lần.
 * 13. (fix) So khớp hash timing-safe (convention cron-auth.ts/momo.ts): hash
 *     lệch độ dài → false, KHÔNG throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

// ─── Adapter delivery spy (mock cả module — otp.ts tiêu thụ getOtpDeliveryAdapter) ──

const delivery = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  sendSecurityNotice: vi.fn(),
}));

vi.mock("@/src/lib/verification-delivery", () => ({
  getOtpDeliveryAdapter: () => ({
    name: "mock",
    sendOtp: delivery.sendOtp,
    sendSecurityNotice: delivery.sendSecurityNotice,
  }),
}));

// ─── db.client mock: in-memory OtpCode store ──────────────────────────────────

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  // Field proxy cho lambda predicate — otp.ts chỉ dùng isNull (single-clause)
  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          lt: (v: unknown) => (row[field] as number) < (v as number),
          lte: (v: unknown) => (row[field] as number) <= (v as number),
          gt: (v: unknown) => (row[field] as number) > (v as number),
          gte: (v: unknown) => (row[field] as number) >= (v as number),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  // otp.ts chỉ order createdAt desc; rows chèn theo thời gian → match CUỐI
  // trong array = row createdAt mới nhất = đúng "orderBy(createdAt desc).first()"
  const query = (preds: Pred[]) => ({
    where: (pred: Pred) => query([...preds, pred]),
    orderBy: () => query(preds),
    first: async (filter?: Pred) => {
      const all = [...preds, ...(filter ? [filter] : [])];
      const hits = dbState.rows.filter((r) => all.every((p) => matches(r, p)));
      return hits.length === 0 ? null : { ...hits[hits.length - 1]! };
    },
    updateAll: async (data: Row) => {
      const hits = dbState.rows.filter((r) => preds.every((p) => matches(r, p)));
      for (const r of hits) Object.assign(r, data);
      return hits.map((r) => ({ ...r }));
    },
    delete: async () => {
      const hits = dbState.rows.filter((r) => preds.every((p) => matches(r, p)));
      for (const r of hits) {
        const i = dbState.rows.indexOf(r);
        if (i >= 0) dbState.rows.splice(i, 1);
      }
      return hits.map((r) => ({ ...r }));
    },
    create: async (data: Row) => {
      const row = {
        id: `otp-${dbState.rows.length + 1}`,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date().toISOString(),
        ...data,
      };
      dbState.rows.push(row);
      return { ...row };
    },
  });

  const orm = {
    public: {
      OtpCode: {
        where: (pred: Pred) => query([pred]),
        create: (data: Row) => query([]).create(data),
      },
    },
  };
  return { db: { orm } };
});

import {
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SEC,
  OTP_PER_TARGET_RULE,
  requestOtp,
  verifyOtp,
  normalizeEmail,
  normalizePhone,
  hkdfKey,
} from "@/src/lib/otp";
import { resetRateLimits } from "@/src/lib/rate-limit";
import * as observability from "@/src/lib/observability";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARAMS = {
  userId: "user-1",
  purpose: "email_verification" as const,
  channel: "email" as const,
  target: "nguoi.mua@loaviet.test",
};

/** Mã vừa "gửi" qua adapter spy — plaintext duy nhất test được phép biết. */
const lastSentCode = (): string => {
  const call = delivery.sendOtp.mock.calls.at(-1);
  if (!call) throw new Error("adapter chưa được gọi — không có mã để đọc");
  return (call[0] as { code: string }).code;
};

/** Mã sai chắc chắn (không trùng mã thật — tránh trúng 1/1_000_000). */
const wrongCodeFor = (code: string): string => (code === "000000" ? "999999" : "000000");

/** Chuỗi hóa argument để quét rò rỉ mã — Error phải lộ message/stack. */
const argText = (a: unknown): string => {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.message} ${a.stack ?? ""}`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.rows.length = 0;
  delivery.sendOtp.mockReset();
  delivery.sendSecurityNotice.mockReset();
  delivery.sendOtp.mockResolvedValue(undefined);
  delivery.sendSecurityNotice.mockResolvedValue(undefined);
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── 1. Hash + TTL + binding ──────────────────────────────────────────────────

describe("requestOtp — hash, TTL, binding", () => {
  it("lưu HMAC hash (64-hex, ≠ mã thô, = HMAC-SHA256 hkdfKey otp-hash), expiresAt = now + 10 phút", async () => {
    const res = await requestOtp(PARAMS);
    expect(res).toEqual({ ok: true, resendAfterSec: OTP_RESEND_COOLDOWN_SEC });
    expect(OTP_RESEND_COOLDOWN_SEC).toBe(60);

    const sent = delivery.sendOtp.mock.calls[0]![0] as {
      to: string;
      code: string;
      purpose: string;
      channel: string;
    };
    expect(sent).toMatchObject({
      to: PARAMS.target,
      purpose: PARAMS.purpose,
      channel: PARAMS.channel,
    });

    const row = dbState.rows[0]!;
    // DB chỉ lưu hash — mã thô chỉ tồn tại trong adapter call
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toBe(sent.code);
    // ĐÚNG công thức plan: HMAC-SHA256(code, hkdfKey("otp-hash")) hex
    expect(row.codeHash).toBe(
      createHmac("sha256", hkdfKey("otp-hash")).update(sent.code).digest("hex"),
    );
    // TTL 10 phút
    expect(OTP_TTL_MINUTES).toBe(10);
    expect(Math.abs(Date.parse(row.expiresAt as string) - (Date.now() + OTP_TTL_MINUTES * 60_000))).toBeLessThan(1_000);
    // Binding đầy đủ — mã chỉ hợp lệ cho đúng (userId,purpose,channel,target)
    expect(row).toMatchObject({
      userId: PARAMS.userId,
      purpose: PARAMS.purpose,
      channel: PARAMS.channel,
      target: PARAMS.target,
      attempts: 0,
      consumedAt: null,
    });
  });

  it("mã 6 chữ số từ crypto.randomInt (zero-padded)", async () => {
    await requestOtp(PARAMS);
    expect(lastSentCode()).toMatch(/^\d{6}$/);
  });
});

// ─── 2+3. Cooldown + per-target rate limit ────────────────────────────────────

describe("requestOtp — resend cooldown + per-target limit", () => {
  it("cooldown 60s: request thứ hai ngay sau → OTP_RATE_LIMITED + retryAfterSec, adapter KHÔNG gửi mã thứ hai", async () => {
    const first = await requestOtp(PARAMS);
    expect(first.ok).toBe(true);
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1);

    const second = await requestOtp(PARAMS);
    expect(second).toMatchObject({ ok: false, code: "OTP_RATE_LIMITED" });
    if (second.ok === false && second.code === "OTP_RATE_LIMITED") {
      expect(second.retryAfterSec).toBeGreaterThan(0);
      expect(second.retryAfterSec).toBeLessThanOrEqual(OTP_RESEND_COOLDOWN_SEC);
    }
    // Review Focus 1 kề cận: path rate-limited KHÔNG gửi delivery thứ hai
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1);
    // KHÔNG tạo row thứ hai
    expect(dbState.rows).toHaveLength(1);
  });

  it("hết cooldown 60s → cho request lại (resend hợp lệ)", async () => {
    await requestOtp(PARAMS);
    vi.advanceTimersByTime(61_000);
    const second = await requestOtp(PARAMS);
    expect(second).toEqual({ ok: true, resendAfterSec: OTP_RESEND_COOLDOWN_SEC });
    expect(delivery.sendOtp).toHaveBeenCalledTimes(2);
    expect(dbState.rows).toHaveLength(2);
  });

  it("per-target limit: request thứ 4 trong 10 phút → OTP_RATE_LIMITED (3 mã / 10 phút / (userId,purpose,target))", async () => {
    expect(OTP_PER_TARGET_RULE).toEqual({ limit: 3, windowMs: 10 * 60_000 });
    // 3 request cách nhau 61s: cooldown không chặn, mỗi lần ghi 1 hit rate limit
    for (let i = 0; i < 3; i++) {
      const res = await requestOtp(PARAMS);
      expect(res.ok).toBe(true);
      vi.advanceTimersByTime(61_000);
    }
    const fourth = await requestOtp(PARAMS);
    expect(fourth).toMatchObject({ ok: false, code: "OTP_RATE_LIMITED" });
    if (fourth.ok === false && fourth.code === "OTP_RATE_LIMITED") {
      expect(fourth.retryAfterSec).toBeGreaterThan(0);
    }
    // đúng 3 mã đã gửi — request bị chặn không gửi mã thứ 4
    expect(delivery.sendOtp).toHaveBeenCalledTimes(3);
    expect(dbState.rows).toHaveLength(3);
  });

  it("target khác có bucket rate limit riêng — không bị chặn vì target khác", async () => {
    await requestOtp(PARAMS);
    const other = await requestOtp({ ...PARAMS, target: "nguoi.khac@loaviet.test" });
    expect(other.ok).toBe(true);
  });
});

// ─── 4+5. Verify + single-use ────────────────────────────────────────────────

describe("verifyOtp — verify + single-use", () => {
  it("mã đúng → ok và row consumed (consumedAt set)", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();
    const res = await verifyOtp({ ...PARAMS, code });
    expect(res).toEqual({ ok: true });
    const row = dbState.rows[0]!;
    expect(row.consumedAt).not.toBeNull();
  });

  it("single-use: dùng lại mã đã verify → OTP_NOT_FOUND (spec §5.3 invalidated after successful use)", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();
    expect(await verifyOtp({ ...PARAMS, code })).toEqual({ ok: true });
    expect(await verifyOtp({ ...PARAMS, code })).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
  });

  it("không có OTP nào cho (userId,purpose,channel,target) → OTP_NOT_FOUND", async () => {
    const res = await verifyOtp({ ...PARAMS, code: "123456" });
    expect(res).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
  });
});

// ─── 6. Attempt limit ─────────────────────────────────────────────────────────

describe("verifyOtp — attempt limit", () => {
  it("sai mã tăng attempts; lần sai thứ 5 → OTP_MAX_ATTEMPTS; sau đó fail luôn (kể cả mã đúng)", async () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    await requestOtp(PARAMS);
    const code = lastSentCode();
    const wrong = wrongCodeFor(code);

    // 4 lần sai đầu → OTP_NOT_FOUND, attempts tăng dần
    for (let i = 1; i <= 4; i++) {
      const res = await verifyOtp({ ...PARAMS, code: wrong });
      expect(res).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
      expect(dbState.rows[0]!.attempts).toBe(i);
    }

    // lần sai thứ 5 → khóa (OTP_MAX_ATTEMPTS)
    const fifth = await verifyOtp({ ...PARAMS, code: wrong });
    expect(fifth).toEqual({ ok: false, code: "OTP_MAX_ATTEMPTS" });
    expect(dbState.rows[0]!.attempts).toBe(5);

    // các lần sau (kể cả MÃ ĐÚNG) vẫn fail — đã khóa
    const sixth = await verifyOtp({ ...PARAMS, code });
    expect(sixth).toEqual({ ok: false, code: "OTP_MAX_ATTEMPTS" });
    expect(dbState.rows[0]!.consumedAt).toBeNull(); // không consume khi khóa
  });
});

// ─── 7. Expiry ────────────────────────────────────────────────────────────────

describe("verifyOtp — expiry", () => {
  it("mã hết hạn (10 phút) → OTP_EXPIRED", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();
    vi.advanceTimersByTime(OTP_TTL_MINUTES * 60_000 + 1_000);
    const res = await verifyOtp({ ...PARAMS, code });
    expect(res).toEqual({ ok: false, code: "OTP_EXPIRED" });
  });
});

// ─── 8. Target/purpose/user/channel binding ──────────────────────────────────

describe("verifyOtp — binding (mã chỉ hợp lệ cho đúng target/purpose/user/channel)", () => {
  it("mã của target/purpose/user/channel khác không verify", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();

    // target khác
    expect(
      await verifyOtp({ ...PARAMS, target: "ke.tan.cong@loaviet.test", code }),
    ).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
    // purpose khác
    expect(
      await verifyOtp({ ...PARAMS, purpose: "password_recovery", code }),
    ).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
    // user khác
    expect(
      await verifyOtp({ ...PARAMS, userId: "user-khac", code }),
    ).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
    // channel khác
    expect(
      await verifyOtp({ ...PARAMS, channel: "phone", code }),
    ).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
  });
});

// ─── 9. Review Focus 1 — không bao giờ emit mã thô ───────────────────────────

describe("requestOtp/verifyOtp — KHÔNG BAO GIỜ emit mã thô (Review Focus 1, spec §4.8)", () => {
  it("mọi path (gửi, sai, đúng, rate-limited, delivery fail) không log mã qua console/captureEvent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const eventSpy = vi.spyOn(observability, "captureEvent");

    try {
      await requestOtp(PARAMS); // gửi thành công
      const code = lastSentCode();
      await verifyOtp({ ...PARAMS, code: wrongCodeFor(code) }); // sai
      await verifyOtp({ ...PARAMS, code }); // đúng
      await requestOtp(PARAMS); // cooldown → rate limited
      delivery.sendOtp.mockImplementationOnce(() => {
        throw new Error("provider down");
      });
      await requestOtp({ ...PARAMS, target: "that-bai@loaviet.test" }); // delivery fail

      // MỌI argument của MỌI spy (kể cả warn/info/debug) không chứa mã thô
      const dumps: string[] = [];
      for (const spy of [logSpy, errSpy, warnSpy, infoSpy, debugSpy, eventSpy]) {
        for (const call of spy.mock.calls) {
          for (const arg of call) dumps.push(argText(arg));
        }
      }
      expect(dumps.join("\n")).not.toContain(code);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      eventSpy.mockRestore();
    }
  });
});

// ─── 10. Chuẩn hóa target ────────────────────────────────────────────────────

describe("normalizeEmail / normalizePhone", () => {
  it("normalizeEmail: trim + lowercase", () => {
    expect(normalizeEmail("  Nguoi.Mua@LoaViet.TEST  ")).toBe("nguoi.mua@loaviet.test");
  });

  it('normalizePhone: "+84 901 234 567" → "0901234567"; "0901.234.567" → "0901234567"', () => {
    expect(normalizePhone("+84 901 234 567")).toBe("0901234567");
    expect(normalizePhone("0901.234.567")).toBe("0901234567");
    expect(normalizePhone(" 0901234567 ")).toBe("0901234567");
  });

  it('normalizePhone sai format → throw ("12345", "+84123", "0123456789012")', () => {
    expect(() => normalizePhone("12345")).toThrow();
    expect(() => normalizePhone("+84 123 456")).toThrow(); // quá ngắn sau khi bỏ +84
    expect(() => normalizePhone("0123456789012")).toThrow(); // quá dài
  });

  it("normalizePhone sai format → message KHÔNG chứa raw input (PII — spec §4.8; captureError ghi error.message ra log)", () => {
    const bad = "+84 123 456";
    let err: unknown;
    try {
      normalizePhone(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("INVALID_PHONE_FORMAT");
    // Raw phone KHÔNG được lọt vào message — caller bắt rồi captureError(scope, e)
    // ghi error.message thẳng ra log/analytics (spec §4.8: không raw phone)
    expect(message).not.toContain(bad);
    expect(message).not.toContain("123");
    expect(message).not.toContain("456");
    expect(message).not.toContain("+84");
  });
});

// ─── 11. Delivery failure ────────────────────────────────────────────────────

describe("requestOtp — delivery failure (fail closed, không mã mồ côi)", () => {
  it("adapter throw → row bị DELETE + OTP_DELIVERY_UNAVAILABLE", async () => {
    delivery.sendOtp.mockImplementationOnce(() => {
      throw new Error("smtp down");
    });
    const res = await requestOtp(PARAMS);
    expect(res).toEqual({ ok: false, code: "OTP_DELIVERY_UNAVAILABLE" });
    // row bị xóa — không để lại mã đã hash nhưng chưa ai nhận được
    expect(dbState.rows).toHaveLength(0);
  });
});

// ─── 12. Concurrency — race-safe attempt limit (fix, spec §5.3 + §7.2) ────────

describe("verifyOtp — concurrency: race-safe attempt limit (spec §5.3 attempt-limited, §7.2 OTP brute force)", () => {
  it("20 guess SAI đồng thời → attempts chạm đúng OTP_MAX_ATTEMPTS (không vượt), mọi guess fail, mã ĐÚNG sau đó bị chặn", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();
    const wrong = wrongCodeFor(code);

    // 20 guess sai đồng thời — event loop cho MỌI call đọc row TRƯỚC khi bất
    // kỳ call nào ghi. Bypass cũ: read-then-write vô điều kiện → 20 call cùng
    // đọc attempts=0 rồi cùng ghi 1 → 20 guess chỉ tốn 1 attempt → brute force
    // cả không gian 6 chữ số (spec §7.2).
    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyOtp({ ...PARAMS, code: wrong })),
    );
    // KHÔNG guess nào được success khi race
    for (const res of results) expect(res.ok).toBe(false);

    // Mỗi guess sai phải được ĐẾM (compare-and-set): 20 guess ≥ 5 → đã khóa.
    // Đúng ngưỡng, KHÔNG vượt (không đếm quá OTP_MAX_ATTEMPTS).
    expect(dbState.rows[0]!.attempts).toBe(OTP_MAX_ATTEMPTS);
    expect(dbState.rows[0]!.consumedAt).toBeNull();

    // Đã khóa → mã ĐÚNG cũng bị chặn (spec §5.3 attempt-limited)
    expect(await verifyOtp({ ...PARAMS, code })).toEqual({
      ok: false,
      code: "OTP_MAX_ATTEMPTS",
    });
  });

  it("20 guess ĐÚNG đồng thời → consume ĐÚNG 1 lần, 19 request còn lại OTP_NOT_FOUND", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyOtp({ ...PARAMS, code })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(dbState.rows[0]!.consumedAt).not.toBeNull();
    // single-use: mã đã consume là chết hẳn — request chậm hơn fail closed
    expect(await verifyOtp({ ...PARAMS, code })).toEqual({
      ok: false,
      code: "OTP_NOT_FOUND",
    });
  });

  it("guess ĐÚNG đua guess sai: sai lấy attempts lên ngưỡng trước → ĐÚNG bị chặn (consume recheck attempts/expiry)", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();
    const wrong = wrongCodeFor(code);

    // 4 lần sai → còn đúng 1 lần trước khóa
    for (let i = 0; i < 4; i++) {
      await verifyOtp({ ...PARAMS, code: wrong });
    }
    expect(dbState.rows[0]!.attempts).toBe(4);

    // Lần sai thứ 5 (khóa) và mã ĐÚNG đua nhau — cả hai cùng đọc attempts=4.
    // Consume cũ chỉ recheck consumedAt IS NULL → mã ĐÚNG consume được row đã
    // khóa. Consume mới phải recheck ĐẦY ĐỦ trong UPDATE: consumedAt IS NULL
    // AND attempts < OTP_MAX_ATTEMPTS AND expiresAt > now.
    const [wrongRes, correctRes] = await Promise.all([
      verifyOtp({ ...PARAMS, code: wrong }),
      verifyOtp({ ...PARAMS, code }),
    ]);
    expect(wrongRes.ok).toBe(false);
    expect(correctRes).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
    expect(dbState.rows[0]!.attempts).toBe(OTP_MAX_ATTEMPTS);
    expect(dbState.rows[0]!.consumedAt).toBeNull(); // row đã khóa KHÔNG bị consume
  });
});

// ─── 13. So khớp hash timing-safe (fix — convention cron-auth.ts/momo.ts) ─────

describe("verifyOtp — so khớp hash timing-safe", () => {
  it("hash lệch độ dài (row hỏng/tam sửa) → fail closed KHÔNG throw (timingSafeEqual đòi equal-length)", async () => {
    await requestOtp(PARAMS);
    const code = lastSentCode();
    dbState.rows[0]!.codeHash = "deadbeef"; // 8 hex ≠ 64 hex HMAC-SHA256

    // Mã đúng nhưng hash hỏng → sai mã; so sánh phải trả false, KHÔNG throw
    const res = await verifyOtp({ ...PARAMS, code });
    expect(res).toEqual({ ok: false, code: "OTP_NOT_FOUND" });
  });
});
