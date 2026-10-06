/**
 * Email/phone verification + identity changes — unit tests (plan Task 6 +
 * review fix: đóng step-up bypass, rate limit, revocation trên tx).
 *
 * Cơ chế mock: `server-only` + `next/cache` + `next/navigation` (redirect throw
 * NEXT_REDIRECT) + `next/headers` (headers/cookies) + `@/src/lib/session`
 * (getSessionFromCookie fixture; revokeAllUserSessions = tripwire — sau fix
 * revocation phải chạy TRÊN tx, không còn qua global client) +
 * `@/src/lib/verification-delivery` (adapter spy) + `@/src/prisma/db.client`
 * (in-memory User/UserSession/OtpCode/AuditEvent/Notification). OTP core +
 * rate limiter GIỮ BẢN THẬT (reset qua resetRateLimits).
 *
 * Hợp đồng sau review fix:
 *  1. (HIGH) Verification flow CHỈ xác minh kênh ĐANG LƯU (target derive từ
 *     DB, formData bị bỏ qua) + refuse khi đã verified. Đổi sang số/email khác
 *     CHỈ qua change flow (mật khẩu ở request VÀ confirm — OTP row không ghi
 *     flow đã tạo nó nên không thể chứng minh step-up từ row → yêu cầu mật khẩu
 *     lại tại confirm). Stolen session không mật khẩu không thể làm SỐ MỚI
 *     verified qua mọi tổ hợp action.
 *  2. (MEDIUM) profile.ts: phone update atomic (CAS where phone = giá trị đã
 *     đọc) — test riêng ở tests/unit/profile-actions.test.ts.
 *  3. (MEDIUM) Mọi request action rate limit per-user (5/10phút, độc lập
 *     target — chống SMS pumping) + per-IP (20/10phút); EMAIL_TAKEN pre-check
 *     SAU rate limit.
 *  4. (MEDIUM) Step-up (verify mật khẩu hiện tại) rate limit per-user + per-IP
 *     cùng ngưỡng login (auth.ts 10/10phút) — không còn password-guessing
 *     oracle cho stolen session.
 *  5. (LOW) changePasswordAction: hash + revoke trong MỘT db.transaction;
 *     revocation chạy TRÊN tx (revokeOtherSessionsTx — local copy predicate
 *     session.ts, dễ reconcile khi Task 7 thêm tx-variant); email/phone change
 *     confirm cũng revoke trên tx.
 *  6. (LOW) Security notice chỉ tới kênh CŨ khi kênh cũ ĐÃ verified.
 *  7. (LOW) profile.ts lưu phone NORMALIZED — test ở profile-actions.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// redirect() throw NEXT_REDIRECT — như rbac.test.ts / financial tests
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// headers() cho rate limit (clientIpFromHeaders) + audit ipHash; cookies() cho auth.ts
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    has: () => false,
    getAll: () => [],
  })),
}));

// ─── Session seam — requireUser đọc qua getSessionFromCookie. Sau fix,
// revocation chạy TRÊN tx (revokeOtherSessionsTx trong verification.ts) —
// revokeAllUserSessions (global client) là TRIpwire: KHÔNG được gọi nữa. ──────

const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
}));

vi.mock("@/src/lib/session", () => ({
  SESSION_COOKIE: "sp_session",
  getSessionFromCookie: vi.fn(async () => sessionState.current),
  revokeSession: vi.fn(),
  createSession: vi.fn(),
  revokeAllUserSessions: vi.fn(async () => 0),
}));

// ─── Delivery adapter spy — OTP + security notice ─────────────────────────────

type OtpDeliveryCall = { to: string; code: string; purpose: string; channel: string };
type SecurityNoticeCall = { to: string; channel: string; subjectKey: string };

const delivery = vi.hoisted(() => ({
  sendOtp: vi.fn(async (_params: OtpDeliveryCall) => {}),
  sendSecurityNotice: vi.fn(async (_params: SecurityNoticeCall) => {}),
}));

vi.mock("@/src/lib/verification-delivery", () => ({
  getOtpDeliveryAdapter: () => ({
    name: "mock",
    sendOtp: delivery.sendOtp,
    sendSecurityNotice: delivery.sendSecurityNotice,
  }),
}));

// ─── db.client mock: in-memory User/UserSession/OtpCode/AuditEvent/Notification ──

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  otpRows: [] as Array<Record<string, unknown>>,
  auditRows: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

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

  const makeModel = (
    rows: Row[],
    defaults?: () => Row,
    firstPick: "first" | "last" = "first",
  ) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hits = rows.filter((r) => all.every((p) => matches(r, p)));
        if (hits.length === 0) return null;
        const hit = firstPick === "last" ? hits[hits.length - 1]! : hits[0]!;
        return { ...hit };
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      update: async (data: Row) => {
        const hits = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hits.length === 0) return null;
        Object.assign(hits[0]!, data);
        return { ...hits[0]! };
      },
      updateAll: async (data: Row) => {
        const hits = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hits) Object.assign(r, data);
        return hits.map((r) => ({ ...r }));
      },
      delete: async () => {
        const hits = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hits) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hits.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const otpDefaults = () => ({
    id: `otp-${dbState.otpRows.length + 1}`,
    attempts: 0,
    consumedAt: null,
    createdAt: new Date().toISOString(),
  });

  const models = {
    User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    UserSession: makeModel(dbState.sessions, () => ({
      id: `sess-${dbState.sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
      revokedReason: null,
      steppedUpAt: null,
      isAdmin: false,
      userAgent: null,
    })),
    // OtpCode: first() lấy row MỚI NHẤT khớp predicate — đúng orderBy desc
    OtpCode: makeModel(dbState.otpRows, otpDefaults, "last"),
    AuditEvent: makeModel(dbState.auditRows, () => ({ id: `audit-${dbState.auditRows.length + 1}` })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
    })),
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      // tx passthrough — cùng store; hành vi rollback thật do integration test
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { verifyPassword } from "@/src/lib/auth";
import { revokeAllUserSessions } from "@/src/lib/session";
import {
  requestEmailVerificationAction,
  confirmEmailVerificationAction,
  requestPhoneVerificationAction,
  confirmPhoneVerificationAction,
  changePasswordAction,
  requestEmailChangeAction,
  confirmEmailChangeAction,
  requestPhoneChangeAction,
  confirmPhoneChangeAction,
  type VerificationFormState,
} from "@/src/lib/actions/verification";

const revokeAllGlobal = vi.mocked(revokeAllUserSessions);

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const PASSWORD = "mat-khau-hien-tai-dung";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

const mkUser = (over: Partial<Row>): Row => ({
  id: "user-x",
  email: "x@loaviet.test",
  passwordHash: PASSWORD_HASH,
  name: "X",
  role: "buyer",
  avatarUrl: null,
  phone: null,
  city: null,
  bio: null,
  isVerifiedSeller: false,
  adminRole: null,
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

/** user-1 (đăng nhập, phone lưu 0900000001 CHƯA verified) + user-2 (phone 0901234567 ĐÃ verified). */
const U1 = mkUser({ id: "user-1", email: "mua@loaviet.test", name: "Người Mua", phone: "0900000001" });
const U2 = mkUser({
  id: "user-2",
  email: "khac@loaviet.test",
  name: "Người Khác",
  phone: "0901234567",
  phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
});

const mkSession = (id: string, userId: string): Row => ({
  id,
  userId,
  tokenHash: `hash-${id}`,
  isAdmin: false,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-11-06T08:00:00.000Z",
  revokedAt: null,
  revokedReason: null,
  steppedUpAt: null,
  userAgent: null,
});

const SESSION = {
  id: "sess-1",
  userId: "user-1",
  isAdmin: false,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-11-06T08:00:00.000Z",
  steppedUpAt: null,
  userAgent: null,
} as const;

/** Đăng nhập fixture session cho user row (SessionUser mirror từ row). */
const login = (user: Row): void => {
  sessionState.current = {
    session: { ...SESSION, userId: user.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      isVerifiedSeller: user.isVerifiedSeller,
      adminRole: user.adminRole,
      sessionId: SESSION.id,
    },
  };
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Request OTP qua action thật → trích mã từ adapter spy (không log bao giờ). */
const requestAndExtractCode = async (
  action: (prev: VerificationFormState, formData: FormData) => Promise<VerificationFormState>,
  formData: FormData,
): Promise<string> => {
  const state = await action({}, formData);
  expect(state.error, `request phải thành công (got ${state.code})`).toBeUndefined();
  const call = delivery.sendOtp.mock.calls.at(-1);
  expect(call).toBeTruthy();
  return call![0].code;
};

/** Session khác của user-1 đã revoke chưa + reason gì. */
const revokedSessions = (): Array<Row> =>
  dbState.sessions.filter((s) => s["revokedAt"] !== null);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.otpRows.length = 0;
  dbState.auditRows.length = 0;
  dbState.notifications.length = 0;
  dbState.users.push({ ...U1 }, { ...U2 });
  dbState.sessions.push(mkSession("sess-1", "user-1"), mkSession("sess-2", "user-1"), mkSession("sess-3", "user-1"));
  sessionState.current = null;
  delivery.sendOtp.mockClear();
  delivery.sendSecurityNotice.mockClear();
  revokeAllGlobal.mockClear();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Ranh giới session — mọi action ──────────────────────────────────────────

describe("ranh giới session — mọi action", () => {
  const ALL_ACTIONS = [
    ["requestEmailVerificationAction", requestEmailVerificationAction],
    ["confirmEmailVerificationAction", confirmEmailVerificationAction],
    ["requestPhoneVerificationAction", requestPhoneVerificationAction],
    ["confirmPhoneVerificationAction", confirmPhoneVerificationAction],
    ["changePasswordAction", changePasswordAction],
    ["requestEmailChangeAction", requestEmailChangeAction],
    ["confirmEmailChangeAction", confirmEmailChangeAction],
    ["requestPhoneChangeAction", requestPhoneChangeAction],
    ["confirmPhoneChangeAction", confirmPhoneChangeAction],
  ] as const;

  it.each(ALL_ACTIONS)("%s: không session → NEXT_REDIRECT, không chạm db", async (_name, action) => {
    sessionState.current = null;
    const form = fd({
      code: "123456",
      phone: "0901234567",
      newPhone: "09011112222",
      newEmail: "moi@loaviet.test",
      currentPassword: PASSWORD,
      newPassword: "mat-khau-moi-123",
    });
    await expect(action({}, form)).rejects.toThrow("NEXT_REDIRECT");
    expect(dbState.otpRows).toHaveLength(0);
    expect(dbState.auditRows).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
    expect(revokedSessions()).toHaveLength(0);
    expect(delivery.sendOtp).not.toHaveBeenCalled();
    expect(delivery.sendSecurityNotice).not.toHaveBeenCalled();
  });
});

// ─── Email verification — CHỈ email đang lưu ──────────────────────────────────

describe("email verification — chỉ xác minh email ĐANG LƯU", () => {
  it("request gửi OTP tới ĐÚNG email lưu + confirm set emailVerifiedAt + audit (detail không email thô)", async () => {
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(requestEmailVerificationAction, new FormData());
    expect(delivery.sendOtp.mock.calls.at(-1)![0]).toMatchObject({
      to: "mua@loaviet.test",
      purpose: "email_verification",
      channel: "email",
    });

    const state = await confirmEmailVerificationAction({}, fd({ code }));
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.emailVerifiedAt).not.toBeNull();

    const evt = dbState.auditRows.find((r) => r.action === "user.email_verified");
    expect(evt).toMatchObject({
      actorId: "user-1",
      subjectId: "user-1",
      resourceType: "User",
      resourceId: "user-1",
      sessionId: "sess-1",
    });
    expect(JSON.stringify(evt)).not.toContain("mua@loaviet.test");
  });

  it("confirm sai mã → lỗi, emailVerifiedAt giữ null", async () => {
    login(dbState.users[0]!);
    const real = await requestAndExtractCode(requestEmailVerificationAction, new FormData());
    const wrong = real === "000000" ? "111111" : "000000";
    const state = await confirmEmailVerificationAction({}, fd({ code: wrong }));
    expect(state.error).toBeTruthy();
    expect(dbState.users[0]!.emailVerifiedAt).toBeNull();
  });

  it("đã verified → request refuse (ALREADY_VERIFIED), không gửi OTP; confirm refuse, không update", async () => {
    dbState.users[0]!.emailVerifiedAt = "2026-10-01T00:00:00.000Z";
    login(dbState.users[0]!);

    const req = await requestEmailVerificationAction({}, new FormData());
    expect(req.code).toBe("ALREADY_VERIFIED");
    expect(delivery.sendOtp).not.toHaveBeenCalled();

    const conf = await confirmEmailVerificationAction({}, fd({ code: "123456" }));
    expect(conf.code).toBe("ALREADY_VERIFIED");
    expect(dbState.users[0]!.emailVerifiedAt).toBe("2026-10-01T00:00:00.000Z"); // giữ nguyên
  });
});

// ─── Phone verification — CHỈ số đang lưu (đóng step-up bypass) ───────────────

describe("phone verification — CHỈ xác minh số ĐANG LƯU (fix HIGH)", () => {
  it("request: OTP tới ĐÚNG số đang lưu — formData phone KHÁC bị bỏ qua hoàn toàn", async () => {
    login(dbState.users[0]!); // stored: 0900000001

    // kẻ tấn công (session đánh cắp) nhồi số của hắn vào formData
    const code = await requestAndExtractCode(
      requestPhoneVerificationAction,
      fd({ phone: "0999999999" }),
    );
    // OTP đi tới SỐ ĐANG LƯU của tài khoản — KHÔNG PHÌ số của kẻ tấn công
    expect(delivery.sendOtp.mock.calls.at(-1)![0]).toMatchObject({
      to: "0900000001",
      purpose: "phone_verification",
      channel: "phone",
    });
    expect(code).toBeTruthy();
  });

  it("request: không có số lưu → PHONE_NOT_ON_FILE, không gửi OTP", async () => {
    dbState.users[0]!.phone = null;
    login(dbState.users[0]!);
    const state = await requestPhoneVerificationAction({}, fd({ phone: "0999999999" }));
    expect(state.code).toBe("PHONE_NOT_ON_FILE");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
    expect(dbState.otpRows).toHaveLength(0);
  });

  it("request: số lưu sai format (legacy) → PHONE_NOT_ON_FILE, không gửi OTP", async () => {
    dbState.users[0]!.phone = "12345"; // legacy rác — không chuẩn hóa được
    login(dbState.users[0]!);
    const state = await requestPhoneVerificationAction({}, new FormData());
    expect(state.code).toBe("PHONE_NOT_ON_FILE");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("request + confirm: đã verified → ALREADY_VERIFIED, không OTP, không update", async () => {
    dbState.users[0]!.phoneVerifiedAt = "2026-10-01T00:00:00.000Z";
    login(dbState.users[0]!);

    const req = await requestPhoneVerificationAction({}, new FormData());
    expect(req.code).toBe("ALREADY_VERIFIED");
    expect(delivery.sendOtp).not.toHaveBeenCalled();

    const conf = await confirmPhoneVerificationAction({}, fd({ code: "123456" }));
    expect(conf.code).toBe("ALREADY_VERIFIED");
    expect(dbState.users[0]!.phoneVerifiedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("confirm: set phoneVerifiedAt (phone giữ nguyên = stored), audit user.phone_verified; formData phone bị bỏ qua", async () => {
    login(dbState.users[0]!); // stored 0900000001
    const code = await requestAndExtractCode(requestPhoneVerificationAction, new FormData());

    // confirm nhồi số khác vào formData — action vẫn verify SỐ ĐANG LƯU
    const state = await confirmPhoneVerificationAction(
      {},
      fd({ phone: "0999999999", code }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBe("0900000001"); // KHÔNG đổi sang số của formData
    expect(dbState.users[0]!.phoneVerifiedAt).not.toBeNull();
    expect(dbState.auditRows.some((r) => r.action === "user.phone_verified")).toBe(true);
    const evt = dbState.auditRows.find((r) => r.action === "user.phone_verified")!;
    expect(JSON.stringify(evt)).not.toContain("0900000001");
  });

  it("confirm: số đang lưu đã ĐƯỢC XÁC MINH bởi tài khoản KHÁC → PHONE_ALREADY_VERIFIED, không merge, không update", async () => {
    // user-2 đã verified 0901234567 (fixture); user-1 cũng đang lưu số đó (unverified)
    dbState.users[0]!.phone = "0901234567";
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(
      requestPhoneVerificationAction,
      new FormData(),
    );
    const state = await confirmPhoneVerificationAction({}, fd({ code }));

    expect(state.code).toBe("PHONE_ALREADY_VERIFIED");
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
    expect(dbState.users[1]!.phone).toBe("0901234567");
    expect(dbState.users[1]!.phoneVerifiedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(dbState.auditRows.filter((r) => r.action === "user.phone_verified")).toHaveLength(0);
  });

  it("confirm: số đang lưu giống tài khoản khác nhưng CHƯA verified ở đó → thành công", async () => {
    // user-2 giữ 0909876543 unverified
    dbState.users[1]!.phone = "0909876543";
    dbState.users[1]!.phoneVerifiedAt = null;
    dbState.users[0]!.phone = "0909876543";
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(requestPhoneVerificationAction, new FormData());
    const state = await confirmPhoneVerificationAction({}, fd({ code }));

    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phoneVerifiedAt).not.toBeNull();
    // user-2 giữ nguyên (unverified) — uniqueness chỉ áp danh tính ĐÃ xác minh
    expect(dbState.users[1]!.phone).toBe("0909876543");
    expect(dbState.users[1]!.phoneVerifiedAt).toBeNull();
  });
});

// ─── HIGH: stolen session — không mật khẩu không thể làm SỐ MỚI verified ──────

describe("stolen session — không mật khẩu không thể làm số MỚI verified (HIGH)", () => {
  const ATTACKER_PHONE = "0999999999";

  it("mọi tổ hợp action không mật khẩu đều KHÔNG đưa số mới tới verified", async () => {
    login(dbState.users[0]!); // stolen session — KHÔNG có mật khẩu

    // (a) verification request nhồi số tấn công → OTP vẫn tới SỐ ĐANG LƯU (0900000001)
    const reqState = await requestPhoneVerificationAction({}, fd({ phone: ATTACKER_PHONE }));
    expect(reqState.error).toBeUndefined();
    expect(delivery.sendOtp.mock.calls.at(-1)![0].to).toBe("0900000001");
    expect(delivery.sendOtp.mock.calls.at(-1)![0].to).not.toBe(ATTACKER_PHONE);

    // (b) verification confirm nhồi số tấn công → action derive target từ DB
    //     (0900000001) — mã gửi cho 0900000001 không tồn tại cho tuple của số tấn công
    const confState = await confirmPhoneVerificationAction(
      {},
      fd({ phone: ATTACKER_PHONE, code: "123456" }),
    );
    expect(confState.error).toBeTruthy();

    // (c) change request không mật khẩu → step-up fail, không OTP cho số tấn công
    const changeReq = await requestPhoneChangeAction(
      {},
      fd({ newPhone: ATTACKER_PHONE, currentPassword: "" }),
    );
    expect(changeReq.code).toBe("MISSING_CURRENT_PASSWORD");
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1); // chỉ OTP (a) tới số đang lưu

    // (d) change confirm không mật khẩu → step-up fail, không mutation
    const changeConf = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: ATTACKER_PHONE, code: "123456", currentPassword: "" }),
    );
    expect(changeConf.code).toBe("MISSING_CURRENT_PASSWORD");

    // kết cục: số tấn công KHÔNG verified, tài khoản giữ nguyên
    expect(dbState.users[0]!.phone).toBe("0900000001");
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
    expect(revokedSessions()).toHaveLength(0);
    expect(dbState.auditRows.filter((r) => r.action === "user.phone_changed")).toHaveLength(0);
  });

  it("change confirm với mật khẩu SAI → WRONG_PASSWORD, không mutation (step-up tại confirm)", async () => {
    login(dbState.users[0]!);
    const state = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09011112222", code: "123456", currentPassword: "sai-het-roi" }),
    );
    expect(state.code).toBe("WRONG_PASSWORD");
    expect(dbState.users[0]!.phone).toBe("0900000001");
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
    expect(revokedSessions()).toHaveLength(0);
  });
});

// ─── changePasswordAction — tx + revocation trên tx (fix LOW #5) ──────────────

describe("changePasswordAction", () => {
  it("sai mật khẩu hiện tại → lỗi, không mutation, KHÔNG revoke, không audit", async () => {
    login(dbState.users[0]!);
    const hashBefore = dbState.users[0]!.passwordHash;

    const state = await changePasswordAction(
      {},
      fd({ currentPassword: "sai-het-roi", newPassword: "mat-khau-moi-123" }),
    );

    expect(state.code).toBe("WRONG_PASSWORD");
    expect(dbState.users[0]!.passwordHash).toBe(hashBefore);
    expect(revokedSessions()).toHaveLength(0);
    expect(dbState.auditRows).toHaveLength(0);
  });

  it("đúng → hash mới + session KHÁC revoked trong TX (reason password_change), session hiện tại sống, audit + notify", async () => {
    login(dbState.users[0]!);

    const state = await changePasswordAction(
      {},
      fd({ currentPassword: PASSWORD, newPassword: "mat-khau-moi-123" }),
    );

    expect(state.error).toBeUndefined();
    await expect(
      verifyPassword("mat-khau-moi-123", dbState.users[0]!.passwordHash as string),
    ).resolves.toBe(true);
    // revocation chạy TRÊN tx — KHÔNG qua global client (tripwire)
    expect(revokeAllGlobal).not.toHaveBeenCalled();
    // session khác bị revoke với đúng reason; session hiện tại sống
    const revoked = revokedSessions();
    expect(revoked.map((s) => s["id"]).sort()).toEqual(["sess-2", "sess-3"]);
    for (const s of revoked) expect(s["revokedReason"]).toBe("password_change");
    const current = dbState.sessions.find((s) => s["id"] === "sess-1")!;
    expect(current["revokedAt"]).toBeNull();
    expect(dbState.auditRows.some((r) => r.action === "user.password_changed")).toBe(true);
    expect(dbState.notifications.some((n) => n.userId === "user-1")).toBe(true);
  });
});

// ─── Step-up rate limit (fix MEDIUM #4 — password-guessing oracle) ────────────

describe("step-up rate limit (spec §7.2 — không còn password oracle)", () => {
  it("10 lần sai liên tiếp tiêu budget; lần 11 → RATE_LIMITED, hash giữ nguyên", async () => {
    login(dbState.users[0]!);
    const hashBefore = dbState.users[0]!.passwordHash;

    for (let i = 0; i < 10; i++) {
      const state = await changePasswordAction(
        {},
        fd({ currentPassword: `sai-lan-${i}`, newPassword: "mat-khau-moi-123" }),
      );
      expect(state.code, `lần ${i + 1} vẫn là WRONG_PASSWORD`).toBe("WRONG_PASSWORD");
    }

    const blocked = await changePasswordAction(
      {},
      fd({ currentPassword: "doan-dung-roi", newPassword: "mat-khau-moi-123" }),
    );
    expect(blocked.code).toBe("RATE_LIMITED");
    expect(dbState.users[0]!.passwordHash).toBe(hashBefore);
    expect(revokedSessions()).toHaveLength(0);
  });
});

// ─── OTP request rate limit (fix MEDIUM #3 — SMS pumping) ─────────────────────

describe("OTP request rate limit — per-user + per-IP (spec §7.1)", () => {
  it("per-USER: request thứ 6 trong 10 phút → RATE_LIMITED (độc lập target — chống pumping)", async () => {
    login(dbState.users[0]!);
    let last: VerificationFormState = {};
    for (let i = 0; i < 6; i++) {
      last = await requestEmailVerificationAction({}, new FormData());
    }
    // lần 1 gửi mã; lần 2-5 cooldown OTP_RATE_LIMITED (vẫn tiêu budget); lần 6 bị chặn
    expect(last.code).toBe("RATE_LIMITED");
    expect(last.error).toMatch(/giây/);
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1);
  });

  it("EMAIL_TAKEN pre-check SAU rate limit — hết budget thì không enumeration qua pre-check", async () => {
    login(dbState.users[0]!);
    // tiêu hết budget per-user (5 request)
    for (let i = 0; i < 5; i++) {
      await requestEmailVerificationAction({}, new FormData());
    }
    // email đã thuộc tài khoản khác — nhưng pre-check không chạy nữa: RATE_LIMITED
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "khac@loaviet.test", currentPassword: PASSWORD }),
    );
    expect(state.code).toBe("RATE_LIMITED");
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1); // chỉ lần đầu gửi mã
  });

  it("per-IP: bucket IP dùng chung mọi user — request thứ 21 trong window → RATE_LIMITED", async () => {
    // 4 user × 5 request (budget per-user) = 20 hit IP; user thứ 5 bị chặn ở request đầu
    for (let u = 0; u < 4; u++) {
      const user = mkUser({ id: `user-ip-${u}`, email: `ip${u}@loaviet.test`, phone: `090000000${u}` });
      dbState.users.push(user);
      login(user);
      for (let i = 0; i < 5; i++) {
        await requestEmailVerificationAction({}, new FormData());
      }
    }
    const fifth = mkUser({ id: "user-ip-5", email: "ip5@loaviet.test", phone: "0900000005" });
    dbState.users.push(fifth);
    login(fifth);
    const state = await requestEmailVerificationAction({}, new FormData());
    expect(state.code).toBe("RATE_LIMITED");
  });
});

// ─── Email change — step-up ở request VÀ confirm + notice chỉ kênh cũ verified ──

describe("email change", () => {
  it("request: email mới đã thuộc tài khoản khác → EMAIL_TAKEN, không tốn OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "khac@loaviet.test", currentPassword: PASSWORD }),
    );
    expect(state.code).toBe("EMAIL_TAKEN");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
    expect(dbState.otpRows).toHaveLength(0);
  });

  it("request: email mới trùng email hiện tại → EMAIL_SAME, không OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "mua@loaviet.test", currentPassword: PASSWORD }),
    );
    expect(state.code).toBe("EMAIL_SAME");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("request: sai mật khẩu hiện tại → WRONG_PASSWORD, không gửi OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", currentPassword: "sai-mat-khau" }),
    );
    expect(state.code).toBe("WRONG_PASSWORD");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("confirm: THIẾU mật khẩu → MISSING_CURRENT_PASSWORD, không mutation (step-up tại confirm)", async () => {
    login(dbState.users[0]!);
    const state = await confirmEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", code: "123456", currentPassword: "" }),
    );
    expect(state.code).toBe("MISSING_CURRENT_PASSWORD");
    expect(dbState.users[0]!.email).toBe("mua@loaviet.test");
    expect(revokedSessions()).toHaveLength(0);
  });

  it("confirm: đổi email thành công — verifiedAt set, session khác revoked TRÊN TX reason email_change, current sống, audit; email cũ CHƯA verified → KHÔNG notice", async () => {
    login(dbState.users[0]!); // email cũ mua@loaviet.test — emailVerifiedAt null

    const code = await requestAndExtractCode(
      requestEmailChangeAction,
      fd({ newEmail: "moi@loaviet.test", currentPassword: PASSWORD }),
    );
    const state = await confirmEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", code, currentPassword: PASSWORD }),
    );

    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.email).toBe("moi@loaviet.test");
    expect(dbState.users[0]!.emailVerifiedAt).not.toBeNull();
    // revocation trên tx — global client không được chạm
    expect(revokeAllGlobal).not.toHaveBeenCalled();
    const revoked = revokedSessions();
    expect(revoked.map((s) => s["id"]).sort()).toEqual(["sess-2", "sess-3"]);
    for (const s of revoked) expect(s["revokedReason"]).toBe("email_change");
    expect(dbState.sessions.find((s) => s["id"] === "sess-1")!["revokedAt"]).toBeNull();
    // email cũ CHƯA verified → không notice (fix LOW #6)
    expect(delivery.sendSecurityNotice).not.toHaveBeenCalled();
    const evt = dbState.auditRows.find((r) => r.action === "user.email_changed");
    expect(evt).toBeTruthy();
    expect(JSON.stringify(evt)).not.toContain("moi@loaviet.test");
    expect(JSON.stringify(evt)).not.toContain("mua@loaviet.test");
    expect(dbState.notifications.some((n) => n.userId === "user-1")).toBe(true);
  });

  it("confirm: email cũ ĐÃ verified → security notice tới email CŨ", async () => {
    dbState.users[0]!.emailVerifiedAt = "2026-10-01T00:00:00.000Z";
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(
      requestEmailChangeAction,
      fd({ newEmail: "moi@loaviet.test", currentPassword: PASSWORD }),
    );
    await confirmEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", code, currentPassword: PASSWORD }),
    );

    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: "mua@loaviet.test", channel: "email" }),
    );
  });

  it("confirm: sai mã → lỗi, email giữ nguyên, không revoke", async () => {
    login(dbState.users[0]!);
    const real = await requestAndExtractCode(
      requestEmailChangeAction,
      fd({ newEmail: "moi@loaviet.test", currentPassword: PASSWORD }),
    );
    const wrong = real === "999999" ? "888888" : "999999";
    const state = await confirmEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", code: wrong, currentPassword: PASSWORD }),
    );
    expect(state.error).toBeTruthy();
    expect(dbState.users[0]!.email).toBe("mua@loaviet.test");
    expect(revokedSessions()).toHaveLength(0);
  });
});

// ─── Phone change — step-up ở request VÀ confirm + notice chỉ kênh cũ verified ──

describe("phone change", () => {
  it("request: cooldown OTP → lỗi form tiếng Việt (OTP_RATE_LIMITED), adapter gọi ĐÚNG 1 lần", async () => {
    login(dbState.users[0]!);
    const form = fd({ newPhone: "09011112222", currentPassword: PASSWORD });

    const first = await requestPhoneChangeAction({}, form);
    expect(first.error).toBeUndefined();

    const second = await requestPhoneChangeAction({}, form);
    expect(second.code).toBe("OTP_RATE_LIMITED");
    expect(second.error).toMatch(/giây/);
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1);
  });

  it("request: sai mật khẩu hiện tại → WRONG_PASSWORD, không gửi OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestPhoneChangeAction(
      {},
      fd({ newPhone: "09011112222", currentPassword: "sai-mat-khau" }),
    );
    expect(state.code).toBe("WRONG_PASSWORD");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("request: số mới đã được xác minh bởi tài khoản khác → PHONE_ALREADY_VERIFIED sớm, không tốn SMS", async () => {
    login(dbState.users[0]!);
    const state = await requestPhoneChangeAction(
      {},
      fd({ newPhone: "0901234567", currentPassword: PASSWORD }),
    );
    expect(state.code).toBe("PHONE_ALREADY_VERIFIED");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("confirm: THIẾU mật khẩu → MISSING_CURRENT_PASSWORD, không mutation (step-up tại confirm)", async () => {
    login(dbState.users[0]!);
    const state = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09011112222", code: "123456", currentPassword: "" }),
    );
    expect(state.code).toBe("MISSING_CURRENT_PASSWORD");
    expect(dbState.users[0]!.phone).toBe("0900000001");
    expect(revokedSessions()).toHaveLength(0);
  });

  it("confirm: đổi số thành công — verifiedAt set, session khác revoked TRÊN TX reason phone_change, current sống, audit; phone cũ CHƯA verified → KHÔNG notice", async () => {
    login(dbState.users[0]!); // phone cũ 0900000001 — phoneVerifiedAt null

    const code = await requestAndExtractCode(
      requestPhoneChangeAction,
      fd({ newPhone: "09011112222", currentPassword: PASSWORD }),
    );
    const state = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09011112222", code, currentPassword: PASSWORD }),
    );

    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBe("09011112222");
    expect(dbState.users[0]!.phoneVerifiedAt).not.toBeNull();
    expect(revokeAllGlobal).not.toHaveBeenCalled();
    const revoked = revokedSessions();
    expect(revoked.map((s) => s["id"]).sort()).toEqual(["sess-2", "sess-3"]);
    for (const s of revoked) expect(s["revokedReason"]).toBe("phone_change");
    expect(dbState.sessions.find((s) => s["id"] === "sess-1")!["revokedAt"]).toBeNull();
    // phone cũ CHƯA verified → không notice (fix LOW #6)
    expect(delivery.sendSecurityNotice).not.toHaveBeenCalled();
    const evt = dbState.auditRows.find((r) => r.action === "user.phone_changed");
    expect(evt).toBeTruthy();
    expect(JSON.stringify(evt)).not.toContain("09011112222");
    expect(JSON.stringify(evt)).not.toContain("0900000001");
  });

  it("confirm: phone cũ ĐÃ verified → security notice tới phone CŨ", async () => {
    dbState.users[0]!.phoneVerifiedAt = "2026-10-01T00:00:00.000Z";
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(
      requestPhoneChangeAction,
      fd({ newPhone: "09011112222", currentPassword: PASSWORD }),
    );
    await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09011112222", code, currentPassword: PASSWORD }),
    );

    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: "0900000001", channel: "phone" }),
    );
  });

  it("confirm: collision xuất hiện GIỮA request và confirm (race) → re-check trong tx chặn, giữ nguyên", async () => {
    login(dbState.users[0]!);
    dbState.users[0]!.phone = "0900000001";

    // request lúc 09055556666 còn tự do (step-up + OTP hợp lệ)
    const code = await requestAndExtractCode(
      requestPhoneChangeAction,
      fd({ newPhone: "09055556666", currentPassword: PASSWORD }),
    );

    // race: tài khoản khác xác minh số đó TRƯỚC khi user-1 confirm
    dbState.users[1]!.phone = "09055556666";
    dbState.users[1]!.phoneVerifiedAt = new Date().toISOString();

    const state = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09055556666", code, currentPassword: PASSWORD }),
    );

    expect(state.code).toBe("PHONE_ALREADY_VERIFIED");
    expect(dbState.users[0]!.phone).toBe("0900000001");
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
    expect(revokedSessions()).toHaveLength(0);
    expect(dbState.auditRows.filter((r) => r.action === "user.phone_changed")).toHaveLength(0);
  });
});
