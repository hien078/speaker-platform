/**
 * recordAppealAction — unit tests (Batch 3 plan Task 7, spec §9 Batch 3
 * "appeal foundation" + §5.5 appealed state + §7.3 IDOR + §4.11/A4 fail-closed).
 *
 * Hợp đồng (plan Task 7 Step 1):
 *  1. Subject của case ĐÃ actioned kháng cáo được — Appeal row tạo, case →
 *     `appealed`, ModerationAction("appeal.recorded") append (case-scoped
 *     history — actor là user thường, KHÔNG AuditEvent — Scope Decisions).
 *  2. Subject resolved từ ModerationEvidence.subjectUserId BẤT BIẾN (S7) —
 *     xóa/sửa source listing SAU report, subject vẫn kháng cáo được; live
 *     lookup getCaseSubjectUserId CHỈ là fallback khi case không có evidence
 *     (và fail closed — null — khi cả hai đường đều mất).
 *  3. NON-subject → NOT_FOUND — CÙNG thông báo như case không tồn tại
 *     (Review Focus 3 — không existence oracle cho case của người khác).
 *  4. Case KHÔNG actioned (open/triaged/investigating/dismissed/closed/appealed)
 *     → APPEAL_NOT_AVAILABLE (A4 fail-closed — table-driven; mọi quy tắc khác
 *     thời hạn/re-appeal = POLICY = Ambiguities A4, KHÔNG phát minh).
 *  5. Appeal thứ hai cho cùng case → ALREADY_APPEALED (pre-check); concurrent
 *     double-appeal → Appeal_caseId_key violation THROW ra khỏi tx callback,
 *     classify NGOÀI (constraint name) → ALREADY_APPEALED — KHÔNG BAO GIỜ
 *     catch-and-return trong callback (silent-success bug — Global Constraints
 *     transaction rule: Postgres abort tx, COMMIT thành ROLLBACK).
 *  6. Statement vượt cap APPEAL_STATEMENT_MAX_LENGTH → validation error,
 *     zero writes.
 *  7. Concurrent: case rời khỏi actioned giữa check và claim → CAS
 *     (.where({ id, state: "actioned" })) 0 rows → CASE_ALREADY_MOVED throw ra
 *     khỏi callback → tx rollback — KHÔNG có Appeal row nào persist.
 *  8. Không session → redirect /login, zero db calls (spec §4.5).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache +
 * next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * (requireUser/getCurrentUser trả SessionUser fixture) + db.client in-memory
 * (User/Listing/Message/ModerationCase/ModerationEvidence/Appeal/
 * ModerationAction + db.transaction SNAPSHOT-RESTORE — throw trong callback
 * hoàn tác mọi create/update của tx mình, row race simulation đánh dấu
 * `_external` KHÔNG bị hoàn tác). `@/src/lib/moderation` (guard +
 * getCaseSubjectUserId) và `@/src/lib/moderation-vocab` GIỮ BẢN THẬT —
 * fallback live lookup chạy thật trên db mock.
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
  SUBJECT_ID: "22222222-2222-4222-8222-222222222222", // seller — subject của case
  OTHER_ID: "44444444-4444-4444-8444-444444444444", // non-subject
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

// ─── db.client mock — in-memory 7 model + tx mirror + unique enforcement ─────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  messages: [] as Row[],
  cases: [] as Row[],
  evidence: [] as Row[],
  appeals: [] as Row[],
  actions: [] as Row[],
  /**
   * Race simulation (concurrent double-appeal): request "thắng" commit Appeal
   * row cho case GIỮA pre-check và Appeal.create của tx mình — consume NGAY
   * khi Appeal.create chạy (unique check sau đó tự fire trên row vừa inject —
   * mô phỏng đúng semantics Postgres: insert thua chặn trên index entry của tx
   * thắng → 23505 Appeal_caseId_key). Row inject đánh dấu `_external: true` —
   * rollback của tx MÌNH (mock có snapshot/restore) KHÔNG được undo.
   */
  raceAppealWinner: null as null | { caseId: string; appellantId: string },
  /**
   * Race simulation (case moved off actioned): MỘT tx khác (moderator) đóng
   * case CONCURRENT — khi Appeal.create của tx mình chạy, case bị flip sang
   * "closed" + đánh dấu `_external` (commit của connection khác) → claim
   * .where({ id, state: "actioned" }) của tx mình 0 rows → CASE_ALREADY_MOVED.
   * One-shot — consume ngay khi fire.
   */
  closeCaseOnAppeal: null as string | null,
}));

vi.mock("@/src/prisma/db.client", async () => {
  const { SqlQueryError } = await import("@prisma/orm-family-sql/errors");

  type Pred = ((proxy: unknown) => unknown) | Row;

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
      // select là projection — mock trả nguyên row (caller chỉ đọc field đã chọn)
      select: (..._fields: string[]) => query(preds),
      orderBy: () => query(preds),
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
        const row = {
          id: `row-${rows.length + 1}`,
          createdAt: "2026-10-01T00:00:00.000Z",
          ...data,
        };
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

  /** Race winner — "concurrent tx" commit giữa chừng, consume MỘT lần. */
  const consumeRaceWinner = (): void => {
    const w = dbState.raceAppealWinner;
    if (w === null) return;
    dbState.raceAppealWinner = null;
    dbState.appeals.push({
      id: "appeal-winner",
      caseId: w.caseId,
      appellantId: w.appellantId,
      statement: null,
      state: "submitted",
      createdAt: "2026-10-01T00:00:00.000Z",
      closedAt: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      _external: true,
    });
  };

  /** Seam case-closed — moderator đóng case concurrent, consume MỘT lần. */
  const consumeCloseCase = (): void => {
    const caseId = dbState.closeCaseOnAppeal;
    if (caseId === null) return;
    dbState.closeCaseOnAppeal = null;
    const closing = dbState.cases.find((r) => r.id === caseId);
    if (closing !== undefined) {
      closing.state = "closed";
      closing["_external"] = true;
    }
  };

  // Appeal — enforce @unique caseId (Task 1: Appeal_caseId_key — one-to-one).
  const appealModel = {
    ...makeModel(dbState.appeals),
    create: async (data: Row) => {
      // Race seams fire NGAY TRƯỚC unique check — mô phỏng commit của
      // connection khác giữa chừng tx của mình.
      consumeCloseCase();
      consumeRaceWinner();
      const dup = dbState.appeals.find((r) => r.caseId === data.caseId);
      if (dup !== undefined) {
        throw new SqlQueryError("mock unique violation (Appeal_caseId_key)", {
          sqlState: "23505",
          constraint: "Appeal_caseId_key",
        });
      }
      const row = {
        id: `appeal-${dbState.appeals.length + 1}`,
        state: "submitted",
        closedAt: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
        createdAt: "2026-10-01T00:00:00.000Z",
        ...data,
      };
      dbState.appeals.push(row);
      return { ...row };
    },
  };

  const models = {
    User: makeModel(dbState.users),
    Listing: makeModel(dbState.listings),
    Message: makeModel(dbState.messages),
    ModerationCase: makeModel(dbState.cases),
    ModerationEvidence: makeModel(dbState.evidence),
    Appeal: appealModel,
    ModerationAction: makeModel(dbState.actions),
  };

  return {
    db: {
      orm: { public: models },
      // TRANSACTIONAL mock: throw trong callback → HOÀN TÁC mọi create/update
      // đã chạy trong tx (snapshot trước, restore khi throw) — pin đúng ngữ
      // nghĩa rollback của Postgres (Global Constraints: violation LUÔN
      // throw ra khỏi callback; catch-and-return trong callback là
      // silent-success bug). Row đánh dấu `_external` (race simulation —
      // commit của MỘT tx khác) KHÔNG bị hoàn tác — connection khác không
      // rollback theo.
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

import { recordAppealAction, type AppealFormState } from "@/src/lib/actions/appeals";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SUBJECT: FixtureUser = {
  id: fixtures.SUBJECT_ID,
  email: "subject@loaviet.test",
  name: "Người Bị Báo Cáo",
  role: "seller",
  avatarUrl: null,
  isVerifiedSeller: true,
  adminRole: null,
  sessionId: "sess-subject",
};

/** Non-subject — không phải subject của case nào trong fixture. */
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
  sellerId: SUBJECT.id,
  title: "JBL Charge 5",
  slug: "jbl-charge-5",
  status: "approved",
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const appeal = (entries: Record<string, string>): Promise<AppealFormState> =>
  recordAppealAction({}, fd(entries));

const login = (user: FixtureUser): void => {
  authState.user = { ...user };
};

/** Zero-writes assertion — appeal + action store rỗng. */
const expectZeroAppealWrites = (): void => {
  expect(dbState.appeals).toHaveLength(0);
  expect(dbState.actions).toHaveLength(0);
};

const seedBase = (): void => {
  for (const arr of [
    dbState.users, dbState.listings, dbState.messages,
    dbState.cases, dbState.evidence, dbState.appeals, dbState.actions,
  ]) {
    arr.length = 0;
  }
  dbState.raceAppealWinner = null;
  dbState.closeCaseOnAppeal = null;
  dbState.users.push({ ...SUBJECT }, { ...OTHER });
  dbState.listings.push({ ...LISTING });
};

/** Case fixture — mặc định actioned (điều kiện kháng cáo), target listing-1. */
const seedCase = (over: Partial<Row>): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `case-${dbState.cases.length + 1}`,
    targetType: "listing",
    targetId: "listing-1",
    reasonCategory: "suspected_scam",
    state: "actioned",
    priority: "normal",
    assignedModeratorId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
  dbState.cases.push(row);
  return row;
};

/** Evidence fixture — subjectUserId BẤT BIẾN chụp tại report time (S7). */
const seedEvidence = (caseId: string, subjectUserId: string | null): Row => {
  const row: Row = {
    id: `ev-${dbState.evidence.length + 1}`,
    caseId,
    sourceResourceType: "listing",
    sourceResourceId: "listing-1",
    relevantSnapshot: { kind: "listing", title: "JBL Charge 5" },
    capturedAt: "2026-10-01T00:00:00.000Z",
    subjectUserId,
    reporterUserId: fixtures.OTHER_ID,
    classification: "suspected_scam",
  };
  dbState.evidence.push(row);
  return row;
};

beforeEach(() => {
  seedBase();
  login(SUBJECT);
});

// ─── 1. Happy path — subject kháng cáo case actioned ─────────────────────────

describe("recordAppealAction — subject kháng cáo case actioned", () => {
  it("tạo Appeal + case → appealed + ModerationAction(appeal.recorded) trong MỘT tx", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);

    const res = await appeal({ caseId: c.id, statement: "Tôi không làm vậy đúng không" });
    expect(res.success).toBeTruthy();
    expect(res.error).toBeUndefined();

    // Appeal — appellant là subject, statement verbatim, state submitted
    expect(dbState.appeals).toHaveLength(1);
    expect(dbState.appeals[0]).toMatchObject({
      caseId: c.id,
      appellantId: SUBJECT.id,
      statement: "Tôi không làm vậy đúng không",
      state: "submitted",
    });

    // Case → appealed (atomic cùng tx — S6: appeal link trỏ vào case nhất quán)
    expect(dbState.cases[0]).toMatchObject({ id: c.id, state: "appealed" });

    // Case-scoped history — actor là user thường (KHÔNG AuditEvent — Scope
    // Decisions; reasonCode/note null — appeal không có typed decision reason)
    expect(dbState.actions).toHaveLength(1);
    expect(dbState.actions[0]).toMatchObject({
      caseId: c.id,
      actorId: SUBJECT.id,
      actionType: "appeal.recorded",
      targetType: "moderation_case",
      targetId: c.id,
      reasonCode: null,
      note: null,
    });
  });

  it("statement để trống → Appeal row với statement null (tuỳ chọn)", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);

    const res = await appeal({ caseId: c.id });
    expect(res.success).toBeTruthy();
    expect(dbState.appeals[0]).toMatchObject({
      caseId: c.id,
      appellantId: SUBJECT.id,
      statement: null,
      state: "submitted",
    });
    expect(dbState.cases[0]).toMatchObject({ state: "appealed" });
  });
});

// ─── 2. Subject từ evidence BẤT BIẾN, không phải live data (S7) ──────────────

describe("recordAppealAction — subject resolved từ evidence (S7)", () => {
  it("source listing ĐÃ BỊ XÓA sau report → subject vẫn kháng cáo được (evidence mang subject)", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);
    // Xóa source SAU report (trước appeal) — live lookup sẽ trả null, evidence
    // vẫn mang subjectUserId (spec §5.5.1: evidence sống qua source delete).
    dbState.listings.length = 0;

    const res = await appeal({ caseId: c.id, statement: "kháng cáo" });
    expect(res.success).toBeTruthy();
    expect(dbState.appeals).toHaveLength(1);
    expect(dbState.cases[0]).toMatchObject({ state: "appealed" });
  });

  it("case KHÔNG có evidence → fallback live lookup getCaseSubjectUserId (seller của listing)", async () => {
    const c = seedCase({});
    // không seed evidence — fallback chạy thật trên db mock

    const res = await appeal({ caseId: c.id, statement: "kháng cáo" });
    expect(res.success).toBeTruthy();
    expect(dbState.appeals[0]).toMatchObject({
      caseId: c.id,
      appellantId: SUBJECT.id, // Listing.sellerId qua fallback
    });
  });

  it("case không evidence VÀ source đã biến mất → subjectUserId null → NOT_FOUND (fail closed)", async () => {
    const c = seedCase({});
    dbState.listings.length = 0; // cả hai đường đều mất

    const res = await appeal({ caseId: c.id, statement: "kháng cáo" });
    expect(res).toEqual({ error: "NOT_FOUND" });
    expectZeroAppealWrites();
    expect(dbState.cases[0]).toMatchObject({ state: "actioned" }); // không đổi
  });
});

// ─── 3. IDOR — non-subject như case không tồn tại (Review Focus 3) ────────────

describe("recordAppealAction — IDOR (Review Focus 3)", () => {
  it("non-subject → NOT_FOUND — CÙNG thông báo như case không tồn tại", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);
    login(OTHER); // không phải subject

    const res = await appeal({ caseId: c.id, statement: "cho tôi kháng cáo với" });
    expect(res).toEqual({ error: "NOT_FOUND" });
    expectZeroAppealWrites();
    expect(dbState.cases[0]).toMatchObject({ state: "actioned" }); // không đổi
  });

  it("case không tồn tại → NOT_FOUND, zero writes (không probe oracle)", async () => {
    const res = await appeal({ caseId: "case-khong-ton-tai", statement: "..." });
    expect(res).toEqual({ error: "NOT_FOUND" });
    expectZeroAppealWrites();
  });
});

// ─── 4. Non-actioned → APPEAL_NOT_AVAILABLE (A4 fail-closed) ─────────────────

describe("recordAppealAction — chỉ case actioned mới kháng cáo được (A4)", () => {
  it.each(["open", "triaged", "investigating", "dismissed", "closed", "appealed"])(
    "case state %s → APPEAL_NOT_AVAILABLE, zero writes",
    async (state) => {
      const c = seedCase({ state });
      seedEvidence(c.id, SUBJECT.id);

      const res = await appeal({ caseId: c.id, statement: "kháng cáo" });
      expect(res).toEqual({ error: "APPEAL_NOT_AVAILABLE" });
      expectZeroAppealWrites();
      expect(dbState.cases[0]).toMatchObject({ state }); // giữ nguyên
    },
  );
});

// ─── 5. Dedupe — pre-check + concurrent 23505 (Global Constraints) ───────────

describe("recordAppealAction — dedupe một appeal / case", () => {
  it("đã có Appeal cho case → ALREADY_APPEALED (pre-check), zero writes", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);
    dbState.appeals.push({
      id: "appeal-first",
      caseId: c.id,
      appellantId: SUBJECT.id,
      statement: null,
      state: "submitted",
      createdAt: "2026-10-01T00:00:00.000Z",
      closedAt: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });

    const res = await appeal({ caseId: c.id, statement: "kháng cáo lần nữa" });
    expect(res).toEqual({ error: "ALREADY_APPEALED" });
    expect(dbState.appeals).toHaveLength(1); // không appeal thứ hai
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.cases[0]).toMatchObject({ state: "actioned" }); // không đổi
  });

  it("concurrent double-appeal → Appeal_caseId_key violation THROW ra khỏi tx, classify NGOÀI → ALREADY_APPEALED — đúng MỘT Appeal row", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);
    // Request thắng commit Appeal cho case GIỮA pre-check và Appeal.create
    // của tx mình — unique check tự fire trên row vừa inject (23505).
    dbState.raceAppealWinner = { caseId: c.id, appellantId: SUBJECT.id };

    const res = await appeal({ caseId: c.id, statement: "kháng cáo" });
    expect(res).toEqual({ error: "ALREADY_APPEALED" });

    // Đúng MỘT row — của người thắng (row của tx mình bị rollback; catch-and-
    // return trong callback sẽ là silent-success bug — Global Constraints).
    expect(dbState.appeals).toHaveLength(1);
    expect(dbState.appeals[0]).toMatchObject({
      id: "appeal-winner",
      caseId: c.id,
      appellantId: SUBJECT.id,
    });
    // Case KHÔNG bị tx mình claim (violation ném ra trước claim) — giữ actioned.
    expect(dbState.cases[0]).toMatchObject({ state: "actioned" });
    expect(dbState.actions).toHaveLength(0);
  });
});

// ─── 6. Statement cap — validation error, zero writes ────────────────────────

describe("recordAppealAction — statement cap", () => {
  it("statement dài hơn 4000 → STATEMENT_TOO_LONG, zero writes", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);

    const res = await appeal({ caseId: c.id, statement: "x".repeat(4001) });
    expect(res).toEqual({ error: "STATEMENT_TOO_LONG" });
    expectZeroAppealWrites();
    expect(dbState.cases[0]).toMatchObject({ state: "actioned" }); // không đổi
  });
});

// ─── 7. Concurrent case move — CAS 0 rows → CASE_ALREADY_MOVED ───────────────

describe("recordAppealAction — case đổi tay giữa check và claim (spec §10.1)", () => {
  it("case bị đóng CONCURRENT → claim 0 rows → CASE_ALREADY_MOVED throw ra khỏi tx, KHÔNG Appeal row nào persist", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SUBJECT.id);
    // Moderator đóng case CONCURRENT — flip NGAY khi Appeal.create của tx
    // mình chạy (giữa create và claim): claim .where(state: "actioned") 0 rows.
    dbState.closeCaseOnAppeal = c.id;

    // CASE_ALREADY_MOVED propagate (KHÔNG phải form state — lỗi concurrent
    // nghiêm trọng hơn một message; tx rollback hoàn tác Appeal vừa create).
    await expect(appeal({ caseId: c.id, statement: "kháng cáo" })).rejects.toThrowError(
      /CASE_ALREADY_MOVED/,
    );

    // KHÔNG có Appeal row nào persist — Appeal.create của tx mình bị hoàn tác
    // bởi rollback (nếu catch-and-return trong callback: row appeal của tx
    // mình đã push + case "closed" external → silent-success bug — test fail).
    expect(dbState.appeals).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    // Case giữ trạng thái của connection khác ("closed" — external, KHÔNG bị
    // rollback theo tx mình).
    expect(dbState.cases[0]).toMatchObject({ state: "closed" });
  });
});

// ─── 8. Không session → redirect, zero db calls ──────────────────────────────

describe("recordAppealAction — authorization (spec §4.5)", () => {
  it("không session → redirect /login, zero db writes", async () => {
    authState.user = null;

    await expect(appeal({ caseId: "case-1", statement: "kháng cáo" })).rejects.toThrowError(
      /NEXT_REDIRECT:\/login/,
    );
    expectZeroAppealWrites();
    expect(dbState.cases).toHaveLength(0); // không read nào chạy sau redirect
  });
});
