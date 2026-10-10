/**
 * Buyer beta access policy — unit tests (Batch 7 plan Task 6, spec §2.1
 * "Private Beta Access Model" + §7.8 beta-membership status + §4.9
 * private-beta authorization; corrections 2026-10-08 item 16).
 *
 * Hợp đồng (plan Task 6 Step 1):
 *  1. isActiveBetaParticipant: active founding_seller → true; active
 *     private_beta_buyer → true; active internal → true (mọi cohort trong
 *     BETA_CHAT_ALLOWED_COHORTS).
 *  2. isActiveBetaParticipant: suspended founding_seller → false; exited →
 *     false; invited (chưa accept) → false; KHÔNG có membership → false
 *     (§7.8 fresh read — suspended/exited phải chặn NGAY).
 *  3. isActiveBetaParticipant: membership active nhưng cohort NGOÀI
 *     BETA_CHAT_ALLOWED_COHORTS → false (giá trị cohort tương lai fail closed
 *     cho tới khi được allowlist — §4.9/§4.11 non-invention).
 *  4. isActiveBetaParticipant: membership active nhưng expiresAt ĐÃ QUA →
 *     false (corrections #16 — cùng isMembershipActive semantics của Batch 2
 *     seller-verification-policy; hết hạn = inactive).
 *  5. assertBuyerBetaChatAccess: non-participant → throw
 *     BETA_MEMBERSHIP_REQUIRED; participant → resolve (no-op).
 *  6. BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP === true — D3/S8 fail-closed
 *     reading của §2.1 "P0 should support restricting … IF OPERATIONS
 *     REQUIRES" (private beta LÀ cohort có kiểm soát — §2.1 opening).
 *     Pin: đảo giá trị = product decision qua code review (Batch 8 register),
 *     KHÔNG qua request/env.
 *  7. Source-contract: beta-access.ts là plain server module — `server-only`
 *     present, KHÔNG "use server" (B2 hygiene; "use server" chỉ dành cho
 *     action file — E352).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + db.client
 * in-memory CHỈ BetaCohortMembership (module không đọc model nào khác —
 * corrections #31 import-graph pin: chỉ server-only + db.client).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ─── db.client mock — in-memory BetaCohortMembership (object predicates) ─────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  memberships: [] as Row[],
}));

vi.mock("@/src/prisma/db.client", () => {
  type Pred = Row;

  const matches = (row: Row, pred: Pred): boolean =>
    Object.entries(pred).every(([k, v]) => row[k] === v);

  const query = (preds: Pred[]) => ({
    where: (pred: Pred) => query([...preds, pred]),
    all: async () => dbState.memberships.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
    first: async () => {
      const hit = dbState.memberships.find((r) => preds.every((p) => matches(r, p)));
      return hit === undefined ? null : { ...hit };
    },
  });

  return {
    db: {
      orm: {
        public: {
          // plain-object where ONLY (corrections #16 — mọi unit mock hỗ trợ
          // object predicate; isActiveBetaParticipant không dùng closure op)
          BetaCohortMembership: {
            where: (pred: Pred) => query([pred]),
            first: (pred: Pred) => query([pred]).first(),
            all: () => query([]).all(),
          },
        },
      },
    },
  };
});

import {
  BETA_CHAT_ALLOWED_COHORTS,
  BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP,
  assertBuyerBetaChatAccess,
  isActiveBetaParticipant,
} from "@/src/lib/beta-access";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";

/** Row BetaCohortMembership — Batch 2 shape (contract.prisma). */
const membership = (over: Row = {}): Row => ({
  id: `bcm-${dbState.memberships.length + 1}`,
  userId: USER,
  cohort: "private_beta_buyer",
  status: "active",
  invitedBy: null,
  invitedAt: null,
  acceptedAt: null,
  expiresAt: null,
  notes: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  dbState.memberships.length = 0;
});

// ─── isActiveBetaParticipant — cohort allowlist (§2.1) ────────────────────────

describe("isActiveBetaParticipant — cohort ∈ BETA_CHAT_ALLOWED_COHORTS + status active", () => {
  it("active founding_seller → true (seller cũng là participant)", async () => {
    dbState.memberships.push(membership({ cohort: "founding_seller" }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(true);
  });

  it("active private_beta_buyer → true (buyer mời qua admin operation §8.4)", async () => {
    dbState.memberships.push(membership({ cohort: "private_beta_buyer" }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(true);
  });

  it("active internal → true (internal user được phép bắt đầu hội thoại)", async () => {
    dbState.memberships.push(membership({ cohort: "internal" }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(true);
  });

  it("membership của user KHÁC → false (không đọc nhầm row người khác)", async () => {
    dbState.memberships.push(
      membership({ userId: "99999999-9999-4999-8999-999999999999", cohort: "private_beta_buyer" }),
    );
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(false);
  });
});

// ─── isActiveBetaParticipant — status fail closed (§7.8 fresh read) ───────────

describe("isActiveBetaParticipant — status !== active → false (§7.8 fresh read)", () => {
  it.each(["suspended", "exited", "invited"] as const)(
    "membership %s → false (suspended/exited chặn NGAY; invited chưa accept)",
    async (status) => {
      dbState.memberships.push(membership({ cohort: "founding_seller", status }));
      await expect(isActiveBetaParticipant(USER)).resolves.toBe(false);
    },
  );

  it("KHÔNG có membership nào → false (registered user without active beta membership — §2.1)", async () => {
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(false);
  });
});

// ─── isActiveBetaParticipant — cohort ngoài allowlist fail closed ────────────

describe("isActiveBetaParticipant — cohort NGOÀI allowlist → false (fail closed cho tới khi allowlist)", () => {
  it("cohort lạ (tương lai) → false — KHÔNG phải member của controlled beta", async () => {
    // Giá trị cohort tương lai (enum mở rộng sau này) — fail closed cho tới
    // khi founder allowlist (§4.11: mở rộng là reviewed change, KHÔNG tự mở).
    dbState.memberships.push(membership({ cohort: "future_beta_wave" }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(false);
  });

  it("BETA_CHAT_ALLOWED_COHORTS đúng §2.1 initial cohort values (drift pin)", () => {
    expect([...BETA_CHAT_ALLOWED_COHORTS]).toEqual(["internal", "founding_seller", "private_beta_buyer"]);
  });
});

// ─── isActiveBetaParticipant — expiresAt (corrections #16) ───────────────────

describe("isActiveBetaParticipant — expiresAt (corrections #16 — hết hạn = inactive)", () => {
  it("active + expiresAt ĐÃ QUA → false (cùng isMembershipActive semantics Batch 2)", async () => {
    dbState.memberships.push(membership({ cohort: "private_beta_buyer", expiresAt: "2020-01-01T00:00:00.000Z" }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(false);
  });

  it("active + expiresAt tương lai → true (còn hạn)", async () => {
    dbState.memberships.push(membership({ cohort: "private_beta_buyer", expiresAt: "2999-01-01T00:00:00.000Z" }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(true);
  });

  it("active + expiresAt null → true (không giới hạn)", async () => {
    dbState.memberships.push(membership({ cohort: "private_beta_buyer", expiresAt: null }));
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(true);
  });

  it("một row hết hạn + một row còn hạn (cohort khác) → true (đủ MỘT active là được)", async () => {
    dbState.memberships.push(
      membership({ id: "bcm-expired", cohort: "internal", expiresAt: "2020-01-01T00:00:00.000Z" }),
      membership({ id: "bcm-live", cohort: "private_beta_buyer", expiresAt: null }),
    );
    await expect(isActiveBetaParticipant(USER)).resolves.toBe(true);
  });
});

// ─── assertBuyerBetaChatAccess — guard (§2.1 + §7.8) ──────────────────────────

describe("assertBuyerBetaChatAccess — guard bắt đầu hội thoại/Deal mới", () => {
  it("non-participant → throw BETA_MEMBERSHIP_REQUIRED (fail closed)", async () => {
    await expect(assertBuyerBetaChatAccess(USER)).rejects.toThrow("BETA_MEMBERSHIP_REQUIRED");
  });

  it("participant (active private_beta_buyer) → resolve (no-op)", async () => {
    dbState.memberships.push(membership({ cohort: "private_beta_buyer" }));
    await expect(assertBuyerBetaChatAccess(USER)).resolves.toBeUndefined();
  });

  it("participant suspended → throw BETA_MEMBERSHIP_REQUIRED (§7.8 chặn NGAY)", async () => {
    dbState.memberships.push(membership({ cohort: "private_beta_buyer", status: "suspended" }));
    await expect(assertBuyerBetaChatAccess(USER)).rejects.toThrow("BETA_MEMBERSHIP_REQUIRED");
  });
});

// ─── D3 — policy constant (S8 — Batch 8 register) ─────────────────────────────

describe("BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP — D3 fail-closed reading (S8)", () => {
  it("=== true — §2.1 restriction ĐANG BẬT; đảo giá trị = reviewed product decision", () => {
    // D3 (Recorded Decisions): private beta LÀ "tightly controlled test cohort"
    // (§2.1 opening) nên reading fail-closed là BẬT. Giá trị này quyết định
    // LIỆU MỘT BUYER NÀO CÓ THỂ CHAT KHI LAUNCH — founder phải acknowledge
    // (Batch 8 register); KHÔNG phải env/client flag (§4.9/§4.10).
    expect(BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP).toBe(true);
  });
});

// ─── Source-contract — plain server module (B2 hygiene) ──────────────────────

describe("beta-access.ts — plain server module (source-contract)", () => {
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");
  const root = fileURLToPath(new URL("../..", import.meta.url));

  it("import \"server-only\" + KHÔNG \"use server\" (domain module, không phải action file)", () => {
    const src = read("src/lib/beta-access.ts");
    expect(src).toContain('import "server-only"');
    expect(src).not.toContain('"use server"');
  });

  it("import CHỈ server-only + db.client (corrections #31 import-graph pin)", () => {
    const src = read("src/lib/beta-access.ts");
    const imports = src
      .split("\n")
      .filter((l) => l.startsWith("import "))
      .map((l) => l.trim());
    expect(imports).toEqual([
      'import "server-only";',
      'import { db } from "@/src/prisma/db.client";',
    ]);
  });
});
