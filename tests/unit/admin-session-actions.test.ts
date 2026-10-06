/**
 * Admin session inventory/revocation + step-up/recovery-code self-service —
 * unit tests (plan Task 9 — spec §5.4.2 admin session requirements, §7.2
 * stale-session reuse, §7.3 IDOR/privilege escalation, §7.6 admin security).
 *
 * Cơ chế mock: `server-only` + `next/cache` + `next/navigation` (redirect throw
 * NEXT_REDIRECT) + `next/headers` (headers/cookies điều khiển được) +
 * `@/src/prisma/db.client` (in-memory User/UserSession/AdminMfa/
 * AdminRecoveryCode/AuditEvent/Notification). session.ts / auth.ts / rbac.ts /
 * admin-mfa.ts / totp.ts / audit-event.ts / rate-limit.ts GIỮ BẢN THẬT —
 * login qua COOKIE THẬT (token → sha256 → row UserSession), guards chạy đúng
 * code sẽ chạy ở production; revocation thật mutate store (reset qua
 * resetRateLimits + resetTotpReplayProtection giữa các case).
 *
 * Hợp đồng (plan Task 9 Step 1 — session-invalidation gate):
 *  1. revokeUserSessionAction: moderator/support (KHÔNG có session.revoke) →
 *     FORBIDDEN, không mutation (Review Focus 4 — gọi action trực tiếp);
 *     operations_admin → revoke + audit "session.revoked".
 *  2. revokeAllUserSessionsAction: revoke MỌI session của user đích + audit
 *     "session.revoked_all"; exceptSessionId (form "đăng xuất thiết bị khác"
 *     trên /admin/security) giữ session hiện tại.
 *  3. Thu hồi session của ADMIN KHÁC cần session.revoke — super_admin vẫn làm
 *     được (spec §5.4.2 explicit revocation support).
 *  4. stepUpAction: TOTP đúng → session stepped-up + audit "admin.step_up";
 *     sai → error + audit "admin.mfa_failed" (KHÔNG chứa mã thô); non-admin →
 *     redirect. Rate limit CHUNG bucket rbac (stepup:mfa:*) — brute-force qua
 *     form này không còn oracle (review fix #2 Task 8 áp dụng cùng surface).
 *  5. revokeMyOtherSessionsAction (user self-service, verification.ts):
 *     requireUser + revoke mọi session KHÁC reason "user_self_revocation" +
 *     audit "session.revoked_all"; session hiện tại sống; IDOR — formData
 *     nhồi sessionId/userId của người khác bị BỎ QUA hoàn toàn.
 *  6. regenerateRecoveryCodesAction: mã MFA đúng → 10 mã MỚI trả MỘT LẦN, mã
 *     cũ chết ngay, audit "admin.mfa_recovery_codes_regenerated"; sai →
 *     error, không mutation; non-admin → redirect.
 *  7. Source contract /admin/security (như finance-public-surface.test.ts):
 *     page tự requireAdminUser, render inventory qua listUserSessions, revoke
 *     forms chỉ hiện khi role có session.revoke (capabilitiesOf — convenience,
 *     spec §4.5), session id + UA hiển thị RÚT GỌN (spec §4.8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// redirect() throw NEXT_REDIRECT — như rbac.test.ts / verification-actions.test.ts
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// ─── headers + cookies điều khiển được — session.ts/rbac chạy THẬT ───────────

const headerState = vi.hoisted(() => ({ headers: new Headers() }));
const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerState.headers),
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieState.store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

// ─── db.client mock: in-memory 6 model (UserSession có include("user")) ───────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  mfas: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
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

  const makeModel = (rows: Row[], defaults?: () => Row, attach?: (row: Row) => void) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      orderBy: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (!hit) return null;
        const copy = { ...hit };
        if (includeRel === "user" && attach) attach(copy);
        return copy;
      },
      all: async () =>
        rows
          .filter((r) => preds.every((p) => matches(r, p)))
          .map((r) => {
            const copy = { ...r };
            if (includeRel === "user" && attach) attach(copy);
            return copy;
          }),
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
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
      include: (rel: string) => query([], rel),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const sessionDefaults = () => ({
    id: `sess-${dbState.sessions.length + 1}`,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: null,
    isAdmin: false,
    userAgent: null,
  });

  const models = {
    User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    UserSession: makeModel(dbState.sessions, sessionDefaults, (row) => {
      row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
    }),
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
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
    })),
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      // tx passthrough — cùng store; rollback thật do integration test lo
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── Imports (SAU mock — module thật chạy trên mock db/next) ──────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { resetTotpReplayProtection, verifyAdminMfaCode, enrollAdminMfa } from "@/src/lib/admin-mfa";
import { hotpCode } from "@/src/lib/totp";
import { getSessionFromCookie, SESSION_COOKIE } from "@/src/lib/session";
import {
  revokeUserSessionAction,
  revokeAllUserSessionsAction,
  stepUpAction,
  regenerateRecoveryCodesAction,
} from "@/src/lib/actions/admin-identity";
import { revokeMyOtherSessionsAction } from "@/src/lib/actions/verification";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const KEY_32B = Buffer.alloc(32, 0x33).toString("base64");

const mkUser = (over: Partial<Row>): Row & { id: string } => ({
  id: "user-x",
  email: "x@loaviet.test",
  passwordHash: "bcrypt-x",
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

const ADMIN_SUPER = mkUser({ id: "admin-super", email: "super@loaviet.test", name: "Super", role: "admin", adminRole: "super_admin" });
const ADMIN_OPS = mkUser({ id: "admin-ops", email: "ops@loaviet.test", name: "Ops", role: "admin", adminRole: "operations_admin" });
const ADMIN_MOD = mkUser({ id: "admin-mod", email: "mod@loaviet.test", name: "Mod", role: "admin", adminRole: "moderator" });
const ADMIN_SUPPORT = mkUser({ id: "admin-support", email: "support@loaviet.test", name: "Support", role: "admin", adminRole: "support" });
const BUYER = mkUser({ id: "user-buyer", email: "buyer@loaviet.test", name: "Buyer" });

/**
 * Login THẬT qua cookie: tạo row UserSession + set cookie token — session.ts
 * getSessionFromCookie đọc cookie store, hash, tra row. isAdmin=true mô phỏng
 * session đã qua MFA login path (điều kiện requireCapability — review fix #1).
 */
const login = (user: Row, opts?: { sessionId?: string; isAdmin?: boolean }): string => {
  const id = opts?.sessionId ?? `sess-${user.id}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: sha256Hex(token),
    isAdmin: opts?.isAdmin ?? false,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: null,
    userAgent: "unit-test-agent/1.0",
  });
  cookieState.store.set(SESSION_COOKIE, token);
  return id;
};

/** Session "thiết bị khác" của user — KHÔNG giữ cookie (chỉ row để bị revoke). */
const seedSession = (id: string, userId: string, over?: Partial<Row>): Row => {
  const row: Row = {
    id,
    userId,
    tokenHash: sha256Hex(`token-${id}`),
    isAdmin: false,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: null,
    userAgent: "other-device-agent/2.0",
    ...over,
  };
  dbState.sessions.push(row);
  return row;
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Enrollment gần nhất (secret + mã khôi phục thô — chỉ tồn tại trong test). */
let enrolled: { secretBase32: string; uri: string; recoveryCodes: string[] } | null = null;
const nowCounter = () => Math.floor(Date.now() / 30_000);
const currentTotp = (): string => hotpCode(enrolled!.secretBase32, nowCounter());

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.mfas.length = 0;
  dbState.codes.length = 0;
  dbState.audits.length = 0;
  dbState.notifications.length = 0;
  dbState.users.push({ ...ADMIN_SUPER }, { ...ADMIN_OPS }, { ...ADMIN_MOD }, { ...ADMIN_SUPPORT }, { ...BUYER });
  cookieState.store.clear();
  headerState.headers = new Headers();
  enrolled = null;
  resetRateLimits();
  resetTotpReplayProtection(); // store replay in-process — reset giữa các case
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. revokeUserSessionAction — capability session.revoke (Review Focus 4) ──

describe("revokeUserSessionAction — requireCapability(session.revoke)", () => {
  it("moderator (KHÔNG có session.revoke) → FORBIDDEN, không mutation, không audit", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const victim = seedSession("sess-victim", BUYER.id);

    await expect(revokeUserSessionAction(fd({ sessionId: "sess-victim" }))).rejects.toThrow("FORBIDDEN");

    expect(victim.revokedAt).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("support (chỉ admin.access) → FORBIDDEN, không mutation", async () => {
    login(ADMIN_SUPPORT, { isAdmin: true });
    const victim = seedSession("sess-victim", BUYER.id);

    await expect(revokeUserSessionAction(fd({ sessionId: "sess-victim" }))).rejects.toThrow("FORBIDDEN");

    expect(victim.revokedAt).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("operations_admin → revoke + audit 'session.revoked' (reason typed, subject = chủ session)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const victim = seedSession("sess-victim", BUYER.id);

    await revokeUserSessionAction(fd({ sessionId: "sess-victim" }));

    expect(victim.revokedAt).not.toBeNull();
    expect(victim.revokedReason).toBe("admin_revoked");
    const evt = dbState.audits.find((r) => r.action === "session.revoked");
    expect(evt).toMatchObject({
      actorId: "admin-ops",
      subjectId: "user-buyer",
      resourceType: "UserSession",
      resourceId: "sess-victim",
      reason: "admin_revoked",
    });
  });

  it("session id không tồn tại → no-op im lặng (không oracle, không audit)", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    await revokeUserSessionAction(fd({ sessionId: "khong-ton-tai" }));

    expect(dbState.audits).toHaveLength(0);
    expect(dbState.sessions.every((s) => s.revokedAt === null)).toBe(true);
  });

  it("admin thu hồi phiên HIỆN TẠI của chính mình → revoke sạch, lookup sau fail (logout sạch)", async () => {
    const currentId = login(ADMIN_OPS, { isAdmin: true });

    await revokeUserSessionAction(fd({ sessionId: currentId }));

    const row = dbState.sessions.find((s) => s.id === currentId)!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("admin_revoked");
    // session bị revoke → request sau logged out (Review Focus 3 — fail closed)
    expect(await getSessionFromCookie()).toBeNull();
  });
});

// ─── 2. revokeAllUserSessionsAction ──────────────────────────────────────────

describe("revokeAllUserSessionsAction — requireCapability(session.revoke)", () => {
  it("revokes MỌI session của user đích + audit 'session.revoked_all' (không đụng user khác)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const v1 = seedSession("v-s1", BUYER.id);
    const v2 = seedSession("v-s2", BUYER.id);
    const v3 = seedSession("v-s3", BUYER.id);
    const stranger = seedSession("keep-super", ADMIN_SUPER.id);

    await revokeAllUserSessionsAction(fd({ userId: BUYER.id }));

    for (const row of [v1, v2, v3]) {
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedReason).toBe("admin_revoked_all");
    }
    expect(stranger.revokedAt).toBeNull(); // session admin khác KHÔNG bị đụng
    const evt = dbState.audits.find((r) => r.action === "session.revoked_all");
    expect(evt).toMatchObject({
      actorId: "admin-ops",
      subjectId: "user-buyer",
      resourceType: "User",
      resourceId: BUYER.id,
      reason: "admin_revoked_all",
    });
  });

  it("moderator → FORBIDDEN, không mutation, không audit", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const victim = seedSession("v-s1", BUYER.id);

    await expect(revokeAllUserSessionsAction(fd({ userId: BUYER.id }))).rejects.toThrow("FORBIDDEN");

    expect(victim.revokedAt).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("exceptSessionId (form 'đăng xuất thiết bị khác' trên /admin/security) — giữ session except", async () => {
    const currentId = login(ADMIN_SUPER, { isAdmin: true });
    const other1 = seedSession("self-2", ADMIN_SUPER.id);
    const other2 = seedSession("self-3", ADMIN_SUPER.id);

    await revokeAllUserSessionsAction(fd({
      userId: ADMIN_SUPER.id,
      exceptSessionId: currentId,
    }));

    expect(other1.revokedAt).not.toBeNull();
    expect(other2.revokedAt).not.toBeNull();
    expect(other1.revokedReason).toBe("admin_revoked_all");
    const current = dbState.sessions.find((s) => s.id === currentId)!;
    expect(current.revokedAt).toBeNull(); // session hiện tại sống — không đá chính mình ra
    // audit vẫn ghi (subject = chính mình)
    expect(dbState.audits.find((r) => r.action === "session.revoked_all")).toMatchObject({
      actorId: "admin-super",
      subjectId: "admin-super",
    });
  });
});

// ─── 3. Admin thu hồi session của ADMIN KHÁC (spec §5.4.2) ────────────────────

describe("admin session revocation — admin đích cũng bị thu hồi qua session.revoke", () => {
  it("super_admin thu hồi session của admin KHÁC — qua session.revoke, audit đủ chủ", async () => {
    login(ADMIN_SUPER, { isAdmin: true });
    const otherAdminSession = seedSession("ops-device", ADMIN_OPS.id, { isAdmin: true });

    await revokeUserSessionAction(fd({ sessionId: "ops-device" }));

    expect(otherAdminSession.revokedAt).not.toBeNull();
    expect(otherAdminSession.revokedReason).toBe("admin_revoked");
    const evt = dbState.audits.find((r) => r.action === "session.revoked");
    expect(evt).toMatchObject({ actorId: "admin-super", subjectId: "admin-ops" });
  });
});

// ─── 4. stepUpAction ──────────────────────────────────────────────────────────

describe("stepUpAction — step-up từ /admin/security", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
    expect(enrolled).not.toBeNull();
  });

  it("TOTP đúng → session stepped-up + audit 'admin.step_up' (reason = factor)", async () => {
    const currentId = login(ADMIN_OPS, { isAdmin: true });

    const state = await stepUpAction({}, fd({ mfaCode: currentTotp() }));

    expect(state.error).toBeUndefined();
    expect(state.success).toBeTruthy();
    const row = dbState.sessions.find((s) => s.id === currentId)!;
    expect(row.steppedUpAt).not.toBeNull();
    const evt = dbState.audits.find((r) => r.action === "admin.step_up");
    expect(evt).toMatchObject({
      actorId: "admin-ops",
      resourceType: "UserSession",
      resourceId: currentId,
      reason: "totp",
    });
  });

  it("mã sai → error, KHÔNG stepped-up, audit 'admin.mfa_failed' KHÔNG chứa mã thô (spec §4.8)", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    const state = await stepUpAction({}, fd({ mfaCode: "000000" }));

    expect(state.error).toBeTruthy();
    expect(dbState.sessions.find((s) => s.userId === ADMIN_OPS.id)!.steppedUpAt).toBeNull();
    const failed = dbState.audits.find((r) => r.action === "admin.mfa_failed");
    expect(failed).toMatchObject({ actorId: "admin-ops", reason: "step_up_invalid_code" });
    expect(JSON.stringify(failed)).not.toContain("000000");
  });

  it("không nhập mã → stepUpRequired, KHÔNG verify (fail closed)", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    const state = await stepUpAction({}, new FormData());

    expect(state.stepUpRequired).toBe(true);
    expect(state.error).toBeTruthy();
    expect(dbState.sessions.find((s) => s.userId === ADMIN_OPS.id)!.steppedUpAt).toBeNull();
    expect(dbState.audits.filter((r) => r.action === "admin.step_up")).toHaveLength(0);
  });

  it("non-admin (session consumer) → NEXT_REDIRECT (requireAdminUser), không verify", async () => {
    login(BUYER); // isAdmin: false — requireAdminUser redirect

    await expect(stepUpAction({}, fd({ mfaCode: "123456" }))).rejects.toThrow("NEXT_REDIRECT");

    expect(dbState.audits).toHaveLength(0);
  });

  it("rate limit CHUNG bucket rbac step-up: 10 lần sai → lần 11 (mã ĐÚNG) cũng bị chặn — không oracle brute-force", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    for (let i = 0; i < 10; i++) {
      const state = await stepUpAction({}, fd({ mfaCode: "000000" }));
      expect(state.error).toBeTruthy();
    }

    // lần 11 — mã ĐÚNG nhưng bucket stepup:mfa:* đã đầy (kiểm tra TRƯỚC verify)
    const blocked = await stepUpAction({}, fd({ mfaCode: currentTotp() }));
    expect(blocked.error).toMatch(/Quá nhiều lần thử/);
    expect(dbState.sessions.find((s) => s.userId === ADMIN_OPS.id)!.steppedUpAt).toBeNull();
    expect(dbState.audits.filter((r) => r.action === "admin.step_up")).toHaveLength(0);
  });
});

// ─── 5. revokeMyOtherSessionsAction — user self-service (IDOR) ────────────────

describe("revokeMyOtherSessionsAction — tự thu hồi (verification.ts, spec §7.3 IDOR)", () => {
  it("requireUser + revoke mọi session KHÁC reason 'user_self_revocation' + audit; session hiện tại sống", async () => {
    const currentId = login(BUYER);
    const s2 = seedSession("buyer-2", BUYER.id);
    const s3 = seedSession("buyer-3", BUYER.id);

    const state = await revokeMyOtherSessionsAction({}, new FormData());

    expect(state.error).toBeUndefined();
    expect(state.success).toBeTruthy();
    expect(s2.revokedAt).not.toBeNull();
    expect(s3.revokedAt).not.toBeNull();
    expect(s2.revokedReason).toBe("user_self_revocation");
    expect(s3.revokedReason).toBe("user_self_revocation");
    const current = dbState.sessions.find((s) => s.id === currentId)!;
    expect(current.revokedAt).toBeNull(); // session hiện tại sống
    const evt = dbState.audits.find((r) => r.action === "session.revoked_all");
    expect(evt).toMatchObject({
      actorId: "user-buyer",
      subjectId: "user-buyer",
      reason: "user_self_revocation",
    });
  });

  it("IDOR: formData nhồi sessionId/userId của NGƯỜI KHÁC → bị bỏ qua hoàn toàn (derive từ session)", async () => {
    login(BUYER);
    const stranger = seedSession("stranger-sess", ADMIN_SUPER.id);

    const state = await revokeMyOtherSessionsAction(
      {},
      fd({ sessionId: "stranger-sess", userId: ADMIN_SUPER.id }),
    );

    expect(state.error).toBeUndefined();
    expect(stranger.revokedAt).toBeNull(); // session của admin khác KHÔNG bị đụng
    // audit vẫn chỉ nói về chính mình
    const evt = dbState.audits.find((r) => r.action === "session.revoked_all");
    expect(evt).toMatchObject({ actorId: "user-buyer", subjectId: "user-buyer" });
  });

  it("chưa đăng nhập → NEXT_REDIRECT (requireUser), không mutation, không audit", async () => {
    cookieState.store.clear();

    await expect(revokeMyOtherSessionsAction({}, new FormData())).rejects.toThrow("NEXT_REDIRECT");

    expect(dbState.sessions.every((s) => s.revokedAt === null)).toBe(true);
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 6. regenerateRecoveryCodesAction — tự phục vụ MFA của chính mình ─────────

describe("regenerateRecoveryCodesAction — sinh lại mã khôi phục (tự phục vụ)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
    expect(enrolled).not.toBeNull();
  });

  it("mã MFA đúng → 10 mã MỚI trả MỘT LẦN, mã cũ chết ngay, audit (KHÔNG chứa mã thô)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const oldCodes = enrolled!.recoveryCodes;

    const state = await regenerateRecoveryCodesAction({}, fd({ mfaCode: currentTotp() }));

    expect(state.error).toBeUndefined();
    const newCodes = state.recoveryCodes!;
    expect(newCodes).toHaveLength(10);
    expect(new Set(newCodes).size).toBe(10); // 10 mã distinct
    // mã cũ chết NGAY (row đã xoá) — dùng lại → null
    expect(await verifyAdminMfaCode(ADMIN_OPS.id, oldCodes[0]!)).toBeNull();
    // mã mới sống (dùng như recovery code → "recovery_code")
    expect(await verifyAdminMfaCode(ADMIN_OPS.id, newCodes[0]!)).toBe("recovery_code");
    const evt = dbState.audits.find((r) => r.action === "admin.mfa_recovery_codes_regenerated");
    expect(evt).toMatchObject({ actorId: "admin-ops", subjectId: "admin-ops" });
    expect(JSON.stringify(evt)).not.toContain(newCodes[0]!); // spec §4.8 — không mã thô
  });

  it("mã sai → error, KHÔNG mutation (mã cũ vẫn dùng được), không audit regenerate", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const oldCodes = enrolled!.recoveryCodes;

    const state = await regenerateRecoveryCodesAction({}, fd({ mfaCode: "000000" }));

    expect(state.error).toBeTruthy();
    expect(state.recoveryCodes).toBeUndefined();
    expect(await verifyAdminMfaCode(ADMIN_OPS.id, oldCodes[0]!)).toBe("recovery_code"); // mã cũ sống
    expect(dbState.audits.filter((r) => r.action === "admin.mfa_recovery_codes_regenerated")).toHaveLength(0);
  });

  it("non-admin → NEXT_REDIRECT (requireAdminUser), không mutation", async () => {
    login(BUYER);
    const codesBefore = dbState.codes.length;

    await expect(regenerateRecoveryCodesAction({}, fd({ mfaCode: "123456" }))).rejects.toThrow("NEXT_REDIRECT");

    expect(dbState.codes).toHaveLength(codesBefore); // KHÔNG sinh mã mới cho ai cả
    expect(dbState.audits).toHaveLength(0);
  });

  it("chưa enroll MFA → error rõ ràng, KHÔNG sinh mã (fail closed)", async () => {
    login(ADMIN_MOD, { isAdmin: true }); // mod chưa enroll trong case này
    const codesBefore = dbState.codes.length;

    const state = await regenerateRecoveryCodesAction({}, fd({ mfaCode: "123456" }));

    expect(state.error).toBeTruthy();
    expect(state.recoveryCodes).toBeUndefined();
    expect(dbState.codes).toHaveLength(codesBefore); // mã của admin khác giữ nguyên
    expect(dbState.audits.filter((r) => r.action === "admin.mfa_recovery_codes_regenerated")).toHaveLength(0);
  });
});

// ─── 7. Source contract — /admin/security + layout (như finance-public-surface) ─

describe("source contract — app/admin/security/page.tsx (spec §4.5/§4.8)", () => {
  const src = () => read("app/admin/security/page.tsx");

  it("tự guard server-side requireAdminUser + render inventory phiên CỦA CHÍNH MÌNH qua listUserSessions", () => {
    expect(src()).toContain("requireAdminUser(");
    expect(src()).toContain("listUserSessions(");
  });

  it("revoke forms chỉ render khi role có session.revoke (capabilitiesOf — convenience, spec §4.5)", () => {
    expect(src()).toContain("capabilitiesOf(");
    expect(src()).toContain('includes("session.revoke")');
    expect(src()).toContain("revokeUserSessionAction");
    expect(src()).toContain("revokeAllUserSessionsAction");
  });

  it("session id + user-agent hiển thị RÚT GỌN — không render nguyên chuỗi (spec §4.8)", () => {
    expect(src()).toContain("slice(0, 8)"); // shortSessionId
    expect(src()).toContain("slice(0, 48)"); // truncateUserAgent
  });
});

describe("source contract — app/admin/layout.tsx (nav lọc theo capability, convenience only)", () => {
  const src = () => read("app/admin/layout.tsx");

  it("nav lọc qua capabilitiesOf theo capability của từng link; /admin/security cho MỌI admin", () => {
    expect(src()).toContain("capabilitiesOf(");
    expect(src()).toContain('"/admin/security"');
    // các link có capability được lọc (không render cho role thiếu quyền)
    expect(src()).toContain('capability: "analytics.read"');
    expect(src()).toContain('capability: "user.view_basic"');
  });

  it("layout vẫn là cổng requireAdminUser — KHÔNG thay guard trang (spec §4.5)", () => {
    expect(src()).toContain("requireAdminUser(");
  });
});
