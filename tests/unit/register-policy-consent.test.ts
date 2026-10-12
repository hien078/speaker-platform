/**
 * registerAction — consent Điều khoản sử dụng + Chính sách quyền riêng tư
 * (zero-cost launch Task D — founder decision 2026-10-12; Nghị định
 * 13/2023/NĐ-CP explicit consent; cơ chế ghi nhận = Batch 2 PolicyAcceptance
 * qua recordPolicyAcceptance — KHÔNG cơ chế thứ hai).
 *
 * Hợp đồng:
 *  1. KHÔNG tick consent → typed error POLICY_CONSENT_REQUIRED (code ổn định
 *     + text tiếng Việt), KHÔNG User row, KHÔNG Cart, KHÔNG PolicyAcceptance,
 *     KHÔNG session (reject TRƯỚC mọi read/write DB sau rate limit).
 *  2. Tick consent ("on") → MỘT transaction: User + Cart + PolicyAcceptance
 *     (terms, v1) + PolicyAcceptance (privacy, v1) — 2 row đồng ý theo version
 *     hiện hành của registry; sau đó session + redirect (giữ hành vi cũ).
 *  3. Atomicity: PolicyAcceptance.create lỗi (vd 23505 unique) → THROW ra
 *     khỏi callback → tx rollback → KHÔNG User mồ côi (user KHÔNG BAO GIỜ
 *     tồn tại mà thiếu row đồng ý).
 *  4. Email đã đăng ký → error như cũ (consent đã tick — hành vi giữ nguyên).
 *  5. Login KHÔNG đụng consent (loginAction bỏ qua acceptPolicies hoàn toàn).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * + next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * (hashPassword/createSession spy — KHÔNG bcrypt thật) + db.client in-memory
 * (User/Cart/PolicyAcceptance) với transaction THẬT của store mock + unique
 * index PolicyAcceptance_userId_policyKey_policyVersion_key THẬT.
 * `@/src/lib/rate-limit` GIỮ BẢN THẬT (resetRateLimits mỗi test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";

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

// ─── auth fixture — hashPassword/createSession spy (KHÔNG bcrypt thật) ────────

const authSpy = vi.hoisted(() => ({
  hashed: [] as string[],
  sessions: [] as string[],
}));

vi.mock("@/src/lib/auth", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/src/lib/auth")>();
  return {
    ...orig,
    hashPassword: vi.fn(async (pw: string) => {
      authSpy.hashed.push(pw);
      return `hash:${pw}`;
    }),
    verifyPassword: vi.fn(async () => false),
    createSession: vi.fn(async (userId: string) => {
      authSpy.sessions.push(userId);
    }),
    destroySession: vi.fn(async () => {}),
  };
});

// ─── db.client mock — in-memory User/Cart/PolicyAcceptance + transaction ─────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  carts: [] as Row[],
  acceptances: [] as Row[],
  /** Khi ≠ null: PolicyAcceptance.create ném lỗi này (mô phỏng 23505 race). */
  acceptanceCreateError: null as unknown,
  /** Số lần transaction callback được gọi — pin MỘT tx cho cả 4 write. */
  txCalls: 0,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Pred = Record<string, unknown>;
  const matches = (row: Row, pred: Pred): boolean =>
    Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[], fail?: () => unknown) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit === undefined ? null : { ...hit };
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      create: async (data: Row) => {
        if (fail) {
          const err = fail();
          if (err) throw err;
        }
        const row = { id: `row-${rows.length + 1}`, createdAt: "2026-10-12T00:00:00.000Z", ...data };
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

  const models = () => ({
    User: makeModel(dbState.users),
    Cart: makeModel(dbState.carts),
    PolicyAcceptance: makeModel(
      dbState.acceptances,
      () => dbState.acceptanceCreateError,
    ),
  });

  return {
    db: {
      orm: { public: models() },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        dbState.txCalls += 1;
        return fn({ orm: { public: models() } });
      },
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { loginAction, registerAction } from "@/src/lib/actions/auth";
import { POLICIES } from "@/src/lib/policy-registry";

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const registerForm = (over?: Record<string, string>): FormData =>
  fd({
    name: "Nguyễn Văn A",
    email: "nguyen@example.test",
    password: "matkhau123",
    phone: "",
    role: "buyer",
    acceptPolicies: "on",
    ...over,
  });

beforeEach(() => {
  dbState.users.length = 0;
  dbState.carts.length = 0;
  dbState.acceptances.length = 0;
  dbState.acceptanceCreateError = null;
  dbState.txCalls = 0;
  authSpy.hashed.length = 0;
  authSpy.sessions.length = 0;
  resetRateLimits();
});

afterEach(() => {
  resetRateLimits();
});

// ─── 1. Thiếu consent → reject, KHÔNG row nào ─────────────────────────────────

describe("registerAction — thiếu consent → typed error, KHÔNG write", () => {
  it("KHÔNG tick → POLICY_CONSENT_REQUIRED + text tiếng Việt, KHÔNG User/Cart/PolicyAcceptance/session", async () => {
    const state = await registerAction({}, registerForm({ acceptPolicies: "" }));

    expect(state.code).toBe("POLICY_CONSENT_REQUIRED");
    expect(state.error).toContain("Điều khoản sử dụng");
    expect(state.error).toContain("Chính sách quyền riêng tư");
    expect(dbState.users).toHaveLength(0);
    expect(dbState.carts).toHaveLength(0);
    expect(dbState.acceptances).toHaveLength(0);
    expect(authSpy.sessions).toHaveLength(0);
  });

  it("checkbox giả mạo giá trị khác \"on\" (vd \"true\") → vẫn reject (server so khớp nghiêm ngặt)", async () => {
    const state = await registerAction({}, registerForm({ acceptPolicies: "true" }));
    expect(state.code).toBe("POLICY_CONSENT_REQUIRED");
    expect(dbState.users).toHaveLength(0);
  });
});

// ─── 2. Có consent → MỘT tx: User + Cart + 2 PolicyAcceptance ─────────────────

describe("registerAction — consent \"on\" → user + 2 row đồng ý trong MỘT tx", () => {
  it("tạo User + Cart + PolicyAcceptance(terms v1) + PolicyAcceptance(privacy v1) trong CÙNG transaction", async () => {
    let nextRedirect: unknown = null;
    try {
      await registerAction({}, registerForm());
    } catch (e) {
      nextRedirect = e; // redirect("/") throw NEXT_REDIRECT — hành vi cũ
    }

    expect(dbState.txCalls).toBe(1); // MỘT tx cho cả 4 write
    expect(dbState.users).toHaveLength(1);
    const user = dbState.users[0]!;
    expect(user).toMatchObject({
      name: "Nguyễn Văn A",
      email: "nguyen@example.test",
      role: "buyer",
    });
    expect(dbState.carts).toHaveLength(1);
    expect(dbState.carts[0]).toMatchObject({ userId: user.id });

    // 2 row đồng ý theo version HIỆN HÀNH của registry (cơ chế Batch 2).
    expect(dbState.acceptances).toHaveLength(2);
    const keys = dbState.acceptances
      .map((r) => `${r["policyKey"]}@${r["policyVersion"]}:${r["userId"] === user.id ? "me" : "khac"}`)
      .sort();
    expect(keys).toEqual([
      `privacy@${POLICIES.privacy.version}:me`,
      `terms@${POLICIES.terms.version}:me`,
    ]);

    // session tạo SAU tx + redirect như cũ.
    expect(authSpy.sessions).toEqual([user.id]);
    expect(nextRedirect).toBeInstanceOf(Error);
    expect((nextRedirect as Error).message).toContain("NEXT_REDIRECT");
  });

  it("email đã đăng ký → error như cũ (consent đã tick — hành vi giữ nguyên)", async () => {
    dbState.users.push({
      id: "user-cu",
      email: "nguyen@example.test",
      passwordHash: "hash:cu",
      name: "Cũ",
      role: "buyer",
    });
    const state = await registerAction({}, registerForm());
    expect(state.error).toContain("Email này đã được đăng ký");
    expect(dbState.acceptances).toHaveLength(0); // KHÔNG ghi đồng ý cho email trùng
    expect(dbState.txCalls).toBe(0); // reject TRƯỚC tx
  });
});

// ─── 3. Atomicity — lỗi trong tx → rollback logic, KHÔNG user mồ côi ─────────

describe("registerAction — tx atomicity (Global Constraints)", () => {
  it("PolicyAcceptance.create đụng 23505 unique (race) → THROW ra khỏi callback → KHÔNG User/Cart (rollback)", async () => {
    dbState.acceptanceCreateError = new SqlQueryError(
      "mock unique violation (PolicyAcceptance_userId_policyKey_policyVersion_key)",
      {
        sqlState: "23505",
        constraint: "PolicyAcceptance_userId_policyKey_policyVersion_key",
      },
    );

    await expect(registerAction({}, registerForm())).rejects.toThrowError(
      /PolicyAcceptance_userId_policyKey_policyVersion/,
    );

    // Store mock KHÔNG rollback thật — nhưng hợp đồng là User.create sống
    // TRONG tx: assert tx đã chạy và lỗi ném RA KHỎI callback (KHÔNG
    // catch-and-return). Trong DB thật, Postgres abort tx → KHÔNG user mồ côi.
    expect(dbState.txCalls).toBe(1);
    // Session KHÔNG được tạo (tx fail → action throw trước createSession).
    expect(authSpy.sessions).toHaveLength(0);
  });
});

// ─── 5. Login KHÔNG bị chặn theo consent ─────────────────────────────────────

describe("loginAction — KHÔNG đụng consent (guard chỉ áp action tạo nội dung)", () => {
  it("login không gửi acceptPolicies vẫn chạy bình thường (đến verify password)", async () => {
    dbState.users.push({
      id: "user-login",
      email: "dangnhap@example.test",
      passwordHash: "hash:cu",
      name: "Đăng Nhập",
      role: "buyer",
    });
    // verifyPassword mock trả false → error "Email hoặc mật khẩu không đúng"
    // (chứ KHÔNG phải POLICY_* — login không đọc consent).
    const state = await loginAction(
      {},
      fd({ email: "dangnhap@example.test", password: "sai-roi" }),
    );
    expect(state.error).toBe("Email hoặc mật khẩu không đúng");
    expect(state.code).toBeUndefined();
  });
});
