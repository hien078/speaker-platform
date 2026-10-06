/**
 * Session lifecycle integration tests — plan Task 2, spec §5.4.2.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit test (tests/unit/session.test.ts) chứng minh logic với db mock; ở đây
 * chứng minh cùng hợp đồng against DB THẬT (bảng UserSession của migration
 * batch 2 — unique tokenHash, timestamptz, predicate updateAll):
 *
 *  1. create → get (lookup bằng tokenHash) → revoke → get null.
 *  2. revokeAllUserSessions giữ session except, revoke còn lại, trả count.
 *  3. Expiry boundary: expiresAt quá hạn (kể cả đúng bằng now) → null.
 *  4. Admin TTL 12 giờ — isAdmin derive từ User.adminRole trên schema thật.
 *  5. touchSessionLastSeen throttle trên DB thật (null → ghi; fresh → skip).
 *
 * `next/headers` vẫn mock (cookie store điều khiển được) — cookies() ngoài
 * request scope không chạy được; phần DB là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

vi.mock("server-only", () => ({}));

// ─── Cookie store điều khiển được (next/headers) ─────────────────────────────
const cookieState = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
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

import { db } from "../../src/prisma/db.client";
import {
  SESSION_COOKIE,
  ADMIN_SESSION_TTL_HOURS,
  CONSUMER_SESSION_TTL_HOURS,
  createSession,
  getSessionFromCookie,
  revokeSession,
  revokeAllUserSessions,
  listUserSessions,
  touchSessionLastSeen,
} from "../../src/lib/session";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

let seq = 0;
const uid = () => `b2-sess-${Date.now()}-${seq++}`;

async function mkUser(
  role: "buyer" | "seller" | "admin",
  adminRole?: "super_admin" | "operations_admin" | "moderator" | "support" | "analyst",
): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B2 Session ${role}`,
    role,
    adminRole: adminRole ?? null,
  });
  return u.id;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// session trước user (FK) — thực tế cascade đã lo, explicit cho rõ ý.
const created = { users: [] as string[], sessions: [] as string[] };

afterEach(async () => {
  for (const id of created.sessions) {
    await db.orm.public.UserSession.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  created.users.length = 0;
  created.sessions.length = 0;
  cookieState.store.clear();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. create → get → revoke → get null ─────────────────────────────────────

d("session lifecycle trên DB thật", () => {
  it("create → get → revoke → get null", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);

    await createSession(userId);
    const cookieToken = cookieState.store.get(SESSION_COOKIE)!;
    expect(cookieToken).toBeTruthy();

    // DB lưu sha256 tokenHash — không lưu token thô
    const row = await db.orm.public.UserSession.where({ userId }).first();
    created.sessions.push(row!.id);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).toBe(sha256Hex(cookieToken));
    expect(row!.tokenHash).not.toBe(cookieToken);
    expect(row!.revokedAt).toBeNull();

    const got = await getSessionFromCookie();
    expect(got).not.toBeNull();
    expect(got!.user.id).toBe(userId);
    expect(got!.user.email).toContain("@integration.test");
    expect(got!.session.id).toBe(row!.id);
    expect(got!.user.sessionId).toBe(row!.id);

    // revoke → request sau null (Review Focus 3)
    await revokeSession(row!.id, "logout");
    const revokedRow = await db.orm.public.UserSession.first({ id: row!.id });
    expect(revokedRow!.revokedAt).not.toBeNull();
    expect(revokedRow!.revokedReason).toBe("logout");
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("revokeAllUserSessions giữ session except, revoke còn lại, trả count", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);

    await createSession(userId); // s1
    const token1 = cookieState.store.get(SESSION_COOKIE)!;
    await createSession(userId); // s2
    const token2 = cookieState.store.get(SESSION_COOKIE)!;
    await createSession(userId); // s3 — cookie hiện tại
    const token3 = cookieState.store.get(SESSION_COOKIE)!;
    const rows = await db.orm.public.UserSession.where({ userId }).all();
    expect(rows).toHaveLength(3);
    rows.forEach((r) => created.sessions.push(r.id));

    const current = await getSessionFromCookie();
    expect(current).not.toBeNull();
    const currentId = current!.session.id;

    const count = await revokeAllUserSessions(userId, "security_rotation", {
      exceptSessionId: currentId,
    });
    expect(count).toBe(2);

    // session bị revoke → token chết
    cookieState.store.set(SESSION_COOKIE, token1);
    expect(await getSessionFromCookie()).toBeNull();
    cookieState.store.set(SESSION_COOKIE, token2);
    expect(await getSessionFromCookie()).toBeNull();
    // session except → vẫn sống
    cookieState.store.set(SESSION_COOKIE, token3);
    const still = await getSessionFromCookie();
    expect(still!.session.id).toBe(currentId);

    // inventory chỉ còn session active
    const inventory = await listUserSessions(userId);
    expect(inventory.map((s) => s.id)).toEqual([currentId]);
  });

  it("revokeAllUserSessions không có except → revoke tất cả, count đúng", async () => {
    const userId = await mkUser("seller");
    created.users.push(userId);
    await createSession(userId);
    await createSession(userId);
    const rows = await db.orm.public.UserSession.where({ userId }).all();
    rows.forEach((r) => created.sessions.push(r.id));

    const count = await revokeAllUserSessions(userId, "password_change");
    expect(count).toBe(2);
    expect(await getSessionFromCookie()).toBeNull();
  });
});

// ─── 3. Expiry boundary ────────────────────────────────────────────────────────

d("expiry boundary trên DB thật", () => {
  it("session quá hạn (expiresAt trong quá khứ) → lookup null", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);
    const token = randomBytes(32).toString("base64url");
    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: sha256Hex(token),
      isAdmin: false,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    created.sessions.push(s.id);
    cookieState.store.set(SESSION_COOKIE, token);
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("boundary: expiresAt đúng bằng now → null (điều kiện <= now)", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);
    const token = randomBytes(32).toString("base64url");
    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: sha256Hex(token),
      isAdmin: false,
      expiresAt: new Date().toISOString(), // đúng now — đã hết hạn theo <=
    });
    created.sessions.push(s.id);
    cookieState.store.set(SESSION_COOKIE, token);
    expect(await getSessionFromCookie()).toBeNull();
  });

  it("session còn hạn → lookup được", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);
    const token = randomBytes(32).toString("base64url");
    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: sha256Hex(token),
      isAdmin: false,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    created.sessions.push(s.id);
    cookieState.store.set(SESSION_COOKIE, token);
    const got = await getSessionFromCookie();
    expect(got).not.toBeNull();
    expect(got!.session.id).toBe(s.id);
  });
});

// ─── 4. TTL theo opts.isAdmin (schema thật) — KHÔNG derive từ adminRole ──────

d("TTL theo opts.isAdmin trên DB thật (review fix #1)", () => {
  it("user thường (adminRole null) → isAdmin false, TTL 30 ngày", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);
    await createSession(userId);
    const row = await db.orm.public.UserSession.where({ userId }).first();
    created.sessions.push(row!.id);
    expect(row!.isAdmin).toBe(false);
    const delta = Date.parse(row!.expiresAt) - Date.parse(row!.createdAt);
    expect(Math.abs(delta - CONSUMER_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
  });

  it("user có adminRole nhưng KHÔNG opts → consumer session (isAdmin false, TTL 30 ngày)", async () => {
    // review fix #1: createSession không derive isAdmin từ adminRole — session
    // admin chỉ tồn tại khi login path đã MFA truyền { isAdmin: true }.
    const userId = await mkUser("admin", "super_admin");
    created.users.push(userId);
    await createSession(userId);
    const row = await db.orm.public.UserSession.where({ userId }).first();
    created.sessions.push(row!.id);
    expect(row!.isAdmin).toBe(false);
    const delta = Date.parse(row!.expiresAt) - Date.parse(row!.createdAt);
    expect(Math.abs(delta - CONSUMER_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
  });

  it("opts.isAdmin=true → isAdmin true, TTL 12 giờ", async () => {
    const userId = await mkUser("admin", "super_admin");
    created.users.push(userId);
    await createSession(userId, { isAdmin: true });
    const row = await db.orm.public.UserSession.where({ userId }).first();
    created.sessions.push(row!.id);
    expect(row!.isAdmin).toBe(true);
    const delta = Date.parse(row!.expiresAt) - Date.parse(row!.createdAt);
    expect(Math.abs(delta - ADMIN_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
  });
});

// ─── 5. touchSessionLastSeen throttle trên DB thật ────────────────────────────

d("touchSessionLastSeen throttle trên DB thật", () => {
  it("null → ghi; fresh → skip; stale → ghi lại", async () => {
    const userId = await mkUser("buyer");
    created.users.push(userId);
    await createSession(userId);
    const row = await db.orm.public.UserSession.where({ userId }).first();
    created.sessions.push(row!.id);
    expect(row!.lastSeenAt).toBeNull();

    // null → ghi ngay
    await touchSessionLastSeen(row!.id);
    const touched1 = await db.orm.public.UserSession.first({ id: row!.id });
    expect(touched1!.lastSeenAt).not.toBeNull();

    // fresh → KHÔNG ghi (giá trị giữ nguyên)
    await touchSessionLastSeen(row!.id);
    const touched2 = await db.orm.public.UserSession.first({ id: row!.id });
    expect(touched2!.lastSeenAt).toBe(touched1!.lastSeenAt);

    // stale 6 phút → ghi lại
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    await db.orm.public.UserSession.where({ id: row!.id }).updateAll({ lastSeenAt: stale });
    await touchSessionLastSeen(row!.id);
    const touched3 = await db.orm.public.UserSession.first({ id: row!.id });
    expect(touched3!.lastSeenAt).not.toBe(stale);
    expect(Date.parse(touched3!.lastSeenAt!)).toBeGreaterThan(Date.parse(stale));
  });
});
