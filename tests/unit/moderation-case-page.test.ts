/**
 * Case detail page — RECUSAL ON VIEWS (review fix Task 6 item 3, spec §5.5.1
 * evidence + §4.5 backend authorization + retaliation-risk recusal A7).
 *
 * Hợp đồng:
 *  1. Moderator KHÔNG conflicted (không là subject/reporter của case) →
 *     render đầy đủ: tên reporter, note, evidence snapshot, subject id;
 *     mỗi render ghi audit moderation.evidence_viewed (spec §5.5.1).
 *  2. Viewer là SUBJECT của case (moderator bị báo cáo) → notFound() —
 *     KHÔNG render gì, và CÁC READ PHỤC VỤ RENDER (reports/evidence/actions/
 *     appeal) KHÔNG chạy — chỉ read tối thiểu của conflict check chạy.
 *  3. Viewer là REPORTER của case → notFound() — cùng posture (retaliation:
 *     subject/reporter cầm report.resolve không thấy danh tính người kia).
 *  4. Conflicted viewer → KHÔNG có audit evidence_viewed (không xem thì
 *     không ghi vết xem).
 *
 * Cơ chế mock như admin-listings-guard.test.ts (session seam qua
 * getSessionFromCookie — rbac THẬT chạy) + db in-memory CÓ READ LOG (mỗi
 * terminal first/all đẩy `${model}:${op}` — assert read nào đã chạy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Session seam — requireCapability (rbac THẬT) đọc qua getSessionFromCookie.
const sessionState = vi.hoisted(() => ({
  current: null as
    | { session: Record<string, unknown>; user: Record<string, unknown> }
    | null,
}));

vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(async () => sessionState.current),
  markSessionSteppedUp: vi.fn(),
  stepUpIsFresh: vi.fn(() => false),
  createSession: vi.fn(),
  revokeSession: vi.fn(),
}));

// ─── db.client mock — in-memory + READ LOG (assert read nào đã chạy) ──────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  cases: [] as Array<Record<string, unknown>>,
  evidence: [] as Array<Record<string, unknown>>,
  reports: [] as Array<Record<string, unknown>>,
  actions: [] as Array<Record<string, unknown>>,
  appeals: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
  /** Mỗi terminal read đẩy `${model}:${op}` — conflict check dùng first, render dùng all. */
  readLog: [] as string[],
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
          in: (values: readonly unknown[]) =>
            Array.isArray(values) && values.includes(row[field]),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  /** attach: gắn quan hệ include (reporter/actor/appellant) từ store users. */
  const ATTACH: Record<string, string> = {
    reporter: "reporterId",
    actor: "actorId",
    appellant: "appellantId",
  };

  const makeModel = (name: string, rows: Row[]) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      select: (..._fields: string[]) => query(preds, includeRel),
      orderBy: () => query(preds, includeRel),
      limit: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        dbState.readLog.push(`${name}:first`);
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        if (includeRel != null && includeRel in ATTACH) {
          const fk = ATTACH[includeRel]!;
          copy[includeRel] =
            dbState.users.find((u) => u["id"] === copy[fk]) ?? null;
        }
        return copy;
      },
      all: async () => {
        dbState.readLog.push(`${name}:all`);
        return rows
          .filter((r) => preds.every((p) => matches(r, p)))
          .map((r) => {
            const copy = { ...r };
            if (includeRel != null && includeRel in ATTACH) {
              const fk = ATTACH[includeRel]!;
              copy[includeRel] =
                dbState.users.find((u) => u["id"] === copy[fk]) ?? null;
            }
            return copy;
          });
      },
      create: async (data: Row) => {
        const row = { id: `${name}-${rows.length + 1}`, createdAt: new Date().toISOString(), ...data };
        rows.push(row);
        return { ...row };
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      include: (rel: string) => query([], rel),
      select: (...fields: string[]) => query([]).select(...fields),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const models = {
    User: makeModel("User", dbState.users),
    ModerationCase: makeModel("ModerationCase", dbState.cases),
    ModerationEvidence: makeModel("ModerationEvidence", dbState.evidence),
    AbuseReport: makeModel("AbuseReport", dbState.reports),
    ModerationAction: makeModel("ModerationAction", dbState.actions),
    Appeal: makeModel("Appeal", dbState.appeals),
    AuditEvent: makeModel("AuditEvent", dbState.audits),
    Listing: makeModel("Listing", dbState.listings),
    UserSuspension: makeModel("UserSuspension", dbState.suspensions),
  };

  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: models } }),
    },
  };
});

import * as casePage from "../../app/admin/moderation/[id]/page";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const mkUser = (over: Partial<Row>): Row & { id: string } => ({
  id: "user-x",
  email: "x@loaviet.test",
  name: "X",
  role: "buyer",
  adminRole: null,
  ...over,
});

/** Moderator thường — KHÔNG liên quan case. */
const ADMIN_MOD = mkUser({ id: "admin-mod", name: "Mod", role: "admin", adminRole: "moderator" });
/** Moderator VỪA là seller của listing bị báo cáo — SUBJECT của case. */
const MOD_SELLER = mkUser({ id: "mod-seller", name: "ModSeller", role: "seller", adminRole: "moderator" });
/** Moderator VỪA là người báo cáo — REPORTER của case. */
const MOD_REPORTER = mkUser({ id: "mod-reporter", name: "ModReporter", role: "admin", adminRole: "moderator" });
const SELLER = mkUser({ id: "seller-1", name: "Seller", role: "seller" });
const BUYER = mkUser({ id: "buyer-1", name: "Người Báo Cáo", role: "buyer" });

const SESSION = {
  id: "sess-1",
  userId: "irrelevant",
  isAdmin: true,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-10-07T20:00:00.000Z",
  steppedUpAt: null,
  userAgent: null,
} as const;

/** Login admin — session.isAdmin true (qua MFA), adminRole từ user. */
const login = (user: Row): void => {
  sessionState.current = {
    session: { ...SESSION },
    user: { ...user, sessionId: SESSION.id },
  };
};

const CASE_ID = "case-1";
const LISTING_ID = "listing-1";

/** Case về listing của SELLER — evidence subject SELLER, reporter BUYER. */
const seedCase = (): void => {
  dbState.cases.push({
    id: CASE_ID,
    targetType: "listing",
    targetId: LISTING_ID,
    state: "investigating",
    priority: "normal",
    assignedModeratorId: null,
    reasonCategory: "suspected_scam",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  dbState.evidence.push({
    id: "ev-1",
    caseId: CASE_ID,
    sourceResourceType: "listing",
    sourceResourceId: LISTING_ID,
    capturedAt: "2026-10-01T00:00:00.000Z",
    relevantSnapshot: { kind: "listing", title: "Loa JBL GIẢ", description: "Hàng nhái" },
    subjectUserId: SELLER.id,
    reporterUserId: BUYER.id,
    classification: "suspected_scam",
  });
  dbState.reports.push({
    id: "rep-1",
    caseId: CASE_ID,
    reporterId: BUYER.id,
    targetType: "listing",
    targetId: LISTING_ID,
    reasonCode: "suspected_scam",
    note: "Tôi bị lừa đảo bởi tin này",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  dbState.listings.push({
    id: LISTING_ID,
    sellerId: SELLER.id,
    title: "Loa JBL GIẢ",
    slug: "loa-jbl-gia",
    status: "approved",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
};

type PageFn = (props: { params: Promise<{ id: string }> }) => Promise<unknown>;
const AdminModerationCasePage = casePage.default as unknown as PageFn;
const call = (caseId: string) => AdminModerationCasePage({ params: Promise.resolve({ id: caseId }) });

// ─── React element tree helpers (async server component return value) ──────

type ElementLike = { type?: unknown; props?: { children?: unknown } | null };

/** Toàn bộ text trong tree — assert nội dung render ra. */
function textOf(node: unknown): string {
  const parts: string[] = [];
  const collect = (n: unknown): void => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (typeof n === "object" && n !== null) {
      collect((n as ElementLike).props?.children);
    }
  };
  collect(node);
  return parts.join(" ");
}

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;

/** Các read PHỤC VỤ RENDER (danh tính reporter/evidence/appellant/history). */
const RENDER_READS = [
  "AbuseReport:all",
  "ModerationEvidence:all",
  "ModerationAction:all",
  "Appeal:first",
];

beforeEach(() => {
  dbState.users.length = 0;
  dbState.cases.length = 0;
  dbState.evidence.length = 0;
  dbState.reports.length = 0;
  dbState.actions.length = 0;
  dbState.appeals.length = 0;
  dbState.audits.length = 0;
  dbState.listings.length = 0;
  dbState.suspensions.length = 0;
  dbState.readLog.length = 0;
  dbState.users.push(
    { ...ADMIN_MOD }, { ...MOD_SELLER }, { ...MOD_REPORTER },
    { ...SELLER }, { ...BUYER },
  );
  seedCase();
  sessionState.current = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 1. Moderator không conflicted → render đầy đủ + audit ───────────────────

describe("case detail — moderator KHÔNG conflicted → render reports/evidence (spec §5.5.1)", () => {
  it("render tên reporter + note + evidence snapshot + subject, audit evidence_viewed được ghi", async () => {
    login(ADMIN_MOD);

    const tree = await call(CASE_ID);
    const text = textOf(tree);

    // nội dung nhạy cảm render cho moderator hợp lệ
    expect(text).toContain("Người Báo Cáo"); // tên reporter
    expect(text).toContain("Tôi bị lừa đảo bởi tin này"); // note reporter
    expect(text).toContain("Loa JBL GIẢ"); // evidence snapshot
    expect(text).toContain(SELLER.id as string); // subject id

    // mỗi render ghi vết xem evidence (spec §5.5.1 — separately audited)
    const viewed = dbState.audits.filter((a) => a["action"] === "moderation.evidence_viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ actorId: ADMIN_MOD.id, resourceId: CASE_ID });
  });
});

// ─── 2/3. Recusal on views — subject/reporter → notFound TRƯỚC render reads ──

describe("case detail — RECUSAL ON VIEWS (item 3): subject/reporter → notFound, KHÔNG read phục vụ render", () => {
  it("viewer là SUBJECT của case (moderator bị báo cáo) → notFound — KHÔNG đọc reports/evidence/actions/appeal, KHÔNG audit evidence_viewed", async () => {
    // case về listing của MOD_SELLER — chính họ là subject
    dbState.evidence[0]!["subjectUserId"] = MOD_SELLER.id;
    dbState.listings[0]!["sellerId"] = MOD_SELLER.id;
    login(MOD_SELLER);

    await expect(call(CASE_ID)).rejects.toThrowError(NOT_FOUND);

    // conflict check chạy (read tối thiểu first — subject match short-circuit
    // trước reporter check) — nhưng KHÔNG read phục vụ render
    expect(dbState.readLog).toContain("ModerationEvidence:first"); // subject check
    for (const read of RENDER_READS) {
      expect(dbState.readLog).not.toContain(read);
    }
    // không xem thì không ghi vết xem (spec §5.5.1)
    expect(dbState.audits.filter((a) => a["action"] === "moderation.evidence_viewed")).toHaveLength(0);
  });

  it("viewer là REPORTER của case → notFound — cùng posture (retaliation: reporter không xử lý case mình báo cáo)", async () => {
    // MOD_REPORTER là người đã báo cáo case này
    dbState.reports[0]!["reporterId"] = MOD_REPORTER.id;
    login(MOD_REPORTER);

    await expect(call(CASE_ID)).rejects.toThrowError(NOT_FOUND);

    // conflict check: subject check (không khớp) + reporter check (khớp)
    expect(dbState.readLog).toContain("ModerationEvidence:first");
    expect(dbState.readLog).toContain("AbuseReport:first");
    for (const read of RENDER_READS) {
      expect(dbState.readLog).not.toContain(read);
    }
    expect(dbState.audits.filter((a) => a["action"] === "moderation.evidence_viewed")).toHaveLength(0);
  });

  it("case KHÔNG tồn tại → notFound (như trước — không existence oracle mới)", async () => {
    login(ADMIN_MOD);
    await expect(call("case-khong-ton-tai")).rejects.toThrowError(NOT_FOUND);
  });
});
