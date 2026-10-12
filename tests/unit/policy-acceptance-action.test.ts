/**
 * acceptCurrentPoliciesAction (/account/policies) — unit tests (zero-cost
 * launch Task D — founder decision 2026-10-12). Cơ chế ghi nhận = Batch 2
 * PolicyAcceptance qua recordPolicyAcceptance; idempotent theo
 * @@unique(userId, policyKey, policyVersion); constraint violation classify
 * NGOÀI tx theo constraint name (Global Constraints).
 *
 * Hợp đồng:
 *  1. Chưa đăng nhập → redirect /login (requireUser), KHÔNG read/write.
 *  2. Thiếu checkbox → typed error POLICY_CONSENT_REQUIRED, KHÔNG row.
 *  3. Thiếu cả hai → MỘT tx tạo PolicyAcceptance(terms v1) + (privacy v1)
 *     theo version hiện hành của registry + revalidatePath + success.
 *  4. Idempotent: đã đủ → success KHÔNG tx, KHÔNG row mới.
 *  5. Thiếu MỘT (vd privacy) → chỉ tạo key còn thiếu.
 *  6. Concurrent double-accept: 23505 PolicyAcceptance_userId_policyKey_
 *     policyVersion_key → classify NGOÀI tx → success idempotent (row của
 *     request thắng đã tồn tại); 23505 constraint KHÁC → rethrow (fail
 *     closed — KHÔNG map mù mọi 23505).
 *  7. Lỗi infra (53300) → rethrow (KHÔNG masquerade thành form error).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * spy + next/navigation (redirect throw) + next/headers + `@/src/lib/auth`
 * fixture + db.client in-memory (PolicyAcceptance) với transaction + unique
 * index THẬT của PolicyAcceptance (mô phỏng race 23505 qua fail hook).
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

// ─── auth fixture — requireUser/getCurrentUser trả SessionUser (recipe) ──────

type FixtureUser = {
  id: string;
  email: string;
  name: string;
  role: "buyer" | "seller" | "admin";
  avatarUrl: string | null;
  isVerifiedSeller: boolean;
  adminRole: string | null;
  sessionId: string;
};

const authState = vi.hoisted(() => ({ user: null as FixtureUser | null }));

vi.mock("@/src/lib/auth", () => ({
  requireUser: vi.fn(async () => {
    if (authState.user === null) {
      const { redirect } = await import("next/navigation");
      redirect("/login");
    }
    return authState.user!;
  }),
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── db.client mock — in-memory PolicyAcceptance + transaction ───────────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  acceptances: [] as Row[],
  /** Khi ≠ null: PolicyAcceptance.create (TRONG tx) ném lỗi này — mô phỏng race. */
  acceptanceCreateError: null as unknown,
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
        const row = { id: `pa-${rows.length + 1}`, acceptedAt: "2026-10-12T00:00:00.000Z", ...data };
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
    PolicyAcceptance: makeModel(dbState.acceptances, () => dbState.acceptanceCreateError),
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

import { revalidatePath } from "next/cache";
import { acceptCurrentPoliciesAction } from "@/src/lib/actions/policy-acceptance";
import { POLICIES } from "@/src/lib/policy-registry";

const USER: FixtureUser = {
  id: "user-acc",
  email: "dongy@example.test",
  name: "Người Dùng Hiện Có",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-acc",
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const acceptForm = (): FormData => fd({ acceptPolicies: "on" });

/** Row đồng ý theo version registry hiện hành. */
const acceptRow = (key: string): Row => ({
  id: `pa-${key}`,
  userId: USER.id,
  policyKey: key,
  policyVersion: POLICIES[key as "terms" | "privacy"].version,
  acceptedAt: "2026-10-12T00:00:00.000Z",
});

beforeEach(() => {
  dbState.acceptances.length = 0;
  dbState.acceptanceCreateError = null;
  dbState.txCalls = 0;
  authState.user = { ...USER };
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => {
  vi.mocked(revalidatePath).mockRestore?.();
});

// ─── 1-2. Auth + consent checkbox ─────────────────────────────────────────────

describe("acceptCurrentPoliciesAction — auth + consent", () => {
  it("chưa đăng nhập → redirect /login, KHÔNG read/write (txCalls = 0)", async () => {
    authState.user = null;
    await expect(acceptCurrentPoliciesAction({}, acceptForm())).rejects.toThrow(
      "NEXT_REDIRECT:/login",
    );
    expect(dbState.txCalls).toBe(0);
    expect(dbState.acceptances).toHaveLength(0);
  });

  it("thiếu checkbox → typed error POLICY_CONSENT_REQUIRED, KHÔNG row, KHÔNG tx", async () => {
    const state = await acceptCurrentPoliciesAction({}, fd({}));
    expect(state.code).toBe("POLICY_CONSENT_REQUIRED");
    expect(state.error).toContain("đồng ý");
    expect(dbState.txCalls).toBe(0);
    expect(dbState.acceptances).toHaveLength(0);
  });
});

// ─── 3-5. Ghi nhận theo missing — idempotent ─────────────────────────────────

describe("acceptCurrentPoliciesAction — ghi nhận idempotent", () => {
  it("thiếu cả hai → MỘT tx tạo terms + privacy theo version registry + revalidate + success", async () => {
    const state = await acceptCurrentPoliciesAction({}, acceptForm());

    expect(state.success).toBeTruthy();
    expect(state.error).toBeUndefined();
    expect(dbState.txCalls).toBe(1);
    expect(
      dbState.acceptances
        .map((r) => `${r["policyKey"]}@${r["policyVersion"]}:${r["userId"]}`)
        .sort(),
    ).toEqual([
      `privacy@${POLICIES.privacy.version}:${USER.id}`,
      `terms@${POLICIES.terms.version}:${USER.id}`,
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/account/policies");
  });

  it("đã đủ → success idempotent, KHÔNG tx, KHÔNG row mới", async () => {
    dbState.acceptances.push(acceptRow("terms"), acceptRow("privacy"));
    const state = await acceptCurrentPoliciesAction({}, acceptForm());

    expect(state.success).toBeTruthy();
    expect(dbState.txCalls).toBe(0);
    expect(dbState.acceptances).toHaveLength(2);
  });

  it("thiếu MỘT (privacy) → chỉ tạo key còn thiếu (terms giữ nguyên row cũ)", async () => {
    dbState.acceptances.push(acceptRow("terms"));
    await acceptCurrentPoliciesAction({}, acceptForm());

    expect(dbState.txCalls).toBe(1);
    expect(dbState.acceptances).toHaveLength(2);
    expect(dbState.acceptances.filter((r) => r["policyKey"] === "terms")).toHaveLength(1);
    expect(dbState.acceptances.filter((r) => r["policyKey"] === "privacy")).toHaveLength(1);
  });
});

// ─── 6-7. Constraint classification NGOÀI tx (Global Constraints) ───────────

describe("acceptCurrentPoliciesAction — 23505 classify NGOÀI tx theo constraint name", () => {
  it("race concurrent double-accept (unique PolicyAcceptance) → success idempotent (row của request thắng đã tồn tại)", async () => {
    dbState.acceptanceCreateError = new SqlQueryError(
      "mock unique violation (PolicyAcceptance_userId_policyKey_policyVersion_key)",
      {
        sqlState: "23505",
        constraint: "PolicyAcceptance_userId_policyKey_policyVersion_key",
      },
    );
    const state = await acceptCurrentPoliciesAction({}, acceptForm());

    // KHÔNG masquerade thành lỗi — trạng thái cuối của DB = đã đồng ý.
    expect(state.success).toBeTruthy();
    expect(state.error).toBeUndefined();
  });

  it("23505 constraint KHÁC → rethrow (fail closed — KHÔNG map mù mọi 23505)", async () => {
    dbState.acceptanceCreateError = new SqlQueryError("mock other unique violation", {
      sqlState: "23505",
      constraint: "Deal_one_open_per_listing_buyer_77dfd57d",
    });
    await expect(acceptCurrentPoliciesAction({}, acceptForm())).rejects.toThrowError(
      /other unique/,
    );
  });

  it("lỗi infra (53300) → rethrow (KHÔNG masquerade thành form error)", async () => {
    dbState.acceptanceCreateError = new SqlQueryError("mock read failed", { sqlState: "53300" });
    await expect(acceptCurrentPoliciesAction({}, acceptForm())).rejects.toThrowError(/read failed/);
  });
});
