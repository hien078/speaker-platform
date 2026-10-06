/**
 * Account recovery — unit tests (plan Task 7, spec §7.2/§7.7: enumeration-safe,
 * IP + identifier rate limits, OTP tới kênh ĐÃ XÁC MINH, completion thu hồi
 * MỌI session kể cả session hiện tại — Review Focus 3).
 *
 * Cơ chế mock: `server-only` + `next/headers` (headers điều khiển được cho IP
 * rate limit + ipHash audit) + `next/server` (after() — callback schedule
 * post-response, chạy thủ công qua runScheduledAfter) + `@/src/prisma/db.client`
 * (in-memory User + OtpCode store, AuditEvent/Notification create spy,
 * transaction truyền tx = { orm } cho callback) + `@/src/lib/session`
 * (revokeAllUserSessionsTx SPY — đúng seam recovery.ts tiêu thụ) +
 * `@/src/lib/verification-delivery` (adapter spy). OTP core, rate limiter,
 * hashPassword GIỮ BẢN THẬT — cùng phong cách otp.test.ts / session.test.ts.
 *
 * Hợp đồng (plan Task 7 Step 1 — recovery-abuse gate + REVIEW FIX):
 *  1. requestPasswordRecoveryAction trả CÙNG thông báo trung tính byte-đối-byte
 *     cho identifier có thật lẫn không khớp (spec §7.7 chống enumeration) —
 *     pin bằng capture từ một request control, KHÔNG import constant (file
 *     "use server" chỉ export được async function — message sống trong module).
 *  2. Identifier không khớp → KHÔNG gửi OTP (adapter spy không gọi) NHƯNG vẫn
 *     tiêu tốn budget IP rate limit (chống spam dò).
 *  3. confirmPasswordRecoveryAction mã hợp lệ → hash mới + revoke MỌI session
 *     BÊN TRONG MỘT db.transaction (review fix #3: password update +
 *     revokeAllUserSessionsTx cùng tx — thất bại giữa chừng không để lại mật
 *     khẩu mới + session cũ còn tác quyền) — KHÔNG exceptSessionId (Review
 *     Focus 3 — stale-session reuse sau recovery).
 *  4. Sai/hết hạn/dùng lại mã → lỗi typed byte-đối-byte như nhau, mật khẩu
 *     KHÔNG đổi.
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
 * 11. (spec §7.1) Confirm có IP rate limit riêng + PER-IDENTIFIER limit keyed
 *     bằng HMAC hash của identifier chuẩn hóa (review fix #4) — limit theo
 *     identifier trả CÙNG lỗi collapsed (không cho kẻ dò phân biệt).
 * 12. (spec §4.8) Không log/emit identifier thô (email/phone), mã OTP, MẬT
 *     KHẨU qua console/captureEvent/captureError ở bất kỳ path nào.
 * 13. (review fix #2 — timing oracle) Matched path KHÔNG chờ requestOtp/audit:
 *     action trả trung tính NGAY (after() schedule post-response) — adapter
 *     promise không bao giờ resolve vẫn trả response; requestOtp throw vẫn trả
 *     CÙNG thông báo trung tính (lỗi được captureError, không PII).
 * 14. (review fix #1 — notice mọi kênh) Completion gửi security notice tới
 *     MỌI kênh ĐÃ XÁC MINH của user (emailVerifiedAt/phoneVerifiedAt != null),
 *     không chỉ kênh vừa dùng — kẻ chiếm SIM/email giữ kênh đó, kênh còn lại
 *     của nạn nhân phải được báo (spec §5.3.1/§7.7).
 * 15. (review fix #5 — test gaps) Mã của purpose KHÁC (email_verification)
 *     không dùng được cho recovery; confirm với mã HỢP LỆ nhưng kênh CHƯA xác
 *     minh (row seed trực tiếp) vẫn fail và mã không bị consume.
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

// ─── after() từ next/server — schedule post-response, chạy thủ công ──────────

const afterState = vi.hoisted(() => ({
  callbacks: [] as Array<() => Promise<void>>,
}));

vi.mock("next/server", () => ({
  after: (fn: () => Promise<void>) => {
    afterState.callbacks.push(fn);
  },
}));

/** Chạy MỌI callback after() đã schedule (đúng thứ tự) — mô phỏng post-response. */
const runScheduledAfter = async (): Promise<void> => {
  const fns = afterState.callbacks.splice(0);
  for (const fn of fns) await fn();
};

// ─── Session seam — revokeAllUserSessionsTx SPY (Review Focus 3, atomic) ─────

const sessionSpies = vi.hoisted(() => ({
  revokeAllUserSessions: vi.fn(async () => 3),
  revokeAllUserSessionsTx: vi.fn(async () => 3),
}));

vi.mock("@/src/lib/session", () => ({
  SESSION_COOKIE: "sp_session",
  createSession: vi.fn(async () => {}),
  getSessionFromCookie: vi.fn(async () => null),
  revokeSession: vi.fn(async () => {}),
  revokeAllUserSessions: sessionSpies.revokeAllUserSessions,
  revokeAllUserSessionsTx: sessionSpies.revokeAllUserSessionsTx,
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
  /** ép OtpCode.create throw — chứng minh requestOtp throw không thành oracle (fix #2). */
  failOtpCreate: false,
  /** tx object mà db.transaction truyền vào callback — assert revokeAllUserSessionsTx nhận đúng tx (fix #3). */
  tx: null as unknown,
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
      if (dbState.failOtpCreate) throw new Error("DB_DOWN_OTP_CREATE");
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

  const orm = {
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
  };

  return {
    db: {
      orm,
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { orm };
        dbState.tx = tx;
        return fn(tx);
      }),
    },
  };
});

import { db } from "@/src/prisma/db.client";
import {
  requestPasswordRecoveryAction,
  confirmPasswordRecoveryAction,
  type RecoveryFormState,
} from "@/src/lib/actions/recovery";
import { revokeAllUserSessions, revokeAllUserSessionsTx } from "@/src/lib/session";
import { resetRateLimits } from "@/src/lib/rate-limit";
import { verifyPassword } from "@/src/lib/auth";
import { requestOtp } from "@/src/lib/otp";
import * as observability from "@/src/lib/observability";

const revokeAllSpy = vi.mocked(revokeAllUserSessions);
const revokeAllTxSpy = vi.mocked(revokeAllUserSessionsTx);
const transactionMock = vi.mocked(db.transaction);

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
const VERIFIED_AT = "2026-10-01T00:00:00.000Z";

/**
 * Capture thông báo trung tính từ một request control (tài khoản có email đã
 * xác minh) — mọi outcome khác phải byte-equal chuỗi này. Không import constant
 * từ module "use server" (chỉ export được async function). Chạy after() của
 * control để OTP/audit của control xảy ra (mô phỏng post-response thật).
 */
const captureNeutralMessage = async (): Promise<string> => {
  dbState.users.push(
    makeUser({
      id: "user-control",
      email: CONTROL_EMAIL,
      emailVerifiedAt: VERIFIED_AT,
      phone: null,
    }),
  );
  const res = await requestRecovery(CONTROL_EMAIL);
  await runScheduledAfter(); // requestOtp + audit của control (post-response)
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

/** Yêu cầu mã cho EMAIL (user-1) + chạy after() — trả mã plaintext. */
const requestCode = async (identifier: string = EMAIL): Promise<string> => {
  const res = await requestRecovery(identifier);
  await runScheduledAfter();
  expect(res.success).toBeDefined();
  return lastSentCode();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  headerState.headers = new Headers();
  dbState.users.length = 0;
  dbState.otpRows.length = 0;
  dbState.auditRows.length = 0;
  dbState.notificationRows.length = 0;
  dbState.failOtpCreate = false;
  dbState.tx = null;
  afterState.callbacks.length = 0;
  delivery.sendOtp.mockReset().mockResolvedValue(undefined);
  delivery.sendSecurityNotice.mockReset().mockResolvedValue(undefined);
  revokeAllSpy.mockReset().mockResolvedValue(3);
  revokeAllTxSpy.mockReset().mockResolvedValue(3);
  transactionMock.mockClear();
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
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );

    const existing = await requestRecovery(EMAIL);
    await runScheduledAfter(); // requestOtp + audit của identifier có thật (post-response)
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
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
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
    expect(dbState.otpRows.filter((r) => r.target === EMAIL)).toHaveLength(0);
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
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
      makeUser({
        id: "user-2",
        email: "khac@loaviet.test",
        emailVerifiedAt: VERIFIED_AT,
        phone: PHONE,
        phoneVerifiedAt: VERIFIED_AT,
      }),
    );

    // Nhập PHONE (của user-2) → khớp user-2 qua kênh phone ĐÃ xác minh
    const res = await requestRecovery(PHONE);
    await runScheduledAfter();
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
        emailVerifiedAt: VERIFIED_AT,
        phone: PHONE,
        phoneVerifiedAt: VERIFIED_AT,
      }),
    );

    // Mất email → nhập phone → mã tới phone
    await requestRecovery(PHONE);
    await runScheduledAfter();
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
        emailVerifiedAt: VERIFIED_AT,
        phone: PHONE,
        phoneVerifiedAt: VERIFIED_AT,
      }),
    );

    // Mất phone → nhập email → mã tới email
    await requestRecovery(EMAIL);
    await runScheduledAfter();
    const sent = delivery.sendOtp.mock.calls
      .map((c) => c[0] as { to: string; channel: string; purpose: string })
      .find((p) => p.to === EMAIL);
    expect(sent).toMatchObject({ to: EMAIL, channel: "email", purpose: "password_recovery" });
  });

  it("identifier có user khớp → audit 'user.recovery_requested' (không PII trong detail)", async () => {
    await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );

    await requestRecovery(EMAIL);
    await runScheduledAfter();
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

// ─── 13. Review fix #2 — matched path không chờ delivery/audit (timing) ───────

describe("requestPasswordRecoveryAction — after(): response không chờ matched-path work (review fix #2)", () => {
  it("adapter promise KHÔNG BAO GIỜ resolve → action vẫn trả thông báo trung tính NGAY (không await requestOtp)", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );
    // Provider treo vĩnh viễn — nếu action await requestOtp thì request này treo theo
    delivery.sendOtp.mockImplementation(() => new Promise<void>(() => {}));

    const res = await requestRecovery(EMAIL);
    // Trả NGAY với đúng thông báo trung tính — không phụ thuộc delivery
    expect(res).toEqual({ success: neutral });
    // Work matched-path được schedule (after) chứ KHÔNG chạy trong request
    expect(afterState.callbacks).toHaveLength(1);
    // KHÔNG chạy callback ở đây — promise treo; beforeEach dọn sạch
  });

  it("requestOtp throw (db lỗi) → action vẫn trả CÙNG thông báo trung tính; lỗi captureError KHÔNG PII", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );
    dbState.failOtpCreate = true; // OtpCode.create throw → requestOtp throw
    const errSpy = vi.spyOn(observability, "captureError").mockImplementation(() => {});

    try {
      const res = await requestRecovery(EMAIL);
      // CÙNG thông báo trung tính — throw trên matched path KHÔNG thành oracle
      // tồn tại (unknown path trả trung tính, matched path cũng phải vậy)
      expect(res).toEqual({ success: neutral });

      await runScheduledAfter(); // callback chạy post-response, tự bắt lỗi
      expect(errSpy).toHaveBeenCalled();
      // captureError args KHÔNG chứa identifier thô (spec §4.8)
      for (const call of errSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(EMAIL);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ─── 8+9+10. Rate limit IP + validation + collapse lỗi OTP ─────────────────────

describe("requestPasswordRecoveryAction — rate limit + validation + collapse", () => {
  it("IP rate limit: request thứ 6 trong 10 phút → lỗi form rate-limit (5 / 10 phút / IP)", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
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
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
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
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
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
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );

    const first = await requestRecovery(EMAIL);
    await runScheduledAfter(); // request 1: tạo row + gửi mã (post-response)
    const second = await requestRecovery(EMAIL);
    await runScheduledAfter(); // request 2: cooldown chặn — không mã thứ hai
    // Collapse: kẻ dò không phân biệt được "tồn tại nhưng cooldown" vs "không tồn tại"
    expect(first).toEqual({ success: neutral });
    expect(second).toEqual({ success: neutral });
    // Chỉ 1 mã gửi cho EMAIL — request bị cooldown không gửi mã thứ hai
    expect(sentTargets().filter((t) => t === EMAIL)).toHaveLength(1);
  });

  it("delivery fail (adapter throw) → COLLAPSE về cùng thông báo trung tính (provider fail-closed không thành oracle)", async () => {
    const neutral = await captureNeutralMessage();
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );
    delivery.sendOtp.mockImplementationOnce(() => {
      throw new Error("provider down");
    });

    const res = await requestRecovery(EMAIL);
    await runScheduledAfter(); // requestOtp tự catch → xoá row → typed error → collapse
    expect(res).toEqual({ success: neutral });
    // Row mồ côi bị xoá (không mã đã hash nhưng chưa ai nhận)
    expect(dbState.otpRows.filter((r) => r.target === EMAIL)).toHaveLength(0);
  });
});

// ─── 3+4+11+14. Confirm — tx atomic + revoke mọi session + lỗi typed ──────────

describe("confirmPasswordRecoveryAction — đặt lại mật khẩu + thu hồi mọi session", () => {
  const seedVerifiedEmailUser = (): void => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: VERIFIED_AT, phone: null }),
    );
  };

  it("mã hợp lệ → hash mới trong CÙNG tx với revokeAllUserSessionsTx KHÔNG exceptSessionId (Review Focus 3 + fix #3 atomic)", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    const res = await confirmRecovery({
      identifier: EMAIL,
      code,
      newPassword: "mat-khau-moi-123",
    });

    expect(res.success).toBeDefined();
    expect(res.error).toBeUndefined();

    // Mật khẩu mới + thu hồi session sống chết cùng MỘT transaction (fix #3) —
    // thất bại giữa chừng không để lại mật khẩu mới + session cũ còn tác quyền.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(revokeAllTxSpy).toHaveBeenCalledTimes(1);
    expect(revokeAllTxSpy).toHaveBeenCalledWith(dbState.tx, "user-1", "password_recovery");
    // Variant non-tx KHÔNG được dùng (đường rời đã bỏ)
    expect(revokeAllSpy).not.toHaveBeenCalled();

    // Hash mới — mật khẩu cũ KHÔNG còn verify được, mật khẩu mới verify được
    const user = dbState.users.find((u) => u.id === "user-1")!;
    expect(user.passwordHash).not.toBe(OLD_HASH);
    expect(await verifyPassword("mat-khau-moi-123", user.passwordHash as string)).toBe(true);
    expect(await verifyPassword("mat-kau-cu-123", user.passwordHash as string)).toBe(false);

    // audit "user.recovery_completed" + notify in-app + security notice kênh đã xác minh
    expect(
      dbState.auditRows.find((r) => r.action === "user.recovery_completed" && r.actorId === "user-1"),
    ).toBeDefined();
    expect(dbState.notificationRows).toHaveLength(1);
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: EMAIL, channel: "email" }),
    );
  });

  it("mã hợp lệ qua kênh PHONE đã xác minh → hash mới + revoke mọi session trong tx (lost-email path khép kín)", async () => {
    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: null,
        phone: PHONE,
        phoneVerifiedAt: VERIFIED_AT,
      }),
    );
    const code = await requestCode(PHONE);

    const res = await confirmRecovery({ identifier: PHONE, code, newPassword: "moi-moi-moi" });
    expect(res.success).toBeDefined();
    const user = dbState.users.find((u) => u.id === "user-1")!;
    expect(await verifyPassword("moi-moi-moi", user.passwordHash as string)).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(revokeAllTxSpy).toHaveBeenCalledWith(dbState.tx, "user-1", "password_recovery");
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, channel: "phone" }),
    );
  });

  it("(fix #1) notice gửi tới MỌI kênh ĐÃ XÁC MINH — recover qua phone → EMAIL cũ cũng được báo (và ngược lại)", async () => {
    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: VERIFIED_AT,
        phone: PHONE,
        phoneVerifiedAt: VERIFIED_AT,
      }),
    );

    // Flow A: mất email → recover qua PHONE → notice phải tới CẢ phone LẪN email
    const codePhone = await requestCode(PHONE);
    const viaPhone = await confirmRecovery({ identifier: PHONE, code: codePhone, newPassword: "lan-phone-123" });
    expect(viaPhone.success).toBeDefined();
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, channel: "phone", subjectKey: "password_reset" }),
    );
    // Kênh email (KHÔNG dùng cho recovery) CŨNG được báo — nạn nhân thấy chiếm tài khoản
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: EMAIL, channel: "email", subjectKey: "password_reset" }),
    );

    // Flow B (vice versa): mất phone → recover qua EMAIL → notice tới CẢ hai kênh
    delivery.sendSecurityNotice.mockClear();
    vi.advanceTimersByTime(61_000); // qua cooldown OTP 60s
    const codeEmail = await requestCode(EMAIL);
    const viaEmail = await confirmRecovery({ identifier: EMAIL, code: codeEmail, newPassword: "lan-email-123" });
    expect(viaEmail.success).toBeDefined();
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: EMAIL, channel: "email" }),
    );
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, channel: "phone" }),
    );
    // Mỗi completion → đúng 2 notice (mỗi kênh đã xác minh 1 lần)
    expect(delivery.sendSecurityNotice).toHaveBeenCalledTimes(2);
  });

  it("sai mã → lỗi typed, mật khẩu KHÔNG đổi, KHÔNG revoke session nào, KHÔNG mở tx", async () => {
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
    expect(transactionMock).not.toHaveBeenCalled();
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
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
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
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
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
  });

  it("(fix #5) confirm với mã HỢP LỆ nhưng kênh CHƯA xác minh (row seed trực tiếp) → vẫn fail, mã KHÔNG bị consume", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: null, phone: null }),
    );
    // Row OTP hợp lệ tồn tại (seed trực tiếp qua OTP core — bypass action) —
    // kẻ có mã thật cũng KHÔNG đặt lại được qua kênh chưa xác minh
    const seeded = await requestOtp({
      userId: "user-1",
      purpose: "password_recovery",
      channel: "email",
      target: EMAIL,
    });
    expect(seeded.ok).toBe(true);
    const code = lastSentCode();

    const res = await confirmRecovery({ identifier: EMAIL, code, newPassword: "gi-do-123" });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    // Mã KHÔNG bị consume — verified-channel check chặn TRƯỚC verifyOtp
    expect(dbState.otpRows.find((r) => r.target === EMAIL)!.consumedAt).toBeNull();
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
  });

  it("(fix #5) mã của purpose KHÁC (email_verification) KHÔNG dùng được cho recovery (purpose binding)", async () => {
    seedVerifiedEmailUser();
    // Mã do luồng xác minh email (Task 6) cấp — không phải mã recovery
    const seeded = await requestOtp({
      userId: "user-1",
      purpose: "email_verification",
      channel: "email",
      target: EMAIL,
    });
    expect(seeded.ok).toBe(true);
    const code = lastSentCode();

    const res = await confirmRecovery({ identifier: EMAIL, code, newPassword: "gi-do-123" });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    // Row email_verification KHÔNG bị consume bởi recovery
    expect(dbState.otpRows.find((r) => r.purpose === "email_verification")!.consumedAt).toBeNull();
  });

  it("(fix #5) sai / hết hạn / dùng lại → lỗi byte-đối-byte như nhau (không phân biệt loại fail)", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: "mot@loaviet.test", emailVerifiedAt: VERIFIED_AT, phone: null }),
      makeUser({ id: "user-2", email: "hai@loaviet.test", emailVerifiedAt: VERIFIED_AT, phone: null }),
      makeUser({ id: "user-3", email: "ba@loaviet.test", emailVerifiedAt: VERIFIED_AT, phone: null }),
    );

    // user-1: sai mã
    const code1 = await requestCode("mot@loaviet.test");
    const wrong = await confirmRecovery({ identifier: "mot@loaviet.test", code: wrongCodeFor(code1), newPassword: "gi-do-123" });

    // user-2: hết hạn
    const code2 = await requestCode("hai@loaviet.test");
    vi.advanceTimersByTime(10 * 60_000 + 1_000);
    const expired = await confirmRecovery({ identifier: "hai@loaviet.test", code: code2, newPassword: "gi-do-123" });

    // user-3: dùng lại mã đã consume
    const code3 = await requestCode("ba@loaviet.test");
    expect((await confirmRecovery({ identifier: "ba@loaviet.test", code: code3, newPassword: "lan-mot-123" })).success).toBeDefined();
    const reused = await confirmRecovery({ identifier: "ba@loaviet.test", code: code3, newPassword: "lan-hai-123" });

    // Ba lỗi byte-đối-byte như nhau — không leak LOẠI fail (spec §7.7)
    expect(wrong.error).toBe(expired.error);
    expect(expired.error).toBe(reused.error);
    expect(wrong.success).toBeUndefined();
    // Mật khẩu: user-1/2 giữ cũ, user-3 giữ của lần 1
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(dbState.users.find((u) => u.id === "user-2")!.passwordHash).toBe(OLD_HASH);
    expect(await verifyPassword("lan-mot-123", dbState.users.find((u) => u.id === "user-3")!.passwordHash as string)).toBe(true);
  });

  it("identifier khớp kênh CHƯA xác minh → cùng lỗi collapsed (không đặt lại được qua kênh chưa xác minh)", async () => {
    dbState.users.push(
      makeUser({ id: "user-1", email: EMAIL, emailVerifiedAt: null, phone: null }),
    );

    const res = await confirmRecovery({ identifier: EMAIL, code: "123456", newPassword: "gi-do-123" });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
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

  it("confirm có IP rate limit riêng (spec §7.1 — OTP verify endpoint)", async () => {
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
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
  });

  it("(fix #4) per-identifier limit: confirm thứ 6 cho CÙNG identifier → CÙNG lỗi collapsed (không phải lỗi rate-limit riêng)", async () => {
    seedVerifiedEmailUser();
    const code = await requestCode();

    // 5 lần "thử" cho EMAIL (mật khẩu rác — lỗi nhập liệu, KHÔNG đụng OTP row)
    // vẫn tiêu tốn budget per-identifier: brute-force MỘT tài khoản từ nhiều IP
    // không mua được thêm attempt (spec §7.1 "target resource").
    for (let i = 0; i < 5; i++) {
      const res = await confirmRecovery({ identifier: EMAIL, code, newPassword: "12345" });
      expect(res.error).toBeDefined();
      expect(res.error).not.toContain("Quá nhiều lần thử");
    }
    // Mã chưa bị consume, chưa bị khóa attempts
    expect(dbState.otpRows.find((r) => r.target === EMAIL)!.consumedAt).toBeNull();
    expect(dbState.otpRows.find((r) => r.target === EMAIL)!.attempts).toBe(0);

    // Lần thứ 6 — MÃ ĐÚNG, mật khẩu hợp lệ — vẫn bị chặn theo IDENTIFIER
    // (IP budget 10 chưa cạn: 6 < 10) và trả CÙNG lỗi collapsed như sai mã.
    const sixth = await confirmRecovery({ identifier: EMAIL, code, newPassword: "moi-that-123" });
    expect(sixth.success).toBeUndefined();
    expect(sixth.error).toBeDefined();
    expect(sixth.error).not.toContain("Quá nhiều lần thử");
    // Byte-equal với lỗi sai mã — kẻ dò không phân biệt "identifier bị khóa" vs "mã sai"
    const wrongRes = await confirmRecovery({ identifier: "khac.hoan-toan@loaviet.test", code, newPassword: "moi-that-123" });
    expect(sixth.error).toBe(wrongRes.error);
    // Mật khẩu KHÔNG đổi, mã KHÔNG bị consume (chặn trước verify)
    expect(dbState.users.find((u) => u.id === "user-1")!.passwordHash).toBe(OLD_HASH);
    expect(dbState.otpRows.find((r) => r.target === EMAIL)!.consumedAt).toBeNull();
    expect(revokeAllTxSpy).not.toHaveBeenCalled();
  });
});

// ─── 12. Spec §4.8 — không emit identifier thô / mã OTP / mật khẩu ra log ────

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

  it("mọi path (gửi, không khớp, sai mã, confirm thành công) không log email/phone/mã OTP/mật khẩu", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const eventSpy = vi.spyOn(observability, "captureEvent");
    const errorCaptureSpy = vi.spyOn(observability, "captureError").mockImplementation(() => {});

    dbState.users.push(
      makeUser({
        id: "user-1",
        email: EMAIL,
        emailVerifiedAt: VERIFIED_AT,
        phone: PHONE,
        phoneVerifiedAt: VERIFIED_AT,
      }),
    );

    try {
      await requestRecovery(EMAIL); // gửi thành công
      await runScheduledAfter();
      const code = lastSentCode();
      await requestRecovery("khong.co@loaviet.test"); // không khớp
      await requestRecovery(PHONE); // kênh phone
      await runScheduledAfter();
      await confirmRecovery({ identifier: EMAIL, code: wrongCodeFor(code), newPassword: "gi-do-123" }); // sai mã
      await confirmRecovery({ identifier: EMAIL, code, newPassword: "moi-that-123" }); // thành công

      const dumps: string[] = [];
      for (const spy of [logSpy, errSpy, warnSpy, infoSpy, debugSpy, eventSpy, errorCaptureSpy]) {
        for (const call of spy.mock.calls) {
          for (const arg of call) dumps.push(argText(arg));
        }
      }
      const dump = dumps.join("\n");
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(EMAIL);
      expect(dump).not.toContain(PHONE);
      // Mật khẩu mới KHÔNG bao giờ xuất hiện ở log (spec §4.8)
      expect(dump).not.toContain("moi-that-123");
      expect(dump).not.toContain("gi-do-123");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      eventSpy.mockRestore();
      errorCaptureSpy.mockRestore();
    }
  });
});
