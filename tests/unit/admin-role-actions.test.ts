/**
 * Admin role management — unit tests (plan Task 11 — spec §5.4 "Manage admin
 * roles: Step-up", §5.4.1 matrix, §5.4.2 step-up + tránh khóa admin vĩnh viễn,
 * §4.5 backend authorization, §4.6 auditability, §7.6 revocation support,
 * §8.5 adminRole là nguồn quyền duy nhất).
 *
 * Cơ chế mock giống tests/unit/admin-session-actions.test.ts: `server-only` +
 * next/cache + next/navigation (redirect throw NEXT_REDIRECT) + next/headers
 * (cookie store điều khiển được) + db.client in-memory (User/UserSession/
 * AdminMfa/AdminRecoveryCode/AuditEvent/SellerVerification/Listing). session.ts /
 * rbac.ts / admin-mfa.ts / totp.ts / audit-event.ts / rate-limit.ts GIỮ BẢN
 * THẬT — login qua COOKIE THẬT, guards chạy đúng code sẽ chạy ở production.
 *
 * Hợp đồng (plan Task 11 Step 1 + review fix D2/D6/minors):
 *  1. operations_admin → FORBIDDEN (chỉ super_admin có admin.role_manage —
 *     ma trận §5.4.1); support → FORBIDDEN (Review Focus 4 — gọi action trực
 *     tiếp, không qua UI); session CONSUMER của super_admin → FORBIDDEN (admin
 *     authority cần session MFA — review fix #1 Task 8).
 *  2. Step-up gate: thiếu step-up + không totpCode → state STEP_UP_REQUIRED
 *     (KHÔNG throw — operator sửa được: nhập mã rồi gửi lại), KHÔNG mutation;
 *     totpCode ĐÚNG trong cùng request → passes + session marked stepped-up;
 *     totpCode SAI → state MFA_CODE_INVALID + audit admin.mfa_failed (KHÔNG
 *     mã thô).
 *  3. Grant/change: role set + MỌI session của đích thu hồi cùng tx (reason
 *     admin_role_changed — Task 8 review) + audit admin.role_set (from→to,
 *     reason typed, KHÔNG PII). KHÔNG đè role display "seller" (D6 — seller
 *     visibility); buyer → "admin".
 *  4. Idempotent (minor): đặt CÙNG role đang giữ → no-op — KHÔNG thu hồi
 *     session, KHÔNG audit.
 *  5. Last-super-admin guard (D2 — helper chia sẻ assertNotLastSuperAdminTx,
 *     row-lock no-op update): demote/gỡ super_admin DUY NHẤT → state
 *     LAST_SUPER_ADMIN, KHÔNG mutation; còn super_admin khác → cho qua.
 *  6. Gỡ quyền quản trị (D6 — role="none" → adminRole null): cùng guard +
 *     step-up + thu hồi session + audit (to=none); User.role restore từ
 *     "admin" theo marker (SellerVerification row HOẶC listing → "seller",
 *     else "buyer"); role "seller"/"buyer" hiện tại KHÔNG bị đụng.
 *  7. Compare-and-set trên adminRole TRƯỚC: read stale → ADMIN_ROLE_CONFLICT
 *     (throw — race hiếm, caller tải lại), KHÔNG revoke, KHÔNG audit (tx
 *     rollback).
 *  8. Input typed: role/reason ngoài enum → typed error trước khi đụng db;
 *     userId rỗng → INVALID_USER; target không tồn tại → USER_NOT_FOUND.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// redirect() throw NEXT_REDIRECT — như admin-session-actions.test.ts
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

// ─── db.client mock: in-memory 7 model (tx có ROLLBACK THẬT) ─────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  mfas: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  sellerVerifications: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  /**
   * Seam CAS-conflict: ép `User.first` trả bản copy với adminRole GIẢ (mô phỏng
   * request khác đổi role SAU khi action đọc — read stale). CAS theo giá trị
   * đã đọc → 0 row → ADMIN_ROLE_CONFLICT (không bao giờ ghi đè quyết định
   * song song).
   */
  staleFirstReadAdminRole: null as string | null,
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
    attach?: (row: Row) => void,
  ) => {
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

  const models = {
    // User.first áp seam stale-read (chỉ ảnh hưởng bản copy trả về — store thật
    // không đổi, đúng như request song song đã commit giá trị khác).
    User: (() => {
      const base = makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` }));
      return {
        ...base,
        first: async (filter?: unknown) => {
          const row = await base.first(filter as never);
          if (row && dbState.staleFirstReadAdminRole !== null) {
            return { ...row, adminRole: dbState.staleFirstReadAdminRole };
          }
          return row;
        },
      };
    })(),
    UserSession: makeModel(dbState.sessions, () => ({
      id: `sess-${dbState.sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
      revokedReason: null,
      steppedUpAt: null,
      isAdmin: false,
      userAgent: null,
    }), (row) => {
      // include("user") — session.ts getSessionFromCookie tra User cùng query
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
    // D6: resolveNonAdminRoleTx đọc marker seller (SellerVerification row / Listing)
    SellerVerification: makeModel(dbState.sellerVerifications, () => ({
      id: `sv-${dbState.sellerVerifications.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      // Tx có ROLLBACK THẬT: snapshot store trước fn, restore khi fn throw —
      // CAS conflict / guard fail trong tx phải kéo rollback theo (không bao
      // giờ "đã thu hồi session mà role không đổi" hay ngược lại).
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snap = {
          users: dbState.users.map((r) => ({ ...r })),
          sessions: dbState.sessions.map((r) => ({ ...r })),
          mfas: dbState.mfas.map((r) => ({ ...r })),
          codes: dbState.codes.map((r) => ({ ...r })),
          audits: dbState.audits.map((r) => ({ ...r })),
          sellerVerifications: dbState.sellerVerifications.map((r) => ({ ...r })),
          listings: dbState.listings.map((r) => ({ ...r })),
        };
        try {
          return await fn({ orm: { public: { ...models } } });
        } catch (e) {
          const restore = (
            rows: Array<Record<string, unknown>>,
            saved: Array<Record<string, unknown>>,
          ) => {
            rows.length = 0;
            rows.push(...saved);
          };
          restore(dbState.users, snap.users);
          restore(dbState.sessions, snap.sessions);
          restore(dbState.mfas, snap.mfas);
          restore(dbState.codes, snap.codes);
          restore(dbState.audits, snap.audits);
          restore(dbState.sellerVerifications, snap.sellerVerifications);
          restore(dbState.listings, snap.listings);
          throw e;
        }
      },
    },
  };
});

// ─── Imports (SAU mock — module thật chạy trên mock db/next) ──────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { resetTotpReplayProtection, enrollAdminMfa } from "@/src/lib/admin-mfa";
import { hotpCode } from "@/src/lib/totp";
import { SESSION_COOKIE } from "@/src/lib/session";
import { setAdminRoleAction } from "@/src/lib/actions/admin-identity";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const KEY_32B = Buffer.alloc(32, 0x44).toString("base64");

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
const ADMIN_SUPER_2 = mkUser({ id: "admin-super-2", email: "super2@loaviet.test", name: "Super Two", role: "admin", adminRole: "super_admin" });
const ADMIN_OPS = mkUser({ id: "admin-ops", email: "ops@loaviet.test", name: "Ops", role: "admin", adminRole: "operations_admin" });
const ADMIN_SUPPORT = mkUser({ id: "admin-support", email: "support@loaviet.test", name: "Support", role: "admin", adminRole: "support" });
const BUYER = mkUser({ id: "user-buyer", email: "buyer@loaviet.test", name: "Buyer" });
const SELLER = mkUser({ id: "user-seller", email: "seller@loaviet.test", name: "Seller", role: "seller" });

/**
 * Login THẬT qua cookie: tạo row UserSession + set cookie token — session.ts
 * getSessionFromCookie đọc cookie store, hash, tra row. isAdmin=true mô phỏng
 * session đã qua MFA login path (điều kiện requireCapability — review fix #1).
 * steppedUpAt tươi mặc định (step-up vừa xong) — case cần stale tự truyền.
 */
const login = (user: Row, opts?: { isAdmin?: boolean; steppedUpAt?: string | null }): string => {
  const id = `sess-${user.id}`;
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
    steppedUpAt: opts?.steppedUpAt !== undefined ? opts.steppedUpAt : new Date().toISOString(),
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

/** Enrollment gần nhất của ACTOR (secret + mã thô — chỉ tồn tại trong test). */
let enrolled: { secretBase32: string; uri: string; recoveryCodes: string[] } | null = null;
const nowCounter = () => Math.floor(Date.now() / 30_000);
const currentTotp = (): string => hotpCode(enrolled!.secretBase32, nowCounter());

const userRow = (id: string): Row => dbState.users.find((u) => u["id"] === id)!;
const sessionRow = (id: string): Row => dbState.sessions.find((s) => s["id"] === id)!;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.mfas.length = 0;
  dbState.codes.length = 0;
  dbState.audits.length = 0;
  dbState.sellerVerifications.length = 0;
  dbState.listings.length = 0;
  dbState.staleFirstReadAdminRole = null;
  dbState.users.push({ ...ADMIN_SUPER }, { ...ADMIN_OPS }, { ...ADMIN_SUPPORT }, { ...BUYER });
  cookieState.store.clear();
  headerState.headers = new Headers();
  enrolled = null;
  resetRateLimits();
  resetTotpReplayProtection(); // store replay in-process — reset giữa các case
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Capability — chỉ super_admin có admin.role_manage (ma trận §5.4.1) ────

describe("setAdminRoleAction — requireCapabilityWithStepUp(admin.role_manage)", () => {
  it("operations_admin → FORBIDDEN (không có admin.role_manage), không mutation, không audit", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const target = seedSession("t-sess", BUYER.id);

    await expect(
      setAdminRoleAction({}, fd({ userId: BUYER.id, role: "moderator", reason: "onboarding" })),
    ).rejects.toThrow("FORBIDDEN");

    expect(userRow(BUYER.id)["adminRole"]).toBeNull(); // KHÔNG mutation
    expect(target["revokedAt"]).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("support → FORBIDDEN (Review Focus 4 — gọi trực tiếp action, không qua UI)", async () => {
    login(ADMIN_SUPPORT, { isAdmin: true });
    const target = seedSession("t-sess", BUYER.id);

    await expect(
      setAdminRoleAction({}, fd({ userId: BUYER.id, role: "analyst", reason: "onboarding" })),
    ).rejects.toThrow("FORBIDDEN");

    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
    expect(target["revokedAt"]).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("super_admin giữ session CONSUMER (isAdmin=false) → FORBIDDEN — admin authority cần session MFA (review fix #1)", async () => {
    // User được promote khi đang giữ session 30 ngày: session cũ KHÔNG phải
    // session MFA → mọi guard admin từ chối cho tới khi login lại qua MFA.
    login(ADMIN_SUPER, { isAdmin: false, steppedUpAt: null });

    await expect(
      setAdminRoleAction({}, fd({ userId: BUYER.id, role: "moderator", reason: "onboarding" })),
    ).rejects.toThrow("FORBIDDEN");

    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("chưa đăng nhập → FORBIDDEN (không cookie), không đụng db", async () => {
    cookieState.store.clear();

    await expect(
      setAdminRoleAction({}, fd({ userId: BUYER.id, role: "moderator", reason: "onboarding" })),
    ).rejects.toThrow("FORBIDDEN");

    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 2. Step-up gate (spec §5.4.2 — admin role modification) ──────────────────

describe("setAdminRoleAction — step-up", () => {
  it("super_admin CHƯA step-up + không totpCode → state STEP_UP_REQUIRED (không throw — operator nhập mã rồi gửi lại), không mutation", async () => {
    login(ADMIN_SUPER, { isAdmin: true, steppedUpAt: null });
    const target = seedSession("t-sess", BUYER.id);

    const state = await setAdminRoleAction(
      {},
      fd({ userId: BUYER.id, role: "moderator", reason: "onboarding" }),
    );

    expect(state.code).toBe("STEP_UP_REQUIRED");
    expect(state.stepUpRequired).toBe(true);
    expect(state.error).toBeTruthy();
    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
    expect(target["revokedAt"]).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("step-up CŨ (hơn 15 phút) + không totpCode → state STEP_UP_REQUIRED", async () => {
    login(ADMIN_SUPER, { isAdmin: true, steppedUpAt: new Date(Date.now() - 16 * 60_000).toISOString() });

    const state = await setAdminRoleAction(
      {},
      fd({ userId: BUYER.id, role: "moderator", reason: "onboarding" }),
    );

    expect(state.code).toBe("STEP_UP_REQUIRED");
    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
  });

  it("step-up cũ + totpCode ĐÚNG trong cùng request → passes + session marked stepped-up", async () => {
    const currentId = login(ADMIN_SUPER, { isAdmin: true, steppedUpAt: null });
    enrolled = await enrollAdminMfa(ADMIN_SUPER.id);
    expect(enrolled).not.toBeNull();

    const state = await setAdminRoleAction(
      {},
      fd({
        userId: BUYER.id,
        role: "moderator",
        reason: "onboarding",
        totpCode: currentTotp(),
      }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(BUYER.id)["adminRole"]).toBe("moderator");
    expect(sessionRow(currentId)["steppedUpAt"]).not.toBeNull(); // guard đã đánh dấu
  });

  it("totpCode SAI → state MFA_CODE_INVALID, không mutation + audit admin.mfa_failed (KHÔNG chứa mã thô)", async () => {
    login(ADMIN_SUPER, { isAdmin: true, steppedUpAt: null });
    enrolled = await enrollAdminMfa(ADMIN_SUPER.id);

    const state = await setAdminRoleAction(
      {},
      fd({
        userId: BUYER.id,
        role: "moderator",
        reason: "onboarding",
        totpCode: "000000",
      }),
    );

    expect(state.code).toBe("MFA_CODE_INVALID");
    expect(state.error).toBeTruthy();
    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
    const failed = dbState.audits.find((r) => r["action"] === "admin.mfa_failed");
    expect(failed).toMatchObject({ actorId: ADMIN_SUPER.id, reason: "step_up_invalid_code" });
    expect(JSON.stringify(failed)).not.toContain("000000"); // spec §4.8 — không mã thô
    expect(dbState.audits.filter((r) => r["action"] === "admin.role_set")).toHaveLength(0);
  });
});

// ─── 3. Happy path — role set + revoke mọi session đích + audit (cùng tx) ────

describe("setAdminRoleAction — grant/change role", () => {
  it("super_admin + step-up tươi → role set + User.role='admin' (buyer) + MỌI session đích thu hồi (reason admin_role_changed) + audit admin.role_set", async () => {
    login(ADMIN_SUPER, { isAdmin: true });
    const t1 = seedSession("t-sess-1", BUYER.id);
    const t2 = seedSession("t-sess-2", BUYER.id);
    const stranger = seedSession("stranger-sess", ADMIN_OPS.id);

    const state = await setAdminRoleAction(
      {},
      fd({ userId: BUYER.id, role: "moderator", reason: "onboarding" }),
    );

    expect(state.success).toBeTruthy();
    // role set (adminRole = nguồn quyền; role display 'admin' cho buyer — D6)
    const target = userRow(BUYER.id);
    expect(target["adminRole"]).toBe("moderator");
    expect(target["role"]).toBe("admin");
    // MỌI session của đích bị thu hồi — buộc login lại qua MFA (Task 8 review)
    for (const row of [t1, t2]) {
      expect(row["revokedAt"]).not.toBeNull();
      expect(row["revokedReason"]).toBe("admin_role_changed");
    }
    expect(stranger["revokedAt"]).toBeNull(); // session user KHÁC không bị đụng

    // audit — from→to (role không phải PII — spec §4.8), reason typed
    const evt = dbState.audits.find((r) => r["action"] === "admin.role_set");
    expect(evt).toMatchObject({
      actorId: ADMIN_SUPER.id,
      subjectId: BUYER.id,
      resourceType: "User",
      resourceId: BUYER.id,
      reason: "onboarding",
    });
    expect(evt!["detail"]).toBe("from=none to=moderator");
    expect(JSON.stringify(evt)).not.toContain(BUYER.email); // KHÔNG PII thô
  });

  it("D6: grant KHÔNG đè role display 'seller' — seller visibility giữ nguyên (adminRole vẫn là nguồn quyền duy nhất)", async () => {
    dbState.users.push({ ...SELLER });
    login(ADMIN_SUPER, { isAdmin: true });

    const state = await setAdminRoleAction(
      {},
      fd({ userId: SELLER.id, role: "moderator", reason: "onboarding" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(SELLER.id)["adminRole"]).toBe("moderator");
    expect(userRow(SELLER.id)["role"]).toBe("seller"); // KHÔNG đè thành "admin"
  });

  it("CHANGE role (đã có adminRole) → from=<old> to=<new>, session đích cũng bị thu hồi hết", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    login(ADMIN_SUPER, { isAdmin: true });
    const opsSession = seedSession("ops-sess", ADMIN_OPS.id);

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_OPS.id, role: "analyst", reason: "responsibility_change" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(ADMIN_OPS.id)["adminRole"]).toBe("analyst");
    expect(opsSession["revokedAt"]).not.toBeNull();
    expect(opsSession["revokedReason"]).toBe("admin_role_changed");
    const evt = dbState.audits.find((r) => r["action"] === "admin.role_set");
    expect(evt!["detail"]).toBe("from=operations_admin to=analyst");
  });

  it("tự đổi role CHÍNH MÌNH khi còn super_admin khác → cho qua, session HIỆN TẠI cũng bị thu hồi (logout sạch)", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    const currentId = login(ADMIN_SUPER, { isAdmin: true });
    const otherDevice = seedSession("super-other", ADMIN_SUPER.id);

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_SUPER.id, role: "operations_admin", reason: "responsibility_change" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(ADMIN_SUPER.id)["adminRole"]).toBe("operations_admin");
    // MỌI session của đích — kể cả session hiện tại của chính actor (role đổi
    // → quyền cũ của session không còn giá trị, login lại qua MFA)
    expect(sessionRow(currentId)["revokedAt"]).not.toBeNull();
    expect(sessionRow(currentId)["revokedReason"]).toBe("admin_role_changed");
    expect(otherDevice["revokedAt"]).not.toBeNull();
    const evt = dbState.audits.find((r) => r["action"] === "admin.role_set");
    expect(evt).toMatchObject({ actorId: ADMIN_SUPER.id, subjectId: ADMIN_SUPER.id });
  });

  it("minor: đặt CÙNG role đang giữ → IDEMPOTENT no-op — KHÔNG thu hồi session, KHÔNG audit", async () => {
    login(ADMIN_SUPER, { isAdmin: true });
    const opsSession = seedSession("ops-sess", ADMIN_OPS.id);
    const auditsBefore = dbState.audits.length;

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_OPS.id, role: "operations_admin", reason: "correction" }),
    );

    expect(state.success).toBeTruthy(); // không lỗi — no-op thành thật
    expect(userRow(ADMIN_OPS.id)["adminRole"]).toBe("operations_admin"); // nguyên vẹn
    expect(opsSession["revokedAt"]).toBeNull(); // KHÔNG thu hồi
    expect(dbState.audits.length).toBe(auditsBefore); // KHÔNG audit mới
  });
});

// ─── 4. Last-super-admin guard (D2 — helper chia sẻ, row-lock) ────────────────

describe("setAdminRoleAction — last-super-admin guard (assertNotLastSuperAdminTx)", () => {
  it("demote super_admin DUY NHẤT (tự demote) → state LAST_SUPER_ADMIN, không mutation", async () => {
    login(ADMIN_SUPER, { isAdmin: true }); // ADMIN_SUPER là super_admin duy nhất trong store

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_SUPER.id, role: "operations_admin", reason: "responsibility_change" }),
    );

    expect(state.code).toBe("LAST_SUPER_ADMIN");
    expect(state.error).toBeTruthy();
    expect(userRow(ADMIN_SUPER.id)["adminRole"]).toBe("super_admin"); // KHÔNG mutation
    expect(dbState.audits.filter((r) => r["action"] === "admin.role_set")).toHaveLength(0);
    expect(dbState.sessions.every((s) => s["revokedAt"] === null)).toBe(true); // không revoke gì
  });

  it("demote super_admin KHÁC khi actor cũng là super_admin → cho qua (actor là super_admin còn lại — guard đếm theo ĐÍCH, không trừ actor)", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    login(ADMIN_SUPER_2, { isAdmin: true }); // actor ≠ target, cả hai đều super_admin

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_SUPER.id, role: "moderator", reason: "offboarding" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(ADMIN_SUPER.id)["adminRole"]).toBe("moderator");
    expect(userRow(ADMIN_SUPER_2.id)["adminRole"]).toBe("super_admin"); // actor còn lại — không về 0
  });

  it("còn super_admin KHÁC → tự demote cho qua (guard chỉ chặn khi về 0)", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    login(ADMIN_SUPER, { isAdmin: true });

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_SUPER.id, role: "operations_admin", reason: "responsibility_change" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(ADMIN_SUPER.id)["adminRole"]).toBe("operations_admin");
    expect(userRow(ADMIN_SUPER_2.id)["adminRole"]).toBe("super_admin"); // người còn lại nguyên vẹn
  });

  it("PROMOTE lên super_admin không bị guard chặn (đi lên không bao giờ về 0)", async () => {
    login(ADMIN_SUPER, { isAdmin: true }); // duy nhất — nhưng đang cấp THÊM

    const state = await setAdminRoleAction(
      {},
      fd({ userId: BUYER.id, role: "super_admin", reason: "onboarding" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow(BUYER.id)["adminRole"]).toBe("super_admin");
  });

  it("GỠ quyền (role=none) super_admin DUY NHẤT → state LAST_SUPER_ADMIN — removal cũng qua guard (D6)", async () => {
    login(ADMIN_SUPER, { isAdmin: true });

    const state = await setAdminRoleAction(
      {},
      fd({ userId: ADMIN_SUPER.id, role: "none", reason: "offboarding" }),
    );

    expect(state.code).toBe("LAST_SUPER_ADMIN");
    expect(userRow(ADMIN_SUPER.id)["adminRole"]).toBe("super_admin"); // KHÔNG mutation
    expect(dbState.audits.filter((r) => r["action"] === "admin.role_set")).toHaveLength(0);
  });
});

// ─── 5. Gỡ quyền quản trị (D6 — role="none" → adminRole null) ────────────────

describe("setAdminRoleAction — remove admin access (role=none)", () => {
  it("gỡ quyền admin → adminRole null + role restore theo marker (SellerVerification row → 'seller') + thu hồi session + audit to=none", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    login(ADMIN_SUPER, { isAdmin: true });
    // Legacy admin: role display "admin" + có SellerVerification row → restore "seller"
    dbState.users.push(mkUser({ id: "legacy-admin", email: "legacy@loaviet.test", name: "Legacy", role: "admin", adminRole: "moderator" }));
    dbState.sellerVerifications.push({ id: "sv-1", userId: "legacy-admin" });
    const legacySession = seedSession("legacy-sess", "legacy-admin");

    const state = await setAdminRoleAction(
      {},
      fd({ userId: "legacy-admin", role: "none", reason: "offboarding" }),
    );

    expect(state.error).toBeUndefined();
    const target = userRow("legacy-admin");
    expect(target["adminRole"]).toBeNull(); // hết quyền quản trị
    expect(target["role"]).toBe("seller"); // restore theo marker (D6)
    expect(legacySession["revokedAt"]).not.toBeNull();
    expect(legacySession["revokedReason"]).toBe("admin_role_changed");
    const evt = dbState.audits.find((r) => r["action"] === "admin.role_set");
    expect(evt!["detail"]).toBe("from=moderator to=none");
    expect(evt).toMatchObject({ actorId: ADMIN_SUPER.id, subjectId: "legacy-admin", reason: "offboarding" });
  });

  it("gỡ quyền: KHÔNG có marker seller (không verification/listing) → role restore 'buyer'", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    login(ADMIN_SUPER, { isAdmin: true });
    // Buyer được promote (role display "admin") → gỡ → restore "buyer"
    dbState.users.push(mkUser({ id: "promoted-buyer", email: "pb@loaviet.test", name: "PB", role: "admin", adminRole: "support" }));
    const pbSession = seedSession("pb-sess", "promoted-buyer");

    const state = await setAdminRoleAction(
      {},
      fd({ userId: "promoted-buyer", role: "none", reason: "offboarding" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow("promoted-buyer")["adminRole"]).toBeNull();
    expect(userRow("promoted-buyer")["role"]).toBe("buyer"); // không marker → buyer
    expect(pbSession["revokedAt"]).not.toBeNull();
  });

  it("gỡ quyền: role display hiện tại 'seller' → GIỮ NGUYÊN (restore chỉ áp dụng khi role='admin')", async () => {
    dbState.users.push({ ...ADMIN_SUPER_2 });
    login(ADMIN_SUPER, { isAdmin: true });
    dbState.users.push(mkUser({ id: "seller-admin", email: "sa@loaviet.test", name: "SA", role: "seller", adminRole: "analyst" }));

    const state = await setAdminRoleAction(
      {},
      fd({ userId: "seller-admin", role: "none", reason: "offboarding" }),
    );

    expect(state.error).toBeUndefined();
    expect(userRow("seller-admin")["adminRole"]).toBeNull();
    expect(userRow("seller-admin")["role"]).toBe("seller"); // không đụng role seller
  });

  it("gỡ quyền của user KHÔNG có adminRole → IDEMPOTENT no-op (from=none to=none)", async () => {
    login(ADMIN_SUPER, { isAdmin: true });
    const buyerSession = seedSession("b-sess", BUYER.id);
    const auditsBefore = dbState.audits.length;

    const state = await setAdminRoleAction(
      {},
      fd({ userId: BUYER.id, role: "none", reason: "offboarding" }),
    );

    expect(state.success).toBeTruthy(); // no-op thành thật, không lỗi
    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
    expect(buyerSession["revokedAt"]).toBeNull(); // KHÔNG thu hồi
    expect(dbState.audits.length).toBe(auditsBefore); // KHÔNG audit
  });
});

// ─── 6. Compare-and-set trên adminRole trước đó (concurrent role change) ─────

describe("setAdminRoleAction — compare-and-set", () => {
  it("read stale (request khác đổi role giữa chừng) → ADMIN_ROLE_CONFLICT (throw), KHÔNG revoke, KHÔNG audit (tx rollback)", async () => {
    login(ADMIN_SUPER, { isAdmin: true });
    // Target đang giữ operations_admin; seam ép bản đọc trả "moderator" —
    // CAS theo "moderator" không khớp row thật → 0 row → conflict typed.
    dbState.staleFirstReadAdminRole = "moderator";
    const targetSession = seedSession("ops-sess", ADMIN_OPS.id);

    await expect(
      setAdminRoleAction({}, fd({ userId: ADMIN_OPS.id, role: "support", reason: "correction" })),
    ).rejects.toThrow("ADMIN_ROLE_CONFLICT");

    // ROLLBACK toàn bộ: role nguyên vẹn, session sống, không audit
    expect(userRow(ADMIN_OPS.id)["adminRole"]).toBe("operations_admin");
    expect(userRow(ADMIN_OPS.id)["role"]).toBe("admin");
    expect(targetSession["revokedAt"]).toBeNull();
    expect(dbState.audits.filter((r) => r["action"] === "admin.role_set")).toHaveLength(0);
  });
});

// ─── 7. Input typed — validate trước khi đụng db ─────────────────────────────

describe("setAdminRoleAction — input typed (fail closed trước khi đụng db)", () => {
  it("role ngoài enum → INVALID_ROLE, không mutation", async () => {
    login(ADMIN_SUPER, { isAdmin: true });

    await expect(
      setAdminRoleAction({}, fd({ userId: BUYER.id, role: "root", reason: "onboarding" })),
    ).rejects.toThrow("INVALID_ROLE");

    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("reason ngoài enum → INVALID_REASON, không mutation", async () => {
    login(ADMIN_SUPER, { isAdmin: true });

    await expect(
      setAdminRoleAction({}, fd({ userId: BUYER.id, role: "moderator", reason: "vì tôi muốn" })),
    ).rejects.toThrow("INVALID_REASON");

    expect(userRow(BUYER.id)["adminRole"]).toBeNull();
  });

  it("userId rỗng → INVALID_USER; target không tồn tại → USER_NOT_FOUND", async () => {
    login(ADMIN_SUPER, { isAdmin: true });

    await expect(
      setAdminRoleAction({}, fd({ userId: "", role: "moderator", reason: "onboarding" })),
    ).rejects.toThrow("INVALID_USER");

    await expect(
      setAdminRoleAction({}, fd({ userId: "khong-ton-tai", role: "moderator", reason: "onboarding" })),
    ).rejects.toThrow("USER_NOT_FOUND");

    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 8. Source contract — /admin/security role section (như finance-public-surface) ──

describe("source contract — app/admin/security (spec §4.5/§4.8)", () => {
  const pageSrc = () => read("app/admin/security/page.tsx");
  const formsSrc = () => read("app/admin/security/forms.tsx");

  it("page tự guard server-side requireAdminUser + role section lọc theo admin.role_manage (convenience, spec §4.5)", () => {
    expect(pageSrc()).toContain("requireAdminUser(");
    expect(pageSrc()).toContain("capabilitiesOf(");
    expect(pageSrc()).toContain('includes("admin.role_manage")');
  });

  it("page KHÔNG select passwordHash — admin list chọn field tường minh (spec §4.8)", () => {
    const src = pageSrc();
    expect(src).toContain(".select(");
    expect(src).not.toContain("passwordHash");
  });

  it("role form là client component useActionState — lỗi typed hiển thị cho operator (minor)", () => {
    expect(formsSrc()).toContain("useActionState");
    expect(formsSrc()).toContain("setAdminRoleAction");
  });

  it("role select + reason select sinh từ danh sách typed (ADMIN_ROLES/ADMIN_ROLE_REASON_CODES — không tự chế giá trị)", () => {
    const src = formsSrc();
    expect(src).toContain("ADMIN_ROLES");
    expect(src).toContain("ADMIN_ROLE_REASON_CODES");
    expect(src).toContain('value="none"'); // D6 — gỡ quyền quản trị
  });
});
