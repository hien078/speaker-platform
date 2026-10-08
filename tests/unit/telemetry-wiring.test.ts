/**
 * Funnel event wiring vào các surface hiện có (Batch 5 Task 8 — S7) — unit tests.
 *
 * CỔNG của task (plan Task 8 Step 1 + corrections #6/#7/#15 + b5-review T6 seam):
 *  - telemetry-recorders.ts (S-22) là module server THUẦN ("server-only", KHÔNG
 *    "use server") — mọi emission logic sống ở ĐÓ, page/action/route chỉ gọi;
 *    recorder fail-open toàn phần (lỗi db/key → captureError, KHÔNG phá flow).
 *  - recordListingView (S-12 chỉ approved / S-8 bỏ prefetch / S-15 throttle
 *    1 view / viewer / listing / 10 phút / ownerView + fromSearch);
 *    recordSearchResultClick (S-14: ss phải khớp row search_submitted ĐÃ GHI
 *    VÀ listing ∈ resultListingIds — ss lạ/forge → KHÔNG event, Review Focus 7).
 *  - startConversationAction: conversation_started CHỈ trên path tạo MỚI (branch
 *    redirect vào convo cũ KHÔNG emit), sau MỌI guard Batch 3 (block/suspension)
 *    + status approved + create thành công (S5); emit TRƯỚC redirect(), KHÔNG
 *    trong catch nuốt NEXT_REDIRECT (corrections #15).
 *  - chat POST: conversation_buyer_first_message cho tin ĐẦU TIÊN của buyer
 *    (0 tin buyer trước đó — D4 eligibility) + message_first_response cho tin
 *    ĐẦU TIÊN của seller SAU ≥1 tin buyer (responseMs = elapsed từ tin buyer
 *    đầu — D4 anchor); tin thứ hai của mỗi bên → KHÔNG event.
 *  - rejectListingAction → listing_rejected (actor = admin); approveListingAction
 *    → seller_first_listing_published CHỈ khi checkListingPublication pass +
 *    update thành công (S5) VÀ CHƯA có event nào cho pseudonym của seller (S-19
 *    event-existence check — append-only → check chính xác "lần approve đầu").
 *  - takeDownListingAction → listing_removed SAU updateAll thành công (non-zero
 *    rows — 0 rows đã throw trong tx → action fail → KHÔNG emit); emit NGOÀI tx
 *    (corrections #7 — KHÔNG BAO GIỜ trong db.transaction callback).
 *  - submitReportAction → report_submitted với targetType/reasonCode TYPED
 *    (corrections #6: KHÔNG targetId trong metadata — PII khi targetType=user;
 *    đích listing đi cột listingId), KHÔNG note text; hai success path (chính +
 *    retry) → compute result once, emit ONCE (corrections #7).
 *  - reviewSellerVerificationAction → seller_verified CHỈ decision=verified
 *    (actor = seller được xác minh, KHÔNG phải admin reviewer).
 *  - setBetaMembershipAction → beta_membership_activated CHỈ khi chuyển sang
 *    active (wasActive derive từ existing?.status — corrections #15: action
 *    không atomic, tolerate duplicate events).
 *  - Finance modules (Review Focus 2): orders/escrow/wallet/ledger/momo/
 *    mock-payment KHÔNG BAO GIỀ chạm ProductEvent/emitProductEvent (source scan).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache +
 * next/navigation (redirect throw) + next/headers (headers/cookies điều khiển
 * được) + `@/src/lib/auth` fixture (requireUser/getCurrentUser cho action/route
 * của user thường) + `@/src/lib/moderation-snapshot` fixture + observability spy
 * + db.client in-memory ĐẦY model (tx SNAPSHOT-RESTORE — throw trong callback
 * hoàn tác mọi create/update của tx mình; unique enforcement ModerationCase
 * partial index + AbuseReport @@unique + race seams ported từ
 * report-actions.test.ts). session/rbac/moderation/rate-limit/audit-event/
 * listing-publication/seller-verification-policy/product-events GIỮ BẢN THẬT —
 * admin login qua COOKIE THẬT, guards chạy đúng code production đọc store mock;
 * emit core thật nạp key test từ env (spy trên db mock = store productEvents).
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

// ─── auth fixture — requireUser/getCurrentUser cho action/route user thường ──

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
  requireUser: vi.fn(async () => {
    if (authState.user === null) {
      const { redirect } = await import("next/navigation");
      redirect("/login");
    }
    return authState.user!;
  }),
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── moderation-snapshot fixture (report tx) ─────────────────────────────────

const snapshotState = vi.hoisted(() => ({ vanish: false }));

vi.mock("@/src/lib/moderation-snapshot", () => ({
  captureTargetSnapshot: vi.fn(
    async (
      targetType: "listing" | "user" | "message",
      _targetId: string,
    ): Promise<{ snapshot: Record<string, unknown>; subjectUserId: string | null } | null> => {
      if (snapshotState.vanish) return null;
      if (targetType === "listing") {
        return {
          snapshot: { kind: "listing", capturedAt: "2026-10-01T00:00:00.000Z" },
          subjectUserId: "seller-1",
        };
      }
      if (targetType === "user") {
        return { snapshot: { kind: "user", capturedAt: "2026-10-01T00:00:00.000Z" }, subjectUserId: null };
      }
      return { snapshot: { kind: "message", capturedAt: "2026-10-01T00:00:00.000Z" }, subjectUserId: "seller-1" };
    },
  ),
}));

// ─── observability spy — rejection log KHÔNG BAO GIỀ value/payload ───────────

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── db.client mock — in-memory ĐẦY model + tx SNAPSHOT-RESTORE + unique ─────

type Row = Record<string, unknown>;
type Pred = ((proxy: unknown) => unknown) | Row;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  sessions: [] as Row[],
  listings: [] as Row[],
  images: [] as Row[],
  uploads: [] as Row[],
  categories: [] as Row[],
  brands: [] as Row[],
  models: [] as Row[],
  verifications: [] as Row[],
  acceptances: [] as Row[],
  memberships: [] as Row[],
  suspensions: [] as Row[],
  blocks: [] as Row[],
  conversations: [] as Row[],
  messages: [] as Row[],
  cases: [] as Row[],
  reports: [] as Row[],
  evidence: [] as Row[],
  actions: [] as Row[],
  audits: [] as Row[],
  adminAudits: [] as Row[],
  notifications: [] as Row[],
  productEvents: [] as Row[],
  /** Race seams report tx — ported từ report-actions.test.ts (S4/L1/L2). */
  raceWinner: null as null | { case?: Row; report?: Row; evidence?: Row; action?: Row },
  closeCaseOnReport: null as string | null,
  failCaseCreate: false,
}));

vi.mock("@/src/prisma/db.client", async () => {
  const { SqlQueryError } = await import("@prisma/orm-family-sql/errors");

  type SortSpec = Array<{ field: string; dir: "asc" | "desc" }>;

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
          in: (values: readonly unknown[]) => Array.isArray(values) && values.includes(row[field]),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
          asc: () => ({ field, dir: "asc" as const }),
          desc: () => ({ field, dir: "desc" as const }),
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const orderBySpec = (cb: (ops: unknown) => unknown): SortSpec => {
    const spec = cb(fieldOps({} as Row));
    return (Array.isArray(spec) ? spec : [spec]) as SortSpec;
  };

  const sortRows = (rows: Row[], spec: SortSpec): Row[] =>
    [...rows].sort((a, b) => {
      for (const s of spec) {
        const av = a[s.field] as number;
        const bv = b[s.field] as number;
        const cmp = av === bv ? 0 : av > bv ? 1 : -1;
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });

  const makeModel = (
    rows: Row[],
    defaults?: () => Row,
    attach?: (row: Row) => void,
  ) => {
    const query = (
      preds: Pred[],
      sortSpec: SortSpec | null,
      limitN: number | null,
      includeRel?: string,
    ) => ({
      where: (pred: Pred) => query([...preds, pred], sortSpec, limitN, includeRel),
      include: (rel: string, _cb?: unknown) => query(preds, sortSpec, limitN, rel),
      orderBy: (cb: (ops: unknown) => unknown) => query(preds, orderBySpec(cb), limitN, includeRel),
      limit: (n: number) => query(preds, sortSpec, n, includeRel),
      select: (..._fields: unknown[]) => query(preds, sortSpec, limitN, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        if (includeRel !== undefined && attach !== undefined) attach(copy);
        return copy;
      },
      all: async () => {
        let hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (sortSpec !== null) hit = sortRows(hit, sortSpec);
        if (limitN !== null) hit = hit.slice(0, limitN);
        return hit.map((r) => {
          const copy = { ...r };
          if (includeRel !== undefined && attach !== undefined) attach(copy);
          return copy;
        });
      },
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
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? {}), id: `row-${rows.length + 1}`, ...data };
        if (row["id"] === undefined || row["id"] === null || row["id"] === "") {
          row["id"] = `row-${rows.length + 1}`;
        }
        rows.push(row);
        const copy = { ...row };
        if (attach !== undefined) attach(copy);
        return copy;
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
    });
    return {
      first: (filter?: Pred) => query([], null, null).first(filter),
      where: (pred: Pred) => query([pred], null, null),
      all: () => query([], null, null).all(),
      create: (data: Row) => query([], null, null).create(data),
      updateAll: (data: Row) => query([], null, null).updateAll(data),
    };
  };

  /** Race winner (S4) — "concurrent tx" commit giữa chừng, consume MỘT lần. */
  const consumeRaceWinner = (): void => {
    const w = dbState.raceWinner;
    if (w === null) return;
    dbState.raceWinner = null;
    for (const [row, store] of [
      [w.case, dbState.cases],
      [w.report, dbState.reports],
      [w.evidence, dbState.evidence],
      [w.action, dbState.actions],
    ] as Array<[Row | undefined, Row[]]>) {
      if (row !== undefined) {
        row["_external"] = true;
        store.push(row);
      }
    }
  };

  const ACTIVE_STATES = ["open", "triaged", "investigating"];

  // ModerationCase — enforce partial unique index (một case active per key).
  const caseModel = {
    ...makeModel(dbState.cases, () => ({
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      state: "open",
      priority: "normal",
      assignedModeratorId: null,
    })),
    create: async (data: Row) => {
      consumeRaceWinner();
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

  // AbuseReport — enforce @@unique([caseId, reporterId]) + seam L1 close-on-report.
  const reportModel = {
    ...makeModel(dbState.reports, () => ({ createdAt: "2026-10-01T00:00:00.000Z" })),
    create: async (data: Row) => {
      consumeRaceWinner();
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
    UserSession: makeModel(
      dbState.sessions,
      () => ({
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        revokedAt: null,
        revokedReason: null,
        steppedUpAt: null,
        isAdmin: false,
        userAgent: null,
      }),
      (row) => {
        row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
      },
    ),
    Listing: makeModel(dbState.listings, () => ({ createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
    ListingImage: makeModel(dbState.images, () => ({ sortOrder: 0 })),
    ListingImageUpload: makeModel(dbState.uploads, () => ({ createdAt: new Date().toISOString() })),
    Category: makeModel(dbState.categories),
    Brand: makeModel(dbState.brands),
    ProductModel: makeModel(dbState.models),
    SellerVerification: makeModel(dbState.verifications, () => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    PolicyAcceptance: makeModel(dbState.acceptances, () => ({ acceptedAt: new Date().toISOString() })),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    UserSuspension: makeModel(dbState.suspensions),
    UserBlock: makeModel(dbState.blocks),
    Conversation: makeModel(dbState.conversations, () => ({ createdAt: new Date().toISOString(), lastMessageAt: null })),
    Message: makeModel(dbState.messages, () => ({ createdAt: new Date().toISOString(), imageUrl: null, readAt: null })),
    ModerationCase: caseModel,
    AbuseReport: reportModel,
    ModerationEvidence: makeModel(dbState.evidence, () => ({ capturedAt: new Date().toISOString() })),
    ModerationAction: makeModel(dbState.actions, () => ({ createdAt: new Date().toISOString() })),
    AuditEvent: makeModel(dbState.audits, () => ({ createdAt: new Date().toISOString() })),
    AdminAuditLog: makeModel(dbState.adminAudits, () => ({ createdAt: new Date().toISOString() })),
    Notification: makeModel(dbState.notifications, () => ({ createdAt: new Date().toISOString() })),
    ProductEvent: makeModel(dbState.productEvents, () => ({ occurredAt: new Date().toISOString() })),
  };

  return {
    db: {
      orm: { public: models },
      // TRANSACTIONAL mock: throw trong callback → HOÀN TÁC mọi create/update của
      // tx mình (snapshot/restore) — pin đúng ngữ nghĩa rollback Postgres; row
      // `_external` (race simulation — commit của MỘT tx khác) KHÔNG bị hoàn tác.
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

// ─── Imports — modules THẬT + modules dưới test ──────────────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import { db } from "@/src/prisma/db.client"; // db mock in-memory (seam fail-open test)
import { actorPseudonymFor, sessionPseudonymFor } from "@/src/lib/product-events";
// Recorders được test QUA action/route gọi chúng (S-22 — emission logic sống trong
// module); recordListingView/recordSearchResultClick test TRỰC TIẾP (page không render
// trong unit — async page render harness không cần cho 2 recorder thuần này).
import { recordListingView, recordSearchResultClick } from "@/src/lib/telemetry-recorders";
import { startConversationAction } from "@/src/lib/actions/chat";
import { POST as postChatMessage } from "../../app/api/chat/[id]/route";
import { approveListingAction, rejectListingAction } from "@/src/lib/actions/admin";
import { takeDownListingAction } from "@/src/lib/actions/moderation";
import { submitReportAction, type ReportFormState } from "@/src/lib/actions/reports";
import { reviewSellerVerificationAction } from "@/src/lib/actions/seller-verification";
import { setBetaMembershipAction } from "@/src/lib/actions/beta-cohort";
import { captureError } from "@/src/lib/observability";

const captureErrorMock = vi.mocked(captureError);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(`${root}/${p}`, "utf8");

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const BUYER: FixtureUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "mua@loaviet.test",
  name: "Người Mua",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-buyer",
};

const SELLER: FixtureUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "ban@loaviet.test",
  name: "Người Bán",
  role: "seller",
  avatarUrl: null,
  isVerifiedSeller: true,
  adminRole: null,
  sessionId: "sess-seller",
};

/** User row cho store db (isInternalActor đọc User.first({id})). */
const mkUserRow = (over: Row = {}): Row & { id: string } => ({
  id: "user-x",
  email: "x@loaviet.test",
  name: "X",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const ADMIN_OPS = mkUserRow({
  id: "admin-ops",
  email: "ops@loaviet.test",
  name: "Ops",
  role: "admin",
  adminRole: "operations_admin",
});

/** Seller ĐỦ policy v1 (Batch 4 verified-seller fixture shape — publication-gate). */
const VERIFIED_SELLER = mkUserRow({
  id: "seller-1",
  email: "seller@loaviet.test",
  name: "Seller",
  role: "seller",
  emailVerifiedAt: "2026-10-01T00:00:00.000Z",
  phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
  sellerType: "individual",
  sellerOperatingProvinceCode: "ha-noi",
});

const CATEGORY = {
  id: "cat-1",
  name: "Loa Bluetooth di động",
  slug: "portable_bluetooth_speaker",
  commissionRate: 5,
  sortOrder: 0,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const BRAND = { id: "brand-1", name: "JBL", slug: "jbl", logoUrl: null, createdAt: "2026-09-01T00:00:00.000Z" };

const MODEL = {
  id: "model-1",
  brandId: "brand-1",
  categoryId: CATEGORY.id,
  name: "Charge 5",
  slug: "jbl-charge-5",
  releaseYear: null,
  description: null,
  specs: null,
  image: null,
  status: "approved",
  mergedIntoId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

/** Nạp seller + 3 row policy (acceptance/membership active/verification). */
const seedPolicyRows = (
  sellerId: string,
  over?: { membershipStatus?: string; verificationStatus?: string },
): void => {
  dbState.acceptances.push({
    id: `pa-${dbState.acceptances.length + 1}`,
    userId: sellerId,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: new Date().toISOString(),
  });
  dbState.memberships.push({
    id: `bcm-${dbState.memberships.length + 1}`,
    userId: sellerId,
    cohort: "founding_seller",
    status: over?.membershipStatus ?? "active",
    invitedBy: null,
    invitedAt: null,
    acceptedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  dbState.verifications.push({
    id: `sv-${dbState.verifications.length + 1}`,
    userId: sellerId,
    status: over?.verificationStatus ?? "verified",
    method: "operations_review",
    submittedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewerId: "admin-ops",
    reasonCode: "requirements_met",
    note: null,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

/** Ảnh upload thuộc seller — rule ownership của content stage. */
const seedUpload = (ownerUserId: string, storageKey: string): void => {
  dbState.uploads.push({
    id: `up-${dbState.uploads.length + 1}`,
    ownerUserId,
    storageKey,
    bytes: 1024,
    width: 800,
    height: 600,
    createdAt: new Date().toISOString(),
  });
};

const seedImage = (listingId: string, url: string, checklistSlot: string | null, sortOrder = 0): void => {
  dbState.images.push({ id: `img-${dbState.images.length + 1}`, listingId, url, sortOrder, checklistSlot });
};

/** Listing fixture structured beta đầy đủ + 1 ảnh gắn (slot front). */
const seedListing = (sellerId: string, status: string, over: Row = {}): Row => {
  const row: Row = {
    id: `listing-${dbState.listings.length + 1}`,
    sellerId,
    categoryId: CATEGORY.id,
    brandId: BRAND.id,
    title: "Loa JBL Charge 5 chính hãng",
    slug: `loa-jbl-charge-5-${dbState.listings.length + 1}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status,
    rejectionReason: null,
    city: "Hà Nội",
    viewCount: 0,
    productModelId: MODEL.id,
    inventoryContext: "used",
    includedAccessories: null,
    knownDefects: null,
    repairHistory: null,
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: "ha-noi",
    communeLevelCode: null,
    locationDisplayName: "Khu vực Cầu Giấy",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  dbState.listings.push(row);
  return row;
};

/** Login THẬT qua cookie (admin actions — rbac đọc session từ store mock). */
const login = (user: Row, opts?: { isAdmin?: boolean; steppedUpAt?: string }): string => {
  const id = `sess-${user["id"]}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user["id"],
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

/** Session admin MFA + step-up TƯƠI (≤15 phút) — không cần totpCode. */
const STEPPED_UP = () => new Date(Date.now() - 60_000).toISOString();

const fd = (entries: Record<string, string | string[]>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const item of v) form.append(k, item);
    else form.set(k, v);
  }
  return form;
};

/** POST /api/chat/[id] — route invocation TRỰC TIẾP (không qua UI). */
const postMessage = (convoId: string, body: string): Promise<Response> =>
  postChatMessage(
    new Request(`http://local/api/chat/${convoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof postChatMessage>[1],
  );

const eventsNamed = (name: string): Row[] =>
  dbState.productEvents.filter((e) => e["name"] === name);

const resetStores = (): void => {
  for (const arr of Object.values(dbState)) {
    if (Array.isArray(arr)) arr.length = 0;
  }
  dbState.raceWinner = null;
  dbState.closeCaseOnReport = null;
  dbState.failCaseCreate = false;
  snapshotState.vanish = false;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  resetStores();
  resetRateLimits();
  authState.user = { ...BUYER };
  cookieState.store.clear();
  headerState.headers = new Headers();
  captureErrorMock.mockClear();
  // Base: user thường (fixture auth) + admin ops (rbac login) + catalog rows.
  dbState.users.push({ ...BUYER }, { ...SELLER }, { ...ADMIN_OPS }, { ...VERIFIED_SELLER });
  dbState.categories.push({ ...CATEGORY });
  dbState.brands.push({ ...BRAND });
  dbState.models.push({ ...MODEL });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── recordListingView (S-12/S-8/S-15) ───────────────────────────────────────

describe("recordListingView — approved-only, no-prefetch, throttle (S-12/S-8/S-15)", () => {
  const listing = (status: string): { id: string; slug: string; status: string; sellerId: string; provinceLevelCode: string | null } => ({
    id: "listing-view-1",
    slug: "loa-jbl-charge-5",
    status,
    sellerId: SELLER.id,
    provinceLevelCode: "ha-noi",
  });

  it("approved + viewer authed → emitted với ownerView/fromSearch/provinceCode; actorPseudonym ≠ raw id", async () => {
    await recordListingView({
      listing: listing("approved"),
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
      isPrefetch: false,
      fromSearch: false,
    });
    expect(dbState.productEvents).toHaveLength(1);
    const evt = dbState.productEvents[0]!;
    expect(evt["name"]).toBe("listing_viewed");
    expect(evt["listingId"]).toBe("listing-view-1");
    expect(evt["provinceCode"]).toBe("ha-noi");
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
    expect(evt["actorPseudonym"]).not.toBe(BUYER.id);
    expect(evt["sessionPseudonym"]).toBe(sessionPseudonymFor(BUYER.sessionId));
    expect(evt["metadata"]).toEqual({ ownerView: false, fromSearch: false });
  });

  it.each(["draft", "hidden", "pending", "removed", "sold"])("status %s → KHÔNG emit (S-12)", async (status) => {
    await recordListingView({
      listing: listing(status),
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
      isPrefetch: false,
      fromSearch: false,
    });
    expect(dbState.productEvents).toHaveLength(0);
  });

  it("isPrefetch → KHÔNG emit (S-8)", async () => {
    await recordListingView({
      listing: listing("approved"),
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
      isPrefetch: true,
      fromSearch: false,
    });
    expect(dbState.productEvents).toHaveLength(0);
  });

  it("view thứ hai trong 10 phút cùng viewer → throttle bỏ (S-15); view của seller → ownerView: true", async () => {
    await recordListingView({
      listing: listing("approved"),
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
      isPrefetch: false,
      fromSearch: false,
    });
    expect(dbState.productEvents).toHaveLength(1);

    // cùng viewer + listing → throttle (limit 1 / 10 phút)
    await recordListingView({
      listing: listing("approved"),
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
      isPrefetch: false,
      fromSearch: true,
    });
    expect(dbState.productEvents).toHaveLength(1);

    // seller tự xem → key throttle KHÁC → emit với ownerView: true
    await recordListingView({
      listing: listing("approved"),
      viewer: { id: SELLER.id, sessionId: SELLER.sessionId },
      isPrefetch: false,
      fromSearch: false,
    });
    expect(dbState.productEvents).toHaveLength(2);
    expect(dbState.productEvents[1]!["metadata"]).toEqual({ ownerView: true, fromSearch: false });
    expect(dbState.productEvents[1]!["actorPseudonym"]).toBe(actorPseudonymFor(SELLER.id));
  });

  it("viewer ẩn danh → vẫn emit với actorPseudonym null (ownerView false)", async () => {
    await recordListingView({
      listing: listing("approved"),
      viewer: null,
      isPrefetch: false,
      fromSearch: true,
    });
    expect(dbState.productEvents).toHaveLength(1);
    const evt = dbState.productEvents[0]!;
    expect(evt["actorPseudonym"]).toBeNull();
    expect(evt["sessionPseudonym"]).toBeNull();
    expect(evt["metadata"]).toEqual({ ownerView: false, fromSearch: true });
  });
});

// ─── recordSearchResultClick (S-14 — Review Focus 7) ─────────────────────────

describe("recordSearchResultClick — ss binding (S-14, Review Focus 7)", () => {
  const seedSearch = (ss: string, resultListingIds: string[]): void => {
    dbState.productEvents.push({
      id: `pe-search-${dbState.productEvents.length + 1}`,
      name: "search_submitted",
      searchSessionId: ss,
      actorPseudonym: actorPseudonymFor(BUYER.id),
      sessionPseudonym: null,
      isInternal: false,
      occurredAt: new Date().toISOString(),
      metadata: { resultCount: resultListingIds.length, resultListingIds },
    });
  };

  it("ss hợp lệ + listing ∈ result set → emit search_result_clicked với actor (Task 9 binding)", async () => {
    seedSearch("ss-1", ["listing-1", "listing-2"]);
    const emitted = await recordSearchResultClick({
      ss: "ss-1",
      listing: { id: "listing-1", provinceLevelCode: "ha-noi" },
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
    });
    expect(emitted).toBe(true);
    expect(dbState.productEvents).toHaveLength(2);
    const evt = eventsNamed("search_result_clicked")[0]!;
    expect(evt["searchSessionId"]).toBe("ss-1");
    expect(evt["listingId"]).toBe("listing-1");
    expect(evt["provinceCode"]).toBe("ha-noi");
    // actor PHẢI được emit (b5-review Task 9 — engine bind click actor ↔ session actor)
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
    expect(evt["sessionPseudonym"]).toBe(sessionPseudonymFor(BUYER.sessionId));
  });

  it("ss hợp lệ + listing NGOÀI result set → KHÔNG event (ss copy không chế tạo CTR)", async () => {
    seedSearch("ss-2", ["listing-1"]);
    const emitted = await recordSearchResultClick({
      ss: "ss-2",
      listing: { id: "listing-other", provinceLevelCode: null },
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
    });
    expect(emitted).toBe(false);
    expect(eventsNamed("search_result_clicked")).toHaveLength(0);
  });

  it("ss KHÔNG khớp search_submitted nào → KHÔNG event (forge)", async () => {
    const emitted = await recordSearchResultClick({
      ss: "ss-forged",
      listing: { id: "listing-1", provinceLevelCode: null },
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
    });
    expect(emitted).toBe(false);
    expect(eventsNamed("search_result_clicked")).toHaveLength(0);
  });

  it("ss null → KHÔNG event", async () => {
    const emitted = await recordSearchResultClick({
      ss: null,
      listing: { id: "listing-1", provinceLevelCode: null },
      viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
    });
    expect(emitted).toBe(false);
    expect(eventsNamed("search_result_clicked")).toHaveLength(0);
  });
});

// ─── startConversationAction — conversation_started (S5/S7) ───────────────────

describe("startConversationAction — conversation_started chỉ trên path tạo MỚI", () => {
  let listingNew: Row;

  beforeEach(() => {
    listingNew = seedListing(SELLER.id, "approved");
  });

  it("tạo conversation MỚI → emit conversation_started (conversationId + listingId + buyer pseudonym)", async () => {
    await expect(
      startConversationAction(fd({ listingId: String(listingNew["id"]) })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(dbState.conversations).toHaveLength(1);
    const evt = eventsNamed("conversation_started")[0]!;
    expect(evt["conversationId"]).toBe(dbState.conversations[0]!["id"]);
    expect(evt["listingId"]).toBe(listingNew["id"]);
    expect(evt["provinceCode"]).toBe("ha-noi");
    // pseudonym — KHÔNG BAO GIỀ raw buyer id trong row (S-10)
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
    expect(JSON.stringify(evt)).not.toContain(BUYER.id);
    expect(evt["sessionPseudonym"]).toBe(sessionPseudonymFor(BUYER.sessionId));
  });

  it("branch existing-conversation (redirect) → KHÔNG emit", async () => {
    dbState.conversations.push({
      id: "convo-existing",
      listingId: listingNew["id"],
      buyerId: BUYER.id,
      sellerId: SELLER.id,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    });

    await expect(
      startConversationAction(fd({ listingId: String(listingNew["id"]) })),
    ).rejects.toThrow("NEXT_REDIRECT:/chat/convo-existing");

    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("cặp bị BLOCK (Batch 3 guard) → CHAT_BLOCKED, KHÔNG conversation, KHÔNG emit (S5)", async () => {
    dbState.blocks.push({
      id: "blk-1",
      blockerId: SELLER.id,
      blockedId: BUYER.id,
      createdAt: new Date().toISOString(),
    });

    await expect(
      startConversationAction(fd({ listingId: String(listingNew["id"]) })),
    ).rejects.toThrow("CHAT_BLOCKED");

    expect(dbState.conversations).toHaveLength(0);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("initiator BỊ ĐÌNH CHỈ (Batch 3 guard) → ACCOUNT_SUSPENDED, KHÔNG emit (S5)", async () => {
    dbState.suspensions.push({
      id: "susp-1",
      userId: BUYER.id,
      status: "active",
      reasonCode: "confirmed_abuse",
      suspendedById: ADMIN_OPS.id,
      suspendedAt: new Date().toISOString(),
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    });

    await expect(
      startConversationAction(fd({ listingId: String(listingNew["id"]) })),
    ).rejects.toThrow("ACCOUNT_SUSPENDED");

    expect(dbState.conversations).toHaveLength(0);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("listing KHÔNG approved → LISTING_NOT_AVAILABLE, KHÔNG emit (b4-holistic guard chạy trước create)", async () => {
    const hidden = seedListing(SELLER.id, "hidden");

    await expect(
      startConversationAction(fd({ listingId: String(hidden["id"]) })),
    ).rejects.toThrow("LISTING_NOT_AVAILABLE");

    expect(dbState.conversations).toHaveLength(0);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });
});

// ─── chat POST — buyer first message + seller first response (D4) ─────────────

describe("chat POST — conversation_buyer_first_message + message_first_response (D4)", () => {
  let convo: Row;

  const seedConvo = (): Row => {
    convo = {
      id: "convo-chat",
      listingId: "listing-chat",
      buyerId: BUYER.id,
      sellerId: SELLER.id,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    };
    dbState.conversations.push(convo);
    return convo;
  };

  const seedMessage = (senderId: string, atMsAgo = 0): void => {
    dbState.messages.push({
      id: `msg-${dbState.messages.length + 1}`,
      conversationId: convo["id"],
      senderId,
      body: "tin nhắn",
      imageUrl: null,
      readAt: null,
      createdAt: new Date(Date.now() - atMsAgo).toISOString(),
    });
  };

  it("tin ĐẦU TIÊN của buyer → conversation_buyer_first_message (actor = buyer)", async () => {
    seedConvo();
    const res = await postMessage(String(convo["id"]), "chào bạn, còn hàng không?");
    expect(res.ok).toBe(true);

    const evt = eventsNamed("conversation_buyer_first_message")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["conversationId"]).toBe(convo["id"]);
    expect(evt["listingId"]).toBe("listing-chat");
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
  });

  it("tin THỨ HAI của buyer → KHÔNG event mới", async () => {
    seedConvo();
    await postMessage(String(convo["id"]), "tin 1");
    await postMessage(String(convo["id"]), "tin 2");

    expect(eventsNamed("conversation_buyer_first_message")).toHaveLength(1);
  });

  it("reply ĐẦU TIÊN của seller sau ≥1 tin buyer → message_first_response với responseMs (D4 anchor)", async () => {
    seedConvo();
    seedMessage(BUYER.id, 5_000); // tin buyer đầu — 5s trước
    authState.user = { ...SELLER }; // SELLER gửi tin

    const res = await postMessage(String(convo["id"]), "còn hàng bạn ơi");
    expect(res.ok).toBe(true);

    const evt = eventsNamed("message_first_response")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["conversationId"]).toBe(convo["id"]);
    expect(evt["listingId"]).toBe("listing-chat");
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(SELLER.id));
    const responseMs = (evt["metadata"] as { responseMs: number }).responseMs;
    // anchor = tin buyer đầu (5s trước) → responseMs ≥ 5000
    expect(responseMs).toBeGreaterThanOrEqual(5_000);
    expect(responseMs).toBeLessThan(60_000);
  });

  it("tin THỨ HAI của seller → KHÔNG message_first_response mới", async () => {
    seedConvo();
    seedMessage(BUYER.id, 5_000);
    authState.user = { ...SELLER };
    await postMessage(String(convo["id"]), "reply 1");
    await postMessage(String(convo["id"]), "reply 2");

    expect(eventsNamed("message_first_response")).toHaveLength(1);
  });

  it("tin seller khi CHƯA có tin buyer nào → KHÔNG event nào (không anchor D4)", async () => {
    seedConvo();
    authState.user = { ...SELLER };
    const res = await postMessage(String(convo["id"]), "chào bạn");
    expect(res.ok).toBe(true);

    expect(eventsNamed("message_first_response")).toHaveLength(0);
    expect(eventsNamed("conversation_buyer_first_message")).toHaveLength(0);
  });
});

// ─── rejectListingAction + approveListingAction (S5/S-19) ─────────────────────

describe("rejectListingAction / approveListingAction — listing_rejected + seller_first_listing_published", () => {
  beforeEach(() => {
    login(ADMIN_OPS, { isAdmin: true });
  });

  it("reject thành công → listing_rejected (actor = admin, KHÔNG reason free-text)", async () => {
    const seller = VERIFIED_SELLER;
    seedPolicyRows(String(seller["id"]));
    const listing = seedListing(String(seller["id"]), "pending");

    await rejectListingAction(
      fd({ listingId: String(listing["id"]), reason: "Ảnh không rõ", version: String(listing["updatedAt"]) }),
    );

    expect(listing["status"]).toBe("rejected");
    const evt = eventsNamed("listing_rejected")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["listingId"]).toBe(listing["id"]);
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(ADMIN_OPS.id));
    // lý do từ chối là FREE TEXT — KHÔNG BAO GIỜ vào telemetry (schema comment)
    expect(JSON.stringify(evt)).not.toContain("Ảnh không rõ");
  });

  it("approve ĐẦU TIÊN của seller → seller_first_listing_published (actor = seller, sau gate + update)", async () => {
    const seller = VERIFIED_SELLER;
    seedPolicyRows(String(seller["id"]));
    seedUpload(String(seller["id"]), "00000000-0000-4000-8000-0000000000dd.webp");
    const listing = seedListing(String(seller["id"]), "pending");
    seedImage(String(listing["id"]), "/uploads/00000000-0000-4000-8000-0000000000dd.webp", "front");

    await approveListingAction(
      fd({ listingId: String(listing["id"]), version: String(listing["updatedAt"]) }),
    );

    expect(listing["status"]).toBe("approved");
    const evt = eventsNamed("seller_first_listing_published")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["listingId"]).toBe(listing["id"]);
    // actor = SELLER được kích hoạt (KHÔNG phải admin duyệt)
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(String(seller["id"])));
    expect(evt["actorPseudonym"]).not.toBe(actorPseudonymFor(ADMIN_OPS.id));
  });

  it("approve tin THỨ HAI của cùng seller → S-19 event-existence check → KHÔNG emit lại", async () => {
    const seller = VERIFIED_SELLER;
    seedPolicyRows(String(seller["id"]));
    seedUpload(String(seller["id"]), "00000000-0000-4000-8000-0000000000dd.webp");
    const first = seedListing(String(seller["id"]), "pending");
    seedImage(String(first["id"]), "/uploads/00000000-0000-4000-8000-0000000000dd.webp", "front");
    await approveListingAction(fd({ listingId: String(first["id"]), version: String(first["updatedAt"]) }));
    expect(eventsNamed("seller_first_listing_published")).toHaveLength(1);

    // tin thứ hai — CÙNG seller, đã có event → skip (append-only → check chính xác "lần đầu")
    const second = seedListing(String(seller["id"]), "pending");
    seedImage(String(second["id"]), "/uploads/00000000-0000-4000-8000-0000000000dd.webp", "front");
    await approveListingAction(fd({ listingId: String(second["id"]), version: String(second["updatedAt"]) }));

    expect(second["status"]).toBe("approved"); // approve VẪN thành công
    expect(eventsNamed("seller_first_listing_published")).toHaveLength(1); // event KHÔNG tăng
  });

  it("approve bị checkListingPublication chặn (seller revoked) → KHÔNG approve, KHÔNG emit (S5)", async () => {
    const seller = VERIFIED_SELLER;
    seedPolicyRows(String(seller["id"]), { verificationStatus: "revoked" });
    const listing = seedListing(String(seller["id"]), "pending");

    await approveListingAction(fd({ listingId: String(listing["id"]), version: String(listing["updatedAt"]) }));

    expect(listing["status"]).toBe("pending"); // gate chặn — không approve
    expect(eventsNamed("seller_first_listing_published")).toHaveLength(0);
    // audit block vẫn ghi (Batch 2/4 behavior giữ nguyên)
    expect(dbState.audits.some((a) => a["action"] === "listing.approve_blocked")).toBe(true);
  });
});

// ─── takeDownListingAction — listing_removed (S7, corrections #7) ────────────

describe("takeDownListingAction — listing_removed sau atomic update thành công", () => {
  beforeEach(() => {
    login(ADMIN_OPS, { isAdmin: true });
  });

  it("takedown approved → listing_removed (actor = admin), emit NGOÀI tx", async () => {
    const listing = seedListing(String(VERIFIED_SELLER["id"]), "approved");

    await takeDownListingAction(
      fd({ listingId: String(listing["id"]), reasonCode: "policy_violation_confirmed" }),
    );

    expect(listing["status"]).toBe("removed");
    const evt = eventsNamed("listing_removed")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["listingId"]).toBe(listing["id"]);
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(ADMIN_OPS.id));
    expect(evt["sessionPseudonym"]).toBe(sessionPseudonymFor("sess-admin-ops"));
  });

  it("takedown 0-row (listing đã removed) → LISTING_NOT_TAKEDOWN_ELIGIBLE, KHÔNG emit", async () => {
    const listing = seedListing(String(VERIFIED_SELLER["id"]), "removed");

    await expect(
      takeDownListingAction(fd({ listingId: String(listing["id"]), reasonCode: "policy_violation_confirmed" })),
    ).rejects.toThrow("LISTING_NOT_TAKEDOWN_ELIGIBLE");

    expect(eventsNamed("listing_removed")).toHaveLength(0);
  });
});

// ─── submitReportAction — report_submitted (S7, corrections #6/#7) ───────────

describe("submitReportAction — report_submitted typed metadata, emit ONCE", () => {
  const submit = (entries: Record<string, string>): Promise<ReportFormState> =>
    submitReportAction({}, fd(entries));

  it("report hợp lệ → report_submitted với targetType/reasonCode typed, listingId cột, KHÔNG note text", async () => {
    const listing = seedListing(String(VERIFIED_SELLER["id"]), "approved");

    const res = await submit({
      targetType: "listing",
      targetId: String(listing["id"]),
      reasonCode: "suspected_scam",
      note: "tôi nghi đây là lừa đảo",
    });
    expect(res.success).toBeTruthy();

    expect(eventsNamed("report_submitted")).toHaveLength(1);
    const evt = eventsNamed("report_submitted")[0]!;
    expect(evt["metadata"]).toEqual({ targetType: "listing", reasonCode: "suspected_scam" });
    // đích listing đi cột typed listingId (corrections #6)
    expect(evt["listingId"]).toBe(listing["id"]);
    // note free-text của reporter KHÔNG BAO GIỀ vào telemetry (S7)
    expect(JSON.stringify(evt)).not.toContain("tôi nghi đây là lừa đảo");
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
  });

  it("report trúng user → metadata typed, KHÔNG targetId (PII — corrections #6)", async () => {
    const res = await submit({ targetType: "user", targetId: SELLER.id, reasonCode: "identity_impersonation" });
    expect(res.success).toBeTruthy();

    const evt = eventsNamed("report_submitted")[0]!;
    expect(evt["metadata"]).toEqual({ targetType: "user", reasonCode: "identity_impersonation" });
    expect(evt["listingId"]).toBeNull();
    // raw user id KHÔNG BAO GIỀ trong row (S-10/§4.8)
    expect(JSON.stringify(evt)).not.toContain(SELLER.id);
  });

  it("rate-limited → KHÔNG event thứ 6 (spec §7.1)", async () => {
    const listing = seedListing(String(VERIFIED_SELLER["id"]), "approved");
    const reasons = ["suspected_scam", "harassment", "spam", "counterfeit_claim", "misleading_listing"];
    for (const reasonCode of reasons) {
      const res = await submit({ targetType: "listing", targetId: String(listing["id"]), reasonCode });
      expect(res.success).toBeTruthy();
    }
    expect(eventsNamed("report_submitted")).toHaveLength(5);

    const denied = await submit({ targetType: "listing", targetId: String(listing["id"]), reasonCode: "prohibited_content" });
    expect(denied).toEqual({ error: "RATE_LIMITED" });
    expect(eventsNamed("report_submitted")).toHaveLength(5);
  });

  it("deduped (REPORT_ALREADY_SUBMITTED) → KHÔNG event mới", async () => {
    const listing = seedListing(String(VERIFIED_SELLER["id"]), "approved");
    await submit({ targetType: "listing", targetId: String(listing["id"]), reasonCode: "suspected_scam" });
    expect(eventsNamed("report_submitted")).toHaveLength(1);

    const again = await submit({ targetType: "listing", targetId: String(listing["id"]), reasonCode: "suspected_scam" });
    expect(again).toEqual({ error: "REPORT_ALREADY_SUBMITTED" });
    expect(eventsNamed("report_submitted")).toHaveLength(1);
  });

  it("success path RETRY (case bị đóng concurrent — L1) → emit ĐÚNG MỘT lần (corrections #7)", async () => {
    const listing = seedListing(String(VERIFIED_SELLER["id"]), "approved");
    // case active có sẵn; moderator đóng nó ĐÚNG lúc tx mình attach report
    dbState.cases.push({
      id: "case-closing",
      targetType: "listing",
      targetId: String(listing["id"]),
      reasonCategory: "suspected_scam",
      state: "open",
      priority: "normal",
      assignedModeratorId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    dbState.closeCaseOnReport = "case-closing";

    const res = await submit({ targetType: "listing", targetId: String(listing["id"]), reasonCode: "suspected_scam" });
    expect(res.success).toBeTruthy();

    // HAI success path (chính + retry) — compute result once, emit ONCE
    expect(eventsNamed("report_submitted")).toHaveLength(1);
  });
});

// ─── reviewSellerVerificationAction — seller_verified (S7) ───────────────────

describe("reviewSellerVerificationAction — seller_verified chỉ decision=verified", () => {
  const seedVerification = (status: string): Row => {
    const row: Row = {
      id: `sv-${dbState.verifications.length + 1}`,
      userId: VERIFIED_SELLER["id"],
      status,
      method: "operations_review",
      submittedAt: new Date().toISOString(),
      reviewedAt: null,
      reviewerId: null,
      reasonCode: null,
      note: null,
      policyVersion: "v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    dbState.verifications.push(row);
    return row;
  };

  it("decision=verified → seller_verified (actor = seller được xác minh, KHÔNG phải admin)", async () => {
    seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: String(VERIFIED_SELLER["id"]), decision: "verified", reasonCode: "requirements_met" }),
    );

    const evt = eventsNamed("seller_verified")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(String(VERIFIED_SELLER["id"])));
    expect(evt["actorPseudonym"]).not.toBe(actorPseudonymFor(ADMIN_OPS.id));
  });

  it("decision=needs_review → KHÔNG emit", async () => {
    seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: String(VERIFIED_SELLER["id"]), decision: "needs_review", reasonCode: "business_claim_needs_evidence" }),
    );

    expect(eventsNamed("seller_verified")).toHaveLength(0);
  });

  it("decision=revoked → KHÔNG emit", async () => {
    seedVerification("verified");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: String(VERIFIED_SELLER["id"]), decision: "revoked", reasonCode: "abuse_case_unresolved" }),
    );

    expect(dbState.verifications[0]!["status"]).toBe("revoked");
    expect(eventsNamed("seller_verified")).toHaveLength(0);
  });
});

// ─── setBetaMembershipAction — beta_membership_activated (S7, corrections #15) ─

describe("setBetaMembershipAction — beta_membership_activated chỉ khi chuyển sang active", () => {
  const MEMBER_ID = "member-beta-1";

  beforeEach(() => {
    login(ADMIN_OPS, { isAdmin: true });
  });

  it("tạo MỚI membership active → emit (actor = member)", async () => {
    await setBetaMembershipAction(fd({ userId: MEMBER_ID, cohort: "founding_seller", status: "active" }));

    expect(dbState.memberships).toHaveLength(1);
    const evt = eventsNamed("beta_membership_activated")[0]!;
    expect(evt).toBeTruthy();
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(MEMBER_ID));
  });

  it("existing ĐÃ active → set active lại → KHÔNG emit (không transition)", async () => {
    dbState.memberships.push({
      id: "bcm-existing",
      userId: MEMBER_ID,
      cohort: "founding_seller",
      status: "active",
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await setBetaMembershipAction(fd({ userId: MEMBER_ID, cohort: "founding_seller", status: "active" }));

    expect(eventsNamed("beta_membership_activated")).toHaveLength(0);
  });

  it("existing invited → active → emit (transition thật)", async () => {
    dbState.memberships.push({
      id: "bcm-invited",
      userId: MEMBER_ID,
      cohort: "founding_seller",
      status: "invited",
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await setBetaMembershipAction(fd({ userId: MEMBER_ID, cohort: "founding_seller", status: "active" }));

    expect(eventsNamed("beta_membership_activated")).toHaveLength(1);
  });

  it("status=suspended → KHÔNG emit", async () => {
    await setBetaMembershipAction(fd({ userId: MEMBER_ID, cohort: "founding_seller", status: "suspended" }));

    expect(dbState.memberships[0]!["status"]).toBe("suspended");
    expect(eventsNamed("beta_membership_activated")).toHaveLength(0);
  });
});

// ─── Recorder fail-open — telemetry KHÔNG phá product flow ────────────────────

describe("recorders fail-open (correction #9 — telemetry không phải ranh giới sản phẩm)", () => {
  it("db read của recorder throw → resolve KHÔNG throw, log chỉ event name + sqlState (correction #17)", async () => {
    const { SqlQueryError } = await import("@prisma/orm-family-sql/errors");
    const err = new SqlQueryError("read failed", { sqlState: "53300" });
    // Seam: ProductEvent.first (S-14 validate read) throw — recorder PHẢI bắt
    // (fail-open) thay vì ném ra caller; restore trong finally để không leak.
    const model = db.orm.public.ProductEvent;
    const originalFirst = model.first;
    model.first = (async () => {
      throw err;
    }) as typeof originalFirst;
    try {
      await expect(
        recordSearchResultClick({
          ss: "ss-1",
          listing: { id: "listing-1", provinceLevelCode: null },
          viewer: { id: BUYER.id, sessionId: BUYER.sessionId },
        }),
      ).resolves.toBe(false);
      expect(captureErrorMock).toHaveBeenCalledWith(
        "telemetry",
        "TELEMETRY_RECORDER_FAILED",
        expect.objectContaining({ name: "search_result_clicked", sqlState: "53300" }),
      );
      // log KHÔNG mang message lỗi db gốc (có thể chứa payload) — correction #17
      expect(JSON.stringify(captureErrorMock.mock.calls[0])).not.toContain("read failed");
    } finally {
      model.first = originalFirst;
    }
  });
});

// ─── Source contracts (S-13/S-22 + Review Focus 2) ───────────────────────────

describe("source contracts", () => {
  const hasUseServerDirective = (src: string): boolean =>
    src.split("\n").some((line) => /^\s*["']use server["']\s*;?\s*$/.test(line));

  const hasServerOnlyImport = (src: string): boolean =>
    src.split("\n").some((line) => /^\s*import\s+["']server-only["']\s*;?\s*$/.test(line));

  it("telemetry-recorders.ts: import 'server-only', KHÔNG 'use server' (S-13/S-22)", () => {
    const src = read("src/lib/telemetry-recorders.ts");
    expect(hasServerOnlyImport(src)).toBe(true);
    expect(hasUseServerDirective(src)).toBe(false);
  });

  it("finance modules KHÔNG chạm ProductEvent/emitProductEvent (Review Focus 2 — S7)", () => {
    for (const p of [
      "src/lib/actions/orders.ts",
      "src/lib/escrow.ts",
      "src/lib/wallet.ts",
      "src/lib/ledger.ts",
      "src/lib/momo.ts",
      "src/lib/mock-payment.ts",
    ]) {
      const src = read(p);
      expect(src).not.toMatch(/ProductEvent|emitProductEvent/);
    }
  });

  it("listing detail page gọi recorders + đọc searchParams (ss) + prefetch header (S-8/S-14)", () => {
    const src = read("app/listings/[slug]/page.tsx");
    expect(src).toContain("recordListingView");
    expect(src).toContain("recordSearchResultClick");
    expect(src).toContain("searchParams");
    expect(src).toContain("next-router-prefetch");
  });

  it("chat.ts emit TRƯỚC redirect, KHÔNG trong catch nuốt NEXT_REDIRECT (corrections #15)", () => {
    const src = read("src/lib/actions/chat.ts");
    const fnSrc = src.slice(src.indexOf("export async function startConversationAction"));
    // gọi THẬT (template literal) — không phải nhắc "redirect()" trong comment
    const redirectCallIdx = fnSrc.indexOf("redirect(`/chat/${convo.id}`)");
    const emitIdx = fnSrc.indexOf("recordConversationStarted");
    expect(emitIdx).toBeGreaterThan(-1);
    expect(redirectCallIdx).toBeGreaterThan(emitIdx); // emit TRƯỚC redirect
  });
});
