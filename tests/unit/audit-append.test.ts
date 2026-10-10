/**
 * Audit append behavior — Batch 3 plan Task 8 (spec §4.6 Auditability +
 * §5.5.1 evidence view "separately audited" + §4.8 write-time redaction +
 * §9 Batch 3 gate "audit append behavior").
 *
 * Hợp đồng (plan Task 8 Step 1):
 *  1. suspend appends ĐÚNG MỘT AuditEvent (moderation.user_suspended); lần
 *     suspend thứ hai FAIL (USER_ALREADY_SUSPENDED — partial index
 *     user_suspension_one_active) appends KHÔNG row nào (tx rollback — audit
 *     row trong tx bị abort KHÔNG tính là appended); lift thành công appends
 *     MỘT moderation.user_suspension_lifted. Append-only: zero op update/delete
 *     trên AuditEvent across suite (mutation log — test cuối).
 *  2. MỌI action privileged của Batch 3 (assign/transition/takedown/suspend/
 *     lift) appends ≥1 AuditEvent với action đúng registry + actorId = admin
 *     + sessionId = session id (spec §4.6 actor/action/resource/reason/context).
 *  3. Evidence view (E2 — async server component chạy TRỰC TIẾP trong Vitest,
 *     await component = execute audit path): render case detail page →
 *     AuditEvent moderation.evidence_viewed đúng 1 lần/render; render thứ hai
 *     → row thứ hai (per-render — spec §5.5.1).
 *  4. Note admin redact TẠI WRITE TIME (redactDetail) vào CẢ AuditEvent.detail
 *     LẪN ModerationAction.note — email + chuỗi hình OTP 6 chữ số bị mask
 *     (spec §4.8).
 *  5. ModerationAction append-only: hai transition → HAI rows (không
 *     overwrite); zero op update/delete trên ModerationAction (mutation log).
 *  6. (S12) KHÔNG có statement nào trong src/ + app/ mutate ModerationEvidence/
 *     ModerationAction/AuditEvent — per-statement source scan (strip comment,
 *     split trên ";", statement chứa CẢ tên model LẪN một op mutation).
 *  7. Audit page filter theo action prefix (?action=) — source-contract: đọc
 *     searchParams.action, filter AuditEvent qua ilike(`${prefix}.%`),
 *     requireCapability("audit.read") vẫn là guard ĐẦU TIÊN (super_admin only —
 *     fail closed, Ambiguities A1).
 *
 *  Registry audit action của Batch 3 (contract Task 8 verify — Tasks 5–7
 *  append qua auditEvent/auditEventTx):
 *    moderation.user_suspended, moderation.user_suspension_lifted,
 *    moderation.case_assigned, moderation.case_transitioned,
 *    moderation.listing_taken_down, moderation.evidence_viewed.
 *  (report.submitted + appeal.recorded DELIBERATELY KHÔNG phải AuditEvent —
 *   Scope Decisions: actor là user thường, record của chúng là AbuseReport/
 *   Appeal + ModerationAction — pin bằng source-contract cuối file.)
 *
 * Cơ chế mock như tests/unit/moderation-actions.test.ts: session/rbac GIỮ
 * BẢN THẬT (login qua COOKIE THẬT — requireCapability chạy đủ matrix +
 * session.isAdmin; step-up suspend qua fixture steppedUpAt TƯƠI — "fresh
 * step-up fixture per call"); db.client in-memory với transaction
 * SNAPSHOT-RESTORE (throw trong callback → mọi create/update trong tx bị
 * hoàn tác — pin rollback thật). UserSuspension.create mô phỏng partial unique
 * index (SqlQueryError 23505 + constraint name kèm hash suffix) như DB thật.
 * "Spy" = persisted rows (dbState.audits/actions — TX-AWARE: row trong tx bị
 * abort biến mất khỏi store) + mutationLog (mọi gọi update/updateAll/delete/
 * deleteAll trên MỌI model — append-only gate across suite, KHÔNG reset
 * trong beforeEach).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
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
  listings: [] as Array<Record<string, unknown>>,
  appeals: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  /**
   * Spy append-only (test cuối file): mọi gọi update/updateAll/delete/deleteAll
   * trên MỌI model đẩy `${model}:${op}` — KHÔNG reset trong beforeEach (tích
   * lũy across suite; tx snapshot-restore thao tác trực tiếp mảng nên KHÔNG
   * ghi log — chỉ đường đi qua model method mới là "code gọi mutation").
   */
  mutationLog: [] as string[],
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

  /** attach: gắn quan hệ include (reporter/actor/appellant) từ store users. */
  const ATTACH: Record<string, string> = {
    reporter: "reporterId",
    actor: "actorId",
    appellant: "appellantId",
  };

  const makeModel = (
    name: string,
    rows: Row[],
    defaults?: () => Row,
    attach?: (row: Row) => void,
    onCreate?: (data: Row) => void,
  ) => {
    /** Mọi mutation qua model method → mutationLog (spy append-only). */
    const logMut = (op: string): void => {
      dbState.mutationLog.push(`${name}:${op}`);
    };
    const query = (preds: Pred[], includeRel?: string) => {
      /** Gắn quan hệ include: "user" qua attach callback (session.ts), các quan hệ moderation qua ATTACH map. */
      const attachRel = (copy: Row): void => {
        if (includeRel === "user" && attach) attach(copy);
        else if (includeRel != null && includeRel in ATTACH) {
          const fk = ATTACH[includeRel]!;
          copy[includeRel] = dbState.users.find((u) => u["id"] === copy[fk]) ?? null;
        }
      };
      return {
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      // select là projection — mock trả nguyên row (caller chỉ đọc field đã chọn)
      select: (..._fields: string[]) => query(preds, includeRel),
      orderBy: () => query(preds, includeRel),
      limit: (_n?: number) => query(preds, includeRel),
      offset: (_n?: number) => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (!hit) return null;
        const copy = { ...hit };
        attachRel(copy);
        return copy;
      },
      all: async () =>
        rows
          .filter((r) => preds.every((p) => matches(r, p)))
          .map((r) => {
            const copy = { ...r };
            attachRel(copy);
            return copy;
          }),
      update: async (data: Row) => {
        logMut("update");
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        Object.assign(hit[0]!, data);
        return { ...hit[0]! };
      },
      updateAll: async (data: Row) => {
        logMut("updateAll");
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      delete: async () => {
        logMut("delete");
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      deleteAll: async () => {
        logMut("deleteAll");
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
      };
    };
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      include: (rel: string) => query([], rel),
      select: (...fields: string[]) => query([]).select(...fields),
      orderBy: () => query([]),
      limit: (_n?: number) => query([]).limit(_n),
      offset: (_n?: number) => query([]).offset(_n),
      create: (data: Row) => query([]).create(data),
      update: (data: Row) => query([]).update(data),
      // top-level delegate qua query() — query tự log vào mutationLog.
      updateAll: (data: Row) => query([]).updateAll(data),
      delete: () => query([]).delete(),
      deleteAll: () => query([]).deleteAll(),
    };
  };

  const models = {
    User: makeModel("User", dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    UserSession: makeModel("UserSession", dbState.sessions, () => ({
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
    // name (kèm hash suffix như DB thật), action phân loại NGOÀI tx theo tên.
    UserSuspension: makeModel("UserSuspension", dbState.suspensions, () => ({
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
    ModerationCase: makeModel("ModerationCase", dbState.cases, () => ({
      id: `case-${dbState.cases.length + 1}`,
      state: "open",
      priority: "normal",
      assignedModeratorId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    ModerationEvidence: makeModel("ModerationEvidence", dbState.evidence, () => ({
      id: `ev-${dbState.evidence.length + 1}`,
      capturedAt: new Date().toISOString(),
      subjectUserId: null,
      reporterUserId: null,
    })),
    AbuseReport: makeModel("AbuseReport", dbState.reports, () => ({
      id: `rep-${dbState.reports.length + 1}`,
      reporterId: null,
      createdAt: new Date().toISOString(),
    })),
    ModerationAction: makeModel("ModerationAction", dbState.actions, () => ({
      id: `act-${dbState.actions.length + 1}`,
      caseId: null,
      actorId: null,
      targetType: null,
      targetId: null,
      reasonCode: null,
      note: null,
      createdAt: new Date().toISOString(),
    })),
    AuditEvent: makeModel("AuditEvent", dbState.audits, () => ({
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
    Notification: makeModel("Notification", dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      body: null,
      link: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    })),
    Listing: makeModel("Listing", dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      rejectionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    Appeal: makeModel("Appeal", dbState.appeals, () => ({
      id: `appeal-${dbState.appeals.length + 1}`,
      appellantId: null,
      statement: null,
      state: "submitted",
      createdAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    })),
    Message: makeModel("Message", dbState.messages, () => ({
      id: `msg-${dbState.messages.length + 1}`,
      imageUrl: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    })),
  };

  const orm = { public: models };
  return {
    db: {
      orm,
      // TRANSACTIONAL mock: throw trong callback → HOÀN TÁC mọi create/update
      // đã chạy trong tx (snapshot trước, restore khi throw) — pin đúng ngữ
      // nghĩa rollback của Postgres (Global Constraints: violation LUÔN throw
      // ra khỏi callback). Audit row tạo trong tx bị abort BIẾN MẤST khỏi
      // store — "appended" = row còn lại sau tx, không phải create call thô.
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = new Map<string, Row[]>();
        for (const [name, rows] of Object.entries(dbState)) {
          // mutationLog là STRING log (spy), không phải row store — bỏ qua.
          if (name === "mutationLog") continue;
          if (Array.isArray(rows)) {
            snapshot.set(name, (rows as Row[]).map((r) => ({ ...r })));
          }
        }
        try {
          return await fn({ orm: { public: orm.public } });
        } catch (e) {
          for (const [name, rows] of Object.entries(dbState)) {
            if (name === "mutationLog") continue;
            if (!Array.isArray(rows)) continue;
            const snap = snapshot.get(name) ?? [];
            const rowArr = rows as Row[];
            rowArr.length = 0;
            rowArr.push(...snap.map((r) => ({ ...r })));
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
  assignModerationCaseAction,
  transitionModerationCaseAction,
  takeDownListingAction,
  suspendUserAction,
  liftSuspensionAction,
} from "@/src/lib/actions/moderation";
import * as casePage from "../../app/admin/moderation/[id]/page";

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

/** Step-up TƯƠI (≤15 phút) — "fresh step-up fixture per call" (plan Task 8). */
const STEPPED_UP = () => new Date(Date.now() - 60_000).toISOString();

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

/** Audit rows đã PERSIST (tx-aware — row trong tx bị abort biến mất khỏi store). */
const auditsOf = (action: string): Row[] =>
  dbState.audits.filter((r) => r["action"] === action);

const actionsOf = (filter: Partial<Row>): Row[] =>
  dbState.actions.filter((r) =>
    Object.entries(filter).every(([k, v]) => r[k] === v),
  );

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.suspensions.length = 0;
  dbState.cases.length = 0;
  dbState.evidence.length = 0;
  dbState.reports.length = 0;
  dbState.actions.length = 0;
  dbState.audits.length = 0;
  dbState.notifications.length = 0;
  dbState.listings.length = 0;
  dbState.appeals.length = 0;
  dbState.messages.length = 0;
  // CHÚ Ý: mutationLog KHÔNG reset — tích lũy across suite (spy append-only,
  // test cuối file assert zero mutation trên 3 model audit).
  dbState.users.push(
    { ...ADMIN_SUPER }, { ...ADMIN_OPS }, { ...ADMIN_MOD },
    { ...SELLER }, { ...BUYER },
  );
  cookieState.store.clear();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. suspend/lift — append đúng một, failed second appends none ───────────

describe("suspend/lift — AuditEvent append (spec §4.6)", () => {
  it("suspend appends ĐÚNG MỘT moderation.user_suspended; suspend thứ hai FAIL (partial index) appends NONE (tx rollback); lift appends MỘT moderation.user_suspension_lifted", async () => {
    // Fresh step-up fixture per call — step-up TƯƠI, KHÔNG cần TOTP (A9).
    const sess1 = login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" }));

    // spy: đúng MỘT call với action moderation.user_suspended (filter theo
    // action — KHÔNG đếm tổng spy calls: action khác trong suite cũng append).
    expect(auditsOf("moderation.user_suspended")).toHaveLength(1);
    expect(auditsOf("moderation.user_suspended")[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: SELLER.id,
      resourceType: "user",
      resourceId: SELLER.id,
      reason: "confirmed_abuse",
      sessionId: sess1,
    });

    // Fresh step-up fixture cho call thứ hai — fail vì partial index
    // user_suspension_one_active (KHÔNG phải vì step-up), classified NGOÀI tx.
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });
    await expect(
      suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" })),
    ).rejects.toThrowError(/USER_ALREADY_SUSPENDED/);

    // VẪN đúng một — audit row trong tx bị abort KHÔNG tính (snapshot-restore).
    expect(auditsOf("moderation.user_suspended")).toHaveLength(1);

    // Lift thành công (KHÔNG step-up — hướng khôi phục) appends MỘT row.
    const susp = dbState.suspensions.find(
      (r) => r["userId"] === SELLER.id && r["status"] === "active",
    );
    expect(susp).toBeTruthy();
    const sess2 = login(ADMIN_OPS, { isAdmin: true });

    await liftSuspensionAction(
      fd({ suspensionId: susp!["id"] as string, reasonCode: "confirmed_abuse" }),
    );

    expect(auditsOf("moderation.user_suspension_lifted")).toHaveLength(1);
    expect(auditsOf("moderation.user_suspension_lifted")[0]).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: SELLER.id,
      reason: "confirmed_abuse",
      sessionId: sess2,
    });
  });
});

// ─── 2. Mọi action privileged của Batch 3 appends AuditEvent (registry) ─────

describe("mọi action privileged của Batch 3 appends AuditEvent (registry Task 8)", () => {
  type Case = {
    label: string;
    auditAction: string;
    moderationActionType: string;
    run: () => Promise<{ actorId: string; sessionId: string }>;
  };

  it.each<Case>([
    {
      label: "assignModerationCaseAction → moderation.case_assigned",
      auditAction: "moderation.case_assigned",
      moderationActionType: "case.assigned",
      run: async () => {
        const sessionId = login(ADMIN_MOD, { isAdmin: true });
        const c = seedCase({});
        seedEvidence(c.id, SELLER.id);
        await assignModerationCaseAction(
          fd({ caseId: c.id, moderatorId: ADMIN_OPS.id, reasonCode: "triage_assignment" }),
        );
        return { actorId: ADMIN_MOD.id, sessionId };
      },
    },
    {
      label: "transitionModerationCaseAction → moderation.case_transitioned",
      auditAction: "moderation.case_transitioned",
      moderationActionType: "case.transitioned",
      run: async () => {
        const sessionId = login(ADMIN_MOD, { isAdmin: true });
        const c = seedCase({ state: "open" });
        seedEvidence(c.id, SELLER.id);
        await transitionModerationCaseAction(
          fd({ caseId: c.id, toState: "triaged", reasonCode: "no_violation_found" }),
        );
        return { actorId: ADMIN_MOD.id, sessionId };
      },
    },
    {
      label: "takeDownListingAction → moderation.listing_taken_down",
      auditAction: "moderation.listing_taken_down",
      moderationActionType: "listing.taken_down",
      run: async () => {
        const sessionId = login(ADMIN_MOD, { isAdmin: true });
        const l = seedListing({ status: "approved" });
        await takeDownListingAction(
          fd({ listingId: l.id, reasonCode: "policy_violation_confirmed" }),
        );
        return { actorId: ADMIN_MOD.id, sessionId };
      },
    },
    {
      label: "liftSuspensionAction → moderation.user_suspension_lifted",
      auditAction: "moderation.user_suspension_lifted",
      moderationActionType: "user.suspension_lifted",
      run: async () => {
        const susp = seedSuspension(BUYER.id);
        const sessionId = login(ADMIN_OPS, { isAdmin: true });
        await liftSuspensionAction(
          fd({ suspensionId: susp.id, reasonCode: "confirmed_abuse" }),
        );
        return { actorId: ADMIN_OPS.id, sessionId };
      },
    },
    {
      label: "suspendUserAction → moderation.user_suspended",
      auditAction: "moderation.user_suspended",
      moderationActionType: "user.suspended",
      run: async () => {
        const sessionId = login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });
        await suspendUserAction(fd({ userId: SELLER.id, reasonCode: "confirmed_abuse" }));
        return { actorId: ADMIN_OPS.id, sessionId };
      },
    },
  ])("$label", async ({ auditAction, moderationActionType, run }) => {
    const { actorId, sessionId } = await run();

    // AuditEvent (spec §4.6) — actor/action/session.
    const rows = auditsOf(auditAction);
    expect(rows.length, `phải append ≥1 AuditEvent ${auditAction}`).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ actorId, sessionId });

    // ModerationAction (case-scoped history — spec §5.5) — cùng actor.
    const history = actionsOf({ actionType: moderationActionType, actorId });
    expect(history.length, `phải append ≥1 ModerationAction ${moderationActionType}`).toBeGreaterThanOrEqual(1);
  });
});

// ─── 3. Evidence view — moderation.evidence_viewed per render (E2) ───────────

describe("evidence view — moderation.evidence_viewed (E2 async server component, spec §5.5.1)", () => {
  type PageFn = (props: { params: Promise<{ id: string }> }) => Promise<unknown>;
  const AdminModerationCasePage = casePage.default as unknown as PageFn;
  const CASE_ID = "case-e2";

  /** Case về SELLER (user target) — viewer ADMIN_MOD không conflicted. */
  const seedForRender = (): void => {
    dbState.cases.push({
      id: CASE_ID,
      targetType: "user",
      targetId: SELLER.id,
      state: "investigating",
      priority: "normal",
      assignedModeratorId: null,
      reasonCategory: "suspected_scam",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    seedEvidence(CASE_ID, SELLER.id);
    dbState.reports.push({
      id: `rep-${dbState.reports.length + 1}`,
      caseId: CASE_ID,
      reporterId: BUYER.id,
      targetType: "user",
      targetId: SELLER.id,
      reasonCode: "suspected_scam",
      note: null,
      createdAt: new Date().toISOString(),
    });
  };

  it("render case detail → AuditEvent moderation.evidence_viewed đúng 1 lần; render thứ hai → row THỨ HAI (per-render)", async () => {
    const sessionId = login(ADMIN_MOD, { isAdmin: true });
    seedForRender();

    // Async server component = async function ngoài Next — await component
    // executes toàn bộ audit path (requireCapability → reads → auditEvent).
    await AdminModerationCasePage({ params: Promise.resolve({ id: CASE_ID }) });

    const viewed = auditsOf("moderation.evidence_viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({
      actorId: ADMIN_MOD.id,
      action: "moderation.evidence_viewed",
      resourceType: "moderation_case",
      resourceId: CASE_ID,
      sessionId,
    });

    // Mỗi render = một vết xem (spec §5.5.1 "separately audited").
    await AdminModerationCasePage({ params: Promise.resolve({ id: CASE_ID }) });
    expect(auditsOf("moderation.evidence_viewed")).toHaveLength(2);
  });
});

// ─── 4. PII — note admin redact tại write time (spec §4.8) ────────────────────

describe("note admin — redactDetail tại write time vào CẢ AuditEvent.detail LẪN ModerationAction.note (spec §4.8)", () => {
  it("note chứa email + chuỗi hình OTP 6 chữ số → mask trong CẢ HAI (write-time redaction)", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const l = seedListing({ status: "approved" });

    await takeDownListingAction(
      fd({
        listingId: l.id,
        reasonCode: "policy_violation_confirmed",
        note: "victim@example.com đối chiếu qua mã 123456",
      }),
    );

    // AuditEvent.detail — mask email + OTP-shape, KHÔNG chứa thô.
    const audit = auditsOf("moderation.listing_taken_down")[0]!;
    expect(audit["detail"]).toContain("[REDACTED_EMAIL]");
    expect(audit["detail"]).toContain("[REDACTED_OTP]");
    expect(audit["detail"]).not.toContain("victim@example.com");
    expect(audit["detail"]).not.toContain("123456");

    // ModerationAction.note — cùng write-time redaction (belt-and-braces).
    const act = actionsOf({ actionType: "listing.taken_down", targetId: l.id })[0]!;
    expect(act["note"]).toContain("[REDACTED_EMAIL]");
    expect(act["note"]).toContain("[REDACTED_OTP]");
    expect(act["note"]).not.toContain("victim@example.com");
    expect(act["note"]).not.toContain("123456");
  });
});

// ─── 5. ModerationAction append-only ─────────────────────────────────────────

describe("ModerationAction — append-only (spec §5.5 case-scoped history)", () => {
  it("hai transition → HAI ModerationAction rows (không overwrite)", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const c = seedCase({ state: "open" });
    seedEvidence(c.id, SELLER.id);

    await transitionModerationCaseAction(
      fd({ caseId: c.id, toState: "triaged", reasonCode: "other_reviewed_reason" }),
    );
    await transitionModerationCaseAction(
      fd({ caseId: c.id, toState: "investigating", reasonCode: "policy_violation_confirmed" }),
    );

    const transitions = actionsOf({ actionType: "case.transitioned", caseId: c.id });
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ reasonCode: "other_reviewed_reason" });
    expect(transitions[1]).toMatchObject({ reasonCode: "policy_violation_confirmed" });
  });
});

// ─── 6. (S12) No statement mutates the three audit models ────────────────────

describe("(S12) KHÔNG statement nào mutate ModerationEvidence/ModerationAction/AuditEvent", () => {
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

  const MODELS = ["ModerationEvidence", "ModerationAction", "AuditEvent"] as const;
  const MUTATION_OPS = [".update(", ".updateAll(", ".delete(", ".deleteAll("] as const;

  it("per-statement scan (strip comment, split \";\") — statement chứa model + op mutation → fail", () => {
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
    expect(offenders, "KHÔNG statement nào mutate 3 model audit (append-only)").toEqual([]);
  });
});

// ─── 7. Audit page — action-prefix filter (?action=) — source contract ────────

describe("audit page — filter theo action prefix (?action=)", () => {
  const PAGE = "app/admin/audit/page.tsx";
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

  it("requireCapability(audit.read) vẫn là guard ĐẦU TIÊN — trước mọi db read (super_admin only, fail closed A1)", () => {
    const src = read(PAGE);
    const guardIdx = src.indexOf('requireCapability("audit.read")');
    const dbIdx = src.indexOf("db.orm.public");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(dbIdx).toBeGreaterThan(guardIdx);
  });

  it("đọc searchParams.action + filter AuditEvent qua ilike(`${prefix}.%`) khi có prefix", () => {
    const src = read(PAGE);
    expect(src).toContain("searchParams");
    expect(src).toMatch(/action\.ilike\(`\$\{[A-Za-z]+\}\.%`\)/);
  });

  it("render prefix filter ĐÓNG (Tất cả + moderation/seller_verification/session/admin/user)", () => {
    const src = read(PAGE);
    expect(src).toContain("Tất cả");
    for (const p of ["moderation", "seller_verification", "session", "admin", "user"]) {
      expect(src, `prefix "${p}" phải có trong danh sách filter`).toContain(`"${p}"`);
    }
  });
});

// ─── 8. Scope Decisions — report/appeal KHÔNG ghi AuditEvent ─────────────────

describe("Scope Decisions — report/appeal KHÔNG phải AuditEvent (actor là user thường)", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

  it("src/lib/actions/reports.ts + appeals.ts KHÔNG gọi auditEvent/auditEventTx", () => {
    for (const f of ["src/lib/actions/reports.ts", "src/lib/actions/appeals.ts"]) {
      const src = read(f);
      expect(src, `${f} không được gọi auditEventTx(`).not.toContain("auditEventTx(");
      expect(src, `${f} không được gọi auditEvent(`).not.toContain("auditEvent(");
    }
  });
});

// ─── 9. Append-only across suite — zero mutation trên 3 model audit ──────────

describe("append-only across suite — zero update*/delete* trên AuditEvent/ModerationAction/ModerationEvidence", () => {
  it("mutationLog (tích lũy toàn suite) KHÔNG có op mutation nào trên 3 model audit", () => {
    // Chạy SAU mọi test db ở trên (vitest chạy describe theo thứ tự khai báo)
    // — mutationLog KHÔNG reset trong beforeEach nên phủ mọi test đã chạy.
    const forbidden = dbState.mutationLog.filter(
      (op) =>
        op.startsWith("AuditEvent:") ||
        op.startsWith("ModerationAction:") ||
        op.startsWith("ModerationEvidence:"),
    );
    expect(forbidden, "3 model audit là append-only — zero update/delete").toEqual([]);
  });
});
