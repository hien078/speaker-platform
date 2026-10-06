/**
 * OTP delivery adapters + dev inbox seam — unit tests (plan Task 3, spec §5.3
 * "adapters" + §4.8 KHÔNG log mã thô ở BẤT KỲ môi trường nào).
 *
 * Giữ BẢN THẬT module verification-delivery (không mock) + route dev inbox —
 * chỉ spy console.log/error/warn/info/debug + captureEvent và stub NODE_ENV.
 * Không đụng db (module chỉ import TYPE từ otp.ts — type-only, không kéo db.client).
 *
 * Hợp đồng (plan Task 3 Step 1):
 *  1. In-memory adapter (dev/test) lưu mã vào inbox, KHÔNG log ở đâu — spy
 *     console.log/error/warn/info/debug, captureEvent: không argument chứa mã;
 *     peekDevOtpInbox trả đúng mã (Review Focus 1 — không môi trường nào log OTP).
 *  2. peekDevOtpInbox: mã CUỐI theo (channel,target,purpose) ở dev; production
 *     throw typed DEV_OTP_INBOX_UNAVAILABLE (seam unreachable by construction).
 *  3. Route /api/dev/otp-inbox: 404 ở production TRƯỚC khi chạm inbox (spy
 *     peekDevOtpInbox không bị gọi); dev trả mã từ inbox.
 *  4. Fail-closed adapter (production): sendOtp throw typed
 *     OTP_DELIVERY_UNAVAILABLE + message nêu đủ điều kiện triển khai còn thiếu
 *     (provider email/SMS thật — Ambiguities A1).
 *  5. sendSecurityNotice KHÔNG BAO GIỜ throw (fail-open, spec §5.3.1 "when
 *     feasible") — log qua captureEvent KHÔNG chứa notice body/target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getOtpDeliveryAdapter,
  peekDevOtpInbox,
  type OtpDeliveryAdapter,
} from "@/src/lib/verification-delivery";
import * as deliveryModule from "@/src/lib/verification-delivery";
import * as observability from "@/src/lib/observability";
import { GET as devInboxGet } from "../../app/api/dev/otp-inbox/route";
import type { OtpChannel, OtpPurpose } from "@/src/lib/otp";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TARGET = "nguoi.dung@loaviet.test";
const PURPOSE: OtpPurpose = "email_verification";
const CHANNEL: OtpChannel = "email";

const devRequest = (query: Record<string, string>) =>
  new Request(
    `http://localhost:3000/api/dev/otp-inbox?${new URLSearchParams(query).toString()}`,
    { method: "GET" },
  );

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
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── 1. In-memory adapter: lưu inbox, không bao giờ log ────────────────────────

describe("in-memory adapter (dev/test) — lưu inbox, KHÔNG log mã", () => {
  it("sendOtp lưu mã vào inbox và KHÔNG BAO GIỜ log — spy console + captureEvent không chứa mã; peek trả đúng mã", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const eventSpy = vi.spyOn(observability, "captureEvent");

    const adapter = getOtpDeliveryAdapter();
    expect(adapter.name).toBe("in-memory");
    const code = "654321";
    await adapter.sendOtp({ to: TARGET, code, purpose: PURPOSE, channel: CHANNEL });

    // Review Focus 1: không môi trường nào log OTP — quét MỌI argument của mọi
    // spy (kể cả warn/info/debug)
    const dumps: string[] = [];
    for (const spy of [logSpy, errSpy, warnSpy, infoSpy, debugSpy, eventSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) dumps.push(argText(arg));
      }
    }
    expect(dumps.join("\n")).not.toContain(code);

    // mã nằm trong inbox — seam dev/test đọc được
    expect(peekDevOtpInbox(TARGET, PURPOSE, CHANNEL)).toBe(code);
  });

  it("sendOtp KHÔNG throw khi mọi thứ bình thường (delivery dev luôn thành công)", async () => {
    const adapter = getOtpDeliveryAdapter();
    await expect(
      adapter.sendOtp({ to: "0901234567", code: "111222", purpose: "phone_verification", channel: "phone" }),
    ).resolves.toBeUndefined();
    expect(peekDevOtpInbox("0901234567", "phone_verification", "phone")).toBe("111222");
  });
});

// ─── 2. peekDevOtpInbox — semantics theo (channel,target,purpose) ──────────────

describe("peekDevOtpInbox — mã cuối theo (channel,target,purpose)", () => {
  it("dev: trả mã CUỐI cho key — mã mới đè mã cũ, key khác không đụng nhau", async () => {
    const adapter = getOtpDeliveryAdapter();
    await adapter.sendOtp({ to: TARGET, code: "100001", purpose: PURPOSE, channel: CHANNEL });
    await adapter.sendOtp({ to: TARGET, code: "200002", purpose: PURPOSE, channel: CHANNEL });
    // mã cuối thắng
    expect(peekDevOtpInbox(TARGET, PURPOSE, CHANNEL)).toBe("200002");

    // key khác (target/purpose/channel) — value riêng, không đè lẫn nhau
    await adapter.sendOtp({ to: "khac@loaviet.test", code: "300003", purpose: PURPOSE, channel: CHANNEL });
    expect(peekDevOtpInbox("khac@loaviet.test", PURPOSE, CHANNEL)).toBe("300003");
    expect(peekDevOtpInbox(TARGET, PURPOSE, CHANNEL)).toBe("200002");
    expect(peekDevOtpInbox(TARGET, "password_recovery", CHANNEL)).toBeNull(); // chưa có
  });

  it("production: throw typed DEV_OTP_INBOX_UNAVAILABLE (seam unreachable by construction)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => peekDevOtpInbox(TARGET, PURPOSE, CHANNEL)).toThrowError(
      /DEV_OTP_INBOX_UNAVAILABLE/,
    );
  });
});

// ─── 3. Route dev-only /api/dev/otp-inbox ─────────────────────────────────────

describe("route /api/dev/otp-inbox — 404 ở production TRƯỚC khi chạm inbox", () => {
  it("dev: trả mã từ inbox theo ?target=&purpose=&channel=", async () => {
    const adapter = getOtpDeliveryAdapter();
    await adapter.sendOtp({ to: "route.dev@loaviet.test", code: "777888", purpose: PURPOSE, channel: CHANNEL });

    const res = await devInboxGet(
      devRequest({ target: "route.dev@loaviet.test", purpose: PURPOSE, channel: CHANNEL }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "777888" });
  });

  it("dev: thiếu query → 400 (không crash)", async () => {
    const res = await devInboxGet(devRequest({}));
    expect(res.status).toBe(400);
  });

  it("production: 404 với body rỗng TRƯỚC khi chạm inbox — peekDevOtpInbox không bị gọi", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const peekSpy = vi.spyOn(deliveryModule, "peekDevOtpInbox");

    const res = await devInboxGet(
      devRequest({ target: "bi-an@loaviet.test", purpose: PURPOSE, channel: CHANNEL }),
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    // "before any inbox access" — seam thậm chí không được gọi (nếu gọi, nó throw
    // DEV_OTP_INBOX_UNAVAILABLE → route 500, không phải 404)
    expect(peekSpy).not.toHaveBeenCalled();
  });
});

// ─── 4. Fail-closed adapter (production) ──────────────────────────────────────

describe("fail-closed adapter (production) — typed OTP_DELIVERY_UNAVAILABLE", () => {
  let adapter: OtpDeliveryAdapter;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    adapter = getOtpDeliveryAdapter();
  });

  it("sendOtp throw typed OTP_DELIVERY_UNAVAILABLE + nêu điều kiện triển khai còn thiếu (provider email/SMS thật)", async () => {
    expect(adapter.name).toBe("fail-closed");
    const err = await adapter
      .sendOtp({ to: TARGET, code: "999000", purpose: PURPOSE, channel: CHANNEL })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("OTP_DELIVERY_UNAVAILABLE");
    // message phải NÊU ĐỦ prerequisite còn thiếu: nhà cung cấp email/SMS thật
    expect((err as Error).message).toMatch(/email\/SMS|provider|nhà cung cấp/);
    // KHÔNG chứa mã thô trong error (spec §4.8)
    expect((err as Error).message).not.toContain("999000");
  });
});

// ─── 5. sendSecurityNotice — fail-open ───────────────────────────────────────

describe("sendSecurityNotice — KHÔNG BAO GIỜ throw (fail-open, spec §5.3.1)", () => {
  it("fail-closed adapter (production): resolve, log qua captureEvent KHÔNG chứa notice body/target", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const eventSpy = vi.spyOn(observability, "captureEvent");

    const adapter = getOtpDeliveryAdapter();
    const notice = {
      to: "ken.tan.cong@loaviet.test",
      channel: CHANNEL,
      subjectKey: "email_changed_notice",
    } as const;
    // fail-open: không throw — caller (Task 6) tiếp tục flow đổi danh tính
    await expect(adapter.sendSecurityNotice(notice)).resolves.toBeUndefined();

    expect(eventSpy).toHaveBeenCalled();
    // meta CHỈ channel + subjectKey (template key, không phải body) —
    // KHÔNG chứa target (raw email — spec §4.8), KHÔNG chứa notice body
    const call = eventSpy.mock.calls.at(-1)!;
    expect(call[2]).toEqual({ channel: notice.channel, subjectKey: notice.subjectKey });
    const dumps = eventSpy.mock.calls.map((c) => c.map(argText).join(" ")).join("\n");
    expect(dumps).not.toContain(notice.to);
  });

  it("in-memory adapter (dev): resolve, log qua captureEvent KHÔNG chứa notice body/target", async () => {
    const eventSpy = vi.spyOn(observability, "captureEvent");

    const adapter = getOtpDeliveryAdapter();
    const notice = {
      to: "notice.dev@loaviet.test",
      channel: CHANNEL,
      subjectKey: "phone_changed_notice",
    } as const;
    await expect(adapter.sendSecurityNotice(notice)).resolves.toBeUndefined();

    expect(eventSpy).toHaveBeenCalled();
    // meta CHỈ channel + subjectKey — không target, không body (spec §4.8)
    const call = eventSpy.mock.calls.at(-1)!;
    expect(call[2]).toEqual({ channel: notice.channel, subjectKey: notice.subjectKey });
    const dumps = eventSpy.mock.calls.map((c) => c.map(argText).join(" ")).join("\n");
    expect(dumps).not.toContain(notice.to);
  });
});
