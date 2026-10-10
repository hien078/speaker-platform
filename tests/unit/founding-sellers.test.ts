/**
 * Founding-seller domain module — vocabularies + transition table + funnel sync
 * + contact masking (Batch 7 plan Task 2, spec §5.10/§5.10.1, §4.8/§7.6).
 *
 * Hợp đồng (plan Task 2 Step 1 + corrections 2026-10-08 items 22/34 + P5):
 *  1. Vocabulary pins: FOUNDING_SELLER_CANDIDATE_STATUSES đúng 10 giá trị
 *     §5.10 verbatim, đúng thứ tự (non-invention pin); labels đủ 10;
 *     FOUNDING_SELLER_TRANSITION_REASONS đúng 7 mã cơ học; bảng
 *     FOUNDING_SELLER_TRANSITIONS đúng từng cặp (PROVISIONAL — FD-3);
 *     MANUALLY_SETTABLE_STATUSES đúng 4 ops states (fail-closed set của
 *     Task 4); caps/tunables: NOTE 4000 / SOURCE 200 / TTL 14 ngày (D1) /
 *     invite 20/h (§7.1) / accept 10-10' (§7.1) / landing 30-10'
 *     (corrections #13, P5) / assistance 7 ngày (D2).
 *  2. canTransitionCandidate: table-driven toàn bộ 10×10 — chỉ cặp nằm trong
 *     FOUNDING_SELLER_TRANSITIONS là true; exited terminal; inactive →
 *     active_founding_seller FALSE (A5 — reactivation là founder policy,
 *     KHÔNG phát minh).
 *  3. maskContact (corrections #34 — fixed-width, không leak độ dài):
 *     email local ≥ 2 ký tự → "l***@domain"; local 1 ký tự → "***@domain";
 *     phone → 2 số đầu + "*****" + 2 số cuối (luôn 9 ký tự); null/"" → "—";
 *     channel null / email không "@" / phone < 4 ký tự → mask toàn bộ —
 *     KHÔNG BAO GIỜ trả về giá trị đầy đủ (§4.8/§7.6).
 *  4. syncFoundingSellerFunnel (corrections #22): đọc GROUND TRUTH
 *     (SellerVerification + Listing approved), CHỈ TIẾN không lùi, nhảy
 *     thẳng trạng thái furthest trong MỘT update (registered → first_listing),
 *     EXEMPT canTransitionCandidate (bảng đó chỉ chi phối manual moves — pin
 *     hành vi: registered → first_listing qua sync hợp pháp dù bảng manual
 *     từ chối), skip hoàn toàn ops states + pre-registration, conditional
 *     write where({ id, status }) — 0 row → { from, to: from, changed: false }
 *     KHÔNG retry, idempotent, KHÔNG ghi đè verifiedAt/firstListingAt cũ.
 *  5. approvedListingCountOf: chỉ đếm listing "approved" của đúng seller
 *     (factual count — KHÔNG phải "quality", A3).
 *  6. candidateNeedsAssistance (D2): active-funnel + (chưa liên hệ || quá
 *     7 ngày) — ops heuristic, KHÔNG phải SLA.
 *  7. Source contracts: vocab = plain module client-safe (không db /
 *     server-only, có marker PROVISIONAL/FD-3); domain = server-only,
 *     KHÔNG "use server", re-export vocab, không log path nào.
 *
 * Cơ chế mock: server-only + db.client in-memory (FoundingSellerCandidate /
 * SellerVerification / Listing) — cùng phong cách tests/unit/deal-domain.test.ts.
 * FoundingSellerCandidate chưa có trong contract emit của tree này (Task 1 —
 * contract + migration — chạy song song trong worktree khác, chưa merge; xem
 * header src/lib/founding-sellers.ts): mock cung cấp table cùng tên;
 * typecheck chống contract diễn ra sau merge (corrections parallelism map).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

// ─── db.client mock — in-memory 3 model của founding-seller domain ────────────

const dbState = vi.hoisted(() => ({
  candidates: [] as Array<Record<string, unknown>>,
  verifications: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  /**
   * Test hook (corrections #22): khi ≠ null, áp move này lên candidate row
   * TRƯỚC khi conditional updateAll match — mô phỏng operator move song song
   * giữa lúc sync đọc và lúc sync ghi (0-row compare-and-set).
   */
  concurrentCandidateMove: null as Record<string, unknown> | null,
  /** Đếm lần sync gọi conditional updateAll trên candidate (pin "không retry"). */
  candidateConditionalWrites: 0,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  // Field proxy cho lambda predicate — đánh giá trực tiếp trên row
  // (founding-seller domain chỉ dùng object where; lambda ops cho đầy đủ
  // như deal-domain.test.ts).
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

  const makeModel = (rows: Row[], hooks?: { beforeUpdateAll?: () => void }) => {
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
        hooks?.beforeUpdateAll?.();
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      aggregate: async (fn: (a: { count: () => number }) => Row) =>
        fn({ count: () => rows.filter((r) => preds.every((p) => matches(r, p))).length }),
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
      aggregate: (fn: (a: { count: () => number }) => Row) => query([]).aggregate(fn),
    };
  };

  return {
    db: {
      orm: {
        public: {
          // Hook beforeUpdateAll: mô phỏng concurrent move cho CAS test +
          // đếm conditional write (sync chỉ ghi qua .where(...).updateAll(...)).
          FoundingSellerCandidate: makeModel(dbState.candidates, {
            beforeUpdateAll: () => {
              dbState.candidateConditionalWrites += 1;
              if (dbState.concurrentCandidateMove !== null) {
                const move = dbState.concurrentCandidateMove;
                dbState.concurrentCandidateMove = null;
                for (const r of dbState.candidates) Object.assign(r, move);
              }
            },
          }),
          SellerVerification: makeModel(dbState.verifications),
          Listing: makeModel(dbState.listings),
        },
      },
    },
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ─────────────────────

import {
  BETA_INVITE_ACCEPT_RATE,
  BETA_INVITE_LANDING_RATE,
  FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS,
  FOUNDING_SELLER_CANDIDATE_STATUSES,
  FOUNDING_SELLER_INVITE_RATE,
  FOUNDING_SELLER_INVITE_TTL_DAYS,
  FOUNDING_SELLER_NOTE_MAX_LENGTH,
  FOUNDING_SELLER_SOURCE_MAX_LENGTH,
  FOUNDING_SELLER_STATUS_LABELS,
  FOUNDING_SELLER_TRANSITIONS,
  FOUNDING_SELLER_TRANSITION_REASONS,
  MANUALLY_SETTABLE_STATUSES,
  canTransitionCandidate,
  maskContact,
} from "@/src/lib/founding-seller-vocab";
import {
  approvedListingCountOf,
  candidateNeedsAssistance,
  syncFoundingSellerFunnel,
} from "@/src/lib/founding-sellers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

const SELLER_ID = "seller-1";
const PAST = "2026-01-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60_000;

function seedCandidate(
  status: string,
  extra: Record<string, unknown> = {},
): void {
  dbState.candidates.push({
    id: `cand-${dbState.candidates.length + 1}`,
    userId: SELLER_ID,
    status,
    verifiedAt: null,
    firstListingAt: null,
    ...extra,
  });
}

function seedVerification(status: string): void {
  dbState.verifications.push({
    id: `ver-${dbState.verifications.length + 1}`,
    userId: SELLER_ID,
    status,
  });
}

function seedListing(status: string, sellerId: string = SELLER_ID): void {
  dbState.listings.push({
    id: `listing-${dbState.listings.length + 1}`,
    sellerId,
    status,
  });
}

const candidateRow = (): Record<string, unknown> => dbState.candidates[0]!;

function resetDb(): void {
  dbState.candidates.length = 0;
  dbState.verifications.length = 0;
  dbState.listings.length = 0;
  dbState.concurrentCandidateMove = null;
  dbState.candidateConditionalWrites = 0;
}

beforeEach(() => {
  resetDb();
});

// ─── 1. Vocabulary pins (spec §5.10 verbatim — non-invention) ────────────────

describe("FOUNDING_SELLER_CANDIDATE_STATUSES — spec §5.10 lifecycle verbatim", () => {
  it("đúng 10 giá trị, đúng thứ tự (prospect → … → exited)", () => {
    expect([...FOUNDING_SELLER_CANDIDATE_STATUSES]).toEqual([
      "prospect",
      "invited",
      "registered",
      "verification_pending",
      "verified",
      "concierge_onboarding",
      "first_listing",
      "active_founding_seller",
      "inactive",
      "exited",
    ]);
  });
});

describe("FOUNDING_SELLER_STATUS_LABELS — đủ 10 trạng thái, không rỗng", () => {
  it("mọi trạng thái có nhãn tiếng Việt không trống", () => {
    expect(Object.keys(FOUNDING_SELLER_STATUS_LABELS).length).toBe(10);
    for (const s of FOUNDING_SELLER_CANDIDATE_STATUSES) {
      expect(FOUNDING_SELLER_STATUS_LABELS[s].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("FOUNDING_SELLER_TRANSITION_REASONS — 7 mã cơ học (PROVISIONAL FD-3)", () => {
  it("đúng tập mã, đúng thứ tự", () => {
    expect([...FOUNDING_SELLER_TRANSITION_REASONS]).toEqual([
      "concierge_started",
      "quality_sample_passed",
      "seller_unresponsive",
      "seller_declined",
      "policy_review",
      "operator_correction",
      "other_reviewed_reason",
    ]);
  });
});

describe("MANUALLY_SETTABLE_STATUSES — đúng 4 ops states (fail-closed set Task 4)", () => {
  it("chỉ concierge_onboarding / active_founding_seller / inactive / exited", () => {
    expect([...MANUALLY_SETTABLE_STATUSES]).toEqual([
      "concierge_onboarding",
      "active_founding_seller",
      "inactive",
      "exited",
    ]);
  });
});

describe("caps + tunables (D1/D2/P5 — PROVISIONAL)", () => {
  it("note/source caps, invite TTL, rate rules, assistance threshold", () => {
    expect(FOUNDING_SELLER_NOTE_MAX_LENGTH).toBe(4_000);
    expect(FOUNDING_SELLER_SOURCE_MAX_LENGTH).toBe(200);
    expect(FOUNDING_SELLER_INVITE_TTL_DAYS).toBe(14);
    expect(FOUNDING_SELLER_INVITE_RATE).toEqual({ limit: 20, windowMs: 60 * 60_000 });
    expect(BETA_INVITE_ACCEPT_RATE).toEqual({ limit: 10, windowMs: 10 * 60_000 });
    // corrections #13 (P5): rate limit cho landing GET /invite/[token]
    expect(BETA_INVITE_LANDING_RATE).toEqual({ limit: 30, windowMs: 10 * 60_000 });
    // D2: ngưỡng "cần hỗ trợ" — ops heuristic, KHÔNG phải SLA
    expect(FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS).toBe(7);
  });
});

// ─── 2. canTransitionCandidate — bảng chuyển trạng thái hợp pháp ─────────────

describe("canTransitionCandidate — bảng chuyển trạng thái (PROVISIONAL FD-3)", () => {
  it("bảng đúng từng cặp theo plan (spec §5.10 lifecycle + 2 terminal ops states)", () => {
    expect(FOUNDING_SELLER_TRANSITIONS.prospect).toEqual(["invited", "exited"]);
    expect(FOUNDING_SELLER_TRANSITIONS.invited).toEqual(["registered", "inactive", "exited"]);
    expect(FOUNDING_SELLER_TRANSITIONS.registered).toEqual([
      "verification_pending",
      "inactive",
      "exited",
    ]);
    expect(FOUNDING_SELLER_TRANSITIONS.verification_pending).toEqual([
      "verified",
      "inactive",
      "exited",
    ]);
    expect(FOUNDING_SELLER_TRANSITIONS.verified).toEqual([
      "concierge_onboarding",
      "first_listing",
      "inactive",
      "exited",
    ]);
    expect(FOUNDING_SELLER_TRANSITIONS.concierge_onboarding).toEqual([
      "first_listing",
      "inactive",
      "exited",
    ]);
    expect(FOUNDING_SELLER_TRANSITIONS.first_listing).toEqual([
      "active_founding_seller",
      "inactive",
      "exited",
    ]);
    expect(FOUNDING_SELLER_TRANSITIONS.active_founding_seller).toEqual(["inactive", "exited"]);
    // A5: inactive → exited là đường DUY NHẤT — kích hoạt lại = founder policy
    expect(FOUNDING_SELLER_TRANSITIONS.inactive).toEqual(["exited"]);
    // exited terminal — không có chuyển đi
    expect(FOUNDING_SELLER_TRANSITIONS.exited).toEqual([]);
  });

  it("table-driven 10×10: mọi cặp trong bảng true, mọi cặp ngoài bảng false", () => {
    for (const from of FOUNDING_SELLER_CANDIDATE_STATUSES) {
      for (const to of FOUNDING_SELLER_CANDIDATE_STATUSES) {
        const legal = FOUNDING_SELLER_TRANSITIONS[from].includes(to);
        expect(canTransitionCandidate(from, to), `${from} → ${to}`).toBe(legal);
      }
    }
  });

  it("exited terminal; self-transition false; A5 reactivation denied", () => {
    for (const to of FOUNDING_SELLER_CANDIDATE_STATUSES) {
      expect(canTransitionCandidate("exited", to)).toBe(false);
    }
    expect(canTransitionCandidate("verified", "verified")).toBe(false);
    // A5 — pin có ý: inactive → active_founding_seller KHÔNG hợp pháp
    expect(canTransitionCandidate("inactive", "active_founding_seller")).toBe(false);
  });
});

// ─── 3. maskContact — §4.8/§7.6 minimization (corrections #34 fixed-width) ────

describe("maskContact — mask contact cho console, không bao giờ trả giá trị đầy đủ", () => {
  it("email: ký tự đầu + ***@domain; local 1 ký tự → ***@domain", () => {
    expect(maskContact("email", "lienhe@example.com")).toBe("l***@example.com");
    expect(maskContact("email", "nguyen.van.an@example.com")).toBe("n***@example.com");
    expect(maskContact("email", "a@example.com")).toBe("***@example.com");
  });

  it("phone: 2 số đầu + ***** + 2 số cuối — fixed-width 9 ký tự (không leak độ dài)", () => {
    expect(maskContact("phone", "0901234567")).toBe("09*****67");
    expect(maskContact("phone", "0901234567")).toHaveLength(9);
    // 11 số và 13 số → cùng chiều dài mask 9 — độ dài thật không bị lộ
    expect(maskContact("phone", "09012345678")).toBe("09*****78");
    expect(maskContact("phone", "09012345678")).toHaveLength(9);
    expect(maskContact("phone", "0123456789012")).toBe("01*****12");
    expect(maskContact("phone", "0123456789012")).toHaveLength(9);
  });

  it("null / undefined / chuỗi rỗng → '—'", () => {
    expect(maskContact("email", null)).toBe("—");
    expect(maskContact("phone", null)).toBe("—");
    expect(maskContact("email", undefined)).toBe("—");
    expect(maskContact("phone", "")).toBe("—");
    expect(maskContact(null, null)).toBe("—");
  });

  it("channel null / email thiếu '@' / phone quá ngắn → mask toàn bộ (fail closed)", () => {
    expect(maskContact(null, "lienhe@example.com")).toBe("***");
    expect(maskContact("email", "khong-at")).toBe("***");
    expect(maskContact("phone", "123")).toBe("*****");
    expect(maskContact("phone", "09")).toBe("*****");
  });

  it("không bao giờ trả về giá trị đầy đủ (corpus email + phone)", () => {
    const emails = [
      "lienhe@example.com",
      "a@example.com",
      "ab@example.com",
      "nguyen.van.an@example.com",
    ];
    for (const e of emails) {
      const masked = maskContact("email", e);
      expect(masked).not.toBe(e);
      expect(e.includes(masked)).toBe(false);
    }
    const phones = ["0901234567", "0912345678", "0123456789012"];
    for (const p of phones) {
      const masked = maskContact("phone", p);
      expect(masked).not.toBe(p);
      expect(p.includes(masked)).toBe(false);
    }
  });
});

// ─── 4. syncFoundingSellerFunnel — ground-truth funnel sync (corrections #22) ─

describe("syncFoundingSellerFunnel — đọc ground truth, chỉ tiến, không lùi", () => {
  it("user không phải ứng viên (không có row link userId) → null", async () => {
    expect(await syncFoundingSellerFunnel(SELLER_ID)).toBeNull();
  });

  it("prospect CHƯA link (userId null) → null — không phải ứng viên của user", async () => {
    dbState.candidates.push({
      id: "cand-prospect",
      userId: null,
      status: "prospect",
      verifiedAt: null,
      firstListingAt: null,
    });
    expect(await syncFoundingSellerFunnel(SELLER_ID)).toBeNull();
  });

  it("registered + SellerVerification pending → verification_pending", async () => {
    seedCandidate("registered");
    seedVerification("pending");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "registered", to: "verification_pending", changed: true });
    expect(candidateRow()["status"]).toBe("verification_pending");
  });

  it("registered + SellerVerification needs_review → verification_pending", async () => {
    seedCandidate("registered");
    seedVerification("needs_review");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "registered", to: "verification_pending", changed: true });
  });

  it("registered + not_started/rejected/revoked hoặc KHÔNG có row → không tiến", async () => {
    for (const s of ["not_started", "rejected", "revoked"]) {
      resetDb();
      seedCandidate("registered");
      seedVerification(s);
      const res = await syncFoundingSellerFunnel(SELLER_ID);
      expect(res, `verification ${s}`).toEqual({
        from: "registered",
        to: "registered",
        changed: false,
      });
    }
    // không có row SellerVerification nào
    resetDb();
    seedCandidate("registered");
    expect(await syncFoundingSellerFunnel(SELLER_ID)).toEqual({
      from: "registered",
      to: "registered",
      changed: false,
    });
  });

  it("verification_pending + SellerVerification verified → verified + verifiedAt set", async () => {
    seedCandidate("verification_pending");
    seedVerification("verified");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "verification_pending", to: "verified", changed: true });
    expect(candidateRow()["status"]).toBe("verified");
    expect(typeof candidateRow()["verifiedAt"]).toBe("string");
    expect(candidateRow()["verifiedAt"]).not.toBe(null);
  });

  it("verified + 1 listing approved → first_listing + firstListingAt set, verifiedAt cũ GIỮ NGUYÊN", async () => {
    seedCandidate("verified", { verifiedAt: PAST });
    seedVerification("verified");
    seedListing("approved");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "verified", to: "first_listing", changed: true });
    expect(candidateRow()["status"]).toBe("first_listing");
    expect(typeof candidateRow()["firstListingAt"]).toBe("string");
    // milestone verified đã có sẵn → KHÔNG ghi đè
    expect(candidateRow()["verifiedAt"]).toBe(PAST);
  });

  it("registered + verified + listing approved → NHẢY THẲNG first_listing trong MỘT update (furthest)", async () => {
    seedCandidate("registered");
    seedVerification("verified");
    seedListing("approved");
    // EXEMPT canTransitionCandidate (corrections #22): registered → first_listing
    // KHÔNG hợp lệ trong bảng manual nhưng sync dùng thứ tự monotonic RIÊNG
    expect(canTransitionCandidate("registered", "first_listing")).toBe(false);
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "registered", to: "first_listing", changed: true });
    expect(candidateRow()["status"]).toBe("first_listing");
    expect(typeof candidateRow()["verifiedAt"]).toBe("string");
    expect(typeof candidateRow()["firstListingAt"]).toBe("string");
    // MỘT update duy nhất — không walk từng bước
    expect(dbState.candidateConditionalWrites).toBe(1);
  });

  it("concierge_onboarding + listing approved → first_listing (S4: ground truth thắng phase ops)", async () => {
    seedCandidate("concierge_onboarding");
    seedVerification("verified");
    seedListing("approved");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "concierge_onboarding", to: "first_listing", changed: true });
    expect(candidateRow()["status"]).toBe("first_listing");
  });

  it("verified + listing approved nhưng verification revoked → KHÔNG tiến (corrections #22: listing leg đi cùng 'verified')", async () => {
    seedCandidate("verified");
    seedVerification("revoked");
    seedListing("approved");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "verified", to: "verified", changed: false });
    expect(dbState.candidateConditionalWrites).toBe(0);
  });

  it("listing KHÔNG approved (pending/draft/hidden/sold/removed/archived/rejected) → không advance verified → first_listing", async () => {
    seedCandidate("verified");
    seedVerification("verified");
    for (const s of ["pending", "draft", "hidden", "sold", "removed", "archived", "rejected"]) {
      seedListing(s);
    }
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "verified", to: "verified", changed: false });
    expect(candidateRow()["status"]).toBe("verified");
    expect(dbState.candidateConditionalWrites).toBe(0);
  });

  it("first_listing + SellerVerification rejected → unchanged (sync không bao giờ lùi)", async () => {
    seedCandidate("first_listing", { verifiedAt: PAST, firstListingAt: PAST });
    seedVerification("rejected");
    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "first_listing", to: "first_listing", changed: false });
    expect(candidateRow()["status"]).toBe("first_listing");
    expect(dbState.candidateConditionalWrites).toBe(0);
  });

  it("ops states inactive/exited/active_founding_seller → SKIP hoàn toàn, kể cả khi ground truth đầy đủ", async () => {
    for (const s of ["inactive", "exited", "active_founding_seller"]) {
      resetDb();
      seedCandidate(s);
      seedVerification("verified");
      seedListing("approved");
      const res = await syncFoundingSellerFunnel(SELLER_ID);
      expect(res, `status ${s}`).toEqual({ from: s, to: s, changed: false });
      expect(candidateRow()["status"]).toBe(s);
    }
    expect(dbState.candidateConditionalWrites).toBe(0);
  });

  it("prospect/invited (defensive — pre-registration thuộc invite flow) → sync KHÔNG đụng", async () => {
    for (const s of ["prospect", "invited"]) {
      resetDb();
      seedCandidate(s);
      seedVerification("pending");
      const res = await syncFoundingSellerFunnel(SELLER_ID);
      expect(res, `status ${s}`).toEqual({ from: s, to: s, changed: false });
      expect(candidateRow()["status"]).toBe(s);
    }
    expect(dbState.candidateConditionalWrites).toBe(0);
  });

  it("idempotent: chạy lại không đổi gì đã đúng, timestamps giữ nguyên", async () => {
    seedCandidate("registered");
    seedVerification("verified");
    seedListing("approved");
    const first = await syncFoundingSellerFunnel(SELLER_ID);
    expect(first).toEqual({ from: "registered", to: "first_listing", changed: true });
    const verifiedAt = candidateRow()["verifiedAt"];
    const firstListingAt = candidateRow()["firstListingAt"];

    const second = await syncFoundingSellerFunnel(SELLER_ID);
    expect(second).toEqual({ from: "first_listing", to: "first_listing", changed: false });
    expect(candidateRow()["verifiedAt"]).toBe(verifiedAt);
    expect(candidateRow()["firstListingAt"]).toBe(firstListingAt);

    const third = await syncFoundingSellerFunnel(SELLER_ID);
    expect(third).toEqual(second);
    expect(candidateRow()["verifiedAt"]).toBe(verifiedAt);
    expect(candidateRow()["firstListingAt"]).toBe(firstListingAt);
  });

  it("CAS: candidate di chuyển song song giữa read và write → 0-row updateAll → changed false, KHÔNG retry, KHÔNG ghi đè", async () => {
    seedCandidate("registered");
    seedVerification("verified");
    seedListing("approved");
    // Operator move song song (inactive) áp TRƯỚC khi conditional write match
    dbState.concurrentCandidateMove = { status: "inactive" };

    const res = await syncFoundingSellerFunnel(SELLER_ID);
    expect(res).toEqual({ from: "registered", to: "registered", changed: false });
    // move của operator thắng — sync KHÔNG ghi đè bằng first_listing
    expect(candidateRow()["status"]).toBe("inactive");
    expect(candidateRow()["firstListingAt"]).toBe(null);
    // KHÔNG retry (corrections #22) — đúng MỘT lần conditional write
    expect(dbState.candidateConditionalWrites).toBe(1);
  });
});

// ─── 5. approvedListingCountOf — factual count (A3: KHÔNG phải "quality") ──────

describe("approvedListingCountOf — chỉ đếm listing approved của đúng seller", () => {
  it("đếm đúng theo (sellerId, status approved); seller khác / status khác không lẫn", async () => {
    seedListing("approved");
    seedListing("approved");
    seedListing("pending");
    seedListing("draft");
    seedListing("approved", "seller-2"); // seller khác

    expect(await approvedListingCountOf(SELLER_ID)).toBe(2);
    expect(await approvedListingCountOf("seller-2")).toBe(1);
    expect(await approvedListingCountOf("seller-3")).toBe(0);
  });
});

// ─── 6. candidateNeedsAssistance — D2 ops heuristic (KHÔNG phải SLA) ──────────

describe("candidateNeedsAssistance — active-funnel + (chưa liên hệ || quá 7 ngày)", () => {
  const NOW = Date.now();
  const daysAgo = (d: number) => new Date(NOW - d * DAY_MS).toISOString();

  it("chưa liên hệ + active-funnel → true", async () => {
    for (const s of [
      "invited",
      "registered",
      "verification_pending",
      "verified",
      "concierge_onboarding",
    ] as const) {
      expect(await candidateNeedsAssistance({ status: s, lastContactAt: null }), s).toBe(true);
    }
  });

  it("liên hệ 8 ngày trước → true; 2 ngày trước → false", async () => {
    expect(
      await candidateNeedsAssistance({ status: "registered", lastContactAt: daysAgo(8) }),
    ).toBe(true);
    expect(
      await candidateNeedsAssistance({ status: "verified", lastContactAt: daysAgo(2) }),
    ).toBe(false);
  });

  it("ops/terminal states → false kể cả khi chưa liên hệ (D2: chỉ active-funnel)", async () => {
    for (const s of [
      "inactive",
      "exited",
      "active_founding_seller",
      "first_listing",
    ] as const) {
      expect(await candidateNeedsAssistance({ status: s, lastContactAt: null }), s).toBe(false);
    }
  });
});

// ─── 7. Source contracts ──────────────────────────────────────────────────────

describe("founding-seller-vocab.ts — plain module client-safe (Batch 3 moderation-vocab precedent)", () => {
  it("source KHÔNG import db client / server-only marker, KHÔNG 'use server'", () => {
    const src = read("src/lib/founding-seller-vocab.ts");
    expect(src).not.toContain("server-only");
    expect(src).not.toContain("@/src/prisma");
    expect(src).not.toContain("db.client");
    expect(src).not.toContain('"use server"');
  });

  it("header mang marker PROVISIONAL / FD-3 (founder mở rộng qua Batch 8 register)", () => {
    const src = read("src/lib/founding-seller-vocab.ts");
    expect(src).toContain("PROVISIONAL");
    expect(src).toContain("FD-3");
  });
});

describe("founding-sellers.ts — server-only domain module source contract", () => {
  it("mang import server-only, KHÔNG phải action file, re-export vocabulary", () => {
    const src = read("src/lib/founding-sellers.ts");
    expect(src).toContain('import "server-only"');
    // KHÔNG phải action — directive use server chỉ dành cho action file
    expect(src).not.toContain('"use server"');
    // server consumers import mọi thứ từ một nơi (deal.ts precedent)
    expect(src).toContain('export * from "@/src/lib/founding-seller-vocab"');
  });

  it("KHÔNG có log path nào (spec §4.8 — không contact/token trong log)", () => {
    const src = read("src/lib/founding-sellers.ts");
    expect(src).not.toContain("console.log");
    expect(src).not.toContain("console.error");
    expect(src).not.toContain("console.warn");
    expect(src).not.toContain("captureEvent");
    expect(src).not.toContain("captureError");
  });

  it("module STATE rõ sync EXEMPT canTransitionCandidate (corrections #22)", () => {
    const src = read("src/lib/founding-sellers.ts");
    expect(src).toContain("canTransitionCandidate");
    expect(src).toContain("EXEMPT");
  });
});
