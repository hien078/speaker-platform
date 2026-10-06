/**
 * User suspension + lift — unit tests (Batch 3 plan Task 5, spec §7.8 + §5.4.2
 * + §4.5/§4.6/§4.8 + §5.5 typed reasons) — suspension mechanism + publication
 * gate extension (8th requirement) + admin users page.
 *
 * Hợp đồng (plan Task 5 Step 1):
 *  1. moderator/support/analyst/non-admin → FORBIDDEN, không mutation
 *     (user.suspend chỉ super/ops — ô "Scoped" của moderator/support chưa
 *     định nghĩa → fail closed, Ambiguities A1).
 *  2. operations_admin + TOTP hợp lệ → UserSuspension row + ModerationAction
 *     ("user.suspended") + AuditEvent ("moderation.user_suspended") appended,
 *     seller được notify, KHÔNG thu hồi session nào (P1/A2 — pinned).
 *  3. step-up stale không totpCode → STEP_UP_REQUIRED; mã sai →
 *     MFA_CODE_INVALID (A9 — "destructive account action", spec §5.4.2).
 *  4. lift KHÔNG đòi step-up (hướng khôi phục — recorded decision).
 *  5. reasonCode ngoài SUSPENSION_REASON_CODES → typed error, zero writes.
 *  6. treo admin account → ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT (A6); tự treo
 *     mình → CANNOT_SUSPEND_SELF.
 *  7. double suspend → USER_ALREADY_SUSPENDED, vẫn MỘT row (partial index
 *     `user_suspension_one_active` — violation THROW ra khỏi callback, phân
 *     loại NGOÀI tx theo sqlState 23505 + constraint name — Global Constraints).
 *  8. caseId: subject mismatch → typed error (S5); case dismissed/appealed/
 *     closed → CASE_NOT_ACTIONABLE; case open → atomically `actioned` +
 *     case.transitioned (resolved_by_sanction) appended (S6); case moved
 *     concurrently → CASE_ALREADY_MOVED, suspension ROLLBACK (atomic claim).
 *  9. actor là subject/reporter của case → MODERATOR_CONFLICT, zero writes (S9).
 * 10. lift: atomic claim theo status active → lifted + action + audit; đã
 *     lifted → SUSPENSION_ALREADY_LIFTED; row thiếu → SUSPENSION_NOT_FOUND (E2).
 * 11. note admin qua redactDetail vào CẢ AuditEvent.detail LẪN
 *     ModerationAction.note (write-time redaction — spec §4.8).
 *
 * Cơ chế mock như tests/unit/publication-gate.test.ts: session/rbac/admin-mfa/
 * audit-event/notify/moderation guards GIỮ BẢN THẬT (login qua COOKIE THẬT,
 * step-up verify mã TOTP thật); db.client in-memory với transaction SNAPSHOT-
 * RESTORE (throw trong callback → mọi create/update trong tx bị hoàn tác —
 * pin hành vi rollback thật mà mock thường làm giả sai). UserSuspension.create
 * mô phỏng partial unique index (23505 + constraint name) như DB thật.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  suspensions: [] as Array<Record<string, unknown>>,
  cases: [] as Array<Record<string, unknown>>,
  evidence: [] as Array<Record<string, unknown>>,
  reports: [] as Array<Record<string, unknown>>,
  actions: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  mfas: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  /** Test seam S6: true → ModerationCase.updateAll luôn trả [] (claim thua). */
  failCaseClaim: false,
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
    // Partial unique index `user_suspension_one_active` (Task 1): MỘT episode
    // active duy nhất per user — create trùng → SqlQueryError 23505 + constraint
    // name, đúng shape driver thật (action phân loại NGOÀI tx theo tên constraint).
    UserSuspension: makeModel(dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
      note: null,
      suspendedById: null,
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    }), undefined, (data) => {
      const active = dbState.suspensions.some(
        (r) => r["userId"] === data["userId"] && r["status"] === "active",
      );
      if (active && data["status"] === "active") {
        // Constraint name mang HASH SUFFIX như DB thật (Prisma render
        // `<name>_<8hex>` — xem migration Task 1) — action phải khớp PREFIX.
        throw new SqlQueryError(
          'duplicate key value violates unique constraint "user_suspension_one_active_c770076c"',
          {
            sqlState: "23505",
            constraint: "user_suspension_one_active_c770076c",
            table: "user_suspension",
          },
        );
      }
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
    })),
    AdminMfa: makeModel(dbState.mfas, () => ({
      id: `mfa-${dbState.mfas.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    AdminRecoveryCode: makeModel(dbState.codes, () => ({
      id: `rc-${dbState.codes.length + 1}`,
      createdAt: new Date().toISOString(),
      usedAt: null,
    })),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      createdAt: new Date().toISOString(),
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
  // khớp điều kiện CAS) cho test CASE_ALREADY_MOVED; wrap CẢ updateAll top-level
  // LẪN trong chuỗi .where(...).updateAll(...) mà action gọi trên tx.
  const wrapCaseModel = (model: (typeof models)["ModerationCase"]) => {
    const seamUpdateAll = async (data: Row) => {
      if (dbState.failCaseClaim) return [];
      return model.updateAll(data);
    };
    const origWhere = model.where.bind(model);
    return {
      ...model,
      updateAll: seamUpdateAll,
      where: (pred: Pred) => {
        const q = origWhere(pred);
        return { ...q, updateAll: seamUpdateAll };
      },
    };
  };

  const orm = { public: { ...models, ModerationCase: wrapCaseModel(models.ModerationCase) } };
  return {
    db: {
      orm,
      // TRANSACTIONAL mock: throw trong callback → HOÀN TÁC mọi create/update
      // đã chạy trong tx (snapshot trước, restore khi throw) — pin đúng ngữ
      // nghĩa rollback của Postgres mà mock thường làm giả sai (Global
      // Constraints: violation LUÔN throw ra khỏi callback).
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
import { resetTotpReplayProtection, enrollAdminMfa } from "@/src/lib/admin-mfa";
import { hotpCode } from "@/src/lib/totp";
import { SESSION_COOKIE } from "@/src/lib/session";
import { SUSPENSION_REASON_CODES } from "@/src/lib/moderation-vocab";
import { suspendUserAction, liftSuspensionAction } from "@/src/lib/actions/moderation";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const KEY_32B = Buffer.alloc(32, 0x33).toString("base64");

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
const SELLER = mkUser({ id: "seller-1", email: "seller@loaviet.test", name: "Seller", role: "seller" });
const BUYER = mkUser({ id: "buyer-1", email: "buyer@loaviet.test", name: "Buyer", role: "buyer" });

/** Login THẬT qua cookie — session.ts đọc cookie store, hash, tra row mock. */
const login = (user: Row, opts?: { isAdmin?: boolean; steppedUpAt?: string }): string => {
  const id = `sess-${user.id}-${dbState.sessions.length + 1}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: sha256Hex(token),
    isAdmin: opts?.isAdmin ?? false,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: opts?.steppedUpAt ?? null,
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

/** Enrollment MFA gần nhất (cho mã TOTP step-up). */
let enrolled: { secretBase32: string; uri: string; recoveryCodes: string[] } | null = null;
const nowCounter = () => Math.floor(Date.now() / 30_000);
const currentTotp = (): string => hotpCode(enrolled!.secretBase32, nowCounter());

/** Step-up TƯƠI (≤15 phút) — không cần totpCode. */
const STEPPED_UP = () => new Date(Date.now() - 60_000).toISOString();
/** Step-up STALE (>15 phút) — đòi totpCode. */
const STALE_STEP_UP = () => new Date(Date.now() - 16 * 60_000).toISOString();

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

/** Suspension row trực tiếp (đã có từ trước — cho test lift). */
const seedSuspension = (userId: string, status = "active"): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `susp-${dbState.suspensions.length + 1}`,
    userId,
    status,
    reasonCode: "confirmed_abuse",
    note: null,
    suspendedById: ADMIN_OPS.id,
    suspendedAt: new Date().toISOString(),
    liftedById: null,
    liftedAt: null,
    liftReasonCode: null,
  };
  dbState.suspensions.push(row);
  return row;
};

const suspensionsOf = (userId: string): Row[] =>
  dbState.suspensions.filter((r) => r["userId"] === userId);

const actionsOf = (filter: Partial<Row>): Row[] =>
  dbState.actions.filter((r) =>
    Object.entries(filter).every(([k, v]) => r[k] === v),
  );

const auditsOf = (action: string): Row[] =>
  dbState.audits.filter((r) => r["action"] === action);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.suspensions.length = 0;
  dbState.cases.length = 0;
  dbState.evidence.length = 0;
  dbState.reports.length = 0;
  dbState.actions.length = 0;
  dbState.audits.length = 0;
  dbState.notifications.length = 0;
  dbState.mfas.length = 0;
  dbState.codes.length = 0;
  dbState.listings.length = 0;
  dbState.messages.length = 0;
  dbState.failCaseClaim = false;
  dbState.users.push(
    { ...ADMIN_SUPER }, { ...ADMIN_OPS }, { ...ADMIN_MOD },
    { ...ADMIN_SUPPORT }, { ...ADMIN_ANALYST }, { ...SELLER }, { ...BUYER },
  );
  cookieState.store.clear();
  headerState.headers = new Headers();
  enrolled = null;
  resetRateLimits();
  resetTotpReplayProtection();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Permission gate — moderator/support/analyst/non-admin fail closed ────

describe("suspendUserAction — permission gate (spec §9 Batch 3 moderator permission)", () => {
  it.each([
    ["moderator", ADMIN_MOD],
    ["support", ADMIN_SUPPORT],
    ["analyst", ADMIN_ANALYST],
  ])("%s (KHÔNG có user.suspend — ô Scoped chưa định nghĩa, A1) → FORBIDDEN, không mutation", async (_role, admin) => {
    login(admin, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("non-admin (session thường) → FORBIDDEN, không mutation", async () => {
    login(BUYER);

    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
  });

  it("chưa đăng nhập → FORBIDDEN (requireCapability fail closed)", async () => {
    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);
  });
});

// ─── 2. Happy path + step-up (A9) ─────────────────────────────────────────────

describe("suspendUserAction — operations_admin + step-up (spec §5.4.2)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
    expect(enrolled).not.toBeNull();
  });

  it("stale step-up KHÔNG totpCode → STEP_UP_REQUIRED, không mutation (A9)", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STALE_STEP_UP() });

    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/^STEP_UP_REQUIRED$/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("stale step-up + mã SAI → MFA_CODE_INVALID, không mutation", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STALE_STEP_UP() });

    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse", totpCode: "000000" })),
    ).rejects.toThrowError(/^MFA_CODE_INVALID$/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
  });

  it("stale step-up + TOTP ĐÚNG → suspend thành công (mã được verify thật)", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STALE_STEP_UP() });

    await suspendUserAction(
      fd({ userId: SELLER.id, reasonCode: "confirmed_abuse", totpCode: currentTotp() }),
    );

    expect(suspensionsOf(SELLER.id)).toHaveLength(1);
  });

  it("step-up TƯƠI (không mã) → suspend thành công", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" }));

    expect(suspensionsOf(SELLER.id)).toHaveLength(1);
  });

  it("operations_admin + TOTP hợp lệ: row + ModerationAction + AuditEvent appended, seller notified, ZERO session revocation (P1)", async () => {
    const sellerSession = login(SELLER); // session THẬT của seller — phải NGUYÊN VẸN
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STALE_STEP_UP() });

    await suspendUserAction(
      fd({ userId: SELLER.id, reasonCode: "confirmed_abuse", totpCode: currentTotp() }),
    );

    // UserSuspension row — đúng fields
    const susp = suspensionsOf(SELLER.id);
    expect(susp).toHaveLength(1);
    expect(susp[0]).toMatchObject({
      userId: SELLER.id,
      status: "active",
      reasonCode: "confirmed_abuse",
      suspendedById: ADMIN_OPS.id,
    });
    expect(susp[0]!["suspendedAt"]).toBeTruthy();

    // ModerationAction history (case-scoped — caseId null khi không link case)
    const act = actionsOf({ actionType: "user.suspended", targetId: SELLER.id });
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      targetType: "user",
      reasonCode: "confirmed_abuse",
    });

    // AuditEvent (spec §4.6) — actor/subject/reason/session
    const audit = auditsOf("moderation.user_suspended");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: SELLER.id,
      resourceType: "user",
      resourceId: SELLER.id,
      reason: "confirmed_abuse",
    });

    // seller được notify (kind moderation — copy PLACEHOLDER FD-3)
    const notif = dbState.notifications.filter(
      (n) => n["userId"] === SELLER.id && n["kind"] === "moderation",
    );
    expect(notif).toHaveLength(1);
    expect(notif[0]!["title"]).toContain("đình chỉ");

    // P1/A2: KHÔNG thu hồi session nào — session seller NGUYÊN VẸN
    const sellerSessionRow = dbState.sessions.find((s) => s["id"] === sellerSession);
    expect(sellerSessionRow).toMatchObject({ revokedAt: null, revokedReason: null });
    expect(
      dbState.sessions.filter((s) => s["revokedAt"] !== null),
    ).toHaveLength(0);
  });

  it("P1 pinned: action KHÔNG import/call revokeAllUserSessions (source-contract)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/lib/actions/moderation.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("revokeAllUserSessions");
  });
});

// ─── 3. Validation + target checks ────────────────────────────────────────────

describe("suspendUserAction — validation + target checks", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
  });

  it("reasonCode NGOÀI SUSPENSION_REASON_CODES → typed error, zero writes", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "vì-tôi-thấy-ghét" })),
    ).rejects.toThrowError(/INVALID_SUSPENSION_REASON/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("target KHÔNG tồn tại → USER_NOT_FOUND, zero writes", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      suspendUserAction(fd({ userId: "khong-ton-tai", reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/USER_NOT_FOUND/);

    expect(dbState.suspensions).toHaveLength(0);
  });

  it("treo ADMIN account → ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT (A6 — lockout thuộc runbook Batch 2)", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      suspendUserAction(fd({ userId: ADMIN_MOD.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT/);

    expect(suspensionsOf(ADMIN_MOD.id)).toHaveLength(0);
  });

  it("tự treo CHÍNH MÌNH → CANNOT_SUSPEND_SELF", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      suspendUserAction(fd({ userId: ADMIN_OPS.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/CANNOT_SUSPEND_SELF/);

    expect(suspensionsOf(ADMIN_OPS.id)).toHaveLength(0);
  });
});

// ─── 4. Double suspend — partial index + classification OUTSIDE ─────────────

describe("suspendUserAction — double suspend (S4 + Global Constraints transaction rule)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
  });

  it("suspend lần hai → USER_ALREADY_SUSPENDED, vẫn MỘT row (violation throw ra khỏi callback, classify NGOÀI tx)", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" }));
    expect(suspensionsOf(SELLER.id)).toHaveLength(1);

    // lần hai — partial index user_suspension_one_active vi phạm → throw ra
    // khỏi callback → tx rollback → classify NGOÀI theo constraint name
    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_spam" })),
    ).rejects.toThrowError(/USER_ALREADY_SUSPENDED/);

    // vẫn đúng MỘT row (episode đầu) — KHÔNG silent-success, KHÔNG nhân bản
    const susp = suspensionsOf(SELLER.id);
    expect(susp).toHaveLength(1);
    expect(susp[0]).toMatchObject({ status: "active", reasonCode: "confirmed_abuse" });
    // ModerationAction của lần THẤT BẠI KHÔNG được append (tx rollback)
    expect(actionsOf({ actionType: "user.suspended" })).toHaveLength(1);
    expect(auditsOf("moderation.user_suspended")).toHaveLength(1);
  });
});

// ─── 5. Case linkage (S5/S6/S9) ──────────────────────────────────────────────

describe("suspendUserAction — caseId linkage (S5 subject match, S6 atomic actioned, S9 conflict)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
  });

  const suspendWithCase = (caseId: string, over?: Record<string, string>) =>
    suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse", caseId, ...over }));

  it("case KHÔNG tồn tại → CASE_NOT_ACTIONABLE, zero writes", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(suspendWithCase("case-khong-ton-tai")).rejects.toThrowError(/CASE_NOT_ACTIONABLE/);
    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
  });

  it("case SUBJECT mismatch (case về người khác) → typed error, zero writes (S5)", async () => {
    const c = seedCase({ targetType: "user", targetId: BUYER.id });
    seedEvidence(c.id, BUYER.id); // subject của case là BUYER, không phải SELLER
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(suspendWithCase(c.id)).rejects.toThrowError(/CASE_SUBJECT_MISMATCH/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.cases.find((x) => x["id"] === c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
  });

  it("case về LISTING (subject = seller) → suspend đúng seller đó ĐƯỢC (SHOULD-FIX 2 — không đòi targetType === user)", async () => {
    const c = seedCase({ targetType: "listing", targetId: "listing-1" });
    seedEvidence(c.id, SELLER.id); // subject của case listing là seller
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendWithCase(c.id);

    expect(suspensionsOf(SELLER.id)).toHaveLength(1);
    expect(dbState.cases.find((x) => x["id"] === c.id)).toMatchObject({ state: "actioned" });
  });

  it("case KHÔNG có evidence → subject fallback qua live lookup (getCaseSubjectUserId)", async () => {
    const c = seedCase({ targetType: "user", targetId: SELLER.id });
    // KHÔNG seed evidence — fallback đọc User trực tiếp
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendWithCase(c.id);

    expect(suspensionsOf(SELLER.id)).toHaveLength(1);
  });

  it.each(["dismissed", "appealed", "closed"])(
    "case state %s → CASE_NOT_ACTIONABLE, zero writes (S5)",
    async (state) => {
      const c = seedCase({ state });
      seedEvidence(c.id, SELLER.id);
      login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

      await expect(suspendWithCase(c.id)).rejects.toThrowError(/CASE_NOT_ACTIONABLE/);

      expect(suspensionsOf(SELLER.id)).toHaveLength(0);
      expect(dbState.actions).toHaveLength(0);
    },
  );

  it("case OPEN → case atomically thành actioned + case.transitioned (resolved_by_sanction) appended (S6)", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendWithCase(c.id);

    // case → actioned (S6: sanction atomic với actioned — appeal link trỏ vào
    // case ĐANG actioned)
    expect(dbState.cases.find((x) => x["id"] === c.id)).toMatchObject({ state: "actioned" });
    // case.transitioned history row với typed reason resolved_by_sanction
    const transition = actionsOf({ actionType: "case.transitioned", caseId: c.id });
    expect(transition).toHaveLength(1);
    expect(transition[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      reasonCode: "resolved_by_sanction",
    });
    // user.suspended action mang caseId
    const suspAct = actionsOf({ actionType: "user.suspended" });
    expect(suspAct[0]).toMatchObject({ caseId: c.id, targetId: SELLER.id });
    // audit detail chứa case ref (đã redact — không PII)
    const audit = auditsOf("moderation.user_suspended");
    expect(audit[0]!["detail"]).toContain(`case:${c.id}`);
  });

  it("case đã ACTIONED từ trước → KHÔNG transition lần hai, sanction vẫn attach", async () => {
    const c = seedCase({ state: "actioned" });
    seedEvidence(c.id, SELLER.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendWithCase(c.id);

    expect(dbState.cases.find((x) => x["id"] === c.id)).toMatchObject({ state: "actioned" });
    expect(actionsOf({ actionType: "case.transitioned" })).toHaveLength(0); // không transition thừa
    expect(actionsOf({ actionType: "user.suspended" })).toHaveLength(1);
  });

  it("case moved CONCURRENTLY (claim thua) → CASE_ALREADY_MOVED, suspension ROLLBACK (S6 atomic claim)", async () => {
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });
    dbState.failCaseClaim = true; // seam: updateAll CAS → 0 rows (row đổi tay)

    await expect(suspendWithCase(c.id)).rejects.toThrowError(/CASE_ALREADY_MOVED/);

    // ROLLBACK: không suspension, không action, không audit — case giữ nguyên
    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
    expect(dbState.cases.find((x) => x["id"] === c.id)).toMatchObject({ state: "open" });
  });

  it("actor là SUBJECT của case → MODERATOR_CONFLICT, zero writes (S9)", async () => {
    // case về CHÍNH admin ops (ai đó báo cáo ops) — ops không được dùng case đó
    const c = seedCase({ targetType: "user", targetId: ADMIN_OPS.id });
    seedEvidence(c.id, ADMIN_OPS.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(suspendWithCase(c.id)).rejects.toThrowError(/MODERATOR_CONFLICT/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.actions).toHaveLength(0);
  });

  it("actor là REPORTER của case → MODERATOR_CONFLICT, zero writes (S9)", async () => {
    const c = seedCase({ targetType: "user", targetId: SELLER.id });
    seedEvidence(c.id, SELLER.id);
    // chính admin ops là người ĐÃ báo cáo case này
    dbState.reports.push({
      id: `rep-${dbState.reports.length + 1}`,
      reporterId: ADMIN_OPS.id,
      targetType: "user",
      targetId: SELLER.id,
      reasonCode: "suspected_scam",
      caseId: c.id,
      createdAt: new Date().toISOString(),
    });
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(suspendWithCase(c.id)).rejects.toThrowError(/MODERATOR_CONFLICT/);

    expect(suspensionsOf(SELLER.id)).toHaveLength(0);
    expect(dbState.cases.find((x) => x["id"] === c.id)).toMatchObject({ state: "open" });
    expect(dbState.actions).toHaveLength(0);
  });
});

// ─── 6. Lift — atomic claim, NO step-up ───────────────────────────────────────

describe("liftSuspensionAction — hướng khôi phục (Scope Decisions: KHÔNG step-up)", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
  });

  it("lift KHÔNG đòi step-up — stale step-up vẫn lift được (recorded decision)", async () => {
    const susp = seedSuspension(SELLER.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STALE_STEP_UP() });

    await liftSuspensionAction(
      fd({ suspensionId: susp.id, reasonCode: "other_reviewed_reason" }),
    );

    expect(dbState.suspensions.find((s) => s["id"] === susp.id)).toMatchObject({
      status: "lifted",
      liftReasonCode: "other_reviewed_reason",
      liftedById: ADMIN_OPS.id,
    });
  });

  it("lift: atomic claim → status lifted + ModerationAction + AuditEvent appended", async () => {
    const susp = seedSuspension(SELLER.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await liftSuspensionAction(
      fd({ suspensionId: susp.id, reasonCode: "other_reviewed_reason" }),
    );

    const row = dbState.suspensions.find((s) => s["id"] === susp.id)!;
    expect(row).toMatchObject({
      status: "lifted",
      liftedById: ADMIN_OPS.id,
      liftReasonCode: "other_reviewed_reason",
    });
    expect(row["liftedAt"]).toBeTruthy();

    const act = actionsOf({ actionType: "user.suspension_lifted" });
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      targetType: "user",
      targetId: SELLER.id,
      reasonCode: "other_reviewed_reason",
    });

    const audit = auditsOf("moderation.user_suspension_lifted");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: SELLER.id,
      reason: "other_reviewed_reason",
    });
  });

  it("lift trên row ĐÃ lifted → SUSPENSION_ALREADY_LIFTED (concurrent lift — atomic claim)", async () => {
    const susp = seedSuspension(SELLER.id, "lifted");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      liftSuspensionAction(fd({ suspensionId: susp.id, reasonCode: "other_reviewed_reason" })),
    ).rejects.toThrowError(/SUSPENSION_ALREADY_LIFTED/);

    // KHÔNG action/audit lần hai (tx rollback)
    expect(actionsOf({ actionType: "user.suspension_lifted" })).toHaveLength(0);
    expect(auditsOf("moderation.user_suspension_lifted")).toHaveLength(0);
  });

  it("lift trên row KHÔNG tồn tại → SUSPENSION_NOT_FOUND (E2 — đọc row trước cho userId)", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      liftSuspensionAction(fd({ suspensionId: "khong-ton-tai", reasonCode: "other_reviewed_reason" })),
    ).rejects.toThrowError(/SUSPENSION_NOT_FOUND/);
  });

  it("lift: reasonCode ngoài vocabulary → typed error, zero writes", async () => {
    const susp = seedSuspension(SELLER.id);
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      liftSuspensionAction(fd({ suspensionId: susp.id, reasonCode: "vì-sao-đó" })),
    ).rejects.toThrowError(/INVALID_SUSPENSION_REASON/);

    expect(dbState.suspensions.find((s) => s["id"] === susp.id)).toMatchObject({ status: "active" });
  });

  it("lift: moderator (KHÔNG có user.suspend) → FORBIDDEN", async () => {
    const susp = seedSuspension(SELLER.id);
    login(ADMIN_MOD, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      liftSuspensionAction(fd({ suspensionId: susp.id, reasonCode: "other_reviewed_reason" })),
    ).rejects.toThrowError(/^FORBIDDEN$/);

    expect(dbState.suspensions.find((s) => s["id"] === susp.id)).toMatchObject({ status: "active" });
  });
});

// ─── 7. Write-time redaction (spec §4.8) ─────────────────────────────────────

describe("suspendUserAction — note qua redactDetail vào CẢ AuditEvent.detail LẪN ModerationAction.note", () => {
  beforeEach(async () => {
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
  });

  it("note chứa email → mask trong UserSuspension.note + ModerationAction.note + AuditEvent.detail", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendUserAction(
      fd({
        userId: SELLER.id,
        reasonCode: "confirmed_abuse",
        note: "liên hệ qua victim@example.com để đối chiếu",
      }),
    );

    const susp = suspensionsOf(SELLER.id);
    expect(susp).toHaveLength(1);
    expect(susp[0]!["note"]).toContain("[REDACTED_EMAIL]");
    expect(susp[0]!["note"]).not.toContain("victim@example.com");

    const act = actionsOf({ actionType: "user.suspended" });
    expect(act[0]!["note"]).toContain("[REDACTED_EMAIL]");
    expect(act[0]!["note"]).not.toContain("victim@example.com");

    const audit = auditsOf("moderation.user_suspended");
    expect(audit[0]!["detail"]).toContain("[REDACTED_EMAIL]");
    expect(audit[0]!["detail"]).not.toContain("victim@example.com");
  });

  it("note chứa số điện thoại + chuỗi 6 chữ số hình OTP → mask trong cả ba (belt-and-braces)", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendUserAction(
      fd({
        userId: SELLER.id,
        reasonCode: "confirmed_scam",
        note: "báo cáo kèm SĐT 0901234567 và mã tham chiếu 482901",
      }),
    );

    const act = actionsOf({ actionType: "user.suspended" });
    expect(act[0]!["note"]).toContain("[REDACTED_PHONE]");
    expect(act[0]!["note"]).toContain("[REDACTED_OTP]");
    expect(act[0]!["note"]).not.toContain("0901234567");
    const audit = auditsOf("moderation.user_suspended");
    expect(audit[0]!["detail"]).toContain("[REDACTED_PHONE]");
  });

  it("KHÔNG note → ModerationAction.note null, AuditEvent.detail không chứa prose thừa", async () => {
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" }));

    const act = actionsOf({ actionType: "user.suspended" });
    expect(act[0]!["note"]).toBeNull();
    const audit = auditsOf("moderation.user_suspended");
    expect(audit[0]!["detail"]).toBeNull(); // không caseId, không note → null
  });
});

// ─── 8. Vocabulary contract (A8) ──────────────────────────────────────────────

describe("SUSPENSION_REASON_CODES — vocabulary PROVISIONAL (A8)", () => {
  it("đúng danh sách plan Task 5 (giá trị founder-acknowledged trước beta)", () => {
    expect([...SUSPENSION_REASON_CODES]).toEqual([
      "confirmed_abuse",
      "confirmed_scam",
      "confirmed_harassment",
      "confirmed_spam",
      "prohibited_content",
      "terms_violation",
      "other_reviewed_reason",
    ]);
  });
});
