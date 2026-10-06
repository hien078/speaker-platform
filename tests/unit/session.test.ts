/**
 * DB-backed sessions — unit tests (plan Task 2, spec §5.4.2).
 *
 * Cơ chế mock: `server-only` + `next/headers` (cookie store điều khiển được)
 * + `@/src/prisma/db.client` (in-memory UserSession map + User fixture) —
 * cùng phong cách finance tests (tests/unit/financial-shutdown-actions.test.ts).
 *
 * Hợp đồng (plan Task 2 Step 1):
 *  1. createSession lưu tokenHash sha256 (64-hex) — KHÔNG lưu token thô;
 *     cookie httpOnly + sameSite lax + path "/" + secure ở production.
 *  2. Consumer TTL 30 ngày; admin TTL 12 giờ — isAdmin derive từ User.adminRole
 *     (spec §8.5: adminRole là nguồn duy nhất; role chỉ còn display).
 *  3. getSessionFromCookie: null cho token unknown / revoked / expired / rác.
 *  4. Session bị revoke → lookup ở request sau trả null (Review Focus 3).
 *  5. revokeAllUserSessions giữ session except, revoke còn lại, trả count.
 *  6. stepUpIsFresh: true trong 15 phút, false khi cũ hơn, false khi null.
 *  7. Session fixation: hai createSession liên tiếp → token khác nhau
 *     (fresh random mỗi login — cookie pre-auth bị bỏ khi rotate).
 *  8. touchSessionLastSeen throttle: chỉ ghi khi lastSeenAt cũ hơn 5 phút.
 *
 * Phần cuối: auth.ts delegate sang session.ts (public API giữ nguyên) —
 * destroySession revoke session hiện tại + xóa cookie; getCurrentUser trả
 * user từ session lookup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

vi.mock("server-only", () => ({}));

// ─── Cookie store điều khiển được (next/headers) ─────────────────────────────
const cookieState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setCalls: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieState.store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieState.store.set(name, value);
      cookieState.setCalls.push({ name, value, options: options ?? {} });
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

// ─── db.client mock: in-memory UserSession + User fixture ─────────────────────
const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  /** ép lookup throw — chứng minh getSessionFromCookie fail closed (không throw). */
  failLookup: false,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  // Field proxy cho lambda predicate — đánh giá trực tiếp trên row
  // (session.ts chỉ dùng single-clause: eq/neq/lt/lte/gt/gte/isNull).
  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          // runtime so sánh ISO string lexicographic — cast chỉ để typescript
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

  const makeModel = (rows: Row[], defaults: () => Row, attach?: (row: Row) => void) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      orderBy: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        if (dbState.failLookup) throw new Error("DB_DOWN");
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (!hit) return null;
        const copy = { ...hit };
        if (includeRel && attach) attach(copy);
        return copy;
      },
      all: async () => {
        if (dbState.failLookup) throw new Error("DB_DOWN");
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        return hit.map((r) => {
          const copy = { ...r };
          if (includeRel && attach) attach(copy);
          return copy;
        });
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...defaults(), ...data };
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

  const orm = {
    public: {
      User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
      UserSession: makeModel(dbState.sessions, sessionDefaults, (row) => {
        row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
      }),
    },
  };
  return { db: { orm } };
});

import {
  SESSION_COOKIE,
  CONSUMER_SESSION_TTL_HOURS,
  ADMIN_SESSION_TTL_HOURS,
  STEP_UP_MAX_AGE_MINUTES,
  createSession,
  getSessionFromCookie,
  revokeSession,
  revokeAllUserSessions,
  listUserSessions,
  markSessionSteppedUp,
  touchSessionLastSeen,
  stepUpIsFresh,
} from "@/src/lib/session";
import { destroySession, getCurrentUser } from "@/src/lib/auth";

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

type Row = Record<string, unknown>;

const BUYER: Row = {
  id: "user-buyer",
  email: "buyer@loaviet.test",
  passwordHash: "x",
  name: "Người Mua",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
};
const ADMIN: Row = {
  id: "user-admin",
  email: "admin@loaviet.test",
  passwordHash: "x",
  name: "Admin Cũ",
  role: "admin",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: "super_admin",
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.failLookup = false;
  dbState.users.push({ ...BUYER }, { ...ADMIN });
  cookieState.store.clear();
  cookieState.setCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  dbState.failLookup = false;
});

// ─── 1. Token: sha256 tokenHash, không lưu token thô; cookie options ──────────

describe("createSession — token opaque + cookie", () => {
  it("lưu tokenHash sha256 (64-hex) — KHÔNG lưu token thô; cookie httpOnly/lax/path=/", async () => {
    await createSession(BUYER.id as string);

    const row = dbState.sessions[0]!;
    const set = cookieState.setCalls.at(-1)!;
    expect(set.name).toBe(SESSION_COOKIE);
    // DB chỉ lưu hash — token thô chỉ tồn tại trong cookie
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(set.value).not.toBe(row.tokenHash);
    expect(sha256Hex(set.value)).toBe(row.tokenHash);
    // cookie options (Next 16 cookies().set)
    expect(set.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("cookie secure=true ở production, false ở dev/test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createSession(BUYER.id as string);
    expect(cookieState.setCalls.at(-1)!.options.secure).toBe(true);

    vi.stubEnv("NODE_ENV", "test");
    await createSession(BUYER.id as string);
    expect(cookieState.setCalls.at(-1)!.options.secure).toBe(false);
  });

  it("session fixation: hai createSession liên tiếp → token khác nhau (fresh random mỗi login)", async () => {
    await createSession(BUYER.id as string);
    const first = cookieState.setCalls.at(-1)!.value;
    await createSession(BUYER.id as string);
    const second = cookieState.setCalls.at(-1)!.value;
    expect(first).not.toBe(second);
    expect(dbState.sessions[0]!.tokenHash).not.toBe(dbState.sessions[1]!.tokenHash);
  });
});

// ─── 2. TTL: consumer 30 ngày, admin 12 giờ (từ adminRole) ────────────────────

describe("TTL theo isAdmin (derive từ User.adminRole — spec §8.5)", () => {
  it("consumer TTL 30 ngày", async () => {
    await createSession(BUYER.id as string);
    const row = dbState.sessions[0]!;
    expect(row.isAdmin).toBe(false);
    expect(CONSUMER_SESSION_TTL_HOURS).toBe(24 * 30);
    const delta = Date.parse(row.expiresAt as string) - Date.now();
    expect(Math.abs(delta - CONSUMER_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
  });

  it("admin TTL 12 giờ — derive từ adminRole khi caller không truyền opts", async () => {
    await createSession(ADMIN.id as string);
    const row = dbState.sessions[0]!;
    expect(row.isAdmin).toBe(true);
    expect(ADMIN_SESSION_TTL_HOURS).toBe(12);
    const delta = Date.parse(row.expiresAt as string) - Date.now();
    expect(Math.abs(delta - ADMIN_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
  });

  it("opts.isAdmin=true override cho user thường → TTL admin", async () => {
    await createSession(BUYER.id as string, { isAdmin: true });
    const row = dbState.sessions[0]!;
    expect(row.isAdmin).toBe(true);
    const delta = Date.parse(row.expiresAt as string) - Date.now();
    expect(Math.abs(delta - ADMIN_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
  });

  it("maxAge cookie = TTL (giây)", async () => {
    await createSession(ADMIN.id as string);
    expect(cookieState.setCalls.at(-1)!.options.maxAge).toBe(ADMIN_SESSION_TTL_HOURS * 3_600);
  });
});

// ─── 3+4. Lookup: null cho unknown / revoked / expired / rác ───────────────────

describe("getSessionFromCookie — reject không hợp lệ (fail closed)", () => {
  it("trả session + user từ MỘT lookup (cookie → hash → row + user)", async () => {
    await createSession(BUYER.id as string, { userAgent: "vitest/1.0" });
    const got = await getSessionFromCookie();
    expect(got).not.toBeNull();
    expect(got!.user).toMatchObject({
      id: BUYER.id,
      email: BUYER.email,
      name: BUYER.name,
      role: "buyer",
      avatarUrl: null,
      isVerifiedSeller: false,
      adminRole: null,
    });
    expect(got!.user.sessionId).toBe(got!.session.id);
    expect(got!.session).toMatchObject({
      userId: BUYER.id,
      isAdmin: false,
      userAgent: "vitest/1.0",
      steppedUpAt: null,
    });
    expect(typeof got!.session.createdAt).toBe("string");
  });

  it("null khi không có cookie", async () => {
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("null cho token không tồn tại (unknown)", async () => {
    cookieState.store.set(SESSION_COOKIE, randomBytes(32).toString("base64url"));
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("null cho token rác (không phải định dạng nào)", async () => {
    cookieState.store.set(SESSION_COOKIE, "not-a-real-token");
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("null cho session đã revoke — lookup request sau fail (Review Focus 3)", async () => {
    await createSession(BUYER.id as string);
    const got = await getSessionFromCookie();
    expect(got).not.toBeNull();
    await revokeSession(got!.session.id, "logout");
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("null cho session hết hạn (expiresAt <= now)", async () => {
    const token = randomBytes(32).toString("base64url");
    dbState.sessions.push({
      id: "sess-expired",
      userId: BUYER.id,
      tokenHash: sha256Hex(token),
      isAdmin: false,
      createdAt: new Date(Date.now() - 7_200_000).toISOString(),
      lastSeenAt: null,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      revokedAt: null,
      revokedReason: null,
      steppedUpAt: null,
      userAgent: null,
    });
    cookieState.store.set(SESSION_COOKIE, token);
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("không throw khi db lỗi — fail closed về logged-out (như getCurrentUser cũ)", async () => {
    await createSession(BUYER.id as string);
    dbState.failLookup = true;
    try {
      expect(await getSessionFromCookie()).toBeNull();
    } finally {
      dbState.failLookup = false;
    }
  });
});

// ─── 5. Revoke helpers + inventory ────────────────────────────────────────────

describe("revoke helpers", () => {
  it("revokeSession ghi revokedAt + revokedReason — idempotent (reason gốc giữ nguyên)", async () => {
    await createSession(BUYER.id as string);
    const { session } = (await getSessionFromCookie())!;
    await revokeSession(session.id, "logout");
    const row = dbState.sessions.find((r) => r.id === session.id)!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("logout");

    // revoke lần 2 với reason khác → no-op (idempotent, không ghi đè reason gốc)
    const revokedAtBefore = row.revokedAt;
    await revokeSession(session.id, "other_reason");
    expect(row.revokedAt).toBe(revokedAtBefore);
    expect(row.revokedReason).toBe("logout");
  });

  it("revokeAllUserSessions giữ session except, revoke còn lại, trả count", async () => {
    await createSession(BUYER.id as string); // s1
    await createSession(BUYER.id as string); // s2
    await createSession(BUYER.id as string); // s3 — cookie hiện tại
    const tokens = cookieState.setCalls.map((c) => c.value);
    const currentId = (await getSessionFromCookie())!.session.id;

    const count = await revokeAllUserSessions(BUYER.id as string, "security_rotation", {
      exceptSessionId: currentId,
    });
    expect(count).toBe(2);

    // session bị revoke → lookup fail
    cookieState.store.set(SESSION_COOKIE, tokens[0]!);
    expect(await getSessionFromCookie()).toBeNull();
    cookieState.store.set(SESSION_COOKIE, tokens[1]!);
    expect(await getSessionFromCookie()).toBeNull();
    // session except → vẫn hợp lệ
    cookieState.store.set(SESSION_COOKIE, tokens[2]!);
    expect((await getSessionFromCookie())!.session.id).toBe(currentId);
  });

  it("revokeAllUserSessions không đụng session của user khác", async () => {
    await createSession(BUYER.id as string);
    await createSession(ADMIN.id as string);
    const count = await revokeAllUserSessions(BUYER.id as string, "logout_all");
    expect(count).toBe(1);
    expect(dbState.sessions.find((r) => r.userId === ADMIN.id)!.revokedAt).toBeNull();
  });

  it("listUserSessions — inventory active (chưa revoke, chưa hết hạn)", async () => {
    await createSession(BUYER.id as string);
    await createSession(BUYER.id as string);
    const list = await listUserSessions(BUYER.id as string);
    expect(list).toHaveLength(2);
    expect(list.every((s) => s.userId === BUYER.id)).toBe(true);

    // session hết hạn không xuất hiện trong inventory
    dbState.sessions.push({
      id: "sess-expired-2",
      userId: BUYER.id,
      tokenHash: sha256Hex(randomBytes(32).toString("base64url")),
      isAdmin: false,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      revokedAt: null,
      revokedReason: null,
      steppedUpAt: null,
      userAgent: null,
    });
    expect(await listUserSessions(BUYER.id as string)).toHaveLength(2);
  });
});

// ─── 6. Step-up ───────────────────────────────────────────────────────────────

describe("step-up (Task 8 dùng — STEP_UP_MAX_AGE_MINUTES)", () => {
  it("stepUpIsFresh: true trong 15 phút, false khi cũ hơn, false khi null", () => {
    expect(STEP_UP_MAX_AGE_MINUTES).toBe(15);
    expect(stepUpIsFresh(new Date(Date.now() - 14 * 60_000).toISOString())).toBe(true);
    expect(stepUpIsFresh(new Date(Date.now() - 16 * 60_000).toISOString())).toBe(false);
    expect(stepUpIsFresh(null)).toBe(false);
  });

  it("markSessionSteppedUp ghi steppedUpAt", async () => {
    await createSession(BUYER.id as string);
    const { session } = (await getSessionFromCookie())!;
    expect(session.steppedUpAt).toBeNull();
    await markSessionSteppedUp(session.id);
    const after = await listUserSessions(BUYER.id as string);
    expect(after.find((s) => s.id === session.id)!.steppedUpAt).not.toBeNull();
  });
});

// ─── 8. touchSessionLastSeen throttle ────────────────────────────────────────

describe("touchSessionLastSeen — throttle 5 phút", () => {
  it("chỉ ghi khi lastSeenAt cũ hơn 5 phút (hoặc null)", async () => {
    await createSession(BUYER.id as string);
    const row = dbState.sessions[0]!;

    // lastSeenAt null → ghi ngay
    await touchSessionLastSeen(row.id as string);
    expect(row.lastSeenAt).not.toBeNull();
    const first = row.lastSeenAt;

    // ngay sau đó → KHÔNG ghi (throttle)
    await touchSessionLastSeen(row.id as string);
    expect(row.lastSeenAt).toBe(first);

    // 6 phút cũ → ghi lại (lastSeenAt tươi trở lại, không còn là giá trị stale)
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    row.lastSeenAt = stale;
    await touchSessionLastSeen(row.id as string);
    expect(row.lastSeenAt).not.toBe(stale);
    expect(Date.parse(row.lastSeenAt as string)).toBeGreaterThan(Date.parse(stale));
  });

  it("session không tồn tại → no-op, không throw", async () => {
    await expect(touchSessionLastSeen("sess-không-tồn-tại")).resolves.toBeUndefined();
  });
});

// ─── auth.ts delegate sang session.ts (public API giữ nguyên) ──────────────────

describe("auth.ts — delegate sang session.ts (chữ ký public giữ nguyên)", () => {
  it("getCurrentUser: null khi không có cookie; user từ session lookup khi có", async () => {
    expect(await getCurrentUser()).toBeNull();
    await createSession(BUYER.id as string);
    const user = await getCurrentUser();
    expect(user!.id).toBe(BUYER.id);
    expect(user!.email).toBe(BUYER.email);
    expect(user!.sessionId).toBe(dbState.sessions[0]!.id);
  });

  it("destroySession: revoke session hiện tại (reason logout) + xóa cookie", async () => {
    await createSession(BUYER.id as string);
    expect(cookieState.store.has(SESSION_COOKIE)).toBe(true);
    await destroySession();
    expect(cookieState.store.has(SESSION_COOKIE)).toBe(false);
    const row = dbState.sessions[0]!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("logout");
    // session đã revoke → lookup fail (Review Focus 3)
    cookieState.store.set(SESSION_COOKIE, cookieState.setCalls[0]!.value);
    expect(await getCurrentUser()).toBeNull();
  });

  it("destroySession không có session → chỉ xóa cookie, không throw", async () => {
    cookieState.store.set(SESSION_COOKIE, "giá-trị-cũ");
    await expect(destroySession()).resolves.toBeUndefined();
    expect(cookieState.store.has(SESSION_COOKIE)).toBe(false);
  });
});
