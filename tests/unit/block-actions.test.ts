/**
 * blockUserAction / unblockUserAction — unit tests (Batch 3 plan Task 3,
 * spec §5.5 blocking + §7.1 rate limits).
 *
 * Hợp đồng (plan Task 3 Step 1):
 *  1. blockUserAction tạo row UserBlock ĐỊNH HƯỚNG {blockerId, blockedId};
 *     chặn lại khi đã chặn = no-op thành công (idempotent upsert theo
 *     @@unique [blockerId, blockedId]) — vẫn đúng MỘT row.
 *  2. Chặn chính mình → CANNOT_BLOCK_SELF, không row.
 *  3. Chặn user không tồn tại → NOT_FOUND, không row (không probe oracle).
 *  4. Rate limit 20 block/unblock / phút / user — bucket `block:<userId>`
 *     DÙNG CHUNG cho cả hai action; action thứ 21 → RATE_LIMITED, không
 *     mutation (spec §7.1).
 *  5. unblockUserAction xóa row; bỏ chặn khi chưa chặn = no-op im lặng.
 *  6. Mọi action yêu cầu session — không cookie → redirect /login, không db
 *     write (backend authorization, spec §4.5).
 *  7. Blocking KHÔNG đụng Message/Conversation (spec §5.5 — block không phá
 *     evidence/history) — tripwire spy: zero calls.
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache +
 * next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * (requireUser/getCurrentUser trả SessionUser fixture) + db.client in-memory
 * (User/UserBlock) + Message/Conversation tripwire. rate-limit GIỮ BẢN THẬT
 * (in-memory, resetRateLimits() mỗi test); moderation vocab (BLOCK_ACTION_RATE_LIMIT)
 * qua module thật.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
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

// ─── auth fixture — requireUser/getCurrentUser trả SessionUser (recipe) ──────

type FixtureUser = {
  id: string;
  email: string;
  name: string;
  role: "buyer" | "seller" | "admin";
  avatarUrl: string | null;
  isVerifiedSeller: boolean;
  adminRole: "super_admin" | "operations_admin" | "moderator" | "support" | "analyst" | null;
  sessionId: string;
};

const authState = vi.hoisted(() => ({ user: null as FixtureUser | null }));

vi.mock("@/src/lib/auth", () => ({
  // requireUser KHÔNG bao giờ return khi chưa đăng nhập — redirect throw
  // (đúng chữ ký Batch 2; fixture null mô phỏng "không cookie").
  requireUser: vi.fn(async () => {
    if (authState.user === null) {
      const { redirect } = await import("next/navigation");
      redirect("/login");
    }
    return authState.user!;
  }),
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── db.client mock — in-memory User/UserBlock + tripwire Message/Conversation ─

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  blocks: [] as Array<Record<string, unknown>>,
  messageSpy: undefined as undefined | ReturnType<typeof vi.fn>,
  conversationSpy: undefined as undefined | ReturnType<typeof vi.fn>,
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

  const makeModel = (rows: Row[]) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit === undefined ? null : { ...hit };
      },
      all: async () =>
        rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { id: `row-${rows.length + 1}`, ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      where: (pred: Pred) => query([pred]),
      all: () => query([]).all(),
      create: (data: Row) => query([]).create(data),
    };
  };

  // UserBlock + upsert idempotent theo @@unique [blockerId, blockedId]
  const blockModel = {
    ...makeModel(dbState.blocks),
    upsert: async (input: { create: Row; update: Row; conflictOn?: Row }) => {
      const conflict = input.conflictOn ?? {};
      const existing = dbState.blocks.find((r) =>
        Object.entries(conflict).every(([k, v]) => r[k] === v),
      );
      if (existing !== undefined) {
        Object.assign(existing, input.update);
        return { ...existing };
      }
      const row = { id: `blk-${dbState.blocks.length + 1}`, createdAt: "2026-10-01T00:00:00.000Z", ...input.create };
      dbState.blocks.push(row);
      return { ...row };
    },
  };

  // Tripwire: block/unblock KHÔNG BAO GIỜ đụng Message/Conversation (spec §5.5)
  const tripwire = (name: string) => {
    const spy = vi.fn((): never => {
      throw new Error(`BLOCK_ACTION_TOUCHED_${name}`);
    });
    const model: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of [
      "first", "all", "create", "update", "updateAll", "delete", "deleteAll",
      "where", "include", "orderBy", "limit", "select", "aggregate", "count", "upsert",
    ]) {
      model[m] = spy;
    }
    return { model, spy };
  };
  const message = tripwire("Message");
  const conversation = tripwire("Conversation");
  dbState.messageSpy = message.spy;
  dbState.conversationSpy = conversation.spy;

  return {
    db: {
      orm: {
        public: {
          User: makeModel(dbState.users),
          UserBlock: blockModel,
          Message: message.model,
          Conversation: conversation.model,
        },
      },
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { blockUserAction, unblockUserAction } from "@/src/lib/actions/blocks";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BUYER: FixtureUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "mua@loaviet.test",
  name: "Người Mua",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-buyer",
};

const SELLER: FixtureUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "ban@loaviet.test",
  name: "Người Bán",
  role: "seller",
  avatarUrl: null,
  isVerifiedSeller: true,
  adminRole: null,
  sessionId: "sess-seller",
};

/** uuid hợp lệ nhưng KHÔNG có user — path "target không tồn tại" (không phải path zod). */
const GHOST_ID = "33333333-3333-4333-8333-333333333333";

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const seedUsers = (): void => {
  dbState.users.length = 0;
  dbState.blocks.length = 0;
  dbState.users.push({ ...BUYER }, { ...SELLER });
};

beforeEach(() => {
  resetRateLimits();
  seedUsers();
  authState.user = { ...BUYER };
});

// ─── 1. Directional row + idempotent upsert ──────────────────────────────────

describe("blockUserAction — row định hướng + idempotent", () => {
  it("tạo row {blockerId, blockedId}; chặn lại = vẫn đúng MỘT row (no-op thành công)", async () => {
    await blockUserAction(fd({ userId: SELLER.id }));

    expect(dbState.blocks.length).toBe(1);
    expect(dbState.blocks[0]).toMatchObject({
      blockerId: BUYER.id,
      blockedId: SELLER.id,
    });

    // chặn lại khi đã chặn — idempotent upsert, không throw, không row thứ hai
    await blockUserAction(fd({ userId: SELLER.id }));
    expect(dbState.blocks.length).toBe(1);
    expect(dbState.blocks[0]).toMatchObject({ blockerId: BUYER.id, blockedId: SELLER.id });
  });

  it("chặn từ người khác là row RIÊNG (dữ liệu định hướng — không phải tập hợp đối xứng)", async () => {
    authState.user = { ...SELLER };
    await blockUserAction(fd({ userId: BUYER.id }));
    expect(dbState.blocks.length).toBe(1);
    expect(dbState.blocks[0]).toMatchObject({ blockerId: SELLER.id, blockedId: BUYER.id });
  });
});

// ─── 2/3. Self + nonexistent target ──────────────────────────────────────────

describe("blockUserAction — chặn chính mình / target không tồn tại", () => {
  it("userId === user.id → CANNOT_BLOCK_SELF, không row (form giả mạo cũng bị chặn)", async () => {
    await expect(blockUserAction(fd({ userId: BUYER.id }))).rejects.toThrow("CANNOT_BLOCK_SELF");
    expect(dbState.blocks.length).toBe(0);
  });

  it("target không tồn tại → NOT_FOUND, không row", async () => {
    await expect(blockUserAction(fd({ userId: GHOST_ID }))).rejects.toThrow("NOT_FOUND");
    expect(dbState.blocks.length).toBe(0);
  });

  it("userId không phải uuid → NOT_FOUND (fail closed — không leak gì khác)", async () => {
    await expect(blockUserAction(fd({ userId: "khong-phai-uuid" }))).rejects.toThrow("NOT_FOUND");
    expect(dbState.blocks.length).toBe(0);
  });
});

// ─── 4. Rate limit — bucket chung block/unblock (spec §7.1) ───────────────────

describe("block/unblock rate limit — 20/phút, bucket DÙNG CHUNG", () => {
  it("action thứ 21 trong một phút → RATE_LIMITED, không mutation", async () => {
    // 20 action đầu (block idempotent) — đều được phép
    for (let i = 0; i < 20; i++) {
      await blockUserAction(fd({ userId: SELLER.id }));
    }
    expect(dbState.blocks.length).toBe(1);

    // action thứ 21 — UNBLOCK dùng cùng bucket `block:<userId>` → RATE_LIMITED,
    // row vẫn còn (denial xảy ra TRƯỚC mutation)
    await expect(unblockUserAction(fd({ userId: SELLER.id }))).rejects.toThrow("RATE_LIMITED");
    expect(dbState.blocks.length).toBe(1);
    expect(dbState.blocks[0]).toMatchObject({ blockerId: BUYER.id, blockedId: SELLER.id });
  });
});

// ─── 5. Unblock — xóa row + no-op im lặng ─────────────────────────────────────

describe("unblockUserAction — xóa row theo hướng blocker", () => {
  it("xóa đúng row của mình; bỏ chặn khi chưa chặn = no-op im lặng", async () => {
    await blockUserAction(fd({ userId: SELLER.id }));
    expect(dbState.blocks.length).toBe(1);

    await unblockUserAction(fd({ userId: SELLER.id }));
    expect(dbState.blocks.length).toBe(0);

    // chưa chặn — vẫn thành công (idempotent), không throw
    await unblockUserAction(fd({ userId: SELLER.id }));
    expect(dbState.blocks.length).toBe(0);
  });

  it("chỉ xóa row CỦA MÌNH — block của người khác không bị đụng", async () => {
    dbState.blocks.push({
      id: "blk-seller-buyer",
      blockerId: SELLER.id,
      blockedId: BUYER.id,
      createdAt: "2026-10-01T00:00:00.000Z",
    });

    await unblockUserAction(fd({ userId: SELLER.id }));
    // row seller→buyer vẫn còn — viewer không thể bỏ chặn block của người khác
    expect(dbState.blocks.length).toBe(1);
    expect(dbState.blocks[0]).toMatchObject({ blockerId: SELLER.id, blockedId: BUYER.id });
  });
});

// ─── 6. Backend authorization — session bắt buộc (spec §4.5) ─────────────────

describe("backend authorization — mọi action yêu cầu session", () => {
  it("không session → redirect /login, KHÔNG db write (form giả mạo không giúp gì)", async () => {
    authState.user = null;

    await expect(blockUserAction(fd({ userId: SELLER.id }))).rejects.toThrow("NEXT_REDIRECT:/login");
    await expect(unblockUserAction(fd({ userId: SELLER.id }))).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(dbState.blocks.length).toBe(0);
    expect(dbState.messageSpy).not.toHaveBeenCalled();
    expect(dbState.conversationSpy).not.toHaveBeenCalled();
  });
});

// ─── 7. Blocking không phá evidence/history (spec §5.5) ───────────────────────

describe("blocking không đụng Message/Conversation (spec §5.5)", () => {
  it("block + unblock → ZERO call trên Message/Conversation", async () => {
    await blockUserAction(fd({ userId: SELLER.id }));
    await unblockUserAction(fd({ userId: SELLER.id }));

    expect(dbState.messageSpy).not.toHaveBeenCalled();
    expect(dbState.conversationSpy).not.toHaveBeenCalled();
  });
});
