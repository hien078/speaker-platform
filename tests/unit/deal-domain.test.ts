/**
 * Deal domain module — vocabularies + §7.8/§5.2 guards (Batch 6 plan Task 2,
 * spec §5.2/§7.1/§7.3/§7.8).
 *
 * Hợp đồng (plan Task 2 Step 1 + corrections 2026-10-08 items 6/20/21/24):
 *  1. Vocabulary pins: DEAL_STATUSES / DEAL_FULFILLMENT_METHODS đúng 4 giá trị
 *     §5.2 verbatim, đúng thứ tự (non-invention pin); DEAL_OUTCOMES đúng D3;
 *     isTerminalDealStatus; hai seam listing-status Q10 = ["approved"];
 *     rate rules §7.1 structural { limit, windowMs } (không import limiter);
 *     CHAT_MESSAGE_MAX_LENGTH; bounds giá D5 (drift với PRICE_MIN/PRICE_MAX
 *     của listing-schema.ts — corrections #21); DEAL_FULFILLMENT_METHODS
 *     drift với LISTING_FULFILLMENT_METHODS (corrections #20).
 *  2. deal-vocab CLIENT-SAFE (B2): source không import db client / server-only
 *     marker / rate-limit module (client form Task 6 import trực tiếp).
 *  3. assertListingStartable (D1): drift test liệt kê MỌI giá trị
 *     listing_status TỪ CONTRACT (emitted contract.json — pattern
 *     search-query.test.ts S6) — chỉ "approved" resolve.
 *  4. assertListingSellerInteractable (D2 — §7.8 seller-side): suspension →
 *     verification → membership, thứ tự pinned, fail closed, đọc FRESH;
 *     membership hết hạn = inactive (corrections #6); DELEGATION spy
 *     isUserSuspended (S10 — deal.ts KHÔNG tự đọc bảng suspension lại).
 *  5. PARITY (corrections #6): cùng fixture, guard và
 *     checkSellerPublicationRequirements (Batch 2) đồng ý trên BA yêu cầu
 *     chung (suspension / verification / membership) — kể cả hết hạn.
 *  6. requireDealConversation (§5.2 relationship): có → trả convo id;
 *     thiếu → DEAL_CONVERSATION_REQUIRED.
 *  7. assertDealParticipant (§7.3 IDOR): buyer/seller/third → DEAL_FORBIDDEN.
 *  8. assertDealOutcomeAllowed (D10): suspension chặn MỌI outcome; block chặn
 *     CHỈ "success" — no_deal/cancelled vẫn ghi nhận được dưới block (§5.5
 *     "where appropriate" — chặn không được làm stranded bản ghi kết quả).
 *  9. (corrections #24) DealStatusHistory APPEND-ONLY: per-statement scan
 *     src/ + app/ — không statement nào update/delete model này (thuật toán
 *     copy từ tests/unit/audit-append.test.ts §6, MODELS = DealStatusHistory).
 *
 * Cơ chế mock: server-only + db.client in-memory (User / PolicyAcceptance /
 * SellerVerification / BetaCohortMembership / UserSuspension / UserBlock /
 * Conversation / Listing) — cùng phong cách tests/unit/session.test.ts;
 * @/src/lib/moderation mock = REAL implementation bọc spy (vi.fn(actual.*))
 * — hành vi thật (đọc cùng db mock), call observable (S10 delegation pin).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// ─── db.client mock — in-memory 8 model của deal domain ───────────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  policyAcceptances: [] as Array<Record<string, unknown>>,
  sellerVerifications: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
  blocks: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  // Field proxy cho lambda predicate — đánh giá trực tiếp trên row
  // (deal domain chỉ dùng object where; lambda ops cho đầy đủ như session.test.ts).
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
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { id: globalThis.crypto.randomUUID(), ...data };
        rows.push(row);
        return { ...row };
      },
      deleteAll: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.length;
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
      deleteAll: () => query([]).deleteAll(),
    };
  };

  return {
    db: {
      orm: {
        public: {
          User: makeModel(dbState.users),
          PolicyAcceptance: makeModel(dbState.policyAcceptances),
          SellerVerification: makeModel(dbState.sellerVerifications),
          BetaCohortMembership: makeModel(dbState.memberships),
          UserSuspension: makeModel(dbState.suspensions),
          UserBlock: makeModel(dbState.blocks),
          Conversation: makeModel(dbState.conversations),
          Listing: makeModel(dbState.listings),
        },
      },
    },
  };
});

// ─── moderation mock — REAL implementation bọc spy (S10 delegation pin) ───────
// importOriginal: hành vi thật (isUserSuspended/getBlockState đọc cùng db mock
// ở trên) — spy chỉ để assert deal.ts DELEGATE thay vì tự đọc lại bảng.

vi.mock("@/src/lib/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/moderation")>();
  return {
    ...actual,
    isUserSuspended: vi.fn(actual.isUserSuspended),
    getBlockState: vi.fn(actual.getBlockState),
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import { checkRateLimit, resetRateLimits } from "@/src/lib/rate-limit";
import { getBlockState, isUserSuspended } from "@/src/lib/moderation";
import { checkSellerPublicationRequirements } from "@/src/lib/seller-verification-policy";
import { LISTING_FULFILLMENT_METHODS } from "@/src/lib/listing-schema";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  CONVERSATION_STARTABLE_LISTING_STATUSES,
  CONVERSATION_START_RATE,
  DEAL_AGREED_PRICE_MAX,
  DEAL_AGREED_PRICE_MIN,
  DEAL_CANCELLATION_REASON_MAX,
  DEAL_CREATE_LISTING_STATUSES,
  DEAL_FULFILLMENT_METHODS,
  DEAL_MUTATION_RATE,
  DEAL_OUTCOMES,
  DEAL_STATUSES,
  TERMINAL_DEAL_STATUSES,
  isTerminalDealStatus,
} from "@/src/lib/deal-vocab";
import * as deal from "@/src/lib/deal";
import {
  assertDealOutcomeAllowed,
  assertDealParticipant,
  assertListingSellerInteractable,
  assertListingStartable,
  requireDealConversation,
} from "@/src/lib/deal";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

const SELLER_ID = "seller-1";
const BUYER_ID = "buyer-1";
const OTHER_ID = "user-3";
const NOW = "2026-10-08T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";

/** Seller đủ đủ 8 yêu cầu publication (Batch 4 verified-seller shape). */
function seedEligibleSeller(id: string): void {
  dbState.users.push({
    id,
    email: `${id}@example.test`,
    emailVerifiedAt: PAST,
    phoneVerifiedAt: PAST,
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
  });
  dbState.policyAcceptances.push({
    id: `${id}-rules`,
    userId: id,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: PAST,
  });
  dbState.sellerVerifications.push({
    id: `${id}-ver`,
    userId: id,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
  });
  dbState.memberships.push({
    id: `${id}-mem`,
    userId: id,
    cohort: "founding_seller",
    status: "active",
    expiresAt: null,
  });
}

/** Message lỗi typed của một guard async — null khi resolve. */
async function guardError(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Mọi giá trị listing_status từ contract EMITTED (src/prisma/contract.json). */
const contractListingStatuses = (() => {
  const contract = JSON.parse(read("src/prisma/contract.json")) as {
    domain: {
      namespaces: Record<
        string,
        { enum: Record<string, { members: Array<{ name: string; value: string }> }> }
      >;
    };
  };
  return contract.domain.namespaces.public!.enum.listing_status!.members.map((m) => m.value);
})();

// ─── PARITY (corrections #6) — guard ↔ checkSellerPublicationRequirements ─────

/** Guard code ↔ requirement publication tương ứng (BA yêu cầu chung). */
const GUARD_CODE_TO_REQUIREMENT = {
  SELLER_SUSPENDED: "account_not_suspended",
  SELLER_NOT_VERIFIED: "operations_review_verified",
  SELLER_MEMBERSHIP_INACTIVE: "founding_seller_membership_active",
} as const;
const REQUIREMENT_TO_GUARD_CODE = {
  account_not_suspended: "SELLER_SUSPENDED",
  operations_review_verified: "SELLER_NOT_VERIFIED",
  founding_seller_membership_active: "SELLER_MEMBERSHIP_INACTIVE",
} as const;
/** Thứ tự guard: suspension → verification → membership (D2 order pin). */
const GUARD_ORDER = [
  "account_not_suspended",
  "operations_review_verified",
  "founding_seller_membership_active",
] as const;

/**
 * Cùng fixture: guard và checkSellerPublicationRequirements phải đồng ý trên
 * BA yêu cầu chung — guard resolve ⟺ không requirement nào trong ba bị thiếu;
 * guard throw code X ⟺ X tương ứng có mặt trong missing, VÀ code đúng với
 * requirement ĐẦU TIÊN thiếu theo THỨ TỰ guard (suspension → verification →
 * membership).
 */
async function expectGuardPolicyParity(sellerId: string): Promise<void> {
  const check = await checkSellerPublicationRequirements(sellerId);
  const err = await guardError(() => assertListingSellerInteractable(sellerId));
  const sharedRequirements = Object.values(GUARD_CODE_TO_REQUIREMENT) as readonly string[];

  if (err === null) {
    const missingShared = check.missing.filter((m) => sharedRequirements.includes(m));
    expect(
      missingShared,
      `guard resolve nhưng policy thiếu: ${check.missing.join(",")}`,
    ).toEqual([]);
    return;
  }
  const requirement = (Object.entries(GUARD_CODE_TO_REQUIREMENT) as Array<[string, string]>)
    .find(([code]) => code === err)?.[1];
  expect(requirement, `code guard lạ: ${err}`).toBeDefined();
  expect(check.missing, `policy phải thiếu '${requirement}'`).toContain(requirement);
  const firstMissing = GUARD_ORDER.find((r) => check.missing.includes(r));
  expect(firstMissing, `policy phải thiếu ít nhất một trong ba: ${check.missing.join(",")}`).toBeDefined();
  expect(err).toBe(REQUIREMENT_TO_GUARD_CODE[firstMissing as keyof typeof REQUIREMENT_TO_GUARD_CODE]);
}

// ─── Fixtures reset ────────────────────────────────────────────────────────────

beforeEach(() => {
  dbState.users.length = 0;
  dbState.policyAcceptances.length = 0;
  dbState.sellerVerifications.length = 0;
  dbState.memberships.length = 0;
  dbState.suspensions.length = 0;
  dbState.blocks.length = 0;
  dbState.conversations.length = 0;
  dbState.listings.length = 0;
  vi.clearAllMocks();
  resetRateLimits();
});

// ─── 1. Vocabulary pins (spec §5.2 verbatim + D3 + Q10 + §7.1 + D5) ───────────

describe("deal-vocab — vocabulary pins", () => {
  it("DEAL_STATUSES đúng 4 giá trị §5.2 verbatim, đúng thứ tự (non-invention pin)", () => {
    expect([...DEAL_STATUSES]).toEqual(["open", "completed", "cancelled", "no_deal"]);
  });

  it("DEAL_FULFILLMENT_METHODS đúng 4 giá trị §5.2 verbatim, đúng thứ tự", () => {
    expect([...DEAL_FULFILLMENT_METHODS]).toEqual([
      "meetup",
      "seller_delivery",
      "carrier",
      "other",
    ]);
  });

  it("DEAL_FULFILLMENT_METHODS drift === LISTING_FULFILLMENT_METHODS (corrections #20 — cùng vocabulary §5.2/A7)", () => {
    expect([...DEAL_FULFILLMENT_METHODS]).toEqual([...LISTING_FULFILLMENT_METHODS]);
  });

  it("DEAL_OUTCOMES đúng D3: [success, no_deal, cancelled] — giá trị marking per party", () => {
    expect([...DEAL_OUTCOMES]).toEqual(["success", "no_deal", "cancelled"]);
  });

  it("isTerminalDealStatus: open → false; completed/cancelled/no_deal → true", () => {
    expect(isTerminalDealStatus("open")).toBe(false);
    expect(isTerminalDealStatus("completed")).toBe(true);
    expect(isTerminalDealStatus("cancelled")).toBe(true);
    expect(isTerminalDealStatus("no_deal")).toBe(true);
    // terminal ⊆ DEAL_STATUSES (drift trong chính vocabulary)
    expect(
      [...TERMINAL_DEAL_STATUSES].every((s) => (DEAL_STATUSES as readonly string[]).includes(s)),
    ).toBe(true);
  });

  it("Q10: CONVERSATION_STARTABLE_LISTING_STATUSES = [approved] = DEAL_CREATE_LISTING_STATUSES", () => {
    expect([...CONVERSATION_STARTABLE_LISTING_STATUSES]).toEqual(["approved"]);
    expect([...DEAL_CREATE_LISTING_STATUSES]).toEqual(["approved"]);
  });

  it("rate rules §7.1 — structural { limit, windowMs } hoạt động với checkRateLimit hiện có", () => {
    expect(CONVERSATION_START_RATE).toEqual({ limit: 20, windowMs: 10 * 60_000 });
    expect(DEAL_MUTATION_RATE).toEqual({ limit: 20, windowMs: 60 * 60_000 });
    // 20 hội thoại mới / 10 phút / user — cái 21 bị từ chối (§7.1 "chat")
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit("deal-domain-test:start", CONVERSATION_START_RATE).allowed).toBe(true);
    }
    expect(checkRateLimit("deal-domain-test:start", CONVERSATION_START_RATE).allowed).toBe(false);
    // 20 create+outcome / giờ / user — cái 21 bị từ chối (§7.1 "Deal mutation")
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit("deal-domain-test:mutation", DEAL_MUTATION_RATE).allowed).toBe(true);
    }
    expect(checkRateLimit("deal-domain-test:mutation", DEAL_MUTATION_RATE).allowed).toBe(false);
  });

  it("CHAT_MESSAGE_MAX_LENGTH = 2000 (khớp maxLength client hiện có — Task 3 enforce server)", () => {
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(2_000);
  });

  it("DEAL_CANCELLATION_REASON_MAX = 500 (§5.2 cancellationReason ≤500)", () => {
    expect(DEAL_CANCELLATION_REASON_MAX).toBe(500);
  });

  it("D5: bounds giá = bound THẬT của repo — drift với PRICE_MIN/PRICE_MAX của listing-schema.ts (corrections #21)", () => {
    expect(DEAL_AGREED_PRICE_MIN).toBe(100_000);
    expect(DEAL_AGREED_PRICE_MAX).toBe(2_000_000_000);
    const src = read("src/lib/listing-schema.ts");
    const min = src.match(/const PRICE_MIN = ([\d_]+)/);
    const max = src.match(/const PRICE_MAX = ([\d_]+)/);
    expect(min, "PRICE_MIN phải còn ở listing-schema.ts (nguồn bound)").not.toBeNull();
    expect(max, "PRICE_MAX phải còn ở listing-schema.ts (nguồn bound)").not.toBeNull();
    expect(DEAL_AGREED_PRICE_MIN).toBe(Number(min![1]!.replace(/_/g, "")));
    expect(DEAL_AGREED_PRICE_MAX).toBe(Number(max![1]!.replace(/_/g, "")));
  });
});

// ─── 2. Client-safe source contract (B2) ──────────────────────────────────────

describe("deal-vocab — client-safe source contract (B2)", () => {
  it("source KHÔNG import db client / server-only marker / rate-limit module (client form import trực tiếp)", () => {
    const src = read("src/lib/deal-vocab.ts");
    expect(src).not.toContain("db.client");
    expect(src).not.toContain("server-only");
    expect(src).not.toContain("@/src/lib/rate-limit");
  });
});

describe("deal.ts — server-only domain module source contract", () => {
  it("mang import server-only marker, KHÔNG phải action file, re-export vocabulary, KHÔNG tự đọc bảng guard (S10)", () => {
    const src = read("src/lib/deal.ts");
    expect(src).toContain('import "server-only"');
    // KHÔNG phải action — directive use server chỉ dành cho action file
    expect(src).not.toContain('"use server"');
    // server consumers import mọi thứ từ một nơi (moderation.ts precedent)
    expect(src).toContain('export * from "@/src/lib/deal-vocab"');
    // S10: suspension/block đọc qua delegation (@/src/lib/moderation) —
    // KHÔNG tự đọc lại bảng episode đình chỉ / block trong deal.ts
    expect(src).not.toContain("UserSuspension");
    expect(src).not.toContain("UserBlock");
  });

  it("deal.ts re-export toàn bộ vocabulary (server consumers import từ một nơi)", () => {
    expect(deal.DEAL_STATUSES).toBe(DEAL_STATUSES);
    expect(deal.DEAL_OUTCOMES).toBe(DEAL_OUTCOMES);
    expect(deal.DEAL_FULFILLMENT_METHODS).toBe(DEAL_FULFILLMENT_METHODS);
    expect(deal.isTerminalDealStatus).toBe(isTerminalDealStatus);
    expect(deal.CONVERSATION_START_RATE).toBe(CONVERSATION_START_RATE);
    expect(deal.DEAL_MUTATION_RATE).toBe(DEAL_MUTATION_RATE);
  });
});

// ─── 3. assertListingStartable — D1 drift test (Q10) ──────────────────────────

describe("assertListingStartable — D1 drift test (liệt kê MỌI listing_status từ contract)", () => {
  it("contract có ≥ 5 giá trị (sanity — walk không được im lặng pass)", () => {
    expect(contractListingStatuses.length).toBeGreaterThanOrEqual(5);
  });

  it("table-driven: CHỈ 'approved' resolve — mọi giá trị khác → LISTING_NOT_CONVERSATIONABLE", async () => {
    for (const value of contractListingStatuses) {
      const err = await guardError(() =>
        assertListingStartable({ id: "listing-1", sellerId: SELLER_ID, status: value }),
      );
      if (value === "approved") {
        expect(err, `listing_status '${value}' phải được mở hội thoại mới`).toBeNull();
      } else {
        expect(err, `listing_status '${value}' phải từ chối hội thoại mới`).toBe(
          "LISTING_NOT_CONVERSATIONABLE",
        );
      }
    }
  });

  it("giá trị ngoài enum → từ chối (fail closed)", async () => {
    for (const value of ["", "APPROVED", "approved ", "bogus"]) {
      const err = await guardError(() =>
        assertListingStartable({ id: "listing-1", sellerId: SELLER_ID, status: value }),
      );
      expect(err, `giá trị '${value}'`).toBe("LISTING_NOT_CONVERSATIONABLE");
    }
  });
});

// ─── 4. assertListingSellerInteractable — §7.8 seller-side (D2) ────────────────

describe("assertListingSellerInteractable — §7.8 seller-side (D2)", () => {
  it("seller đủ điều kiện resolve (không đình chỉ + verified + active founding_seller)", async () => {
    seedEligibleSeller(SELLER_ID);
    await expect(assertListingSellerInteractable(SELLER_ID)).resolves.toBeUndefined();
  });

  it("suspended seller → SELLER_SUSPENDED — DELEGATION spy isUserSuspended (S10); lifted → resolve (chỉ episode active chặn)", async () => {
    seedEligibleSeller(SELLER_ID);
    dbState.suspensions.push({
      id: "sus-1",
      userId: SELLER_ID,
      status: "active",
      reasonCode: "other_reviewed_reason",
      suspendedAt: NOW,
    });
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow("SELLER_SUSPENDED");
    // S10: suspension đọc qua @/src/lib/moderation — KHÔNG tự đọc lại trong deal.ts
    expect(isUserSuspended).toHaveBeenCalledWith(SELLER_ID);

    // lifted → không còn chặn (đọc FRESH — chỉ row active)
    dbState.suspensions[0]!.status = "lifted";
    await expect(assertListingSellerInteractable(SELLER_ID)).resolves.toBeUndefined();
  });

  it("verification table-driven: revoked/rejected/needs_review/pending/not_started + row thiếu → SELLER_NOT_VERIFIED (§7.8 revocation — D2)", async () => {
    for (const status of ["revoked", "rejected", "needs_review", "pending", "not_started"]) {
      seedEligibleSeller(SELLER_ID);
      dbState.sellerVerifications[0]!.status = status;
      await expect(
        assertListingSellerInteractable(SELLER_ID),
        `SellerVerification.status '${status}'`,
      ).rejects.toThrow("SELLER_NOT_VERIFIED");
    }
    // row thiếu hoàn toàn → cùng code (fail closed)
    seedEligibleSeller(SELLER_ID);
    dbState.sellerVerifications.length = 0;
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow("SELLER_NOT_VERIFIED");
  });

  it("membership table-driven: suspended/exited/invited + row thiếu → SELLER_MEMBERSHIP_INACTIVE (§7.8 beta-membership — D2)", async () => {
    for (const status of ["suspended", "exited", "invited"]) {
      seedEligibleSeller(SELLER_ID);
      dbState.memberships[0]!.status = status;
      await expect(
        assertListingSellerInteractable(SELLER_ID),
        `BetaCohortMembership.status '${status}'`,
      ).rejects.toThrow("SELLER_MEMBERSHIP_INACTIVE");
    }
    seedEligibleSeller(SELLER_ID);
    dbState.memberships.length = 0;
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
  });

  it("membership HẾT HẠN → SELLER_MEMBERSHIP_INACTIVE (corrections #6 — expiresAt đã qua = inactive); hạn tương lai → resolve", async () => {
    seedEligibleSeller(SELLER_ID);
    dbState.memberships[0]!.expiresAt = PAST;
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    dbState.memberships[0]!.expiresAt = FUTURE;
    await expect(assertListingSellerInteractable(SELLER_ID)).resolves.toBeUndefined();
  });

  it("order pin: suspension thắng verification thắng membership (seller đủ 3 lỗi → SELLER_SUSPENDED)", async () => {
    seedEligibleSeller(SELLER_ID);
    dbState.suspensions.push({
      id: "sus-2",
      userId: SELLER_ID,
      status: "active",
      reasonCode: "other_reviewed_reason",
      suspendedAt: NOW,
    });
    dbState.sellerVerifications[0]!.status = "revoked";
    dbState.memberships[0]!.status = "exited";
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow("SELLER_SUSPENDED");
    // gỡ suspension → verification là lỗi kế tiếp
    dbState.suspensions.length = 0;
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow("SELLER_NOT_VERIFIED");
    // phục hồi verification → membership là lỗi kế tiếp
    dbState.sellerVerifications[0]!.status = "verified";
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
  });

  it("đọc FRESH từ DB mỗi call — trạng thái đổi giữa 2 call được thấy ngay", async () => {
    seedEligibleSeller(SELLER_ID);
    await expect(assertListingSellerInteractable(SELLER_ID)).resolves.toBeUndefined();
    dbState.sellerVerifications[0]!.status = "revoked";
    await expect(assertListingSellerInteractable(SELLER_ID)).rejects.toThrow("SELLER_NOT_VERIFIED");
  });

  it("PARITY (corrections #6): guard và checkSellerPublicationRequirements đồng ý trên BA yêu cầu chung", async () => {
    // 1. sạch hoàn toàn → guard resolve, policy ok (đủ 8 yêu cầu)
    seedEligibleSeller(SELLER_ID);
    await expectGuardPolicyParity(SELLER_ID);
    expect((await checkSellerPublicationRequirements(SELLER_ID)).ok).toBe(true);

    // 2. đình chỉ
    seedEligibleSeller(SELLER_ID);
    dbState.suspensions.push({
      id: "sus-p",
      userId: SELLER_ID,
      status: "active",
      reasonCode: "other_reviewed_reason",
      suspendedAt: NOW,
    });
    await expectGuardPolicyParity(SELLER_ID);

    // 3. thu hồi verification
    seedEligibleSeller(SELLER_ID);
    dbState.sellerVerifications[0]!.status = "revoked";
    await expectGuardPolicyParity(SELLER_ID);

    // 4. thiếu hẳn row verification
    seedEligibleSeller(SELLER_ID);
    dbState.sellerVerifications.length = 0;
    await expectGuardPolicyParity(SELLER_ID);

    // 5. membership exited
    seedEligibleSeller(SELLER_ID);
    dbState.memberships[0]!.status = "exited";
    await expectGuardPolicyParity(SELLER_ID);

    // 6. membership HẾT HẠN (corrections #6 — policy isMembershipActive coi
    //    hết hạn = inactive; guard phải đồng ý)
    seedEligibleSeller(SELLER_ID);
    dbState.memberships[0]!.expiresAt = PAST;
    await expectGuardPolicyParity(SELLER_ID);

    // 7. đình chỉ + thu hồi + hết hạn cùng lúc → cả hai thấy CẢ BA thiếu,
    //    guard throw theo thứ tự suspension (order pin)
    seedEligibleSeller(SELLER_ID);
    dbState.suspensions.push({
      id: "sus-p2",
      userId: SELLER_ID,
      status: "active",
      reasonCode: "other_reviewed_reason",
      suspendedAt: NOW,
    });
    dbState.sellerVerifications[0]!.status = "revoked";
    dbState.memberships[0]!.expiresAt = PAST;
    await expectGuardPolicyParity(SELLER_ID);
  });
});

// ─── 5. requireDealConversation — §5.2 relationship ──────────────────────────

describe("requireDealConversation — §5.2 corresponding allowed conversation relationship", () => {
  it("có hội thoại (listing, buyer) → trả về convo id", async () => {
    dbState.conversations.push({
      id: "convo-1",
      listingId: "listing-1",
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
    });
    await expect(requireDealConversation("listing-1", BUYER_ID)).resolves.toEqual({
      id: "convo-1",
    });
  });

  it("thiếu hội thoại → DEAL_CONVERSATION_REQUIRED (Deal chỉ tạo trong hội thoại đã tồn tại)", async () => {
    await expect(requireDealConversation("listing-1", BUYER_ID)).rejects.toThrow(
      "DEAL_CONVERSATION_REQUIRED",
    );
  });

  it("buyer có hội thoại trên listing KHÁC → vẫn DEAL_CONVERSATION_REQUIRED cho listing này (where khóa listingId+buyerId)", async () => {
    dbState.conversations.push({
      id: "convo-other",
      listingId: "listing-2",
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
    });
    await expect(requireDealConversation("listing-1", BUYER_ID)).rejects.toThrow(
      "DEAL_CONVERSATION_REQUIRED",
    );
  });
});

// ─── 6. assertDealParticipant — §7.3 IDOR ────────────────────────────────────

describe("assertDealParticipant — §7.3 cross-account Deal modification (IDOR)", () => {
  const deal = { buyerId: BUYER_ID, sellerId: SELLER_ID };

  it("buyer → 'buyer'; seller → 'seller'", async () => {
    await expect(assertDealParticipant(deal, BUYER_ID)).resolves.toBe("buyer");
    await expect(assertDealParticipant(deal, SELLER_ID)).resolves.toBe("seller");
  });

  it("user thứ ba → DEAL_FORBIDDEN (Review Focus 1)", async () => {
    await expect(assertDealParticipant(deal, OTHER_ID)).rejects.toThrow("DEAL_FORBIDDEN");
  });
});

// ─── 7. assertDealOutcomeAllowed — D10 (§5.5 "where appropriate") ──────────────

describe("assertDealOutcomeAllowed — D10: block chặn CHỈ success, suspension chặn MỌI outcome", () => {
  it("cặp sạch → resolve cho cả ba outcome", async () => {
    for (const outcome of DEAL_OUTCOMES) {
      await expect(
        assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, outcome),
        `outcome '${outcome}'`,
      ).resolves.toBeUndefined();
    }
  });

  it("actor bị đình chỉ → ACCOUNT_SUSPENDED cho MỌI outcome — DELEGATION spy isUserSuspended (§7.8)", async () => {
    dbState.suspensions.push({
      id: "sus-3",
      userId: BUYER_ID,
      status: "active",
      reasonCode: "other_reviewed_reason",
      suspendedAt: NOW,
    });
    for (const outcome of DEAL_OUTCOMES) {
      await expect(
        assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, outcome),
        `outcome '${outcome}'`,
      ).rejects.toThrow("ACCOUNT_SUSPENDED");
    }
    expect(isUserSuspended).toHaveBeenCalledWith(BUYER_ID);
  });

  it("block HAI HƯỚNG + outcome 'success' → CHAT_BLOCKED — DELEGATION spy getBlockState (§5.5)", async () => {
    // viewer (actor) chặn counterpart
    dbState.blocks.push({ id: "blk-1", blockerId: BUYER_ID, blockedId: SELLER_ID });
    await expect(assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, "success")).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    expect(getBlockState).toHaveBeenCalledWith(BUYER_ID, SELLER_ID);
    // counterpart chặn actor — cũng chặn
    dbState.blocks.length = 0;
    dbState.blocks.push({ id: "blk-2", blockerId: SELLER_ID, blockedId: BUYER_ID });
    await expect(assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, "success")).rejects.toThrow(
      "CHAT_BLOCKED",
    );
  });

  it("block HAI HƯỚNG + outcome 'no_deal'/'cancelled' → RESOLVE (D10 — cặp block vẫn ghi nhận được kết quả, không stranded)", async () => {
    dbState.blocks.push({ id: "blk-3", blockerId: BUYER_ID, blockedId: SELLER_ID });
    await expect(assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, "no_deal")).resolves.toBeUndefined();
    await expect(assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, "cancelled")).resolves.toBeUndefined();
    // ngược hướng — cũng resolve
    dbState.blocks.length = 0;
    dbState.blocks.push({ id: "blk-4", blockerId: SELLER_ID, blockedId: BUYER_ID });
    await expect(assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, "no_deal")).resolves.toBeUndefined();
    await expect(assertDealOutcomeAllowed(BUYER_ID, SELLER_ID, "cancelled")).resolves.toBeUndefined();
  });
});

// ─── 8. (corrections #24) DealStatusHistory append-only — per-statement scan ───
// Thuật toán copy từ tests/unit/audit-append.test.ts §6 (S12) — file
// earlier-batch KHÔNG edit; Batch 6 giữ bản scan riêng cho DealStatusHistory.

describe("(corrections #24) KHÔNG statement nào mutate DealStatusHistory (append-only)", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));

  /** Mọi file .ts/.tsx dưới src/ + app/ (đệ quy). */
  const sourceFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) out.push(p);
      }
    };
    walk(join(root, "src"));
    walk(join(root, "app"));
    return out;
  };

  const MODELS = ["DealStatusHistory"] as const;
  const MUTATION_OPS = [".update(", ".updateAll(", ".delete(", ".deleteAll("] as const;

  it("per-statement scan (strip comment, split ';') — statement chứa model + op mutation → fail", () => {
    const files = sourceFiles();
    // sanity: scan phải thấy được code hiện có — walk hỏng không được im lặng pass.
    expect(files.length, "phải enumerate được source files").toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const f of files) {
      let text = readFileSync(f, "utf8");
      // Strip block comment, rồi line comment (bỏ qua `//` trong string URL —
      // `://` không phải comment; truncate statement chỉ gây false NEGATIVE,
      // không bao giờ false positive).
      text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
      text = text.replace(/(^|[^:"'`])\/\/[^\n]*/g, " ");
      const statements = text.split(";");
      statements.forEach((st, i) => {
        const hasModel = MODELS.some((m) => st.includes(m));
        const hasOp = MUTATION_OPS.some((op) => st.includes(op));
        if (hasModel && hasOp) {
          offenders.push(`${f} [statement ${i}] :: ${st.trim().slice(0, 160)}`);
        }
      });
    }
    expect(
      offenders,
      "DealStatusHistory là append-only (spec §5.2) — chỉ .create( được phép; history sống qua Cascade từ Deal (corrections #4)",
    ).toEqual([]);
  });
});
