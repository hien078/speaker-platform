/**
 * submitReportAction — unit tests (Batch 3 plan Task 4, spec §5.5 report +
 * §5.5.1 evidence capture + §7.1 report rate limit + §7.3 cross-account
 * report access).
 *
 * Hợp đồng (plan Task 4 Step 1):
 *  1. Report hợp lệ tạo report + case + evidence + action trong MỘT tx — đúng
 *     field contract (reasonCode verbatim, classification === reasonCode,
 *     subjectUserId === sellerId, reporterUserId === reporter).
 *  2. reasonCode ngoài enum → validation error, zero db writes.
 *  3. note > 2000 → validation error.
 *  4. Rate limit 5 report / 10 phút / reporter — report thứ 6 → RATE_LIMITED,
 *     không row thứ 6 (spec §7.1 — Review Focus 4).
 *  5. Dedupe CASE-FIRST (S3): case active cho (target, reason) mà THIS reporter
 *     đã báo cáo → REPORT_ALREADY_SUBMITTED, không report/case thứ hai.
 *  6. Dedupe KHÔNG fire khi case rời active states — case actioned → báo cáo
 *     lại được, grouping tạo case MỚI (reporter re-report sau khi case đi tiếp).
 *  7. Grouping: reporter thứ hai cùng target+reason JOIN case hiện có — một
 *     case, hai report, hai evidence (spec §5.5 "may group multiple reports").
 *  8. Khác reason trên cùng target → case RIÊNG (grouping key gồm reasonCategory).
 *  9. Concurrent same-reporter double-submit → violation ([caseId, reporterId])
 *     THROW ra khỏi tx callback, classify NGOÀI (constraint name) →
 *     REPORT_ALREADY_SUBMITTED — đúng MỘT report row (S4 + Global Constraints
 *     transaction rule: catch-and-return trong callback = silent-success bug —
 *     Postgres abort tx, COMMIT thành ROLLBACK).
 * 10. Concurrent same-target-same-reason HAI reporter → cả hai land trên MỘT
 *     case (partial-index violation throw ra, classify ngoài, RETRY re-read
 *     thấy case của người thắng; hai report, hai evidence).
 * 11. Target không tồn tại (listing/user/message) → NOT_FOUND, zero writes —
 *     KHÔNG tạo case (không probe oracle).
 * 12. Message report bởi NON-participant → NOT_FOUND, zero writes (§7.3).
 * 13. Tự báo cáo (own listing / own account / own sent message) → typed error,
 *     zero writes (ba case — self-report là noise + self-suppression).
 * 14. Không session → redirect /login, zero db calls (spec §4.5).
 * 15. Snapshot null TRONG tx → rollback, NOT_FOUND, zero rows (fail closed —
 *     capture chạy TRƯỚC mọi create; target biến mất giữa validate và tx).
 * 16. (Review fix L1) Case active bị ĐÓNG concurrent giữa re-read và attach →
 *     conditional no-op update trên ModerationCase (state ∈ active) trả 0 rows
 *     → sentinel throw ra khỏi tx → RETRY toàn bộ tx MỘT lần → re-read thấy
 *     case đã đóng → tạo case active MỚI — report/evidence/action attach vào
 *     case mới, case cũ KHÔNG nhận gì (attach có điều kiện).
 * 17. (Review fix L2) Lỗi RETRY được phân loại theo constraint name —
 *     AbuseReport_caseId_reporterId_key → REPORT_ALREADY_SUBMITTED (reporter
 *     THẬT SỰ đã trên case — row của người thắng persist); race lặp lại
 *     (partial index lần hai) → REPORT_RETRY_FAILED — KHÔNG có gì persist,
 *     KHÔNG masquerade thành ALREADY_SUBMITTED.
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache +
 * next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * (requireUser/getCurrentUser trả SessionUser fixture) + db.client in-memory
 * (User/Listing/Message/Conversation/ModerationCase/AbuseReport/
 * ModerationEvidence/ModerationAction + db.transaction SNAPSHOT-RESTORE —
 * throw trong callback hoàn tác mọi create/update của tx mình, row race
 * simulation đánh dấu `_external` KHÔNG bị hoàn tác) +
 * `@/src/lib/moderation-snapshot` fixture. `@/src/lib/moderation` (vocab) và
 * `@/src/lib/rate-limit` GIỮ BẢN THẬT — resetRateLimits() mỗi test.
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

// ─── Fixtures — vi.hoisted để mock factory dùng được (vi.mock hoisted) ────────

const fixtures = vi.hoisted(() => ({
  BUYER_ID: "11111111-1111-4111-8111-111111111111",
  SELLER_ID: "22222222-2222-4222-8222-222222222222",
  OTHER_ID: "44444444-4444-4444-8444-444444444444",
  GHOST_ID: "55555555-5555-4555-8555-555555555555",
}));

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

// ─── moderation-snapshot mock — fixture snapshot theo target type ───────────

const snapshotState = vi.hoisted(() => ({
  /** true → captureTargetSnapshot trả null (target "biến mất" giữa validate và tx). */
  vanish: false,
}));

vi.mock("@/src/lib/moderation-snapshot", () => ({
  captureTargetSnapshot: vi.fn(
    async (
      targetType: "listing" | "user" | "message",
      targetId: string,
    ): Promise<{ snapshot: Record<string, unknown>; subjectUserId: string | null } | null> => {
      if (snapshotState.vanish) return null;
      if (targetType === "listing") {
        return {
          snapshot: {
            kind: "listing",
            id: targetId,
            title: "JBL Charge 5",
            price: 1_500_000,
            capturedAt: "2026-10-01T00:00:00.000Z",
          },
          subjectUserId: fixtures.SELLER_ID, // seller của listing fixture
        };
      }
      if (targetType === "user") {
        return {
          snapshot: { kind: "user", id: targetId, name: "Người Bán", capturedAt: "2026-10-01T00:00:00.000Z" },
          subjectUserId: targetId,
        };
      }
      return {
        snapshot: {
          kind: "message",
          id: targetId,
          body: "tin nhắn cần báo cáo",
          capturedAt: "2026-10-01T00:00:00.000Z",
        },
        subjectUserId: fixtures.SELLER_ID, // sender của MESSAGE fixture
      };
    },
  ),
}));

// ─── db.client mock — in-memory 8 model + tx mirror + unique enforcement ──────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  messages: [] as Row[],
  conversations: [] as Row[],
  cases: [] as Row[],
  reports: [] as Row[],
  evidence: [] as Row[],
  actions: [] as Row[],
  /**
   * Race simulation (S4): rows mà request "thắng" commit giữa chừng — consumed
   * bởi ModerationCase.create / AbuseReport.create TIẾP THEO (unique check sau
   * đó tự fire trên row vừa inject — mô phỏng đúng semantics Postgres: insert
   * thua chặn trên index entry của tx thắng, tx thắng commit → 23505), rồi clear.
   * Row inject đánh dấu `_external: true` — rollback của tx MÌNH (mock có
   * snapshot/restore) KHÔNG được undo chúng (Postgres: connection khác).
   */
  raceWinner: null as null | { case?: Row; report?: Row; evidence?: Row; action?: Row },
  /**
   * Seam L1 (review fix Task 4): id của case bị MỘT tx khác (moderator) đóng
   * CONCURRENT — khi AbuseReport.create chạy (giữa re-read và attach), case này
   * bị flip sang "closed" + đánh dấu `_external` (commit của connection khác).
   * One-shot — consume ngay khi fire.
   */
  closeCaseOnReport: null as string | null,
  /**
   * Seam L2 (review fix Task 4): true → ModerationCase.create throw partial-index
   * violation (23505) KHÔNG inject row — mô phỏng "creator khác lại thắng lần
   * nữa" cho CẢ hai lần thử (retry cũng thua → phải phân loại lỗi retry riêng).
   */
  failCaseCreate: false,
}));

vi.mock("@/src/prisma/db.client", async () => {
  const { SqlQueryError } = await import("@prisma/orm-family-sql/errors");

  type Pred = ((proxy: unknown) => unknown) | Row;

  // khớp ACTIVE_MODERATION_CASE_STATES (src/lib/moderation-vocab.ts)
  const ACTIVE_STATES = ["open", "triaged", "investigating"];

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          in: (arr: readonly unknown[]) => (arr as readonly unknown[]).includes(row[field]),
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
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { id: `row-${rows.length + 1}`, createdAt: "2026-10-01T00:00:00.000Z", ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      where: (pred: Pred) => query([pred]),
      all: () => query([]).all(),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
    };
  };

  /** Race winner (S4) — "concurrent tx" commit giữa chừng, consume MỘT lần.
   *  Row inject đánh dấu `_external` — rollback của tx mình KHÔNG undo. */
  const consumeRaceWinner = (): void => {
    const w = dbState.raceWinner;
    if (w === null) return;
    dbState.raceWinner = null;
    if (w.case !== undefined) {
      w.case["_external"] = true;
      dbState.cases.push(w.case);
    }
    if (w.report !== undefined) {
      w.report["_external"] = true;
      dbState.reports.push(w.report);
    }
    if (w.evidence !== undefined) {
      w.evidence["_external"] = true;
      dbState.evidence.push(w.evidence);
    }
    if (w.action !== undefined) {
      w.action["_external"] = true;
      dbState.actions.push(w.action);
    }
  };

  // ModerationCase — enforce partial unique index (Task 1):
  // một case active duy nhất per (targetType, targetId, reasonCategory).
  const caseModel = {
    ...makeModel(dbState.cases),
    create: async (data: Row) => {
      consumeRaceWinner();
      // Seam L2: creator khác lại thắng — violation lần nữa, KHÔNG inject row.
      if (dbState.failCaseCreate) {
        throw new SqlQueryError("mock partial unique index violation (repeat race)", {
          sqlState: "23505",
          constraint: "moderation_case_one_active_per_target_reason",
        });
      }
      const dup = dbState.cases.find(
        (r) =>
          r.targetType === data.targetType &&
          r.targetId === data.targetId &&
          r.reasonCategory === data.reasonCategory &&
          (ACTIVE_STATES as readonly string[]).includes(r.state as string),
      );
      if (dup !== undefined) {
        throw new SqlQueryError("mock partial unique index violation", {
          sqlState: "23505",
          constraint: "moderation_case_one_active_per_target_reason",
        });
      }
      const row = {
        id: `case-${dbState.cases.length + 1}`,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        state: "open",
        priority: "normal",
        assignedModeratorId: null,
        ...data,
      };
      dbState.cases.push(row);
      return { ...row };
    },
  };

  // AbuseReport — enforce @@unique([caseId, reporterId]) (Task 1).
  const reportModel = {
    ...makeModel(dbState.reports),
    create: async (data: Row) => {
      consumeRaceWinner();
      // Seam L1: case bị MỘT tx khác đóng CONCURRENT — flip + đánh dấu external
      // NGAY TRƯỚC khi report của tx mình được push (mô phỏng moderator commit
      // transition giữa re-read và attach của tx mình). One-shot.
      if (dbState.closeCaseOnReport !== null) {
        const closing = dbState.cases.find((r) => r.id === dbState.closeCaseOnReport);
        if (closing !== undefined) {
          closing.state = "closed";
          closing["_external"] = true;
        }
        dbState.closeCaseOnReport = null;
      }
      const dup = dbState.reports.find(
        (r) => r.caseId === data.caseId && r.reporterId === data.reporterId,
      );
      if (dup !== undefined) {
        throw new SqlQueryError("mock unique violation", {
          sqlState: "23505",
          constraint: "AbuseReport_caseId_reporterId_key",
        });
      }
      const row = { id: `report-${dbState.reports.length + 1}`, createdAt: "2026-10-01T00:00:00.000Z", ...data };
      dbState.reports.push(row);
      return { ...row };
    },
  };

  const models = {
    User: makeModel(dbState.users),
    Listing: makeModel(dbState.listings),
    Message: makeModel(dbState.messages),
    Conversation: makeModel(dbState.conversations),
    ModerationCase: caseModel,
    AbuseReport: reportModel,
    ModerationEvidence: makeModel(dbState.evidence),
    ModerationAction: makeModel(dbState.actions),
  };

  return {
    db: {
      orm: { public: models },
      // TRANSACTIONAL mock (review fix L1/L2): throw trong callback → HOÀN TÁC
      // mọi create/update đã chạy trong tx (snapshot trước, restore khi throw)
      // — pin đúng ngữ nghĩa rollback của Postgres (Global Constraints: violation
      // LUÔN throw ra khỏi callback; catch-and-return trong callback là
      // silent-success bug). Row đánh dấu `_external` (race simulation — commit
      // của MỘT tx khác) KHÔNG bị hoàn tác — connection khác không rollback theo.
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = new Map<string, Row[]>();
        for (const [name, rows] of Object.entries(dbState)) {
          if (Array.isArray(rows)) snapshot.set(name, rows.map((r) => ({ ...r })));
        }
        try {
          return await fn({ orm: { public: models } });
        } catch (e) {
          for (const [name, rows] of Object.entries(dbState)) {
            if (!Array.isArray(rows)) continue;
            const snap = snapshot.get(name) ?? [];
            const external = rows.filter((r) => r["_external"] === true);
            rows.length = 0;
            rows.push(...snap.map((r) => ({ ...r })));
            for (const ext of external) {
              const i = rows.findIndex((r) => r.id === ext.id);
              if (i >= 0) rows[i] = { ...ext };
              else rows.push({ ...ext });
            }
          }
          throw e;
        }
      },
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { submitReportAction, type ReportFormState } from "@/src/lib/actions/reports";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BUYER: FixtureUser = {
  id: fixtures.BUYER_ID,
  email: "mua@loaviet.test",
  name: "Người Mua",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-buyer",
};

const SELLER: FixtureUser = {
  id: fixtures.SELLER_ID,
  email: "ban@loaviet.test",
  name: "Người Bán",
  role: "seller",
  avatarUrl: null,
  isVerifiedSeller: true,
  adminRole: null,
  sessionId: "sess-seller",
};

/** Reporter thứ hai — không phải participant của CONVO. */
const OTHER: FixtureUser = {
  id: fixtures.OTHER_ID,
  email: "khac@loaviet.test",
  name: "Người Khác",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-other",
};

const LISTING: Row = {
  id: "listing-1",
  sellerId: SELLER.id,
  title: "JBL Charge 5",
  slug: "jbl-charge-5",
  status: "approved",
};

/** Listing của chính BUYER — path self-report. */
const OWN_LISTING: Row = {
  id: "listing-own",
  sellerId: BUYER.id,
  title: "Loa của tôi",
  slug: "loa-cua-toi",
  status: "approved",
};

const CONVO: Row = {
  id: "convo-1",
  listingId: LISTING.id,
  buyerId: BUYER.id,
  sellerId: SELLER.id,
};

/** Tin của SELLER trong CONVO — BUYER (participant) báo cáo được. */
const MESSAGE: Row = {
  id: "msg-1",
  conversationId: CONVO.id,
  senderId: SELLER.id,
  body: "tin nhắn của seller",
  imageUrl: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

/** Tin BUYER tự gửi — path self-report (BUYER là participant của CONVO). */
const OWN_MESSAGE: Row = {
  id: "msg-own",
  conversationId: CONVO.id,
  senderId: BUYER.id,
  body: "tin của chính tôi",
  imageUrl: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const submit = (entries: Record<string, string>): Promise<ReportFormState> =>
  submitReportAction({}, fd(entries));

const login = (user: FixtureUser): void => {
  authState.user = { ...user };
};

/** Zero-writes assertion — mọi store moderation rỗng. */
const expectZeroModerationWrites = (): void => {
  expect(dbState.cases).toHaveLength(0);
  expect(dbState.reports).toHaveLength(0);
  expect(dbState.evidence).toHaveLength(0);
  expect(dbState.actions).toHaveLength(0);
};

const seedBase = (): void => {
  for (const arr of [
    dbState.users, dbState.listings, dbState.messages, dbState.conversations,
    dbState.cases, dbState.reports, dbState.evidence, dbState.actions,
  ]) {
    arr.length = 0;
  }
  dbState.raceWinner = null;
  dbState.closeCaseOnReport = null;
  dbState.failCaseCreate = false;
  snapshotState.vanish = false;
  dbState.users.push({ ...BUYER }, { ...SELLER }, { ...OTHER });
  dbState.listings.push({ ...LISTING }, { ...OWN_LISTING });
  dbState.conversations.push({ ...CONVO });
  dbState.messages.push({ ...MESSAGE }, { ...OWN_MESSAGE });
};

beforeEach(() => {
  resetRateLimits();
  seedBase();
  login(BUYER);
});

// ─── 1. Happy path — bốn row trong MỘT tx ────────────────────────────────────

describe("submitReportAction — report hợp lệ", () => {
  it("tạo report + case + evidence + action trong MỘT tx với đúng field contract", async () => {
    const res = await submit({
      targetType: "listing",
      targetId: "listing-1",
      reasonCode: "suspected_scam",
      note: "tôi nghi đây là lừa đảo",
    });
    expect(res.success).toBeTruthy();
    expect(res.error).toBeUndefined();

    // case — grouping key (target, reason), state open, priority normal
    expect(dbState.cases).toHaveLength(1);
    expect(dbState.cases[0]).toMatchObject({
      targetType: "listing",
      targetId: "listing-1",
      reasonCategory: "suspected_scam",
      state: "open",
      priority: "normal",
    });

    // report — reporter + typed reason verbatim + note + case linkage
    expect(dbState.reports).toHaveLength(1);
    expect(dbState.reports[0]).toMatchObject({
      reporterId: BUYER.id,
      targetType: "listing",
      targetId: "listing-1",
      reasonCode: "suspected_scam",
      note: "tôi nghi đây là lừa đảo",
      caseId: dbState.cases[0]!.id,
    });

    // evidence — snapshot bất biến + subject = seller + classification = reason
    expect(dbState.evidence).toHaveLength(1);
    expect(dbState.evidence[0]).toMatchObject({
      caseId: dbState.cases[0]!.id,
      sourceResourceType: "listing",
      sourceResourceId: "listing-1",
      subjectUserId: SELLER.id,
      reporterUserId: BUYER.id,
      classification: "suspected_scam",
    });
    expect(dbState.evidence[0]!.relevantSnapshot).toEqual({
      kind: "listing",
      id: "listing-1",
      title: "JBL Charge 5",
      price: 1_500_000,
      capturedAt: "2026-10-01T00:00:00.000Z",
    });

    // action — case-scoped history, actor là user thường (KHÔNG AuditEvent — Scope Decisions)
    expect(dbState.actions).toHaveLength(1);
    expect(dbState.actions[0]).toMatchObject({
      caseId: dbState.cases[0]!.id,
      actorId: BUYER.id,
      actionType: "evidence.captured",
      targetType: "listing",
      targetId: "listing-1",
      reasonCode: "suspected_scam",
    });
  });

  it("user target hợp lệ: tồn tại + ≠ reporter → report + case (subjectUserId = target)", async () => {
    const res = await submit({ targetType: "user", targetId: SELLER.id, reasonCode: "identity_impersonation" });
    expect(res.success).toBeTruthy();
    expect(dbState.cases).toHaveLength(1);
    expect(dbState.evidence[0]).toMatchObject({
      subjectUserId: SELLER.id,
      reporterUserId: BUYER.id,
      classification: "identity_impersonation",
    });
  });

  it("message target hợp lệ (participant, không phải sender) → report + case", async () => {
    const res = await submit({ targetType: "message", targetId: "msg-1", reasonCode: "harassment" });
    expect(res.success).toBeTruthy();
    expect(dbState.cases).toHaveLength(1);
    expect(dbState.reports[0]).toMatchObject({
      targetType: "message",
      targetId: "msg-1",
      reasonCode: "harassment",
    });
    expect(dbState.evidence[0]).toMatchObject({
      sourceResourceType: "message",
      sourceResourceId: "msg-1",
      subjectUserId: SELLER.id,
    });
  });
});

// ─── 2/3. Validation — typed form error, zero writes ──────────────────────────

describe("submitReportAction — validation", () => {
  it("reasonCode ngoài enum → INVALID_REASON_CODE, zero db writes", async () => {
    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "vui_ve" });
    expect(res).toEqual({ error: "INVALID_REASON_CODE" });
    expectZeroModerationWrites();
  });

  it("targetType ngoài enum → INVALID_TARGET_TYPE, zero db writes", async () => {
    const res = await submit({ targetType: "order", targetId: "listing-1", reasonCode: "spam" });
    expect(res).toEqual({ error: "INVALID_TARGET_TYPE" });
    expectZeroModerationWrites();
  });

  it("note dài hơn 2000 → NOTE_TOO_LONG, zero db writes", async () => {
    const res = await submit({
      targetType: "listing",
      targetId: "listing-1",
      reasonCode: "suspected_scam",
      note: "x".repeat(2001),
    });
    expect(res).toEqual({ error: "NOTE_TOO_LONG" });
    expectZeroModerationWrites();
  });
});

// ─── 4. Rate limit — 5 report / 10 phút / reporter (spec §7.1) ────────────────

describe("submitReportAction — rate limit (Review Focus 4)", () => {
  it("report thứ 6 trong 10 phút → RATE_LIMITED, không row thứ 6", async () => {
    // 5 report hợp lệ — năm reason khác nhau trên cùng target (mỗi reason một case)
    const reasons = ["suspected_scam", "harassment", "spam", "counterfeit_claim", "misleading_listing"];
    for (const reasonCode of reasons) {
      const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode });
      expect(res.success).toBeTruthy();
    }
    expect(dbState.reports).toHaveLength(5);
    expect(dbState.cases).toHaveLength(5);

    const denied = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "prohibited_content" });
    expect(denied).toEqual({ error: "RATE_LIMITED" });
    expect(dbState.reports).toHaveLength(5); // không row thứ 6
    expect(dbState.cases).toHaveLength(5);
  });
});

// ─── 5/6. Dedupe — case-first (S3) ─────────────────────────────────────────────

describe("submitReportAction — dedupe case-first (S3)", () => {
  it("case active + reporter này ĐÃ báo cáo → REPORT_ALREADY_SUBMITTED, không report/case thứ hai", async () => {
    await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(dbState.cases).toHaveLength(1);

    const again = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(again).toEqual({ error: "REPORT_ALREADY_SUBMITTED" });
    expect(dbState.cases).toHaveLength(1);
    expect(dbState.reports).toHaveLength(1);
    expect(dbState.evidence).toHaveLength(1);
    expect(dbState.actions).toHaveLength(1);
  });

  it("dedupe KHÔNG fire khi case rời active states — actioned → báo cáo lại được, grouping tạo case MỚI", async () => {
    await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    // case chuyển actioned (transition action thuộc Task 6 — mutate store trực tiếp)
    dbState.cases[0]!.state = "actioned";

    const again = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(again.success).toBeTruthy();
    expect(dbState.cases).toHaveLength(2); // case MỚI — actioned case rời grouping key
    expect(dbState.cases[1]).toMatchObject({ state: "open", reasonCategory: "suspected_scam" });
    expect(dbState.reports).toHaveLength(2);
  });
});

// ─── 7/8. Grouping — key (target, reason) ──────────────────────────────────────

describe("submitReportAction — case grouping (spec §5.5)", () => {
  it("reporter thứ hai cùng target+reason JOIN case hiện có — một case, hai report, hai evidence", async () => {
    await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" }); // BUYER
    login(OTHER);
    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" }); // OTHER
    expect(res.success).toBeTruthy();

    expect(dbState.cases).toHaveLength(1); // JOIN — không case thứ hai
    expect(dbState.reports).toHaveLength(2);
    expect(dbState.evidence).toHaveLength(2);
    expect(dbState.reports.every((r) => r.caseId === dbState.cases[0]!.id)).toBe(true);
    expect(dbState.reports.map((r) => r.reporterId).sort()).toEqual([BUYER.id, OTHER.id].sort());
  });

  it("khác reason trên cùng target → case RIÊNG (grouping key gồm reasonCategory)", async () => {
    await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "harassment" });
    expect(dbState.cases).toHaveLength(2);
    expect(dbState.cases.map((c) => c.reasonCategory).sort()).toEqual(["harassment", "suspected_scam"]);
    expect(dbState.reports).toHaveLength(2);
  });
});

// ─── 9/10. Concurrent — violation THROW ra khỏi tx, classify NGOÀI (S4) ───────

describe("submitReportAction — concurrent races (Global Constraints transaction rule)", () => {
  it("same-reporter double-submit → 23505 ([caseId, reporterId]) THROW ra khỏi tx, classify NGOÀI → REPORT_ALREADY_SUBMITTED — đúng MỘT report row", async () => {
    // case active đã có (request thắng tạo), CHƯA có report của BUYER tại dedupe time
    dbState.cases.push({
      id: "case-winner",
      targetType: "listing",
      targetId: "listing-1",
      reasonCategory: "suspected_scam",
      state: "open",
      priority: "normal",
      assignedModeratorId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    // request thắng commit report (caseId, BUYER) GIỮA dedupe-read và tx-create —
    // AbuseReport.create của mình thấy row đó → unique check tự fire
    dbState.raceWinner = {
      report: {
        id: "report-winner",
        reporterId: BUYER.id,
        targetType: "listing",
        targetId: "listing-1",
        reasonCode: "suspected_scam",
        note: null,
        caseId: "case-winner",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    };

    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(res).toEqual({ error: "REPORT_ALREADY_SUBMITTED" });

    // đúng MỘT report row (của người thắng) — tx của mình abort: evidence/action
    // không được tạo, case không nhân đôi (catch-and-return trong callback sẽ là
    // silent-success bug — Postgres đã abort tx, COMMIT thành ROLLBACK)
    expect(dbState.reports).toHaveLength(1);
    expect(dbState.reports[0]!.id).toBe("report-winner");
    expect(dbState.evidence).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.cases).toHaveLength(1);
  });

  it("same-target-same-reason HAI reporter → cả hai land trên MỘT case (partial-index violation throw ra, RETRY re-read thấy case người thắng)", async () => {
    // BUYER "request thắng" — case+report+evidence+action commit giữa chừng
    // (inject khi OTHER tạo case trong tx — partial index check tự fire trên row vừa inject)
    dbState.raceWinner = {
      case: {
        id: "case-winner",
        targetType: "listing",
        targetId: "listing-1",
        reasonCategory: "suspected_scam",
        state: "open",
        priority: "normal",
        assignedModeratorId: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      report: {
        id: "report-buyer",
        reporterId: BUYER.id,
        targetType: "listing",
        targetId: "listing-1",
        reasonCode: "suspected_scam",
        note: null,
        caseId: "case-winner",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      evidence: {
        id: "evidence-buyer",
        caseId: "case-winner",
        sourceResourceType: "listing",
        sourceResourceId: "listing-1",
        relevantSnapshot: { kind: "listing", id: "listing-1" },
        subjectUserId: SELLER.id,
        reporterUserId: BUYER.id,
        classification: "suspected_scam",
        capturedAt: "2026-10-01T00:00:00.000Z",
      },
      action: {
        id: "action-buyer",
        caseId: "case-winner",
        actorId: BUYER.id,
        actionType: "evidence.captured",
        targetType: "listing",
        targetId: "listing-1",
        reasonCode: "suspected_scam",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    };

    login(OTHER);
    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(res.success).toBeTruthy();

    // MỘT case (của người thắng — OTHER JOIN qua retry), HAI report, HAI evidence
    expect(dbState.cases).toHaveLength(1);
    expect(dbState.cases[0]!.id).toBe("case-winner");
    expect(dbState.reports).toHaveLength(2);
    expect(dbState.reports.map((r) => r.reporterId).sort()).toEqual([BUYER.id, OTHER.id].sort());
    expect(dbState.evidence).toHaveLength(2);
    expect(dbState.actions).toHaveLength(2);
    expect(dbState.reports.every((r) => r.caseId === "case-winner")).toBe(true);
  });
});

// ─── 11/12/13. Target authorization (spec §7.3) ───────────────────────────────

describe("submitReportAction — target authorization (§7.3)", () => {
  it.each([
    ["listing", "listing-khong-ton-tai"],
    ["user", fixtures.GHOST_ID],
    ["message", "msg-khong-ton-tai"],
  ])("target %s không tồn tại → NOT_FOUND, zero writes (không tạo case — không probe oracle)", async (targetType, targetId) => {
    const res = await submit({ targetType, targetId, reasonCode: "suspected_scam" });
    expect(res).toEqual({ error: "NOT_FOUND" });
    expectZeroModerationWrites();
  });

  it("message report bởi NON-participant → NOT_FOUND, zero writes (cross-account report access)", async () => {
    login(OTHER); // OTHER không nằm trong CONVO (buyer BUYER, seller SELLER)
    const res = await submit({ targetType: "message", targetId: "msg-1", reasonCode: "harassment" });
    expect(res).toEqual({ error: "NOT_FOUND" });
    expectZeroModerationWrites();
  });

  it("tự báo cáo listing của mình → CANNOT_REPORT_SELF, zero writes", async () => {
    const res = await submit({ targetType: "listing", targetId: "listing-own", reasonCode: "suspected_scam" });
    expect(res).toEqual({ error: "CANNOT_REPORT_SELF" });
    expectZeroModerationWrites();
  });

  it("tự báo cáo tài khoản của mình → CANNOT_REPORT_SELF, zero writes", async () => {
    const res = await submit({ targetType: "user", targetId: BUYER.id, reasonCode: "identity_impersonation" });
    expect(res).toEqual({ error: "CANNOT_REPORT_SELF" });
    expectZeroModerationWrites();
  });

  it("tự báo cáo tin nhắn mình gửi → CANNOT_REPORT_SELF, zero writes", async () => {
    const res = await submit({ targetType: "message", targetId: "msg-own", reasonCode: "harassment" });
    expect(res).toEqual({ error: "CANNOT_REPORT_SELF" });
    expectZeroModerationWrites();
  });
});

// ─── 14. Backend authorization — session bắt buộc (spec §4.5) ────────────────

describe("submitReportAction — backend authorization", () => {
  it("không session → redirect /login, zero db calls", async () => {
    authState.user = null;
    await expect(
      submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" }),
    ).rejects.toThrow("NEXT_REDIRECT:/login");
    expectZeroModerationWrites();
  });
});

// ─── 15. Snapshot null TRONG tx — fail closed ─────────────────────────────────

describe("submitReportAction — capture fail-closed", () => {
  it("snapshot null TRONG tx → rollback, NOT_FOUND, zero rows (capture TRƯỚC mọi create)", async () => {
    // listing-1 TỒN TẠI (validate pass) nhưng capture trả null — target biến mất
    // giữa validate và tx (race) → throw ra khỏi callback → tx rollback → NOT_FOUND
    snapshotState.vanish = true;
    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(res).toEqual({ error: "NOT_FOUND" });
    expectZeroModerationWrites();
  });
});

// ─── 16/17. Review fix L1/L2 — case đóng concurrent + lỗi retry phân loại ─────

describe("submitReportAction — review fix L1: case bị đóng giữa re-read và attach", () => {
  it("case active bị CLOSE concurrent (ngay sau re-read, trước attach) → RETRY tạo case MỚI — report/evidence/action trên case mới, case cũ KHÔNG nhận gì", async () => {
    // case active đã có từ trước (moderator sẽ đóng nó đúng lúc tx mình attach)
    dbState.cases.push({
      id: "case-closing",
      targetType: "listing",
      targetId: "listing-1",
      reasonCategory: "suspected_scam",
      state: "open",
      priority: "normal",
      assignedModeratorId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    // seam: khi AbuseReport.create chạy, "tx khác" (moderator transition) commit
    // đóng case này — mô phỏng KHÔNG lock giữa re-read và AbuseReport.create.
    dbState.closeCaseOnReport = "case-closing";

    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });
    expect(res.success).toBeTruthy();
    expect(res.error).toBeUndefined();

    // case cũ: closed (commit của moderator) — KHÔNG nhận report/evidence/action
    // nào của tx đã rollback (attach có ĐIỀU KIỆN trên state active).
    const oldCase = dbState.cases.find((c) => c.id === "case-closing")!;
    expect(oldCase.state).toBe("closed");

    // case MỚI active nhận đủ report + evidence + action (retry re-read thấy case
    // cũ đã đóng → tạo case active mới cho grouping key).
    expect(dbState.cases).toHaveLength(2);
    const fresh = dbState.cases.find((c) => c.id !== "case-closing")!;
    expect(fresh).toMatchObject({
      state: "open",
      targetType: "listing",
      targetId: "listing-1",
      reasonCategory: "suspected_scam",
    });
    expect(dbState.reports).toHaveLength(1);
    expect(dbState.reports[0]).toMatchObject({ caseId: fresh.id, reporterId: BUYER.id });
    expect(dbState.evidence).toHaveLength(1);
    expect(dbState.evidence[0]!.caseId).toBe(fresh.id);
    expect(dbState.actions).toHaveLength(1);
    expect(dbState.actions[0]!.caseId).toBe(fresh.id);
  });
});

describe("submitReportAction — review fix L2: lỗi retry KHÔNG masquerade thành ALREADY_SUBMITTED", () => {
  it("retry thua với AbuseReport_caseId_reporterId_key (double-submit cùng reporter qua race case-create) → REPORT_ALREADY_SUBMITTED — đúng MỘT report (của người thắng)", async () => {
    // BUYER "request thắng" tạo case + report giữa chừng (inject khi tx mình tạo
    // case — partial index fire trên row vừa inject).
    dbState.raceWinner = {
      case: {
        id: "case-winner",
        targetType: "listing",
        targetId: "listing-1",
        reasonCategory: "suspected_scam",
        state: "open",
        priority: "normal",
        assignedModeratorId: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      report: {
        id: "report-winner",
        reporterId: BUYER.id,
        targetType: "listing",
        targetId: "listing-1",
        reasonCode: "suspected_scam",
        note: null,
        caseId: "case-winner",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    };

    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });

    // Retry re-read JOIN case người thắng → AbuseReport.create violate
    // (caseId, reporterId) — reporter THẬT SỰ đã trên case (row của người thắng
    // persist) → ALREADY_SUBMITTED là ĐÚNG semantics ở đây.
    expect(res).toEqual({ error: "REPORT_ALREADY_SUBMITTED" });
    expect(dbState.reports).toHaveLength(1);
    expect(dbState.reports[0]!.id).toBe("report-winner");
    expect(dbState.evidence).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.cases).toHaveLength(1);
  });

  it("retry cũng thua race case-create (partial index LẦN HAI) → REPORT_RETRY_FAILED — KHÔNG có gì persist, KHÔNG báo ALREADY_SUBMITTED", async () => {
    // Creator khác lại thắng cả lần thử thứ hai — KHÔNG có gì của reporter persist
    // (cả hai tx đều rollback ở create). Báo REPORT_ALREADY_SUBMITTED là SAI
    // (misleading — reviewer L2): phải là lỗi riêng để user thử lại.
    dbState.failCaseCreate = true;

    const res = await submit({ targetType: "listing", targetId: "listing-1", reasonCode: "suspected_scam" });

    expect(res).toEqual({ error: "REPORT_RETRY_FAILED" });
    expectZeroModerationWrites(); // nothing persisted — KHÔNG silent-success
  });
});
