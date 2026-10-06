/**
 * Beta cohort membership — admin grant/suspend (plan Task 10, spec §2.1/§4.9/
 * §8.4) — unit tests.
 *
 * Beta membership là ĐIỀU KIỆN publication (founding_seller active) — chỉ
 * admin operation (beta_cohort.manage) được set; user hiện có KHÔNG tự
 * động thành founding seller (spec §8.4 "Existing users do not automatically
 * become founding sellers").
 *
 * Hợp đồng (plan Task 10 Step 1):
 *  1. analyst/moderator/support (KHÔNG có beta_cohort.manage) → FORBIDDEN,
 *     không mutation, không audit (Review Focus 4 — gọi action trực tiếp).
 *  2. operations_admin → upsert theo @@unique(userId, cohort) + audit
 *     "beta_cohort.membership_set" (cohort + status trong detail, KHÔNG PII).
 *  3. Status transitions recorded: active → suspended → exited → active;
 *     tạo mới ghi invitedBy/invitedAt.
 *  4. Cohort/status ngoài enum → validation error, không mutation.
 *
 * Cơ chế mock như seller-verification-actions.test.ts: session/rbac/audit
 * GIỮ BẢN THẬT, login qua COOKIE THẬT; db.client in-memory
 * (User/UserSession(include user)/BetaCohortMembership/AuditEvent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

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

// ─── db.client mock ───────────────────────────────────────────────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
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
    }), (row) => {
      row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
    }),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      id: `bcm-${dbState.memberships.length + 1}`,
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    AuditEvent: makeModel(dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import { setBetaMembershipAction } from "@/src/lib/actions/beta-cohort";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

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
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const ADMIN_OPS = mkUser({ id: "admin-ops", email: "ops@loaviet.test", name: "Ops", role: "admin", adminRole: "operations_admin" });
const ADMIN_SUPER = mkUser({ id: "admin-super", email: "super@loaviet.test", name: "Super", role: "admin", adminRole: "super_admin" });
const ADMIN_MOD = mkUser({ id: "admin-mod", email: "mod@loaviet.test", name: "Mod", role: "admin", adminRole: "moderator" });
const ADMIN_SUPPORT = mkUser({ id: "admin-support", email: "support@loaviet.test", name: "Support", role: "admin", adminRole: "support" });
const ADMIN_ANALYST = mkUser({ id: "admin-analyst", email: "analyst@loaviet.test", name: "Analyst", role: "admin", adminRole: "analyst" });
const BUYER = mkUser({ id: "user-buyer", email: "buyer@loaviet.test", name: "Buyer" });

const login = (user: Row, opts?: { isAdmin?: boolean }): string => {
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
    steppedUpAt: null,
    userAgent: "unit-test-agent/1.0",
  });
  cookieState.store.set(SESSION_COOKIE, token);
  return id;
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.memberships.length = 0;
  dbState.audits.length = 0;
  dbState.users.push({ ...ADMIN_OPS }, { ...ADMIN_SUPER }, { ...ADMIN_MOD }, { ...ADMIN_SUPPORT }, { ...ADMIN_ANALYST }, { ...BUYER });
  cookieState.store.clear();
  headerState.headers = new Headers();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Capability beta_cohort.manage (Review Focus 4) ────────────────────────

describe("setBetaMembershipAction — requireCapability(beta_cohort.manage)", () => {
  it.each([
    ["moderator", ADMIN_MOD],
    ["support", ADMIN_SUPPORT],
    ["analyst", ADMIN_ANALYST],
  ])("%s → FORBIDDEN, không mutation, không audit", async (_label, admin) => {
    login(admin as Row, { isAdmin: true });

    await expect(
      setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" })),
    ).rejects.toThrow("FORBIDDEN");

    expect(dbState.memberships).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("session adminRole nhưng chưa qua MFA (isAdmin=false) → FORBIDDEN", async () => {
    login(ADMIN_OPS); // consumer session

    await expect(
      setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" })),
    ).rejects.toThrow("FORBIDDEN");

    expect(dbState.memberships).toHaveLength(0);
  });

  it("chưa đăng nhập → FORBIDDEN", async () => {
    cookieState.store.clear();

    await expect(
      setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" })),
    ).rejects.toThrow("FORBIDDEN");
  });
});

// ─── 2. Upsert + audit ────────────────────────────────────────────────────────

describe("setBetaMembershipAction — operations_admin upsert + audit", () => {
  it("tạo mới membership active → row + invitedBy/invitedAt + audit (cohort+status, KHÔNG PII)", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    await setBetaMembershipAction(
      fd({ userId: BUYER.id, cohort: "founding_seller", status: "active", notes: "founding batch" }),
    );

    expect(dbState.memberships).toHaveLength(1);
    const row = dbState.memberships[0]!;
    expect(row).toMatchObject({
      userId: BUYER.id,
      cohort: "founding_seller",
      status: "active",
      invitedBy: ADMIN_OPS.id,
      notes: "founding batch",
    });
    expect(row.invitedAt).not.toBeNull();
    const evt = dbState.audits.find((r) => r.action === "beta_cohort.membership_set");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: BUYER.id,
      resourceType: "BetaCohortMembership",
      resourceId: row.id,
    });
    expect(evt!.detail).toContain("cohort=founding_seller");
    expect(evt!.detail).toContain("status=active");
    // KHÔNG PII (spec §4.8) — không email/phone của user đích
    expect(JSON.stringify(evt)).not.toContain("buyer@loaviet.test");
  });

  it("status transitions recorded: active → suspended → exited → active (CÙNG row, không nhân bản)", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" }));
    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "suspended" }));
    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "exited" }));
    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" }));

    expect(dbState.memberships).toHaveLength(1); // @@unique(userId, cohort)
    const row = dbState.memberships[0]!;
    expect(row.status).toBe("active");
    // mỗi lần set một audit event
    const events = dbState.audits.filter((r) => r.action === "beta_cohort.membership_set");
    expect(events).toHaveLength(4);
  });

  it("cohort KHÁC (private_beta_buyer) — riêng row theo @@unique(userId, cohort)", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" }));
    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "private_beta_buyer", status: "active" }));

    expect(dbState.memberships).toHaveLength(2);
    expect(dbState.memberships.filter((m) => m.cohort === "founding_seller")).toHaveLength(1);
    expect(dbState.memberships.filter((m) => m.cohort === "private_beta_buyer")).toHaveLength(1);
  });

  it("cohort/status ngoài enum → validation error, không mutation", async () => {
    login(ADMIN_OPS, { isAdmin: true });

    await expect(
      setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "vip", status: "active" })),
    ).rejects.toThrow();
    await expect(
      setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "banned" })),
    ).rejects.toThrow();

    expect(dbState.memberships).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("super_admin cũng có beta_cohort.manage (ma trận §5.4.1)", async () => {
    login(ADMIN_SUPER, { isAdmin: true });

    await setBetaMembershipAction(fd({ userId: BUYER.id, cohort: "founding_seller", status: "active" }));

    expect(dbState.memberships).toHaveLength(1);
  });
});
