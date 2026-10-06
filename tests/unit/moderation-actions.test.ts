/**
 * Moderation console actions — assign / transition / takedown (Batch 3 plan
 * Task 6, spec §5.5 + §5.4.1 + §4.5/§4.6/§4.8 + §7.8) — unit tests.
 *
 * Hợp đồng (plan Task 6 Step 1):
 *  1. assign: moderator (report.resolve ✓) → assigned + ModerationAction
 *     (typed ASSIGNMENT reason) + AuditEvent appended; analyst/support/
 *     non-admin → FORBIDDEN (ô ma trận ✓ chỉ super/ops/moderator — A1).
 *  2. assign: assignee KHÔNG đủ eligibility (analyst id) →
 *     ASSIGNEE_NOT_ELIGIBLE, không update.
 *  3. assign: case closed → CASE_CLOSED (S8); concurrent assign thứ hai →
 *     CASE_ASSIGNMENT_CONFLICT (CAS trên assignee cũ + state vừa đọc).
 *  4. transition: legal open → triaged → action + audit với reasonCode;
 *     illegal pairs → INVALID_TRANSITION (closed terminal, dismissed → chỉ
 *     closed, không đi ngược); concurrent → CASE_ALREADY_MOVED (atomic claim —
 *     spec §10.1 concurrent update); appealed → closed ĐÓNG kèm Appeal row.
 *  5. takedown (R4): approved|hidden|pending → removed ATOMIC (updateAll
 *     conditional theo status IN) — KHÔNG BAO GIỜ viết rejected/rejectionReason;
 *     already-removed → LISTING_NOT_TAKEDOWN_ELIGIBLE; audit detail mang
 *     prev:<status> (SHOULD-FIX 5 — cho A4 restore tương lai); seller notified.
 *  6. takedown với caseId (S5/S6): target mismatch → typed error;
 *     dismissed/appealed/closed → CASE_NOT_ACTIONABLE; case open →
 *     atomically actioned + case.transitioned (resolved_by_sanction).
 *  7. Mọi action: actor là subject/reporter của case → MODERATOR_CONFLICT,
 *     zero writes (S9 fail closed — recusal policy A7).
 *  8. Append-only: hai transition → HAI ModerationAction rows (không overwrite).
 *  9. PII (spec §4.8): note admin qua redactDetail vào CẢ ModerationAction.note
 *     LẪN AuditEvent.detail (write-time redaction).
 * 10. (Review fix pattern Task 5) notify sau commit là BEST-EFFORT: lỗi
 *     Notification.create KHÔNG biến takedown đã commit thành 500.
 *
 * Cơ chế mock như tests/unit/suspension-actions.test.ts: session/rbac/audit
 * GIỮ BẢN THẬT (login qua COOKIE THẬT); db.client in-memory với transaction
 * SNAPSHOT-RESTORE (throw trong callback → mọi create/update trong tx bị
 * hoàn tác — pin hành vi rollback thật). Seam failCaseClaim mô phỏng claim
 * thua (ModerationCase.updateAll → []) cho CASE_ALREADY_MOVED /
 * CASE_ASSIGNMENT_CONFLICT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ─── headers + cookies điều khiển được — session.ts/rbac chạy THẬT ───────────

const headerState = vi.hoisted(() => ({ headers: new Headers() }));
const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerState.headers),
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieState.store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

// ─── db.client mock — in-memory + TRANSACTION (snapshot/restore on throw) ────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  cases: [] as Array<Record<string, unknown>>,
  evidence: [] as Array<Record<string, unknown>>,
  reports: [] as Array<Record<string, unknown>>,
  actions: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  appeals: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  /** Seam S8: true → ModerationCase.updateAll luôn trả [] (claim thua). */
  failCaseClaim: false,
  /**
   * Seam (review fix pattern Task 5): true → Notification.create throw MỘT lần
   * (one-shot) — mô phỏng notify fail SAU khi tx commit; action phải best-effort.
   */
  failNotifyCreate: false,
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
          lt: (v: unknown) => (row[field] as number) < (v as number),
          lte: (v: unknown) => (row[field] as number) <= (v as number),
          gt: (v: unknown) => (row[field] as number) > (v as number),
          gte: (v: unknown) => (row[field] as number) >= (v as number),
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

  const makeModel = (
    rows: Row[],
    defaults?: () => Row,
    attach?: (row: Row) => void,
    onCreate?: (data: Row) => void,
  ) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      // select là projection — mock trả nguyên row (caller chỉ đọc field đã chọn)
      select: (..._fields: string[]) => query(preds, includeRel),
      orderBy: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (!hit) return null;
        const copy = { ...hit };
        if (includeRel === "user" && attach) attach(copy);
        return copy;
      },
      all: async () =>
        rows
          .filter((r) => preds.every((p) => matches(r, p)))
          .map((r) => {
            const copy = { ...r };
            if (includeRel === "user" && attach) attach(copy);
            return copy;
          }),
      update: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        Object.assign(hit[0]!, data);
        return { ...hit[0]! };
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        onCreate?.(data); // hook mô phỏng constraint (throw TRƯỚC khi push)
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      include: (rel: string) => query([], rel),
      select: (...fields: string[]) => query([], undefined).select(...fields),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
    };
  };

  const models = {
    User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    UserSession: makeModel(dbState.sessions, () => ({
      id: `sess-${dbState.sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
      revokedReason: null,
      steppedUpAt: null,
      isAdmin: false,
      userAgent: null,
    }), (row) => {
      row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
    }),
    ModerationCase: makeModel(dbState.cases, () => ({
      id: `case-${dbState.cases.length + 1}`,
      state: "open",
      priority: "normal",
      assignedModeratorId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    ModerationEvidence: makeModel(dbState.evidence, () => ({
      id: `ev-${dbState.evidence.length + 1}`,
      capturedAt: new Date().toISOString(),
      subjectUserId: null,
      reporterUserId: null,
    })),
    AbuseReport: makeModel(dbState.reports, () => ({
      id: `rep-${dbState.reports.length + 1}`,
      reporterId: null,
      createdAt: new Date().toISOString(),
    })),
    ModerationAction: makeModel(dbState.actions, () => ({
      id: `act-${dbState.actions.length + 1}`,
      caseId: null,
      actorId: null,
      targetType: null,
      targetId: null,
      reasonCode: null,
      note: null,
      createdAt: new Date().toISOString(),
    })),
    AuditEvent: makeModel(dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      actorId: null,
      subjectId: null,
      resourceType: null,
      resourceId: null,
      reason: null,
      policyVersion: null,
      sessionId: null,
      detail: null,
      ipHash: null,
      createdAt: new Date().toISOString(),
    })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      body: null,
      link: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    }), undefined, () => {
      // Seam best-effort notify: Notification.create fail (DB lỗi) — one-shot.
      if (dbState.failNotifyCreate) {
        dbState.failNotifyCreate = false;
        throw new Error("mock notification insert failure");
      }
    }),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      rejectionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    Appeal: makeModel(dbState.appeals, () => ({
      id: `appeal-${dbState.appeals.length + 1}`,
      appellantId: null,
      statement: null,
      state: "submitted",
      createdAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    })),
    Message: makeModel(dbState.messages, () => ({
      id: `msg-${dbState.messages.length + 1}`,
      imageUrl: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    })),
  };

  // ModerationCase qua seam failCaseClaim — mô phỏng "row đã đổi tay" (0 row
  // khớp điều kiện CAS) cho CASE_ALREADY_MOVED / CASE_ASSIGNMENT_CONFLICT.
  // Wrap ĐỆ QUY mọi tầng .where(...):updateAll(...) — predicate GIỮ NGUYÊN
  // (delegation về updateAll của CHÍNH query đó, không về top-level model).
  const wrapCaseModel = (model: (typeof models)["ModerationCase"]) => {
    const wrapQuery = (q: {
      where: (pred: Pred) => unknown;
      updateAll: (data: Row) => Promise<Row[]>;
    }) => {
      const origUpdateAll = q.updateAll.bind(q);
      const seamUpdateAll = async (data: Row): Promise<Row[]> => {
        if (dbState.failCaseClaim) return [];
        return origUpdateAll(data);
      };
      return {
        ...q,
        where: (pred: Pred) => wrapQuery(q.where(pred) as never),
        updateAll: seamUpdateAll,
      };
    };
    const origWhere = model.where.bind(model);
    return {
      ...model,
      where: (pred: Pred) => wrapQuery(origWhere(pred) as never),
      updateAll: async (data: Row): Promise<Row[]> => {
        if (dbState.failCaseClaim) return [];
        return model.updateAll(data);
      },
    };
  };

  const orm = { public: { ...models, ModerationCase: wrapCaseModel(models.ModerationCase) } };
  return {
    db: {
      orm,
      // TRANSACTIONAL mock: throw trong callback → HOÀN TÁC mọi create/update
      // đã chạy trong tx (snapshot trước, restore khi throw) — pin đúng ngữ
      // nghĩa rollback của Postgres (Global Constraints: violation LUÔN throw
      // ra khỏi callback).
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = new Map<string, Row[]>();
        for (const [name, rows] of Object.entries(dbState)) {
          if (Array.isArray(rows)) snapshot.set(name, rows.map((r) => ({ ...r })));
        }
        try {
          return await fn({ orm: { public: orm.public } });
        } catch (e) {
          for (const [name, rows] of Object.entries(dbState)) {
            if (!Array.isArray(rows)) continue;
            const snap = snapshot.get(name) ?? [];
            rows.length = 0;
            rows.push(...snap.map((r) => ({ ...r })));
          }
          throw e;
        }
      },
    },
  };
});

// ─── Imports (SAU mock) ──────────────────────────────────────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import {
  MODERATION_ASSIGNMENT_REASON_CODES,
  MODERATION_DECISION_REASON_CODES,
} from "@/src/lib/moderation-vocab";
import {
  assignModerationCaseAction,
  transitionModerationCaseAction,
  takeDownListingAction,
} from "@/src/lib/actions/moderation";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const mkUser = (over: Partial<Row>): Row & { id: string } => ({
  id: "user-x",
  email: "x@loaviet.test",
  passwordHash: "bcrypt-x",
  name: "X",
  role: "buyer",
  avatarUrl: null,
  phone: null,
  city: null,
  bio: null,
  isVerifiedSeller: false,
  adminRole: null,
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  sellerType: null,
  sellerOperatingProvinceCode: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const ADMIN_SUPER = mkUser({ id: "admin-super", email: "super@loaviet.test", name: "Super", role: "admin", adminRole: "super_admin" });
const ADMIN_OPS = mkUser({ id: "admin-ops", email: "ops@loaviet.test", name: "Ops", role: "admin", adminRole: "operations_admin" });
const ADMIN_MOD = mkUser({ id: "admin-mod", email: "mod@loaviet.test", name: "Mod", role: "admin", adminRole: "moderator" });
const ADMIN_SUPPORT = mkUser({ id: "admin-support", email: "support@loaviet.test", name: "Support", role: "admin", adminRole: "support" });
const ADMIN_ANALYST = mkUser({ id: "admin-analyst", email: "analyst@loaviet.test", name: "Analyst", role: "admin", adminRole: "analyst" });
/** Moderator VỪA là seller — cho test conflict-of-interest trên takedown (S9). */
const MOD_SELLER = mkUser({ id: "mod-seller", email: "modseller@loaviet.test", name: "ModSeller", role: "seller", adminRole: "moderator" });
const SELLER = mkUser({ id: "seller-1", email: "seller@loaviet.test", name: "Seller", role: "seller" });
const BUYER = mkUser({ id: "buyer-1", email: "buyer@loaviet.test", name: "Buyer", role: "buyer" });

/** Login THẬT qua cookie — session.ts đọc cookie store, hash, tra row mock. */
const login = (user: Row): string => {
  const id = `sess-${user.id}-${dbState.sessions.length + 1}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: sha256Hex(token),
    isAdmin: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: null,
    userAgent: "unit-test-agent/1.0",
  });
  cookieState.store.set(SESSION_COOKIE, token);
  return id;
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Case fixture (targetType/targetId/state/reasonCategory). */
const seedCase = (over: Partial<Row>): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `case-${dbState.cases.length + 1}`,
    targetType: "user",
    targetId: SELLER.id,
    state: "open",
    priority: "normal",
    assignedModeratorId: null,
    reasonCategory: "suspected_scam",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  dbState.cases.push(row);
  return row;
};

/** Evidence row cho case (subjectUserId chụp tại report time — bất biến). */
const seedEvidence = (caseId: string, subjectUserId: string): void => {
  dbState.evidence.push({
    id: `ev-${dbState.evidence.length + 1}`,
    caseId,
    sourceResourceType: "user",
    sourceResourceId: subjectUserId,
    capturedAt: new Date().toISOString(),
    relevantSnapshot: { kind: "user", id: subjectUserId },
    subjectUserId,
    reporterUserId: BUYER.id,
    classification: "suspected_scam",
  });
};

/** Listing fixture của seller (mặc định approved — R4 claim eligible). */
const seedListing = (over: Partial<Row>): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `listing-${dbState.listings.length + 1}`,
    sellerId: SELLER.id,
    title: "Loa JBL Charge 5 chính hãng",
    slug: "loa-jbl-charge-5-chinh-hang",
    description: "Loa bluetooth cũ còn tốt.",
    status: "approved",
    rejectionReason: null,
    price: 1_800_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  dbState.listings.push(row);
  return row;
};

/** Appeal row submitted cho case (khiếu nại đang chờ — bookkeeping Task 6). */
const seedAppeal = (caseId: string): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `appeal-${dbState.appeals.length + 1}`,
    caseId,
    appellantId: SELLER.id,
    statement: null,
    state: "submitted",
    createdAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
  };
  dbState.appeals.push(row);
  return row;
};

const caseRow = (id: string): Row | undefined =>
  dbState.cases.find((c) => c["id"] === id);
const listingRow = (id: string): Row | undefined =>
  dbState.listings.find((l) => l["id"] === id);

const actionsOf = (filter: Partial<Row>): Row[] =>
  dbState.actions.filter((r) =>
    Object.entries(filter).every(([k, v]) => r[k] === v),
  );

const auditsOf = (action: string): Row[] =>
  dbState.audits.filter((r) => r["action"] === action);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.cases.length = 0;
  dbState.evidence.length = 0;
  dbState.reports.length = 0;
  dbState.actions.length = 0;
  dbState.audits.length = 0;
  dbState.notifications.length = 0;
  dbState.listings.length = 0;
  dbState.appeals.length = 0;
  dbState.messages.length = 0;
  dbState.failCaseClaim = false;
  dbState.failNotifyCreate = false;
  dbState.users.push(
    { ...ADMIN_SUPER }, { ...ADMIN_OPS }, { ...ADMIN_MOD },
    { ...ADMIN_SUPPORT }, { ...ADMIN_ANALYST }, { ...MOD_SELLER },
    { ...SELLER }, { ...BUYER },
  );
  cookieState.store.clear();
  headerState.headers = new Headers();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. assign — permission gate + happy path ────────────────────────────────

describe("assignModerationCaseAction — permission gate (spec §9 moderator permission)", () => {
  it.each([
    ["analyst", ADMIN_ANALYST],
    ["support", ADMIN_SUPPORT],
  ])("%s (KHÔNG có report.resolve) → FORBIDDEN, không mutation", async (_role, admin) => {
    login(admin);
    const c = seedCase({});

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null, state: "open" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("non-admin (session thường) → FORBIDDEN, không mutation", async () => {
    login(BUYER);
    const c = seedCase({});

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null });
  });

  it("chưa đăng nhập → FORBIDDEN (requireCapability fail closed)", async () => {
    await expect(
      assignModerationCaseAction(fd({ caseId: "case-x", moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("moderator (ô ✓ report.resolve) → assigned + action (typed assignment reason) + audit appended", async () => {
    login(ADMIN_MOD);
    const c = seedCase({});
    seedEvidence(c.id, SELLER.id);

    await assignModerationCaseAction(
      fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" }),
    );

    // case được gán moderator (CAS trên assignee cũ null)
    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: ADMIN_OPS.id, state: "open" });

    // ModerationAction — typed ASSIGNMENT reason (spec §5.5), note null
    const act = actionsOf({ actionType: "case.assigned", caseId: c.id });
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      targetType: "moderation_case",
      targetId: c.id,
      reasonCode: "triage_assignment",
      note: null,
    });

    // AuditEvent (spec §4.6) — actor/reason/session
    const audit = auditsOf("moderation.case_assigned");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      resourceType: "moderation_case",
      resourceId: c.id,
      reason: "triage_assignment",
    });
  });

  it("reassignment (case đã có assignee) → CAS trên assignee CŨ, gán người mới được", async () => {
    login(ADMIN_MOD);
    const c = seedCase({ assignedModeratorId: ADMIN_OPS.id });

    await assignModerationCaseAction(
      fd({ caseId: c.id, moderatorId: ADMIN_SUPER.id, reasonCode: "reassignment" }),
    );

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: ADMIN_SUPER.id });
    expect(actionsOf({ actionType: "case.assigned" })).toHaveLength(1);
  });
});

// ─── 2. assign — eligibility + case checks + race ────────────────────────────

describe("assignModerationCaseAction — eligibility + case checks (S8/S9)", () => {
  beforeEach(() => {
    login(ADMIN_MOD);
  });

  it("assignee KHÔNG đủ eligibility (analyst id) → ASSIGNEE_NOT_ELIGIBLE, không update", async () => {
    const c = seedCase({});

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_ANALYST.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/ASSIGNEE_NOT_ELIGIBLE/);

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("assignee KHÔNG tồn tại → ASSIGNEE_NOT_ELIGIBLE (fail closed)", async () => {
    const c = seedCase({});

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: "khong-ton-tai", reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/ASSIGNEE_NOT_ELIGIBLE/);
  });

  it("case KHÔNG tồn tại → CASE_NOT_FOUND, zero writes", async () => {
    await expect(
      assignModerationCaseAction(fd({ caseId: "case-khong-ton-tai", moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/CASE_NOT_FOUND/);
    expect(dbState.actions).toHaveLength(0);
  });

  it("case CLOSED → CASE_CLOSED, không update (S8 — không assign case đã đóng)", async () => {
    const c = seedCase({ state: "closed" });

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/CASE_CLOSED/);

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null });
    expect(dbState.actions).toHaveLength(0);
  });

  it("reasonCode NGOÀI MODERATION_ASSIGNMENT_REASON_CODES → typed error, zero writes (A8 vocabulary)", async () => {
    const c = seedCase({});

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "vì-tôi-thấy-đúng" })),
    ).rejects.toThrowError(/INVALID_ASSIGNMENT_REASON/);

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("concurrent assign thứ hai (claim thua) → CASE_ASSIGNMENT_CONFLICT, KHÔNG action/audit (tx rollback)", async () => {
    const c = seedCase({});
    seedEvidence(c.id, SELLER.id);
    dbState.failCaseClaim = true; // seam: CAS updateAll → 0 rows (row đổi tay)

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/CASE_ASSIGNMENT_CONFLICT/);

    // tx rollback: case GIỮ NGUYÊN, không history, không audit
    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null, state: "open" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 3. transition — legal/illegal/concurrent/appeal bookkeeping ─────────────

describe("transitionModerationCaseAction — transitions (spec §5.5 states)", () => {
  beforeEach(() => {
    login(ADMIN_MOD);
  });

  it("legal open → triaged → action + audit appended với reasonCode", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);

    await transitionModerationCaseAction(
      fd({ caseId: c.id, toState: "triaged", reasonCode: "no_violation_found" }),
    );

    expect(caseRow(c.id)).toMatchObject({ state: "triaged", priority: "normal" });
    const act = actionsOf({ actionType: "case.transitioned", caseId: c.id });
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      targetType: "moderation_case",
      targetId: c.id,
      reasonCode: "no_violation_found",
    });
    const audit = auditsOf("moderation.case_transitioned");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      resourceType: "moderation_case",
      resourceId: c.id,
      reason: "no_violation_found",
    });
  });

  it("priority tùy chọn → case priority cập nhật trong cùng claim", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);

    await transitionModerationCaseAction(
      fd({ caseId: c.id, toState: "investigating", reasonCode: "other_reviewed_reason", priority: "high" }),
    );

    expect(caseRow(c.id)).toMatchObject({ state: "investigating", priority: "high" });
  });

  it("priority NGOÀI vocabulary → typed error, zero writes", async () => {
    const c = seedCase({ state: "open" });

    await expect(
      transitionModerationCaseAction(
        fd({ caseId: c.id, toState: "triaged", reasonCode: "no_violation_found", priority: "urgent" }),
      ),
    ).rejects.toThrowError(/INVALID_PRIORITY/);

    expect(caseRow(c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
  });

  it.each([
    ["open", "closed"],
    ["closed", "triaged"],
    ["dismissed", "actioned"],
    ["investigating", "triaged"],
  ])("illegal %s → %s → INVALID_TRANSITION, zero writes", async (from, to) => {
    const c = seedCase({ state: from });
    seedEvidence(c.id, SELLER.id);

    await expect(
      transitionModerationCaseAction(fd({ caseId: c.id, toState: to, reasonCode: "no_violation_found" })),
    ).rejects.toThrowError(/INVALID_TRANSITION/);

    expect(caseRow(c.id)).toMatchObject({ state: from });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("toState NGOÀI MODERATION_CASE_STATES → typed error, zero writes", async () => {
    const c = seedCase({ state: "open" });

    await expect(
      transitionModerationCaseAction(fd({ caseId: c.id, toState: "frozen", reasonCode: "no_violation_found" })),
    ).rejects.toThrowError(/INVALID_CASE_STATE/);

    expect(dbState.actions).toHaveLength(0);
  });

  it("reasonCode NGOÀI MODERATION_DECISION_REASON_CODES → typed error, zero writes", async () => {
    const c = seedCase({ state: "open" });

    await expect(
      transitionModerationCaseAction(fd({ caseId: c.id, toState: "triaged", reasonCode: "vì-tôi-thấy-đúng" })),
    ).rejects.toThrowError(/INVALID_DECISION_REASON/);

    expect(caseRow(c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
  });

  it("concurrent move thứ hai (claim thua) → CASE_ALREADY_MOVED, KHÔNG action/audit (atomic claim — spec §10.1)", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);
    dbState.failCaseClaim = true; // seam: CAS updateAll → 0 rows

    await expect(
      transitionModerationCaseAction(fd({ caseId: c.id, toState: "triaged", reasonCode: "no_violation_found" })),
    ).rejects.toThrowError(/CASE_ALREADY_MOVED/);

    expect(caseRow(c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("appealed → closed ĐÓNG kèm Appeal row (state closed + closedAt set — bookkeeping A4)", async () => {
    const c = seedCase({ state: "appealed" });
    seedEvidence(c.id, SELLER.id);
    const appeal = seedAppeal(c.id);

    await transitionModerationCaseAction(
      fd({ caseId: c.id, toState: "closed", reasonCode: "appeal_closed" }),
    );

    expect(caseRow(c.id)).toMatchObject({ state: "closed" });
    const appealRow = dbState.appeals.find((a) => a["id"] === appeal.id);
    expect(appealRow).toMatchObject({ state: "closed" });
    expect(appealRow!["closedAt"]).toBeTruthy();
    expect(actionsOf({ actionType: "case.transitioned", caseId: c.id })).toHaveLength(1);
  });

  it("append-only: HAI transition → HAI ModerationAction rows (không overwrite)", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);

    await transitionModerationCaseAction(fd({ caseId: c.id, toState: "triaged", reasonCode: "other_reviewed_reason" }));
    await transitionModerationCaseAction(fd({ caseId: c.id, toState: "investigating", reasonCode: "policy_violation_confirmed" }));

    const transitions = actionsOf({ actionType: "case.transitioned", caseId: c.id });
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ reasonCode: "other_reviewed_reason" });
    expect(transitions[1]).toMatchObject({ reasonCode: "policy_violation_confirmed" });
    expect(caseRow(c.id)).toMatchObject({ state: "investigating" });
  });

  it("case KHÔNG tồn tại → CASE_NOT_FOUND, zero writes", async () => {
    await expect(
      transitionModerationCaseAction(fd({ caseId: "case-khong-ton-tai", toState: "triaged", reasonCode: "no_violation_found" })),
    ).rejects.toThrowError(/CASE_NOT_FOUND/);
  });

  it.each([
    ["analyst", ADMIN_ANALYST],
    ["support", ADMIN_SUPPORT],
  ])("%s (KHÔNG có report.resolve) → FORBIDDEN, không mutation", async (_role, admin) => {
    cookieState.store.clear();
    login(admin);
    const c = seedCase({ state: "open" });

    await expect(
      transitionModerationCaseAction(fd({ caseId: c.id, toState: "triaged", reasonCode: "no_violation_found" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(caseRow(c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
  });
});

// ─── 4. takedown — R4 atomic claim + audit prev + notify ─────────────────────

describe("takeDownListingAction — takedown → removed (R4, spec §5.5/§7.8)", () => {
  it("approved → removed ATOMIC + action (typed reason) + audit (prev:approved) + seller notified — rejectionReason KHÔNG BAO GIỜ được viết (R4)", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "approved" });

    await takeDownListingAction(
      fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" }),
    );

    // R4: status → removed; KHÔNG viết rejected/rejectionReason (lý do là typed
    // code trong ModerationAction)
    expect(listingRow(l.id)).toMatchObject({ status: "removed", rejectionReason: null });

    const act = actionsOf({ actionType: "listing.taken_down", targetId: l.id });
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      targetType: "listing",
      reasonCode: "policy_violation_confirmed",
      caseId: null,
    });

    // Audit — detail mang prev:<status> (SHOULD-FIX 5 — cho A4 restore tương lai)
    const audit = auditsOf("moderation.listing_taken_down");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      subjectId: SELLER.id,
      resourceType: "listing",
      resourceId: l.id,
      reason: "policy_violation_confirmed",
    });
    expect(audit[0]!["detail"]).toContain("prev:approved");

    // seller được notify (kind listing — copy PLACEHOLDER FD-3, link /sell/my)
    const notif = dbState.notifications.filter(
      (n) => n["userId"] === SELLER.id && n["kind"] === "listing",
    );
    expect(notif).toHaveLength(1);
    expect(notif[0]!["link"]).toBe("/sell/my");
  });

  it("listing HIDDEN vẫn bị takedown (seller không thể tự ẩn để né) — prev:hidden", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "hidden" });

    await takeDownListingAction(fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" }));

    expect(listingRow(l.id)).toMatchObject({ status: "removed" });
    expect(auditsOf("moderation.listing_taken_down")[0]!["detail"]).toContain("prev:hidden");
  });

  it("listing PENDING vẫn bị takedown (gỡ khỏi hàng đợi duyệt) — prev:pending", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "pending" });

    await takeDownListingAction(fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" }));

    expect(listingRow(l.id)).toMatchObject({ status: "removed" });
    expect(auditsOf("moderation.listing_taken_down")[0]!["detail"]).toContain("prev:pending");
  });

  it("listing ĐÃ removed → LISTING_NOT_TAKEDOWN_ELIGIBLE, KHÔNG write thứ hai", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "removed" });

    await expect(
      takeDownListingAction(fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/LISTING_NOT_TAKEDOWN_ELIGIBLE/);

    expect(listingRow(l.id)).toMatchObject({ status: "removed" });
    expect(dbState.actions).toHaveLength(0); // tx rollback — không action/audit
    expect(dbState.audits).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
  });

  it("listing KHÔNG tồn tại → LISTING_NOT_FOUND", async () => {
    login(ADMIN_MOD);

    await expect(
      takeDownListingAction(fd({ listingId: "listing-khong-ton-tai", reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/LISTING_NOT_FOUND/);
  });

  it("reasonCode NGOÀI MODERATION_DECISION_REASON_CODES → typed error, zero writes", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "approved" });

    await expect(
      takeDownListingAction(fd({ listingId: l.id, reasonCode: "vì-tôi-thấy-đúng" })),
    ).rejects.toThrowError(/INVALID_DECISION_REASON/);

    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
    expect(dbState.actions).toHaveLength(0);
  });

  it.each([
    ["support", ADMIN_SUPPORT],
    ["analyst", ADMIN_ANALYST],
  ])("%s (KHÔNG có listing.moderate) → FORBIDDEN, listing giữ nguyên", async (_role, admin) => {
    login(admin);
    const l = seedListing({ status: "approved" });

    await expect(
      takeDownListingAction(fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
    expect(dbState.actions).toHaveLength(0);
  });

  it("non-admin (session thường) → FORBIDDEN", async () => {
    login(BUYER);
    const l = seedListing({ status: "approved" });

    await expect(
      takeDownListingAction(fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("note chứa email → mask trong CẢ ModerationAction.note LẪN AuditEvent.detail (write-time redact — spec §4.8)", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "approved" });

    await takeDownListingAction(
      fd({ listingId: l.id, reasonCode: "policy_violation_confirmed", note: "liên hệ victim@example.com để đối chiếu" }),
    );

    const act = actionsOf({ actionType: "listing.taken_down" });
    expect(act[0]!["note"]).toContain("[REDACTED_EMAIL]");
    expect(act[0]!["note"]).not.toContain("victim@example.com");
    const audit = auditsOf("moderation.listing_taken_down");
    expect(audit[0]!["detail"]).toContain("[REDACTED_EMAIL]");
    expect(audit[0]!["detail"]).not.toContain("victim@example.com");
  });

  it("(review fix pattern) notify FAIL sau khi tx commit → action VẪN thành công (KHÔNG 500), takedown + action + audit NGUYÊN VẸN, lỗi qua captureError (KHÔNG PII)", async () => {
    login(ADMIN_MOD);
    const l = seedListing({ status: "approved" });
    dbState.failNotifyCreate = true; // Notification.create throw (one-shot)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // KHÔNG throw — takedown đã commit, notify chỉ là best-effort
    await takeDownListingAction(fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" }));

    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    errSpy.mockRestore();

    expect(listingRow(l.id)).toMatchObject({ status: "removed" });
    expect(actionsOf({ actionType: "listing.taken_down" })).toHaveLength(1);
    expect(auditsOf("moderation.listing_taken_down")).toHaveLength(1);
    expect(dbState.notifications).toHaveLength(0); // insert fail — không có row

    // lỗi được captureError — scope "moderation", KHÔNG PII (không email seller)
    const scopeLine = lines.find((li) => li.includes('"scope":"moderation"'));
    expect(scopeLine).toBeTruthy();
    expect(scopeLine).not.toContain(SELLER.email as string);
  });
});

// ─── 5. takedown với caseId — S5 target match + S6 atomic actioned ──────────

describe("takeDownListingAction — caseId linkage (S5/S6)", () => {
  beforeEach(() => {
    login(ADMIN_MOD);
  });

  it("case target MISMATCH (case về listing khác) → typed error, zero writes (S5)", async () => {
    const l = seedListing({ status: "approved" });
    const other = seedListing({ status: "approved" });
    const c = seedCase({ targetType: "listing", targetId: other.id });
    seedEvidence(c.id, SELLER.id);

    await expect(
      takeDownListingAction(fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/CASE_TARGET_MISMATCH/);

    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it.each(["dismissed", "appealed", "closed"])(
    "case state %s → CASE_NOT_ACTIONABLE, listing giữ nguyên (S5)",
    async (state) => {
      const l = seedListing({ status: "approved" });
      const c = seedCase({ targetType: "listing", targetId: l.id, state });
      seedEvidence(c.id, SELLER.id);

      await expect(
        takeDownListingAction(fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" })),
      ).rejects.toThrowError(/CASE_NOT_ACTIONABLE/);

      expect(listingRow(l.id)).toMatchObject({ status: "approved" });
      expect(dbState.actions).toHaveLength(0);
    },
  );

  it("case KHÔNG tồn tại → CASE_NOT_ACTIONABLE, zero writes", async () => {
    const l = seedListing({ status: "approved" });

    await expect(
      takeDownListingAction(fd({ listingId: l.id, caseId: "case-khong-ton-tai", reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/CASE_NOT_ACTIONABLE/);

    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
  });

  it("case OPEN → atomically actioned + case.transitioned (resolved_by_sanction) appended (S6)", async () => {
    const l = seedListing({ status: "approved" });
    const c = seedCase({ targetType: "listing", targetId: l.id, state: "open" });
    seedEvidence(c.id, SELLER.id);

    await takeDownListingAction(
      fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" }),
    );

    expect(listingRow(l.id)).toMatchObject({ status: "removed" });
    expect(caseRow(c.id)).toMatchObject({ state: "actioned" });
    const transition = actionsOf({ actionType: "case.transitioned", caseId: c.id });
    expect(transition).toHaveLength(1);
    expect(transition[0]).toMatchObject({ reasonCode: "resolved_by_sanction" });
    // audit detail mang case ref + prev
    const audit = auditsOf("moderation.listing_taken_down");
    expect(audit[0]!["detail"]).toContain(`case:${c.id}`);
    expect(audit[0]!["detail"]).toContain("prev:approved");
  });

  it("case ĐÃ actioned từ trước → KHÔNG transition lần hai, takedown vẫn attach", async () => {
    const l = seedListing({ status: "approved" });
    const c = seedCase({ targetType: "listing", targetId: l.id, state: "actioned" });
    seedEvidence(c.id, SELLER.id);

    await takeDownListingAction(
      fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" }),
    );

    expect(listingRow(l.id)).toMatchObject({ status: "removed" });
    expect(caseRow(c.id)).toMatchObject({ state: "actioned" });
    expect(actionsOf({ actionType: "case.transitioned" })).toHaveLength(0);
    expect(actionsOf({ actionType: "listing.taken_down" })).toHaveLength(1);
  });

  it("case moved CONCURRENTLY (claim thua) → CASE_ALREADY_MOVED, takedown ROLLBACK (S6 atomic)", async () => {
    const l = seedListing({ status: "approved" });
    const c = seedCase({ targetType: "listing", targetId: l.id, state: "open" });
    seedEvidence(c.id, SELLER.id);
    dbState.failCaseClaim = true; // seam: case CAS → 0 rows

    await expect(
      takeDownListingAction(fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/CASE_ALREADY_MOVED/);

    // ROLLBACK toàn bộ tx: listing GIỮ NGUYÊN approved, không action/audit
    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
    expect(caseRow(c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 6. Conflict-of-interest (S9) — mọi action ───────────────────────────────

describe("MODERATOR_CONFLICT — actor là subject/reporter của case (S9 fail closed, A7)", () => {
  it("assign bởi SUBJECT của case → MODERATOR_CONFLICT, zero writes", async () => {
    // moderator bị báo cáo (case về chính họ) — không được tự assign case mình
    const c = seedCase({ targetType: "user", targetId: ADMIN_MOD.id });
    seedEvidence(c.id, ADMIN_MOD.id);
    login(ADMIN_MOD);

    await expect(
      assignModerationCaseAction(fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" })),
    ).rejects.toThrowError(/MODERATOR_CONFLICT/);

    expect(caseRow(c.id)).toMatchObject({ assignedModeratorId: null });
    expect(dbState.actions).toHaveLength(0);
  });

  it("transition bởi REPORTER của case → MODERATOR_CONFLICT, zero writes", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);
    // chính moderator là người ĐÃ báo cáo case này
    dbState.reports.push({
      id: `rep-${dbState.reports.length + 1}`,
      reporterId: ADMIN_MOD.id,
      targetType: "user",
      targetId: SELLER.id,
      reasonCode: "suspected_scam",
      caseId: c.id,
      createdAt: new Date().toISOString(),
    });
    login(ADMIN_MOD);

    await expect(
      transitionModerationCaseAction(fd({ caseId: c.id, toState: "triaged", reasonCode: "no_violation_found" })),
    ).rejects.toThrowError(/MODERATOR_CONFLICT/);

    expect(caseRow(c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("takedown bởi SUBJECT của case (moderator là seller của chính listing bị báo cáo) → MODERATOR_CONFLICT, zero writes", async () => {
    const l = seedListing({ sellerId: MOD_SELLER.id, status: "approved" });
    const c = seedCase({ targetType: "listing", targetId: l.id });
    seedEvidence(c.id, MOD_SELLER.id);
    login(MOD_SELLER);

    await expect(
      takeDownListingAction(fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/MODERATOR_CONFLICT/);

    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("takedown bởi REPORTER của case → MODERATOR_CONFLICT, zero writes", async () => {
    const l = seedListing({ status: "approved" });
    const c = seedCase({ targetType: "listing", targetId: l.id });
    seedEvidence(c.id, SELLER.id);
    dbState.reports.push({
      id: `rep-${dbState.reports.length + 1}`,
      reporterId: ADMIN_MOD.id,
      targetType: "listing",
      targetId: l.id,
      reasonCode: "suspected_scam",
      caseId: c.id,
      createdAt: new Date().toISOString(),
    });
    login(ADMIN_MOD);

    await expect(
      takeDownListingAction(fd({ listingId: l.id, caseId: c.id, reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrowError(/MODERATOR_CONFLICT/);

    expect(listingRow(l.id)).toMatchObject({ status: "approved" });
    expect(dbState.actions).toHaveLength(0);
  });
});

// ─── 7. Vocabulary contract (A8) ──────────────────────────────────────────────

describe("Typed reason vocabularies — PROVISIONAL (A8)", () => {
  it("MODERATION_ASSIGNMENT_REASON_CODES đúng danh sách plan Task 6", () => {
    expect([...MODERATION_ASSIGNMENT_REASON_CODES]).toEqual([
      "triage_assignment",
      "reassignment",
      "other_reviewed_reason",
    ]);
  });

  it("MODERATION_DECISION_REASON_CODES đúng danh sách plan Task 2/6", () => {
    expect([...MODERATION_DECISION_REASON_CODES]).toEqual([
      "no_violation_found",
      "insufficient_evidence",
      "policy_violation_confirmed",
      "resolved_by_sanction",
      "duplicate_case",
      "appeal_closed",
      "other_reviewed_reason",
    ]);
  });
});

// ─── 8. Source contract — R4: KHÔNG viết rejected/rejectionReason ────────────

describe("takeDownListingAction — R4 source contract", () => {
  it("src/lib/actions/moderation.ts KHÔNG chứa rejected/rejectionReason trong CODE (R4)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/lib/actions/moderation.ts", import.meta.url)),
      "utf8",
    );
    // Tách comment ra khỏi code: bỏ block comment /* */ + phần sau // mỗi dòng
    // (quy tắc R4 của file được PHÉP nhắc từ khóa trong comment — Task 9 scan
    // classify từng hit là comment-hay-code; ở đây assert phần CODE là sạch).
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
    expect(codeOnly).not.toContain("rejected");
    expect(codeOnly).not.toContain("rejectionReason");
  });
});
