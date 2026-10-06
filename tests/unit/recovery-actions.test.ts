/**
 * Account recovery — unit tests (plan Task 7, spec §7.2/§7.7: enumeration-safe,
 * IP + identifier rate limits, OTP tới kênh ĐÃ XÁC MINH, completion thu hồi
 * MỌI session kể cả session hiện tại — Review Focus 3).
 *
 * Cơ chế mock: `server-only` + `next/headers` (headers điều khiển được cho IP
 * rate limit + ipHash audit) + `@/src/prisma/db.client` (in-memory User +
 * OtpCode store, AuditEvent/Notification create spy) + `@/src/lib/session`
 * (revokeAllUserSessions SPY — đúng seam recovery.ts tiêu thụ) +
 * `@/src/lib/verification-delivery` (adapter spy). OTP core, rate limiter,
 * hashPassword GIỮ BẢN THẬT — cùng phong cách otp.test.ts / session.test.ts.
 *
 * Hợp đồng (plan Task 7 Step 1 — recovery-abuse gate):
 *  1. requestPasswordRecoveryAction trả CÙNG thông báo trung tính byte-đối-byte
 *     cho identifier có thật lẫn không khớp (spec §7.7 chống enumeration) —
 *     pin bằng capture từ một request control, KHÔNG import constant (file
 *     "use server" chỉ export được async function — message sống trong module).
 *  2. Identifier không khớp → KHÔNG gửi OTP (adapter spy không gọi) NHƯNG vẫn
 *     tiêu tốn budget IP rate limit (chống spam dò).
 *  3. confirmPasswordRecoveryAction mã hợp lệ → hash mới + revokeAllUserSessions
 *     gọi KHÔNG exceptSessionId (Review Focus 3 — stale-session reuse sau
 *     recovery: session tạo TRƯỚC khi reset không còn tác quyền).
 *  4. Sai/hết hạn/dùng lại mã → lỗi typed, mật khẩu KHÔNG đổi.
 *  5. Tài khoản có phone ĐÃ XÁC MINH → OTP channel=phone (lost-email path)
 *     và ngược lại email → channel=email.
 *  6. Identifier khớp kênh CHƯA XÁC MINH → thông báo trung tính, KHÔNG OTP
 *     (recovery qua kênh chưa xác minh là vector chiếm tài khoản).
 *  7. User KHÔNG có kênh đã xác minh nào → thông báo trung tính, KHÔNG OTP
 *     (out-of-band là manual fallback của runbook — Ambiguities A3).
 *  8. IP rate limit: request thứ 6 trong 10 phút → lỗi form rate-limit.
 *  9. Identifier không đúng dạng email CŨNG phone → lỗi nhập liệu TRƯỚC khi
 *     tra cứu db (không tốn lookup).
 * 10. (collapse) Mọi error code OTP (cooldown/per-target/delivery) của request
 *     path và mọi failure code verify của confirm path COLLAPSE về cùng thông
 *     báo — không phân biệt được "tồn tại nhưng bị chặn" vs "không tồn tại".
 * 11. (spec §7.1) Confirm cũng có IP rate limit riêng (OTP verify endpoint).
 * 12. (spec §4.8) Không log/emit identifier thô (email/phone) hay mã OTP qua
 *     console/captureEvent ở bất kỳ path nào.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── headers() điều khiển được — IP cho rate limit + ipHash audit ─────────────

const headerState = vi.hoisted(() => ({
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerState.headers),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
    has: () => false,
    getAll: () => [],
  })),
}));

// ─── Session seam — revokeAllUserSessions SPY (Review Focus 3) ────────────────

const sessionSpies = vi.hoisted(() => ({
  revokeAllUserSessions: vi.fn(async () => 3),
}));

vi.mock("@/src/lib/session", () => ({
  SESSION_COOKIE: "sp_session",
  createSession: vi.fn(async () => {}),
  getSessionFromCookie: vi.fn(async () => null),
  revokeSession: vi.fn(async () => {}),
  revokeAllUserSessions: sessionSpies.revokeAllUserSessions,
}));

// ─── Adapter delivery spy — sendOtp/sendSecurityNotice ───────────────────────

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
  peekDevOtpInbox: vi.fn(() => null),
}));

// ─── db.client mock: in-memory User + OtpCode, AuditEvent/Notification spy ─────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  otpRows: [] as Array<Record<string, unknown>>,
  auditRows: [] as Array<Record<string, unknown>>,
  notificationRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  // Field proxy cho lambda predicate — chỉ dùng single-clause ops của repo.
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

  // OTP store: rows chèn theo thời gian → match CUỐI array = createdAt mới nhất
  // (otp.ts orderBy createdAt desc — cùng cơ chế otp.test.ts).
  const otpQuery = (preds: Pred[]) => ({
    where: (pred: Pred) => otpQuery([...preds, pred]),
    orderBy: () => otpQuery(preds),
    first: async () => {
      const hits = dbState.otpRows.filter((r) => preds.every((p) => matches(r, p)));
      return hits.length === 0 ? null : { ...hits[hits.length - 1]! };
    },
    updateAll: async (data: Row) => {
      const hits = dbState.otpRows.filter((r) => preds.every((p) => matches(r, p)));
      for (const r of hits) Object.assign(r, data);
      return hits.map((r) => ({ ...r }));
    },
    delete: async () => {
      const hits = dbState.otpRows.filter((r) => preds.every((p) => matches(r, p)));
      for (const r of hits) {
        const i = dbState.otpRows.indexOf(r);
        if (i >= 0) dbState.otpRows.splice(i, 1);
      }
      return hits.map((r) => ({ ...r }));
    },
    create: async (data: Row) => {
      const row = {
        id: `otp-${dbState.otpRows.length + 1}`,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date().toISOString(),
        ...data,
      };
      dbState.otpRows.push(row);
      return { ...row };
    },
  });

  const userQuery = (preds: Pred[]) => ({
    where: (pred: Pred) => userQuery([...preds, pred]),
    first: async () => {
      const hits = dbState.users.filter((r) => preds.every((p) => matches(r, p)));
      return hits.length === 0 ? null : { ...hits[0]! };
    },
    updateAll: async (data: Row) => {
      const hits = dbState.users.filter((r) => preds.every((p) => matches(r, p)));
      for (const r of hits) Object.assign(r, data);
      return hits.map((r) => ({ ...r }));
    },
  });

  return {
    db: {
      orm: {
        public: {
          User: {
            where: (pred: Pred) => userQuery([pred]),
          },
          OtpCode: {
            where: (pred: Pred) => otpQuery([pred]),
            create: (data: Row) => otpQuery([]).create(data),
          },
          AuditEvent: {
            create: vi.fn(async (data: Row) => {
              dbState.auditRows.push(data);
              return data;
            }),
          },
          Notification: {
            create: vi.fn(async (data: Row) => {
              dbState.notificationRows.push(data);
              return data;
            }),
          },
        },
      },
      transaction: vi.fn(),
    },
  };
});

import {
  requestPasswordRecoveryAction,
  confirmPasswordRecoveryAction,
  type RecoveryFormState,
} from "@/src/lib/actions/recovery";
import { revokeAllUserSessions } from "@/src/lib/session";
import { resetRateLimits } from "@/src/lib/rate-limit";
import { verifyPassword } from "@/src/lib/auth";
import * as observability from "@/src/lib/observability";

const revokeAllSpy = vi.mocked(revokeAllUserSessions);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OLD_HASH = "$2a$10$oldoldoldoldoldoldoldoldoldoldoldoldoldoldoldou";

/** User fixture — email/phone + trạng thái xác minh từng kênh (spec §5.3). */
const makeUser = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "user-1",
  name: "Người dùng",
  role: "buyer",
  passwordHash: OLD_HASH,
  ...over,
});

const fd = (fields: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};

const requestRecovery = (identifier: string): Promise<RecoveryFormState> =>
  requestPasswordRecoveryAction({}, fd({ identifier }));

const confirmRecovery = (fields: Record<string, string>): Promise<RecoveryFormState> =>
  confirmPasswordRecoveryAction({}, fd(fields));

const EMAIL = "nguoi.mua@loaviet.test";
const PHONE = "0901234567";
const CONTROL_EMAIL = "control@loaviet.test";

/**
 * Capture thông báo trung tính từ một request control (tài khoản có email đã
 * xác minh) — mọi outcome khác phải byte-equal chuỗi này. Không import constant
 * từ module "use server" (chỉ export được async function).
 */
const captureNeutralMessage = async (): Promise<string> => {
  dbState.users.push(
    makeUser({
      id: "user-control",
      email: CONTROL_EMAIL,
      emailVerifiedAt: "2026-10-01T00:00:00.000Z",
      phone: null,
    }),
  );
  const res = await requestRecovery(CONTROL_EMAIL);
  if (res.success === undefined) throw new Error("fixture control phải ra thông báo trung tính");
  return res.success;
};

/** Mã vừa "gửi" qua adapter spy — plaintext duy nhất test được phép biết. */
const lastSentCode = (): string => {
  const call = delivery.sendOtp.mock.calls.at(-1);
  if (!call) throw new Error("adapter chưa được gọi — không có mã để đọc");
  return (call[0] as { code: string }).code;
};

/** Mã sai chắc chắn (không trùng mã thật — tránh trúng 1/1_000_000). */
const wrongCodeFor = (code: string): string => (code === "000000" ? "999999" : "000000");

/** Các target adapter đã "gửi" tới — để đếm per-identifier chính xác. */
const sentTargets = (): string[] =>
  delivery.sendOtp.mock.calls.map((c) => (c[0] as { to: string }).to);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  headerState.headers = new Headers();
  dbState.users.length = 0;
  dbState.otpRows.length = 0;
  dbState.auditRows.length = 0;
  dbState.notificationRows.length = 0;
  delivery.sendOtp.mockReset().mockResolvedValue(undefined);
  delivery.sendSecurityNotice.mockReset().mockResolvedValue(undefined);
  revokeAllSpy.mockReset().mockResolvedValue(3);
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── 1+2+6+7. Thông báo trung tính + không OTP cho kênh chưa/không xác minh ──

describe("requestPasswordRecoveryAction — thông báo trung tính (spec §7.7)", () => {
  it("identifier CÓ TÀI KHOẢN khớp và identifier KHÔNG khớp → CÙNG thông báo byte-đối-byte", async () => {
    const neutral = await captureNeutralMessage(); // control: email đã xác minh
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );

    const existing = await requestRecovery(EMAIL);
    const unknown = await requestRecovery("khong.co@loaviet.test");

    // Byte-equal — không phân biệt được tồn tại hay không (spec §7.7)
    expect(existing).toEqual({ success: neutral });
    expect(unknown).toEqual({ success: neutral });
    expect(existing.success).toBe(unknown.success);
    expect(existing.error).toBeUndefined();
    expect(unknown.error).toBeUndefined();
    // Identifier có thật → gửi đúng 1 mã cho nó; identifier lạ → KHÔNG gửi
    expect(sentTargets().filter((t) => t === EMAIL)).toHaveLength(1);
    expect(sentTargets()).not.toContain("khong.co@loaviet.test");
  });

  it("identifier không khớp → adapter KHÔNG được gọi nhưng VẪN tiêu tốn budget IP rate limit", async () => {
    // 5 request cho identifier lạ — đúng budget 5/10 phút/IP
    for (let i = 0; i < 5; i++) {
      const res = await requestRecovery(`khong.co.${i}@loaviet.test`);
      expect(res.success).toBeDefined();
    }
    expect(delivery.sendOtp).not.toHaveBeenCalled();

    // Request thứ 6 (identifier CÓ thật) → bị chặn vì budget IP đã cạn —
    // kẻ spam dò identifier lạ không mua được thêm budget cho identifier thật.
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );
    const sixth = await requestRecovery(EMAIL);
    expect(sixth.success).toBeUndefined();
    expect(sixth.error).toContain("Quá nhiều lần thử");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("identifier khớp email CHƯA XÁC MINH → thông báo trung tính, KHÔNG OTP (kênh chưa xác minh là vector chiếm tài khoản)", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: null, phone: null }),
    );

    const res = await requestRecovery(EMAIL);
    expect(res).toEqual({ success: neutral });
    expect(sentTargets()).not.toContain(EMAIL);
    expect(dbState.otpRows).toHaveLength(1); // chỉ row của control
  });

  it("identifier khớp phone CHƯA XÁC MINH → thông báo trung tính, KHÔNG OTP", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: null, phone: PHONE, phoneVerifiedAt: null }),
    );

    const res = await requestRecovery(PHONE);
    expect(res).toEqual({ success: neutral });
    expect(sentTargets()).not.toContain(PHONE);
  });

  it("user KHÔNG có kênh đã xác minh nào → thông báo trung tính, KHÔNG OTP (out-of-band là manual fallback — Ambiguities A3)", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: null, phone: PHONE, phoneVerifiedAt: null }),
    );

    // Thử cả hai kênh — đều không khớp kênh đã xác minh
    expect(await requestRecovery(EMAIL)).toEqual({ success: neutral });
    expect(await requestRecovery(PHONE)).toEqual({ success: neutral });
    expect(sentTargets()).not.toContain(EMAIL);
    expect(sentTargets()).not.toContain(PHONE);
  });

  it("identifier khớp đúng user sở hữu kênh đó — không cross-channel (phone của user-2 không khớp user-1)", async () => {
    await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
      makeUser({
        id: "user-2",
        email: "khac@loaviet.test",
        emailVerifiedAt: "2026-10-01T00:00:00.000Z",
        phone: PHONE,
        phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
      }),
    );

    // Nhập PHONE (của user-2) → khớp user-2 qua kênh phone ĐÃ xác minh
    const res = await requestRecovery(PHONE);
    expect(res.success).toBeDefined();
    const sent = delivery.sendOtp.mock.calls
      .map((c) => c[0] as { to: string; purpose: string; channel: string })
      .find((p) => p.to === PHONE);
    expect(sent).toMatchObject({ to: PHONE, purpose: "password_recovery", channel: "phone" });
  });
});

// ─── 5. Kênh gửi theo kênh ĐÃ XÁC MINH của identifier ──────────────────────────

describe("requestPasswordRecoveryAction — kênh OTP theo identifier (lost-email / lost-phone)", () => {
  it("tài khoản có phone ĐÃ XÁC MINH → OTP channel=phone, target=phone (lost-email path)", async () => {
    await captureNeutralMessage();
    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: "2026-10-01T00:00:00.000Z",
        phone: PHONE,
        phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
      }),
    );

    // Mất email → nhập phone → mã tới phone
    await requestRecovery(PHONE);
    const sent = delivery.sendOtp.mock.calls
      .map((c) => c[0] as { to: string; channel: string; purpose: string })
      .find((p) => p.to === PHONE);
    expect(sent).toMatchObject({ to: PHONE, channel: "phone", purpose: "password_recovery" });
  });

  it("tài khoản có email ĐÃ XÁC MINH → OTP channel=email, target=email (lost-phone path)", async () => {
    await captureNeutralMessage();
    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: "2026-10-01T00:00:00.000Z",
        phone: PHONE,
        phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
      }),
    );

    // Mất phone → nhập email → mã tới email
    await requestRecovery(EMAIL);
    const sent = delivery.sendOtp.mock.calls
      .map((c) => c[0] as { to: string; channel: string; purpose: string })
      .find((p) => p.to === EMAIL);
    expect(sent).toMatchObject({ to: EMAIL, channel: "email", purpose: "password_recovery" });
  });

  it("identifier có user khớp → audit 'user.recovery_requested' (không PII trong detail)", async () => {
    await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );

    await requestRecovery(EMAIL);
    const row = dbState.auditRows.find(
      (r) => r.action === "user.recovery_requested" && r.actorId === "user-1",
    );
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      actorId: "user-1",
      subjectId: "user-1",
      resourceType: "User",
      resourceId: "user-1",
    });
    // detail KHÔNG chứa email thô (spec §4.8)
    expect(JSON.stringify(row)).not.toContain(EMAIL);
  });
});

// ─── 8+9+10. Rate limit IP + validation + collapse lỗi OTP ─────────────────────

describe("requestPasswordRecoveryAction — rate limit + validation + collapse", () => {
  it("IP rate limit: request thứ 6 trong 10 phút → lỗi form rate-limit (5 / 10 phút / IP)", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );

    // 5 request đầu (identifier lạ, không tốn OTP) → đều qua được limiter
    for (let i = 0; i < 5; i++) {
      const res = await requestRecovery(`khong.co.${i}@loaviet.test`);
      expect(res.success).toBeDefined();
    }
    expect(delivery.sendOtp).not.toHaveBeenCalled();

    // Request thứ 6 → bị chặn theo IP — kể cả identifier có thật
    const sixth = await requestRecovery(EMAIL);
    expect(sixth.success).toBeUndefined();
    expect(sixth.error).toContain("Quá nhiều lần thử");
    // Request bị chặn KHÔNG gửi mã
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("hết window 10 phút → budget IP reset, request lại được", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );

    for (let i = 0; i < 5; i++) await requestRecovery(`khong.co.${i}@loaviet.test`);
    expect((await requestRecovery(EMAIL)).error).toContain("Quá nhiều lần thử");

    vi.advanceTimersByTime(10 * 60_000 + 1_000);
    const after = await requestRecovery(EMAIL);
    expect(after.success).toBeDefined();
    expect(after.error).toBeUndefined();
  });

  it("identifier không đúng dạng email CŨNG phone → lỗi nhập liệu TRƯỚC khi tra cứu (không đụng db)", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );

    // 5 giá trị rác — đúng budget IP 5/10 phút, không request nào chạm db
    for (const bad of ["", "   ", "khong-dung-dinh-dang", "12345", "a@b"]) {
      const res = await requestRecovery(bad);
      expect(res.success, `identifier "${bad}" phải là lỗi nhập liệu`).toBeUndefined();
      expect(res.error).toBeDefined();
      // Lỗi nhập liệu — KHÔNG phải rate limit (đó là lỗi khác)
      expect(res.error).not.toContain("Quá nhiều lần thử");
    }
    // Không request OTP nào, không user nào bị đọc (lookup chỉ xảy ra sau validate)
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("cooldown OTP (request thứ 2 trong 60s cho identifier có thật) → COLLAPSE về cùng thông báo trung tính", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );

    const first = await requestRecovery(EMAIL);
    const second = await requestRecovery(EMAIL); // requestOtp → OTP_RATE_LIMITED (cooldown)
    // Collapse: kẻ dò không phân biệt được "tồn tại nhưng cooldown" vs "không tồn tại"
    expect(first).toEqual({ success: neutral });
    expect(second).toEqual({ success: neutral });
    // Chỉ 1 mã gửi cho EMAIL — request bị cooldown không gửi mã thứ hai
    expect(sentTargets().filter((t) => t === EMAIL)).toHaveLength(1);
  });

  it("delivery fail (adapter throw) → COLLAPSE về cùng thông báo trung tính (provider fail-closed không thành oracle)", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );
    delivery.sendOtp.mockImplementationOnce(() => {
      throw new Error("provider down");
    });

    const res = await requestRecovery(EMAIL);
    expect(res).toEqual({ success: neutral });
  });
});

// ─── 3+4. Confirm — hash mới + revoke MỌI session + lỗi typed ─────────────────

describe("confirmPasswordRecoveryAction — đặt lại mật khẩu + thu hồi mọi session", () => {
  const seedVerifiedEmailUser = (): void => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: "2026-10-01T00:00:00.000Z", phone: null }),
    );
  };

  const requestCode = async (): Promise<string> => {
    await requestRecovery(EMAIL);
    return lastSentCode();
  };

  it("mã hợp lệ → hash mật khẩu MỚI (verify được) + revokeAllUserSessions KHÔNG exceptSessionId (Review Focus 3)", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    const res = await confirmRecovery({
      identifier: EMAIL,
      code,
      newPassword: "mat-khau-moi-123",
    });

    expect(res.success).toBeDefined();
    expect(res.error).toBeUndefined();

    // Hash mới — mật khẩu cũ KHÔNG còn verify được, mật khẩu mới verify được
    const user = dbState.users.find((u) => u.id === "user-1")!;
    expect(user.passwordHash).not.toBe(OLD_HASH);
    expect(await verifyPassword("mat-khau-moi-123", user.passwordHash as string)).toBe(true);
    expect(await verifyPassword("mat-kau-cu-123", user.passwordHash as string)).toBe(false);

    // Review Focus 3: revoke MỌI session — gọi ĐÚNG 2 tham số, KHÔNG có
    // exceptSessionId (session hiện tại cũng chết — stale-session reuse đóng).
    expect(revokeAllSpy).toHaveBeenCalledTimes(1);
    expect(revokeAllSpy).toHaveBeenCalledWith("user-1", "password_recovery");

    // audit "user.recovery_completed" + notify in-app + security notice kênh đã xác minh
    expect(
      dbState.auditRows.find((r) => r.action === "user.recovery_completed" && r.actorId === "user-1"),
    ).toBeDefined();
    expect(dbState.notificationRows).toHaveLength(1);
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: EMAIL, channel: "email" }),
    );
  });

  it("mã hợp lệ qua kênh PHONE đã xác minh → hash mới + revoke mọi session (lost-email path khép kín)", async () => {
    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: null,
        phone: PHONE,
        phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    await requestRecovery(PHONE);
    const code = lastSentCode();

    const res = await confirmRecovery({ identifier: PHONE, code, newPassword: "moi-moi-moi" });
    expect(res.success).toBeDefined();
    const user = dbState.users.find((u) => u.id === "user-1")!;
    expect(await verifyPassword("moi-moi-moi", user.passwordHash as string)).toBe(true);
    expect(revokeAllSpy).toHaveBeenCalledWith("user-1", "password_recovery");
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, channel: "phone" }),
    );
  });

  it("sai mã → lỗi typed, mật khẩu KHÔNG đổi, KHÔNG revoke session nào", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    const res = await confirmRecovery({
      identifier: EMAIL,
      code: wrongCodeFor(code),
      newPassword: "khong-thanh-cong",
    });

    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(revokeAllSpy).not.toHaveBeenCalled();
    expect(
      dbState.auditRows.find((r) => r.action === "user.recovery_completed"),
    ).toBeUndefined();
  });

  it("mã hết hạn → cùng lỗi collapsed, mật khẩu KHÔNG đổi", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();
    vi.advanceTimersByTime(10 * 60_000 + 1_000); // OTP_TTL_MINUTES = 10

    const res = await confirmRecovery({ identifier: EMAIL, code, newPassword: "khong-thanh-cong" });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(revokeAllSpy).not.toHaveBeenCalled();
  });

  it("dùng lại mã đã consume → cùng lỗi collapsed (single-use, spec §5.3)", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    const first = await confirmRecovery({ identifier: EMAIL, code, newPassword: "lan-mot-123" });
    expect(first.success).toBeDefined();

    // Mã đã consume — dùng lại cho "đặt lại lần 2" phải fail
    const second = await confirmRecovery({ identifier: EMAIL, code, newPassword: "lan-hai-123" });
    expect(second.success).toBeUndefined();
    expect(second.error).toBeDefined();
    // Mật khẩu giữ nguyên của lần 1 — không bị ghi đè
    expect(await verifyPassword("lan-mot-123", dbState.users.find((u) => u.id === "user-1")!.passwordHash as string)).toBe(true);
  });

  it("identifier không khớp tài khoản nào → CÙNG lỗi với sai mã (confirm không thành oracle enumeration)", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    const unknown = await confirmRecovery({
      identifier: "khong.co@loaviet.test",
      code,
      newPassword: "gi-do-123",
    });
    const wrongCode = await confirmRecovery({
      identifier: EMAIL,
      code: wrongCodeFor(code),
      newPassword: "gi-do-123",
    });

    // Hai lỗi byte-đối-byte như nhau — không phân biệt "không có tài khoản" vs "mã sai"
    expect(unknown.error).toBe(wrongCode.error);
    expect(unknown.success).toBeUndefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(revokeAllSpy).not.toHaveBeenCalled();
  });

  it("identifier khớp kênh CHƯA xác minh → cùng lỗi collapsed (không đặt lại được qua kênh chưa xác minh)", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: null, phone: null }),
    );

    const res = await confirmRecovery({ identifier: EMAIL, code: "123456", newPassword: "gi-do-123" });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(revokeAllSpy).not.toHaveBeenCalled();
  });

  it("mật khẩu mới quá ngắn → lỗi nhập liệu, mật khẩu KHÔNG đổi, mã KHÔNG bị consume", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    const res = await confirmRecovery({ identifier: EMAIL, code, newPassword: "12345" });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    // Mã chưa bị consume — validate trước verify (người dùng sửa mật khẩu rồi thử lại được)
    expect(dbState.otpRows.find((r) => r.target === EMAIL)!.consumedAt).toBeNull();
  });

  it("confirm cũng có IP rate limit riêng (spec §7.1 — OTP verify endpoint)", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    // 10 lần sai liên tiếp trong window → request thứ 11 bị chặn theo IP
    for (let i = 0; i < 10; i++) {
      const res = await confirmRecovery({ identifier: EMAIL, code: wrongCodeFor(code), newPassword: "gi-do-123" });
      expect(res.error).toBeDefined();
      expect(res.error).not.toContain("Quá nhiều lần thử");
    }
    const eleventh = await confirmRecovery({ identifier: EMAIL, code, newPassword: "moi-that-123" });
    expect(eleventh.error).toContain("Quá nhiều lần thử");
    // Mã ĐÚNG cũng không qua được khi IP bị chặn — mật khẩu giữ nguyên
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(revokeAllSpy).not.toHaveBeenCalled();
  });
});

// ─── 12. Spec §4.8 — không emit identifier thô / mã OTP ra log ────────────────

describe("recovery actions — KHÔNG emit PII/OTP ra log (spec §4.8)", () => {
  const argText = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.message} ${a.stack ?? ""}`;
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  };

  it("mọi path (gửi, không khớp, sai mã, confirm thành công) không log email/phone/mã OTP", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const eventSpy = vi.spyOn(observability, "captureEvent");

    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: "2026-10-01T00:00:00.000Z",
        phone: PHONE,
        phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
      }),
    );

    try {
      await requestRecovery(EMAIL); // gửi thành công
      const code = lastSentCode();
      await requestRecovery("khong.co@loaviet.test"); // không khớp
      await requestRecovery(PHONE); // kênh phone
      await confirmRecovery({ identifier: EMAIL, code: wrongCodeFor(code), newPassword: "gi-do-123" }); // sai mã
      await confirmRecovery({ identifier: EMAIL, code, newPassword: "moi-that-123" }); // thành công

      const dumps: string[] = [];
      for (const spy of [logSpy, errSpy, warnSpy, eventSpy]) {
        for (const call of spy.mock.calls) {
          for (const arg of call) dumps.push(argText(arg));
        }
      }
      const dump = dumps.join("\n");
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(EMAIL);
      expect(dump).not.toContain(PHONE);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
      eventSpy.mockRestore();
    }
  });
});
