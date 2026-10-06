/**
 * Admin MFA login + step-up — unit tests (plan Task 8, spec §5.3/§5.4.2).
 *
 * MFA gate (plan Task 8 Step 2):
 *  1. Admin CHƯA enroll MFA → không đăng nhập được — MFA_ENROLLMENT_REQUIRED,
 *     KHÔNG tạo session (fail closed — bootstrap Task 11).
 *  2. Admin ĐÃ enroll: chỉ password → { mfaRequired: true }, KHÔNG tạo session;
 *     + TOTP đúng → session tạo với isAdmin=true; + TOTP sai → error, KHÔNG
 *     session (rate limit auth:mfa riêng cho lần sai).
 *  3. Đăng nhập bằng MÃ KHÔI PHỤC → session tạo + audit
 *     "admin.mfa_recovery_code_used" (spec §4.6); mã đã dùng không dùng lại được.
 *  4. User thường: field MFA bị bỏ qua hoàn toàn (MFA chỉ dành cho adminRole —
 *     SMS không bao giờ là factor admin, spec §5.3).
 *  5. requireCapabilityWithStepUp (chuyển từ Task 4 sang đây): fresh step-up
 *     pass; stale không code → STEP_UP_REQUIRED; stale + code đúng → session
 *     đánh dấu stepped-up + audit "admin.step_up"; code sai → MFA_CODE_INVALID;
 *     capability ngoài STEP_UP_CAPABILITIES không bao giờ đòi step-up.
 *
 * Cơ chế mock: `server-only` + `next/headers` (headers điều khiển được) +
 * `next/navigation` (redirect throw NEXT_REDIRECT) + `@/src/prisma/db.client`
 * (in-memory User/AdminMfa/AdminRecoveryCode/AuditEvent/Cart) + `@/src/lib/auth`
 * (verifyPassword/createSession spy) + `@/src/lib/session` (getSessionFromCookie
 * điều khiển được — đúng seam rbac tiêu thụ) + `@/src/lib/rate-limit` (limiter
 * fake theo-key để test bucket auth:mfa RIÊNG). admin-mfa/totp/audit-event GIỮ
 * BẢN THẬT — login flow chạy đúng code sẽ chạy ở production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── redirect throw NEXT_REDIRECT (như rbac.test.ts) ─────────────────────────

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// ─── headers điều khiển được (clientIpFromHeaders + ipHash audit) ─────────────

const headerState = vi.hoisted(() => ({
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerState.headers),
}));

// ─── rate-limit FAKE theo-key — bucket auth:mfa test RIÊNG được ───────────────

const rateState = vi.hoisted(() => ({
  hits: new Map<string, number>(),
  /** key luôn cho qua (dùng để cô lập bucket auth:mfa khỏi auth:login). */
  alwaysAllow: new Set<string>(),
  /** IP "client" — điều khiển được để test bucket per-account chặn qua nhiều IP. */
  ip: "test-ip",
}));

vi.mock("@/src/lib/rate-limit", () => ({
  checkRateLimit: (key: string, rule: { limit: number }) => {
    if (rateState.alwaysAllow.has(key)) {
      return { allowed: true, retryAfterSec: 0, remaining: rule.limit };
    }
    const n = (rateState.hits.get(key) ?? 0) + 1;
    rateState.hits.set(key, n);
    const allowed = n <= rule.limit;
    return { allowed, retryAfterSec: 60, remaining: Math.max(0, rule.limit - n) };
  },
  clientIpFromHeaders: () => rateState.ip,
}));

// ─── db.client mock: in-memory 5 model ────────────────────────────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  mfas: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  carts: [] as Array<Record<string, unknown>>,
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

  const makeModel = (rows: Row[], defaults?: () => Row) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit ? { ...hit } : null;
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? {}), ...data };
        rows.push(row);
        return { ...row };
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
    };
  };

  const orm = {
    public: {
      User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
      AdminMfa: makeModel(dbState.mfas, () => ({
        id: `mfa-${dbState.mfas.length + 1}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      AdminRecoveryCode: makeModel(dbState.codes, () => ({
        id: `rc-${dbState.codes.length + 1}`,
        createdAt: new Date().toISOString(),
        usedAt: null, // nullable column — DB thật luôn có null, mock phải trung thực
      })),
      AuditEvent: makeModel(dbState.audits, () => ({
        id: `audit-${dbState.audits.length + 1}`,
        createdAt: new Date().toISOString(),
      })),
      Cart: makeModel(dbState.carts, () => ({
        id: `cart-${dbState.carts.length + 1}`,
        createdAt: new Date().toISOString(),
      })),
    },
  };
  return {
    db: {
      orm,
      transaction: async (fn: (tx: { orm: typeof orm }) => Promise<unknown>) => fn({ orm }),
    },
  };
});

// ─── auth mock: verifyPassword/createSession spy (chữ ký giữ nguyên) ──────────

const authSpy = vi.hoisted(() => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
}));

vi.mock("@/src/lib/auth", () => ({
  hashPassword: vi.fn(async () => "hashed"),
  verifyPassword: vi.fn(async (password: string) => password === "đúng-mật-khẩu"),
  createSession: authSpy.createSession,
  destroySession: authSpy.destroySession,
}));

// ─── session mock: getSessionFromCookie điều khiển được (seam của rbac) ──────

const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
  steppedUp: [] as string[],
}));

vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(async () => sessionState.current),
  markSessionSteppedUp: vi.fn(async (id: string) => {
    sessionState.steppedUp.push(id);
    const s = sessionState.current?.session;
    if (s && s.id === id) s.steppedUpAt = new Date().toISOString();
  }),
  stepUpIsFresh: (steppedUpAt: string | null) =>
    steppedUpAt !== null && Date.now() - Date.parse(steppedUpAt) <= 15 * 60_000,
}));

import { loginAction } from "@/src/lib/actions/auth";
import {
  STEP_UP_CAPABILITIES,
  requireCapabilityWithStepUp,
  type AdminRole,
} from "@/src/lib/rbac";
import { enrollAdminMfa, resetTotpReplayProtection } from "@/src/lib/admin-mfa";
import { hotpCode } from "@/src/lib/totp";
import { markSessionSteppedUp } from "@/src/lib/session";
// ─── Fixtures ────────────────────────────────────────────────────────────────

const KEY_32B = Buffer.alloc(32, 0x33).toString("base64");

const ADMIN = {
  id: "user-admin",
  email: "admin@loaviet.test",
  passwordHash: "bcrypt-admin",
  name: "Admin",
  role: "admin",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: "super_admin",
} as const;

const BUYER = {
  id: "user-buyer",
  email: "buyer@loaviet.test",
  passwordHash: "bcrypt-buyer",
  name: "Buyer",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
} as const;

const nowCounter = () => Math.floor(Date.now() / 30_000);

/** Kết quả enrollAdminMfa gần nhất (secret + mã khôi phục thô — chỉ trong test). */
let enrolled: { secretBase32: string; uri: string; recoveryCodes: string[] } | null = null;

/** Session + SessionUser fixture cho step-up (shape như getSessionFromCookie). */
const sessionOf = (
  userId: string,
  adminRole: AdminRole,
  steppedUpAt: string | null,
  sessionId = "sess-1",
) => ({
  session: {
    id: sessionId,
    userId,
    isAdmin: true,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    steppedUpAt,
    userAgent: null,
  },
  user: {
    id: userId,
    email: "u@loaviet.test",
    name: "U",
    role: "admin",
    avatarUrl: null,
    isVerifiedSeller: false,
    adminRole,
    sessionId,
  },
});

const loginForm = (email: string, password: string, mfaCode?: string): FormData => {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  if (mfaCode !== undefined) fd.set("mfaCode", mfaCode);
  return fd;
};

/** loginAction thành công → redirect throw NEXT_REDIRECT — bắt để assert side effect. */
const loginOk = async (fd: FormData): Promise<string> => {
  let redirectUrl = "";
  try {
    await loginAction({}, fd);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("NEXT_REDIRECT:")) redirectUrl = msg.slice("NEXT_REDIRECT:".length);
    else throw e;
  }
  return redirectUrl;
};

/** Mã TOTP hiện tại của enrollment gần nhất. */
const currentTotp = (): string => hotpCode(enrolled!.secretBase32, nowCounter());

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
  dbState.users.length = 0;
  dbState.mfas.length = 0;
  dbState.codes.length = 0;
  dbState.audits.length = 0;
  dbState.carts.length = 0;
  dbState.users.push({ ...ADMIN }, { ...BUYER });
  rateState.hits.clear();
  rateState.alwaysAllow.clear();
  rateState.ip = "test-ip";
  sessionState.current = null;
  sessionState.steppedUp.length = 0;
  authSpy.createSession.mockClear();
  authSpy.destroySession.mockClear();
  headerState.headers = new Headers();
  enrolled = null;
  resetTotpReplayProtection(); // store replay in-process — reset giữa các case
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Admin chưa enroll — fail closed ──────────────────────────────────────

describe("loginAction — admin chưa MFA (fail closed)", () => {
  it("MFA_ENROLLMENT_REQUIRED, KHÔNG tạo session, KHÔNG side effect nào", async () => {
    // adminRole super_admin nhưng chưa có row AdminMfa
    const state = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu"));
    expect(state.error).toContain("MFA_ENROLLMENT_REQUIRED");
    expect(state.mfaRequired).toBeUndefined();
    expect(authSpy.createSession).not.toHaveBeenCalled();
    expect(dbState.carts).toHaveLength(0); // chặn trước cả tạo giỏ hàng
  });
});

// ─── 2. Admin đã enroll — challenge → verify ────────────────────────────────

describe("loginAction — admin đã enroll MFA", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN.id);
    expect(enrolled).not.toBeNull();
  });

  it("chỉ password → { mfaRequired: true }, KHÔNG tạo session", async () => {
    const state = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu"));
    expect(state.mfaRequired).toBe(true);
    expect(state.error).toBeUndefined();
    expect(authSpy.createSession).not.toHaveBeenCalled();
  });

  it("password sai → error như thường, KHÔNG đụng MFA", async () => {
    const state = await loginAction({}, loginForm(ADMIN.email, "sai-mật-khẩu"));
    expect(state.error).toContain("Email hoặc mật khẩu không đúng");
    expect(state.mfaRequired).toBeUndefined();
    expect(authSpy.createSession).not.toHaveBeenCalled();
  });

  it("+ TOTP đúng → session tạo với isAdmin=true (TTL 12h do session.ts lo)", async () => {
    const url = await loginOk(loginForm(ADMIN.email, "đúng-mật-khẩu", currentTotp()));
    expect(url).toBe("/"); // redirect về trang chủ
    expect(authSpy.createSession).toHaveBeenCalledTimes(1);
    expect(authSpy.createSession).toHaveBeenCalledWith(ADMIN.id, { isAdmin: true });
    // audit admin.login cho MỌI login admin thành công (review minor) — reason = factor
    const logins = dbState.audits.filter((a) => a.action === "admin.login");
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ actorId: ADMIN.id, reason: "totp" });
    // TOTP login KHÔNG đụng audit recovery
    expect(dbState.audits.filter((a) => a.action === "admin.mfa_recovery_code_used")).toHaveLength(0);
  });

  it("+ TOTP sai → error, KHÔNG session, audit 'admin.mfa_failed' (KHÔNG chứa mã)", async () => {
    const state = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", "000000"));
    expect(state.error).toContain("Mã xác thực không đúng");
    expect(state.mfaRequired).toBeUndefined();
    expect(authSpy.createSession).not.toHaveBeenCalled();
    const failed = dbState.audits.filter((a) => a.action === "admin.mfa_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actorId: ADMIN.id });
    expect(JSON.stringify(failed)).not.toContain("000000"); // spec §4.8 — không mã thô
  });

  it("+ TOTP sai 10 lần → bucket auth:mfa chặn (rate limit riêng), KHÔNG session", async () => {
    // cô lập bucket auth:mfa: auth:login luôn cho qua
    rateState.alwaysAllow.add("auth:login:test-ip");
    for (let i = 0; i < 10; i++) {
      const state = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", "000000"));
      expect(state.error).toContain("Mã xác thực không đúng");
    }
    // lần 11 — bucket auth:mfa (10/10 phút/IP) đã đầy
    const blocked = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", "000000"));
    expect(blocked.error).toContain("Quá nhiều lần thử mã xác thực");
    expect(authSpy.createSession).not.toHaveBeenCalled();
  });

  it("bucket ĐƯỢC KIỂM TRA TRƯỚC khi verify — mã ĐÚNG cũng bị từ chối khi đang limited (review fix #3)", async () => {
    // 10 lần sai làm đầy bucket → submit mã ĐÚNG: bị chặn ở CỔNG, KHÔNG verify,
    // KHÔNG session — "correct guess succeeds while limited" không thể xảy ra.
    rateState.alwaysAllow.add("auth:login:test-ip");
    for (let i = 0; i < 10; i++) {
      await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", "000000"));
    }
    const correctButLimited = await loginAction(
      {},
      loginForm(ADMIN.email, "đúng-mật-khẩu", currentTotp()),
    );
    expect(correctButLimited.error).toContain("Quá nhiều lần thử mã xác thực");
    expect(authSpy.createSession).not.toHaveBeenCalled();
    // qua cửa sổ (test: reset bucket) → mã đúng vào được ngay — KHÔNG lockout vĩnh viễn
    rateState.hits.delete("auth:mfa:ip:test-ip");
    rateState.hits.delete(`auth:mfa:user:${ADMIN.id}`);
    const url = await loginOk(loginForm(ADMIN.email, "đúng-mật-khẩu", currentTotp()));
    expect(url).toBe("/");
    expect(authSpy.createSession).toHaveBeenCalledWith(ADMIN.id, { isAdmin: true });
  });

  it("bucket PER-ACCOUNT auth:mfa:user:<id> — đổi IP vẫn bị chặn (chặn brute-force 1 tài khoản qua nhiều IP)", async () => {
    rateState.alwaysAllow.add("auth:login:test-ip");
    rateState.alwaysAllow.add("auth:login:attacker-ip");
    for (let i = 0; i < 10; i++) {
      await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", "000000"));
    }
    // đổi IP (bucket IP mới sạch) — nhưng bucket THEO TÀI KHOẢN đã đầy
    rateState.ip = "attacker-ip";
    const blocked = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", "000000"));
    expect(blocked.error).toContain("Quá nhiều lần thử mã xác thực");
    expect(authSpy.createSession).not.toHaveBeenCalled();
  });

  it("TOTP replay: CÙNG mã đăng nhập lần hai → bị từ chối (RFC 6238 §5.2 — review fix #4)", async () => {
    const code = currentTotp();
    const url = await loginOk(loginForm(ADMIN.email, "đúng-mật-khẩu", code));
    expect(url).toBe("/");
    expect(authSpy.createSession).toHaveBeenCalledTimes(1);
    // replay cùng mã (còn hợp lệ trong window ±1) → sai mã, KHÔNG session mới
    const replay = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", code));
    expect(replay.error).toContain("Mã xác thực không đúng");
    expect(authSpy.createSession).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. Recovery-code login — session + audit ───────────────────────────────

describe("loginAction — mã khôi phục (single-use, audited)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN.id);
    expect(enrolled).not.toBeNull();
  });

  it("tạo session + audit 'admin.mfa_recovery_code_used'; mã ĐÃ dùng không đăng nhập lại được", async () => {
    const code = enrolled!.recoveryCodes[2]!;

    const url = await loginOk(loginForm(ADMIN.email, "đúng-mật-khẩu", code));
    expect(url).toBe("/");
    expect(authSpy.createSession).toHaveBeenCalledWith(ADMIN.id, { isAdmin: true });

    // audit đúng action, actor là chính admin, KHÔNG chứa mã thô (spec §4.8)
    const audits = dbState.audits.filter((a) => a.action === "admin.mfa_recovery_code_used");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ADMIN.id, resourceType: "AdminMfa" });
    expect(JSON.stringify(audits)).not.toContain(code);
    expect(JSON.stringify(audits)).not.toContain(code.replaceAll("-", ""));

    // mã khôi phục dùng MỘT LẦN — dùng lại → sai mã, không session mới
    authSpy.createSession.mockClear();
    const reuse = await loginAction({}, loginForm(ADMIN.email, "đúng-mật-khẩu", code));
    expect(reuse.error).toContain("Mã xác thực không đúng");
    expect(authSpy.createSession).not.toHaveBeenCalled();
  });
});

// ─── 4. User thường — MFA bị bỏ qua hoàn toàn ─────────────────────────────────

describe("loginAction — user thường bỏ qua MFA", () => {
  it("field mfaCode có giá trị vẫn đăng nhập bình thường, không đụng AdminMfa", async () => {
    const url = await loginOk(loginForm(BUYER.email, "đúng-mật-khẩu", "mã-gì-đó-cũng-được"));
    expect(url).toBe("/");
    expect(authSpy.createSession).toHaveBeenCalledTimes(1);
    expect(authSpy.createSession).toHaveBeenCalledWith(BUYER.id); // KHÔNG có opts isAdmin
    // không row AdminMfa nào được tạo/đọc cho user thường
    expect(dbState.mfas).toHaveLength(0);
  });
});

// ─── 5. requireCapabilityWithStepUp — admin step-up gate ────────────────────

describe("requireCapabilityWithStepUp — step-up gate (spec §5.4.2)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN.id);
    expect(enrolled).not.toBeNull();
  });

  it("STEP_UP_CAPABILITIES đúng danh sách plan (kể cả seller.verify + revoke — A5; user.suspend — Batch 3 A9)", () => {
    expect([...STEP_UP_CAPABILITIES].sort()).toEqual(
      [
        "pii.view_sensitive",
        "admin.role_manage",
        "security.config",
        "seller.verify",
        "seller.verification.revoke",
        // Batch 3 (A9): đình chỉ user = "destructive account action" (spec
        // §5.4.2) — đọc chặn platform participation qua actor-side guards.
        "user.suspend",
      ].sort(),
    );
  });

  it("Batch 3 (A9): user.suspend stale không code → STEP_UP_REQUIRED; stale + code ĐÚNG → pass + đánh dấu stepped-up", async () => {
    const stale = () => sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    sessionState.current = stale();
    await expect(requireCapabilityWithStepUp("user.suspend")).rejects.toThrowError(
      /^STEP_UP_REQUIRED$/,
    );
    expect(sessionState.steppedUp).toHaveLength(0);

    sessionState.current = stale();
    const ctx = await requireCapabilityWithStepUp("user.suspend", currentTotp());
    expect(ctx.user.id).toBe(ADMIN.id);
    expect(ctx.session.id).toBe("sess-1");
    expect(sessionState.steppedUp).toEqual(["sess-1"]);
    const audits = dbState.audits.filter((a) => a.action === "admin.step_up");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ADMIN.id, sessionId: "sess-1" });
  });

  it("step-up TƯƠI (trong 15 phút) → pass, không đòi mã lại", async () => {
    sessionState.current = sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 60_000).toISOString());
    const ctx = await requireCapabilityWithStepUp("seller.verify");
    expect(ctx.user.id).toBe(ADMIN.id);
    expect(ctx.session.id).toBe("sess-1");
    expect(sessionState.steppedUp).toHaveLength(0); // không ghi đè steppedUpAt mới
  });

  it("step-up STALE không code → STEP_UP_REQUIRED (fail closed)", async () => {
    sessionState.current = sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    await expect(requireCapabilityWithStepUp("seller.verify")).rejects.toThrowError(/^STEP_UP_REQUIRED$/);
    expect(sessionState.steppedUp).toHaveLength(0);
  });

  it("chưa step-up bao giờ (null) không code → STEP_UP_REQUIRED", async () => {
    sessionState.current = sessionOf(ADMIN.id, "super_admin", null);
    await expect(requireCapabilityWithStepUp("admin.role_manage")).rejects.toThrowError(/^STEP_UP_REQUIRED$/);
  });

  it("stale + TOTP đúng → session đánh dấu stepped-up + audit 'admin.step_up' + pass", async () => {
    sessionState.current = sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    const code = currentTotp();
    const ctx = await requireCapabilityWithStepUp("seller.verify", code);
    expect(ctx.user.id).toBe(ADMIN.id);
    expect(sessionState.steppedUp).toEqual(["sess-1"]);
    const audits = dbState.audits.filter((a) => a.action === "admin.step_up");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ADMIN.id, sessionId: "sess-1" });
    expect(JSON.stringify(audits)).not.toContain(code); // spec §4.8 — không mã thô
  });

  it("stale + MÃ KHÔI PHỤC đúng → cũng step-up được + audit 'admin.mfa_recovery_code_used' (review minor)", async () => {
    // admin thứ hai với enrollment riêng — dùng mã khôi phục của chính mình
    const other = { ...ADMIN, id: "user-admin-2", email: "admin2@loaviet.test" };
    dbState.users.push(other);
    const otherEnrolled = (await enrollAdminMfa(other.id))!;
    expect(otherEnrolled.recoveryCodes).toHaveLength(10);

    sessionState.current = sessionOf(other.id, "super_admin", null);
    const code = otherEnrolled.recoveryCodes[0]!;
    const ctx = await requireCapabilityWithStepUp("security.config", code);
    expect(ctx.user.id).toBe(other.id);
    expect(sessionState.steppedUp).toEqual(["sess-1"]);
    expect(dbState.audits.filter((a) => a.action === "admin.step_up")).toHaveLength(1);
    // mã khôi phục dùng ở STEP-UP cũng được audit như ở login (review minor)
    const recoveryAudits = dbState.audits.filter(
      (a) => a.action === "admin.mfa_recovery_code_used",
    );
    expect(recoveryAudits).toHaveLength(1);
    expect(recoveryAudits[0]).toMatchObject({ actorId: other.id, resourceType: "AdminMfa" });
    expect(JSON.stringify(recoveryAudits)).not.toContain(code); // spec §4.8
  });

  it("stale + mã SAI → MFA_CODE_INVALID + audit 'admin.mfa_failed', không đánh dấu stepped-up", async () => {
    sessionState.current = sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    await expect(requireCapabilityWithStepUp("seller.verify", "000000")).rejects.toThrowError(/^MFA_CODE_INVALID$/);
    expect(sessionState.steppedUp).toHaveLength(0);
    expect(dbState.audits.filter((a) => a.action === "admin.step_up")).toHaveLength(0);
    const failed = dbState.audits.filter((a) => a.action === "admin.mfa_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actorId: ADMIN.id });
    expect(JSON.stringify(failed)).not.toContain("000000"); // spec §4.8
  });

  it("step-up TOTP replay: CÙNG mã lần hai → MFA_CODE_INVALID (RFC 6238 §5.2 — review fix #4)", async () => {
    const stale = () => sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    const code = currentTotp();
    sessionState.current = stale();
    await requireCapabilityWithStepUp("seller.verify", code); // lần 1 — hợp lệ
    // 16 phút sau (stale lại), submit CÙNG mã — replay → MFA_CODE_INVALID
    sessionState.current = stale();
    await expect(requireCapabilityWithStepUp("seller.verify", code)).rejects.toThrowError(
      /^MFA_CODE_INVALID$/,
    );
    // mã của step MỚI → hợp lệ lại — không khóa vĩnh viễn
    sessionState.current = stale();
    await expect(
      requireCapabilityWithStepUp("seller.verify", hotpCode(enrolled!.secretBase32, nowCounter() + 1)),
    ).resolves.toBeTruthy();
  });

  it("step-up rate limit: bucket KIỂM TRA TRƯỚC verify — mã ĐÚNG cũng bị MFA_RATE_LIMITED khi đang limited (review fix #2)", async () => {
    const stale = () => sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    sessionState.current = stale();
    // 10 lần sai làm đầy bucket (session + user + IP cùng chặn)
    for (let i = 0; i < 10; i++) {
      await expect(requireCapabilityWithStepUp("seller.verify", "000000")).rejects.toThrowError(
        /^MFA_CODE_INVALID$/,
      );
    }
    // lần 11 với mã ĐÚNG → bị chặn ở CỔNG (KHÔNG verify) — typed MFA_RATE_LIMITED
    sessionState.current = stale();
    await expect(requireCapabilityWithStepUp("seller.verify", currentTotp())).rejects.toThrowError(
      /^MFA_RATE_LIMITED$/,
    );
    expect(sessionState.steppedUp).toHaveLength(0); // không đánh dấu gì cả
    // qua cửa sổ (reset bucket) → mã đúng step-up được — không lockout vĩnh viễn
    rateState.hits.delete("stepup:mfa:session:sess-1");
    rateState.hits.delete(`stepup:mfa:user:${ADMIN.id}`);
    rateState.hits.delete("stepup:mfa:ip:test-ip");
    sessionState.current = stale();
    await expect(requireCapabilityWithStepUp("seller.verify", currentTotp())).resolves.toBeTruthy();
  });

  it("step-up rate limit per-SESSION — session khác của cùng user không bị kéo theo", async () => {
    const stale = () => sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    sessionState.current = { ...stale(), session: { ...stale().session, id: "sess-A" } };
    for (let i = 0; i < 10; i++) {
      await expect(requireCapabilityWithStepUp("seller.verify", "000000")).rejects.toThrowError(
        /^MFA_CODE_INVALID$/,
      );
    }
    // session B (session khác) — bucket session sạch nhưng bucket USER đã đầy → vẫn chặn
    sessionState.current = { ...stale(), session: { ...stale().session, id: "sess-B" } };
    await expect(requireCapabilityWithStepUp("seller.verify", "000000")).rejects.toThrowError(
      /^MFA_RATE_LIMITED$/,
    );
  });

  it("capability NGOÀI STEP_UP_CAPABILITIES → không bao giờ đòi step-up", async () => {
    // moderator có listing.moderate (không nằm trong STEP_UP_CAPABILITIES)
    sessionState.current = sessionOf("user-mod", "moderator", null);
    const ctx = await requireCapabilityWithStepUp("listing.moderate");
    expect(ctx.user.adminRole).toBe("moderator");
    expect(sessionState.steppedUp).toHaveLength(0);
  });

  it("sai role → FORBIDDEN TRƯỚC khi đụng step-up (requireCapability chạy đầu)", async () => {
    sessionState.current = sessionOf("user-sup", "support", null); // support không có seller.verify
    await expect(requireCapabilityWithStepUp("seller.verify", "bất-kỳ")).rejects.toThrowError(/^FORBIDDEN$/);
    expect(sessionState.steppedUp).toHaveLength(0);
  });

  it("không có session → FORBIDDEN", async () => {
    sessionState.current = null;
    await expect(requireCapabilityWithStepUp("seller.verify", "bất-kỳ")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("đánh dấu stepped-up qua seam markSessionSteppedUp của session.ts (không tự ghi DB)", async () => {
    sessionState.current = sessionOf(ADMIN.id, "super_admin", new Date(Date.now() - 16 * 60_000).toISOString());
    await requireCapabilityWithStepUp("pii.view_sensitive", currentTotp());
    expect(markSessionSteppedUp).toHaveBeenCalledWith("sess-1");
  });
});
