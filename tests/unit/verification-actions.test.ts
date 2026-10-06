/**
 * Email/phone verification + identity changes — unit tests (plan Task 6,
 * spec §5.3/§5.3.1: verified identifier unique among active accounts, collision
 * → typed error KHÔNG BAO GIỜ merge; sensitive change có step-up, reset
 * verifiedAt, revoke session khác, notice bảo mật tới kênh CŨ; enumeration-safe).
 *
 * Cơ chế mock: `server-only` + `next/cache` + `next/navigation` (redirect throw
 * NEXT_REDIRECT) + `next/headers` (headers/cookies điều khiển được) +
 * `@/src/lib/session` (getSessionFromCookie fixture + revokeAllUserSessions
 * spy — đúng seam actions tiêu thụ; hành vi thật của session do
 * tests/unit/session.test.ts đảm nhiệm) + `@/src/lib/verification-delivery`
 * (adapter spy) + `@/src/prisma/db.client` (in-memory User/OtpCode/AuditEvent/
 * Notification). OTP core (requestOtp/verifyOtp/normalizePhone) GIỮ BẢN THẬT —
 * test hành trình action đầy đủ qua OTP thật (hash, cooldown, consume);
 * rate limiter thật + resetRateLimits giữa các case.
 *
 * Hợp đồng (plan Task 6 Step 1):
 *  1. confirmEmailVerificationAction: emailVerifiedAt set + audit
 *     "user.email_verified" — detail KHÔNG chứa email thô (spec §4.8).
 *  2. confirmPhoneVerificationAction: phone đã được xác minh bởi tài khoản
 *     KHÁC → typed PHONE_ALREADY_VERIFIED, không merge, không update
 *     (spec §5.3.1 — identity collision).
 *  3. confirmPhoneVerificationAction: phone giống nhau nhưng CHƯA xác minh ở
 *     tài khoản khác → verify thành công (uniqueness chỉ áp danh tính ĐÃ
 *     xác minh).
 *  4. changePasswordAction: sai mật khẩu hiện tại → lỗi, không mutation;
 *     đúng → hash mới, revoke session khác reason "password_change", session
 *     hiện tại giữ nguyên (Review Focus 3), audit + notify.
 *  5. requestEmailChangeAction: email mới đã thuộc tài khoản khác → typed
 *     EMAIL_TAKEN (enumeration-safe message), không gửi OTP.
 *  6. confirmEmailChangeAction: email swapped, emailVerifiedAt set, session
 *     khác revoked reason "email_change", security notice tới email CŨ
 *     (adapter spy), audit "user.email_changed".
 *  7. requestPhoneChangeAction: cooldown/rate-limit OTP → lỗi form tiếng Việt
 *     (OTP_RATE_LIMITED), adapter gọi ĐÚNG 1 lần.
 *  8. MỌI action đòi session: không cookie → NEXT_REDIRECT, không chạm db.
 *  (+) Step-up đổi email/phone: sai mật khẩu hiện tại → lỗi, không gửi OTP.
 *  (+) confirmPhoneChangeAction: collision re-check TRONG tx (race giữa
 *      request và confirm) → PHONE_ALREADY_VERIFIED, user giữ nguyên.
 *  (+) confirmPhoneChangeAction: đổi số thành công — notice tới phone CŨ,
 *      revoke session khác reason "phone_change", audit "user.phone_changed".
 *  (+) confirmEmailChangeAction: sai mã → lỗi, email giữ nguyên.
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

// headers() cho requireUser/audit-event (ipHash); cookies() cho auth.ts import
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

// ─── Session seam — actions đọc requireUser → getSessionFromCookie, và gọi
// revokeAllUserSessions sau thay đổi nhạy cảm (spec §5.3.1). Hành vi thật của
// module session do tests/unit/session.test.ts đảm nhiệm; ở đây spy args. ────

const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
  revokedAll: [] as Array<{ userId: unknown; reason: unknown; opts?: { exceptSessionId?: string } }>,
}));

vi.mock("@/src/lib/session", () => ({
  SESSION_COOKIE: "sp_session",
  getSessionFromCookie: vi.fn(async () => sessionState.current),
  revokeSession: vi.fn(),
  createSession: vi.fn(),
  revokeAllUserSessions: vi.fn(
    async (userId: string, reason: string, opts?: { exceptSessionId?: string }) => {
      sessionState.revokedAll.push({ userId, reason, opts });
      return 0;
    },
  ),
}));

// ─── Delivery adapter spy — OTP + security notice (spec §5.3.1 "when feasible") ──

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

// ─── db.client mock: in-memory User (first-match) + OtpCode (last = newest,
// đúng ngữ nghĩa orderBy createdAt desc) + AuditEvent/Notification capture ───

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
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
      // tx passthrough — cùng store: mutation trong tx thấy ngay; hành vi
      // rollback thật do integration test đảm nhiệm (collision check chạy
      // TRƯỚC mutation nên unit test không cần rollback vật lý).
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { verifyPassword } from "@/src/lib/auth";
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

/** user-1 (đăng nhập) + user-2 (đã xác minh phone 0901234567). */
const U1 = mkUser({ id: "user-1", email: "mua@loaviet.test", name: "Người Mua" });
const U2 = mkUser({
  id: "user-2",
  email: "khac@loaviet.test",
  name: "Người Khác",
  phone: "0901234567",
  phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
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

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.otpRows.length = 0;
  dbState.auditRows.length = 0;
  dbState.notifications.length = 0;
  dbState.users.push({ ...U1 }, { ...U2 });
  sessionState.current = null;
  sessionState.revokedAll.length = 0;
  delivery.sendOtp.mockClear();
  delivery.sendSecurityNotice.mockClear();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 8. MỌI action đòi session (chống gọi trực tiếp không đăng nhập) ─────────

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
    // fail closed: không OTP, không audit, không notify, không revoke
    expect(dbState.otpRows).toHaveLength(0);
    expect(dbState.auditRows).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
    expect(sessionState.revokedAll).toHaveLength(0);
    expect(delivery.sendOtp).not.toHaveBeenCalled();
    expect(delivery.sendSecurityNotice).not.toHaveBeenCalled();
  });
});

// ─── 1. Email verification ───────────────────────────────────────────────────

describe("email verification", () => {
  it("confirmEmailVerificationAction: set emailVerifiedAt + audit user.email_verified (detail không có email thô)", async () => {
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(requestEmailVerificationAction, new FormData());
    // mã gửi tới ĐÚNG email của user, purpose/channel đúng
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
    // spec §4.8: KHÔNG email thô trong audit detail
    expect(JSON.stringify(evt)).not.toContain("mua@loaviet.test");
  });

  it("sai mã → lỗi, emailVerifiedAt giữ null", async () => {
    login(dbState.users[0]!);
    const real = await requestAndExtractCode(requestEmailVerificationAction, new FormData());
    // mã SAI chắc chắn (không phụ thuộc random): khác mã thật
    const wrong = real === "000000" ? "111111" : "000000";
    const state = await confirmEmailVerificationAction({}, fd({ code: wrong }));
    expect(state.error).toBeTruthy();
    expect(dbState.users[0]!.emailVerifiedAt).toBeNull();
  });
});

// ─── 2+3. Phone verification — identity collision (spec §5.3.1) ──────────────

describe("phone verification — collision rule (spec §5.3.1)", () => {
  it("phone đã ĐƯỢC XÁC MINH bởi tài khoản khác → PHONE_ALREADY_VERIFIED, không merge, không update", async () => {
    login(dbState.users[0]!); // user-1, phone null
    // user-2 giữ phone 0901234567 ĐÃ xác minh (fixture)

    const code = await requestAndExtractCode(
      requestPhoneVerificationAction,
      fd({ phone: "0901234567" }),
    );
    const state = await confirmPhoneVerificationAction({}, fd({ phone: "0901234567", code }));

    expect(state.code).toBe("PHONE_ALREADY_VERIFIED");
    // KHÔNG merge, KHÔNG update user-1
    expect(dbState.users[0]!.phone).toBeNull();
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
    // chủ sở hữu cũ giữ nguyên tuyệt đối
    expect(dbState.users[1]!.phone).toBe("0901234567");
    expect(dbState.users[1]!.phoneVerifiedAt).toBe("2026-10-01T00:00:00.000Z");
    // không audit "user.phone_verified" — không có gì xảy ra với danh tính
    expect(dbState.auditRows.filter((r) => r.action === "user.phone_verified")).toHaveLength(0);
  });

  it("phone giống nhau nhưng CHƯA xác minh ở tài khoản khác → verify thành công", async () => {
    // user-2 giữ phone nhưng phoneVerifiedAt null — uniqueness chỉ áp danh tính ĐÃ xác minh
    dbState.users[1]!.phone = "0909876543";
    dbState.users[1]!.phoneVerifiedAt = null;
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(
      requestPhoneVerificationAction,
      fd({ phone: "0909876543" }),
    );
    const state = await confirmPhoneVerificationAction({}, fd({ phone: "0909876543", code }));

    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBe("0909876543");
    expect(dbState.users[0]!.phoneVerifiedAt).not.toBeNull();
    // user-2 giữ nguyên (unverified) — không bị strip phone
    expect(dbState.users[1]!.phone).toBe("0909876543");
    expect(dbState.users[1]!.phoneVerifiedAt).toBeNull();
    expect(dbState.auditRows.some((r) => r.action === "user.phone_verified")).toBe(true);
  });

  it("số điện thoại sai format → lỗi form, không gửi OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestPhoneVerificationAction({}, fd({ phone: "12345" }));
    expect(state.error).toBeTruthy();
    expect(delivery.sendOtp).not.toHaveBeenCalled();
    expect(dbState.otpRows).toHaveLength(0);
  });
});

// ─── 4. changePasswordAction (Review Focus 3) ────────────────────────────────

describe("changePasswordAction", () => {
  it("sai mật khẩu hiện tại → lỗi, không mutation, không revoke, không audit", async () => {
    login(dbState.users[0]!);
    const hashBefore = dbState.users[0]!.passwordHash;

    const state = await changePasswordAction(
      {},
      fd({ currentPassword: "sai-het-roi", newPassword: "mat-khau-moi-123" }),
    );

    expect(state.code).toBe("WRONG_PASSWORD");
    expect(dbState.users[0]!.passwordHash).toBe(hashBefore);
    expect(sessionState.revokedAll).toHaveLength(0);
    expect(dbState.auditRows).toHaveLength(0);
  });

  it("đúng → hash mới, revoke session KHÁC reason password_change (session hiện tại giữ), audit + notify", async () => {
    login(dbState.users[0]!);

    const state = await changePasswordAction(
      {},
      fd({ currentPassword: PASSWORD, newPassword: "mat-khau-moi-123" }),
    );

    expect(state.error).toBeUndefined();
    await expect(
      verifyPassword("mat-khau-moi-123", dbState.users[0]!.passwordHash as string),
    ).resolves.toBe(true);
    // Review Focus 3: session khác bị revoke, session hiện tại (except) sống
    expect(sessionState.revokedAll).toEqual([
      { userId: "user-1", reason: "password_change", opts: { exceptSessionId: "sess-1" } },
    ]);
    expect(dbState.auditRows.some((r) => r.action === "user.password_changed")).toBe(true);
    expect(dbState.notifications.some((n) => n.userId === "user-1")).toBe(true);
  });
});

// ─── 5+6. Email change (step-up + OTP + notice tới email CŨ) ──────────────────

describe("email change", () => {
  it("request: email mới đã thuộc tài khoản khác → EMAIL_TAKEN, không gửi OTP", async () => {
    login(dbState.users[0]!);

    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "khac@loaviet.test", currentPassword: PASSWORD }),
    );

    expect(state.code).toBe("EMAIL_TAKEN");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
    expect(dbState.otpRows).toHaveLength(0);
  });

  it("request: email mới trùng email hiện tại của chính mình → lỗi, không gửi OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "mua@loaviet.test", currentPassword: PASSWORD }),
    );
    expect(state.error).toBeTruthy();
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("request: sai mật khẩu hiện tại (thiếu step-up) → lỗi, không gửi OTP", async () => {
    login(dbState.users[0]!);
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", currentPassword: "sai-mat-khau" }),
    );
    expect(state.code).toBe("WRONG_PASSWORD");
    expect(delivery.sendOtp).not.toHaveBeenCalled();
  });

  it("confirm: email swapped, emailVerifiedAt set, session khác revoked reason email_change, notice tới email CŨ, audit", async () => {
    login(dbState.users[0]!); // email CŨ: mua@loaviet.test

    const code = await requestAndExtractCode(
      requestEmailChangeAction,
      fd({ newEmail: "moi@loaviet.test", currentPassword: PASSWORD }),
    );
    expect(delivery.sendOtp.mock.calls.at(-1)![0]).toMatchObject({
      to: "moi@loaviet.test",
      purpose: "email_verification",
      channel: "email",
    });

    const state = await confirmEmailChangeAction(
      {},
      fd({ newEmail: "moi@loaviet.test", code }),
    );

    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.email).toBe("moi@loaviet.test");
    expect(dbState.users[0]!.emailVerifiedAt).not.toBeNull();
    expect(sessionState.revokedAll).toEqual([
      { userId: "user-1", reason: "email_change", opts: { exceptSessionId: "sess-1" } },
    ]);
    // security notice tới kênh CŨ (spec §5.3.1 "when feasible")
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: "mua@loaviet.test", channel: "email" }),
    );
    const evt = dbState.auditRows.find((r) => r.action === "user.email_changed");
    expect(evt).toBeTruthy();
    // spec §4.8: audit detail không chứa email thô (cũ lẫn mới)
    expect(JSON.stringify(evt)).not.toContain("moi@loaviet.test");
    expect(JSON.stringify(evt)).not.toContain("mua@loaviet.test");
    expect(dbState.notifications.some((n) => n.userId === "user-1")).toBe(true);
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
      fd({ newEmail: "moi@loaviet.test", code: wrong }),
    );
    expect(state.error).toBeTruthy();
    expect(dbState.users[0]!.email).toBe("mua@loaviet.test");
    expect(sessionState.revokedAll).toHaveLength(0);
  });
});

// ─── 7. Phone change (cooldown + collision-in-tx + notice tới phone CŨ) ───────

describe("phone change", () => {
  it("request: cooldown OTP → lỗi form tiếng Việt (OTP_RATE_LIMITED), adapter gọi ĐÚNG 1 lần", async () => {
    login(dbState.users[0]!);
    const form = fd({ newPhone: "09011112222", currentPassword: PASSWORD });

    const first = await requestPhoneChangeAction({}, form);
    expect(first.error).toBeUndefined();

    const second = await requestPhoneChangeAction({}, form);
    expect(second.code).toBe("OTP_RATE_LIMITED");
    expect(second.error).toMatch(/giây/); // thông điệp tiếng Việt, có thời gian chờ
    expect(delivery.sendOtp).toHaveBeenCalledTimes(1);
  });

  it("request: sai mật khẩu hiện tại (thiếu step-up) → lỗi, không gửi OTP", async () => {
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

  it("confirm: đổi số thành công — phoneVerifiedAt set, session khác revoked reason phone_change, notice tới phone CŨ, audit", async () => {
    dbState.users[0]!.phone = "0900000001"; // phone CŨ (đã từng verify)
    dbState.users[0]!.phoneVerifiedAt = "2026-10-01T00:00:00.000Z";
    login(dbState.users[0]!);

    const code = await requestAndExtractCode(
      requestPhoneChangeAction,
      fd({ newPhone: "09011112222", currentPassword: PASSWORD }),
    );
    const state = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09011112222", code }),
    );

    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBe("09011112222");
    expect(dbState.users[0]!.phoneVerifiedAt).not.toBeNull();
    expect(sessionState.revokedAll).toEqual([
      { userId: "user-1", reason: "phone_change", opts: { exceptSessionId: "sess-1" } },
    ]);
    expect(delivery.sendSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: "0900000001", channel: "phone" }),
    );
    const evt = dbState.auditRows.find((r) => r.action === "user.phone_changed");
    expect(evt).toBeTruthy();
    expect(JSON.stringify(evt)).not.toContain("09011112222");
    expect(JSON.stringify(evt)).not.toContain("0900000001");
  });

  it("confirm: collision xuất hiện GIỮA request và confirm (race) → re-check trong tx chặn, user giữ nguyên", async () => {
    login(dbState.users[0]!);
    dbState.users[0]!.phone = "0900000001";

    // request lúc 09055556666 còn tự do
    const code = await requestAndExtractCode(
      requestPhoneChangeAction,
      fd({ newPhone: "09055556666", currentPassword: PASSWORD }),
    );

    // race: tài khoản khác xác minh số đó TRƯỚC khi user-1 confirm
    dbState.users[1]!.phone = "09055556666";
    dbState.users[1]!.phoneVerifiedAt = new Date().toISOString();

    const state = await confirmPhoneChangeAction(
      {},
      fd({ newPhone: "09055556666", code }),
    );

    expect(state.code).toBe("PHONE_ALREADY_VERIFIED");
    expect(dbState.users[0]!.phone).toBe("0900000001"); // giữ nguyên
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
    expect(sessionState.revokedAll).toHaveLength(0);
    expect(dbState.auditRows.filter((r) => r.action === "user.phone_changed")).toHaveLength(0);
  });
});
