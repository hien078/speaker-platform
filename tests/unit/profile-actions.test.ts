/**
 * updateProfileAction — unit tests (Batch 2 Task 6 review fix: profile phone
 * handling). Trước fix: profile cho đổi phone ĐÃ verified (bỏ badge âm thầm),
 * check-then-write race, lưu raw không chuẩn hóa.
 *
 * Hợp đồng sau review fix:
 *  1. (HIGH) Phone ĐÃ verified + số KHÁC → typed PHONE_VERIFIED_CHANGE_REQUIRED
 *     (trỏ sang change flow — mật khẩu + OTP); KHÔNG mutation. Đổi phone
 *     CHƯA verified vẫn được (UX thêm số lần đầu).
 *  2. (MEDIUM) Update atomic: CAS `where({ id, phone: <giá trị đã đọc> })` —
 *     phone đổi giữa read và write (request song song) → 0 row → typed
 *     PHONE_CONCURRENT_CHANGE, không mutation.
 *  3. (LOW) Lưu phone NORMALIZED (normalizePhone — thay regex cũ
 *     ^0\d{8,9}$); sai format → lỗi, không mutation.
 *  4. Regression: name/city/bio update bình thường; phone giữ nguyên chuỗi →
 *     KHÔNG reset phoneVerifiedAt.
 *
 * Cơ chế mock: `server-only` + `next/cache` + `next/navigation` +
 * `@/src/lib/session` (getSessionFromCookie fixture) + `@/src/prisma/db.client`
 * (in-memory User; hook afterUserRead mô phỏng race). normalizePhone GIỮ BẢN
 * THẬT từ src/lib/otp.ts (Task 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
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

// db mock — User model + hook afterUserRead (mô phỏng concurrent write giữa
// read và update của action — cho test CAS)
const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  afterUserRead: null as (() => void) | null,
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

  const query = (preds: Pred[]) => ({
    where: (pred: Pred) => query([...preds, pred]),
    first: async (filter?: Pred) => {
      const all = [...preds, ...(filter ? [filter] : [])];
      const hits = dbState.users.filter((r) => all.every((p) => matches(r, p)));
      const hit = hits.length === 0 ? null : { ...hits[0]! };
      // hook race: chạy SAU khi action đã đọc row — mô phỏng request song song
      // ghi phone giữa read và update
      dbState.afterUserRead?.();
      return hit;
    },
    update: async (data: Row) => {
      const hits = dbState.users.filter((r) => preds.every((p) => matches(r, p)));
      if (hits.length === 0) return null;
      Object.assign(hits[0]!, data);
      return { ...hits[0]! };
    },
    updateAll: async (data: Row) => {
      const hits = dbState.users.filter((r) => preds.every((p) => matches(r, p)));
      for (const r of hits) Object.assign(r, data);
      return hits.map((r) => ({ ...r }));
    },
    create: async (data: Row) => {
      const row = { id: `user-${dbState.users.length + 1}`, ...data };
      dbState.users.push(row);
      return { ...row };
    },
  });

  return {
    db: {
      orm: { public: { User: { first: (filter?: Pred) => query([]).first(filter), where: (p: Pred) => query([p]), create: (d: Row) => query([]).create(d) } } },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { User: { where: (p: Pred) => query([p]) } } } }),
    },
  };
});

import { updateProfileAction } from "@/src/lib/actions/profile";

type Row = Record<string, unknown>;

const mkUser = (over: Partial<Row>): Row => ({
  id: "user-1",
  email: "mua@loaviet.test",
  passwordHash: "x",
  name: "Người Mua",
  role: "buyer",
  avatarUrl: null,
  phone: null,
  city: null,
  bio: null,
  isVerifiedSeller: false,
  adminRole: null,
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  ...over,
});

const login = (user: Row): void => {
  sessionState.current = {
    session: { id: "sess-1", userId: user.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: null,
      isVerifiedSeller: false,
      adminRole: null,
      sessionId: "sess-1",
    },
  };
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
  dbState.afterUserRead = null;
  dbState.users.push(mkUser({}));
  login(dbState.users[0]!);
});

afterEach(() => {
  vi.unstubAllEnvs();
  dbState.afterUserRead = null;
});

describe("updateProfileAction — phone & verified state (review fix)", () => {
  it("đổi phone CHƯA verified → lưu NORMALIZED + reset phoneVerifiedAt", async () => {
    dbState.users[0]!.phone = "0900000001";
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua", phone: "090 123 4567", city: "Hà Nội", bio: "" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBe("0901234567"); // normalized (fix LOW #7)
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
  });

  it("nhập +84 → chuẩn hóa về 0… (normalizePhone)", async () => {
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua", phone: "+84 901 234 567", city: "", bio: "" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBe("0901234567");
  });

  it("sai format → lỗi, không mutation (normalizePhone throw)", async () => {
    dbState.users[0]!.phone = "0900000001";
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua", phone: "12345", city: "", bio: "" }),
    );
    expect(state.error).toBeTruthy();
    expect(dbState.users[0]!.phone).toBe("0900000001"); // giữ nguyên
  });

  it("phone ĐÃ verified + số KHÁC → PHONE_VERIFIED_CHANGE_REQUIRED, không mutation (fix HIGH)", async () => {
    dbState.users[0]!.phone = "0901234567";
    dbState.users[0]!.phoneVerifiedAt = "2026-10-01T00:00:00.000Z";
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua", phone: "0909999888", city: "", bio: "" }),
    );
    expect((state as { code?: string }).code).toBe("PHONE_VERIFIED_CHANGE_REQUIRED");
    expect(state.error).toMatch(/Đổi số điện thoại/); // trỏ sang change flow
    expect(dbState.users[0]!.phone).toBe("0901234567"); // KHÔNG mutation
    expect(dbState.users[0]!.phoneVerifiedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("phone ĐÃ verified + CÙNG SỐ (viết khác định dạng) → OK, GIỮ phoneVerifiedAt", async () => {
    dbState.users[0]!.phone = "0901234567";
    dbState.users[0]!.phoneVerifiedAt = "2026-10-01T00:00:00.000Z";
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua Mới", phone: "090 123 4567", city: "", bio: "" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.name).toBe("Người Mua Mới");
    expect(dbState.users[0]!.phone).toBe("0901234567");
    expect(dbState.users[0]!.phoneVerifiedAt).toBe("2026-10-01T00:00:00.000Z"); // giữ verified
  });

  it("xóa phone (để trống) khi CHƯA verified → phone null, verifiedAt null", async () => {
    dbState.users[0]!.phone = "0900000001";
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua", phone: "", city: "", bio: "" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.phone).toBeNull();
    expect(dbState.users[0]!.phoneVerifiedAt).toBeNull();
  });

  it("CAS race: phone đổi GIỮA read và update → PHONE_CONCURRENT_CHANGE, không mutation (fix MEDIUM #2)", async () => {
    dbState.users[0]!.phone = "0900000001";
    // request song song đổi phone ngay SAU khi action đọc row
    dbState.afterUserRead = () => {
      dbState.users[0]!.phone = "0909999888";
    };
    const state = await updateProfileAction(
      {},
      fd({ name: "Người Mua", phone: "090 123 4567", city: "", bio: "" }),
    );
    expect((state as { code?: string }).code).toBe("PHONE_CONCURRENT_CHANGE");
    expect(dbState.users[0]!.phone).toBe("0909999888"); // giá trị concurrent thắng — không bị clobber
    expect(dbState.users[0]!.name).toBe("Người Mua"); // giữ nguyên
  });

  it("regression: name/city/bio update bình thường khi phone giữ nguyên chuỗi → không reset verifiedAt", async () => {
    dbState.users[0]!.phone = "0901234567";
    dbState.users[0]!.phoneVerifiedAt = "2026-10-01T00:00:00.000Z";
    const state = await updateProfileAction(
      {},
      fd({ name: "Tên Mới", phone: "0901234567", city: "Đà Nẵng", bio: "giới thiệu" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.users[0]!.name).toBe("Tên Mới");
    expect(dbState.users[0]!.city).toBe("Đà Nẵng");
    expect(dbState.users[0]!.bio).toBe("giới thiệu");
    expect(dbState.users[0]!.phoneVerifiedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});
