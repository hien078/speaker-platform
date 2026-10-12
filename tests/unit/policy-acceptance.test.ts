/**
 * Policy acceptance guard (terms + privacy) — unit tests (zero-cost launch
 * Task D — founder decision 2026-10-12; Nghị định 13/2023/NĐ-CP explicit
 * consent; cơ chế ghi nhận = Batch 2 PolicyAcceptance, KHÔNG cơ chế thứ hai).
 *
 * Hợp đồng:
 *  1. missingPolicyAcceptances: user thiếu CẢ HAI → ["terms","privacy"];
 *     thiếu MỘT → đúng key đó; đủ → []. Đọc theo version HIỆN HÀNH của
 *     registry (v1) — row cùng key nhưng version khác KHÔNG tính.
 *  2. assertCurrentPoliciesAccepted: thiếu → throw POLICY_ACCEPTANCE_REQUIRED
 *     (typed code — KHÔNG free text); đủ → resolve, KHÔNG throw.
 *  3. Version bump trong registry (founder duyệt + bump — FD-R4 pattern):
 *     row v1 cũ KHÔNG thỏa version v2 mới → guard deny lại (re-accept qua
 *     /account/policies).
 *  4. recordPolicyAcceptance: tạo row (userId, key, version registry) khi
 *     thiếu; ĐÃ CÓ → no-op (idempotent theo @@unique — cơ chế Batch 2).
 *  5. User không tồn tại (không row nào) → thiếu cả hai (fail closed).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + db.client
 * in-memory (PolicyAcceptance) — module THẬT (policy-acceptance.ts) chạy
 * đúng code production đọc store mock. Registry mock RIÊNG cho case version
 * bump (importOriginal + spread — chỉ đổi version của terms).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── db.client mock — in-memory PolicyAcceptance ─────────────────────────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  acceptances: [] as Row[],
}));

vi.mock("@/src/prisma/db.client", () => {
  type Pred = Row;
  const matches = (row: Row, pred: Pred): boolean =>
    Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[]) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit === undefined ? null : { ...hit };
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      create: async (data: Row) => {
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

  return {
    db: {
      orm: { public: { PolicyAcceptance: makeModel(dbState.acceptances) } },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { PolicyAcceptance: makeModel(dbState.acceptances) } } }),
    },
  };
});

import {
  ACCOUNT_POLICY_KEYS,
  POLICY_ACCEPTANCE_REQUIRED_ERROR,
  assertCurrentPoliciesAccepted,
  missingPolicyAcceptances,
  recordPolicyAcceptance,
} from "@/src/lib/policy-acceptance";
import { POLICIES } from "@/src/lib/policy-registry";
import { db } from "@/src/prisma/db.client";

const USER_ID = "user-1";

/** Row chấp nhận theo registry version hiện hành (hoặc version chỉ định). */
const accept = (key: string, version: string): Row => ({
  id: `pa-${key}-${version}`,
  userId: USER_ID,
  policyKey: key,
  policyVersion: version,
  acceptedAt: "2026-10-12T00:00:00.000Z",
});

beforeEach(() => {
  dbState.acceptances.length = 0;
});

// ─── 1-2. missingPolicyAcceptances + assertCurrentPoliciesAccepted ───────────

describe("missingPolicyAcceptances — đọc theo version hiện hành của registry", () => {
  it("user không có row nào → thiếu CẢ HAI (terms, privacy — fail closed)", async () => {
    expect(await missingPolicyAcceptances(USER_ID)).toEqual(["terms", "privacy"]);
  });

  it("thiếu MỘT → đúng key đó", async () => {
    dbState.acceptances.push(accept("terms", POLICIES.terms.version));
    expect(await missingPolicyAcceptances(USER_ID)).toEqual(["privacy"]);
  });

  it("đủ hai row ở version hiện hành → []", async () => {
    dbState.acceptances.push(
      accept("terms", POLICIES.terms.version),
      accept("privacy", POLICIES.privacy.version),
    );
    expect(await missingPolicyAcceptances(USER_ID)).toEqual([]);
  });

  it("row cùng key nhưng KHÁC version (bump cũ) KHÔNG tính — đọc theo registry", async () => {
    dbState.acceptances.push(
      accept("terms", "v0-stale"),
      accept("privacy", POLICIES.privacy.version),
    );
    expect(await missingPolicyAcceptances(USER_ID)).toEqual(["terms"]);
  });

  it("row của user KHÁC không ảnh hưởng (filter userId)", async () => {
    dbState.acceptances.push(
      { ...accept("terms", POLICIES.terms.version), userId: "user-khac" },
      { ...accept("privacy", POLICIES.privacy.version), userId: "user-khac" },
    );
    expect(await missingPolicyAcceptances(USER_ID)).toEqual(["terms", "privacy"]);
  });
});

describe("assertCurrentPoliciesAccepted — typed error POLICY_ACCEPTANCE_REQUIRED", () => {
  it("thiếu → throw đúng typed code (KHÔNG free text)", async () => {
    await expect(assertCurrentPoliciesAccepted(USER_ID)).rejects.toThrow(
      POLICY_ACCEPTANCE_REQUIRED_ERROR,
    );
  });

  it("đủ → resolve, KHÔNG throw", async () => {
    dbState.acceptances.push(
      accept("terms", POLICIES.terms.version),
      accept("privacy", POLICIES.privacy.version),
    );
    await expect(assertCurrentPoliciesAccepted(USER_ID)).resolves.toBeUndefined();
  });
});

// ─── 3. Version bump (FD-R4 pattern — re-accept qua /account/policies) ────────

describe("version bump trong registry → guard deny lại (FD-R4 pattern)", () => {
  beforeEach(() => {
    vi.doMock("@/src/lib/policy-registry", async (importOriginal) => {
      const orig = await importOriginal<typeof import("@/src/lib/policy-registry")>();
      return {
        ...orig,
        // Founder duyệt + bump terms v1 → v2 (commit của founder — như FD-R4
        // cho seller_rules): guard phải đọc version MỚI, row v1 cũ hết hiệu
        // lực → deny lại cho tới khi user re-accept qua /account/policies.
        POLICIES: {
          ...orig.POLICIES,
          terms: { ...orig.POLICIES.terms, version: "v2" },
        },
      };
    });
  });

  it("user đã đồng ý terms v1 + privacy v1 → bump terms v2 → thiếu terms v2 → deny", async () => {
    dbState.acceptances.push(accept("terms", "v1"), accept("privacy", "v1"));
    // Fresh module graph với registry mock (terms v2): resetModules + doMock
    // rồi dynamic import — policy-acceptance.ts đọc POLICIES từ registry nên
    // guard giờ đòi terms@v2 (row v1 cũ hết hiệu lực).
    vi.resetModules();
    const mod = await import("@/src/lib/policy-acceptance");
    expect(await mod.missingPolicyAcceptances(USER_ID)).toEqual(["terms"]);
    await expect(mod.assertCurrentPoliciesAccepted(USER_ID)).rejects.toThrow(
      "POLICY_ACCEPTANCE_REQUIRED",
    );
    // Re-accept terms@v2 (qua /account/policies) → guard pass lại.
    await db.transaction(async (tx) => {
      await mod.recordPolicyAcceptance(tx as never, USER_ID, "terms");
    });
    expect(dbState.acceptances.some((r) => r["policyVersion"] === "v2")).toBe(true);
    await expect(mod.assertCurrentPoliciesAccepted(USER_ID)).resolves.toBeUndefined();
  });

  afterEach(() => {
    vi.doUnmock("@/src/lib/policy-registry");
  });
});

// ─── 4. recordPolicyAcceptance — cơ chế Batch 2, idempotent ──────────────────

describe("recordPolicyAcceptance — ghi nhận trong tx của caller (Batch 2)", () => {
  it("thiếu → tạo row (userId, key, version registry) với acceptedAt default", async () => {
    await db.transaction(async (tx) => {
      await recordPolicyAcceptance(tx as never, USER_ID, "terms");
    });
    expect(dbState.acceptances).toHaveLength(1);
    expect(dbState.acceptances[0]).toMatchObject({
      userId: USER_ID,
      policyKey: "terms",
      policyVersion: POLICIES.terms.version,
    });
  });

  it("ĐÃ CÓ row theo (userId, key, version) → no-op (idempotent — KHÔNG row mới)", async () => {
    dbState.acceptances.push(accept("terms", POLICIES.terms.version));
    await db.transaction(async (tx) => {
      await recordPolicyAcceptance(tx as never, USER_ID, "terms");
    });
    expect(dbState.acceptances).toHaveLength(1);
  });

  it("hai policy (terms + privacy) ghi được trong CÙNG tx", async () => {
    await db.transaction(async (tx) => {
      await recordPolicyAcceptance(tx as never, USER_ID, "terms");
      await recordPolicyAcceptance(tx as never, USER_ID, "privacy");
    });
    expect(
      dbState.acceptances
        .map((r) => `${r["policyKey"]}@${r["policyVersion"]}`)
        .sort(),
    ).toEqual(["privacy@v1", "terms@v1"]);
  });
});

// ─── 5. Hằng số ───────────────────────────────────────────────────────────────

describe("hằng số Task D", () => {
  it("ACCOUNT_POLICY_KEYS = terms + privacy (KHÔNG seller_rules — đó là publication Batch 2)", () => {
    expect(ACCOUNT_POLICY_KEYS).toEqual(["terms", "privacy"]);
  });

  it("typed error code ổn định cho form/test", () => {
    expect(POLICY_ACCEPTANCE_REQUIRED_ERROR).toBe("POLICY_ACCEPTANCE_REQUIRED");
  });
});
