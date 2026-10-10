/**
 * Founding seller lifecycle actions (Batch 7 plan Task 4 — spec §5.10/§5.10.1,
 * §4.5/§4.9, §4.6, §4.8, §4.11; corrections 2026-10-08 items 21/22/23/29 + FD-3
 * PROVISIONAL vocabulary).
 *
 * Hợp đồng (plan Task 4 Step 1 — mỗi case map một dòng plan):
 *  1. syncCandidateFunnelAction (S5 — ĐƯỜNG DUY NHẤT operator chạy sync;
 *     corrections #22): linked candidate → sync chạy + audit
 *     founding_seller.funnel_synced (detail from→to); unlinked → no-op
 *     KHÔNG audit churn; sync unchanged (ground truth không cho tiến) →
 *     KHÔNG audit; thiếu → NOT_FOUND; moderator → FORBIDDEN.
 *  2. updateCandidateStatusAction: ops + legal pair (verified →
 *     concierge_onboarding, reason concierge_started) → status updated +
 *     audit reason TYPED + detail from→to; first_listing →
 *     active_founding_seller (quality_sample_passed) → allowed (§12.1 manual
 *     sampling là quyết định operator); illegal pairs (to ∈
 *     MANUALLY_SETTABLE, ngoài bảng) → INVALID_TRANSITION table-driven; automatic
 *     states (prospect/invited/registered/verification_pending/verified/
 *     first_listing) → STATUS_NOT_MANUALLY_SETTABLE (fail closed chống fake
 *     funnel); moderator/support/analyst → FORBIDDEN không mutation; session
 *     adminRole chưa qua MFA → FORBIDDEN; reasonCode ngoài vocabulary → typed
 *     error zero writes; note quá cap → typed error; note → CHỈ vào
 *     AuditEvent.detail qua redactDetail (corrections #23 — KHÔNG append vào
 *     candidate.notes); concurrent second move → CANDIDATE_ALREADY_MOVED
 *     (CAS where({ id, status }) — §10.1); KHÔNG step-up (plain
 *     requireCapability — Global Constraints).
 *  3. assignCandidateOperatorAction (corrections #23): operator hợp lệ
 *     (operations_admin/super_admin — capabilitiesOf(adminRole) chứa
 *     beta_cohort.manage) → assigned + audit; analyst làm operator →
 *     ASSIGNEE_NOT_ELIGIBLE; operatorId rỗng → unassign (null) + audit;
 *     thiếu → NOT_FOUND (0-row updateAll); moderator → FORBIDDEN.
 *  4. recordCandidateContactAction: lastContactAt set + audit
 *     founding_seller.contact_recorded; note redacted (email trong note →
 *     [REDACTED_EMAIL] trong AuditEvent.detail — KHÔNG raw); thiếu →
 *     NOT_FOUND; moderator → FORBIDDEN.
 *  5. updateCandidateNotesAction (useActionState state): notes stored
 *     redacted; quá cap → form error; thiếu → form error NOT_FOUND;
 *     moderator → FORBIDDEN.
 *  6. updateQualityListingCountAction: count set + audit
 *     founding_seller.quality_count_set; negative/non-int → typed error;
 *     thiếu → NOT_FOUND; moderator → FORBIDDEN; hệ thống KHÔNG BAO GIỜ
 *     auto-compute (A3 — source-contract: writer duy nhất là action này +
 *     default 0 lúc create).
 *  7. Source contracts: constants.ts append FOUNDING_SELLER_STATUS_BADGE
 *     (đủ 10 trạng thái §5.10 — LISTING_STATUS_BADGE giữ nguyên); action
 *     file KHÔNG requireCapabilityWithStepUp (không phát minh step-up —
 *     §4.11/§5.4.2); KHÔNG export const (Next 16 E352).
 *
 * Cơ chế mock (corrections #21 — real RBAC): rbac/session/auth GIỮ BẢN THẬT
 * (login qua UserSession row + cookie thật trên next/headers mock — MFA proof
 * isAdmin); db.client in-memory (User/UserSession(include user)/
 * FoundingSellerCandidate/AuditEvent/SellerVerification/Listing) + hook
 * beforeCandidateUpdateAll (mô phỏng operator move song song giữa read và CAS
 * — 0-row compare-and-set); audit-event GIỮ BẢN THẬT bọc spy (assert ROW tồn
 * tại — không chỉ spy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// ─── next/headers mock — cookie store cho session THẬT ────────────────────────

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
    delete: (arg: string | { name: string }) => {
      cookieState.store.delete(typeof arg === "string" ? arg : arg.name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

// ─── observability spy — silence console ─────────────────────────────────────

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── db.client mock — in-memory 6 model ───────────────────────────────────────

type Row = Record<string, unknown>;
type Pred = ((proxy: unknown) => unknown) | Row;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  sessions: [] as Row[],
  candidates: [] as Row[],
  audits: [] as Row[],
  verifications: [] as Row[],
  listings: [] as Row[],
  /**
   * Hook chạy ĐẦU FoundingSellerCandidate.updateAll — mô phỏng operator move
   * song song giữa lúc action đọc status và lúc CAS ghi (0-row claim).
   */
  beforeCandidateUpdateAll: null as (() => void) | null,
}));

vi.mock("@/src/prisma/db.client", () => {
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
    typeof pred === "function" ? Boolean(pred(fieldOps(row))) : Object.entries(pred).every(([k, v]) => row[k] === v);

  const NOW = "2026-10-08T00:00:00.000Z";

  const makeModel = (
    label: string,
    rows: Row[],
    defaults?: () => Row,
    attachUser?: (copy: Row) => void,
  ) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      orderBy: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        if (includeRel === "user" && attachUser) attachUser(copy);
        return copy;
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      updateAll: async (data: Row) => {
        if (label === "FoundingSellerCandidate") dbState.beforeCandidateUpdateAll?.();
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      aggregate: async (fn: (a: { count: () => number }) => Row) =>
        fn({ count: () => rows.filter((r) => preds.every((p) => matches(r, p))).length }),
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
      aggregate: (fn: (a: { count: () => number }) => Row) => query([]).aggregate(fn),
    };
  };

  const models = {
    User: makeModel(
      "User",
      dbState.users,
      () => ({
        id: `user-${dbState.users.length + 1}`,
        email: null,
        phone: null,
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        adminRole: null,
        role: "buyer",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
    UserSession: makeModel(
      "UserSession",
      dbState.sessions,
      () => ({
        id: `sess-${dbState.sessions.length + 1}`,
        createdAt: NOW,
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        revokedAt: null,
        revokedReason: null,
        steppedUpAt: null,
        isAdmin: false,
        userAgent: null,
      }),
      (copy) => {
        copy.user = dbState.users.find((u) => u.id === copy.userId) ?? null;
      },
    ),
    FoundingSellerCandidate: makeModel(
      "FoundingSellerCandidate",
      dbState.candidates,
      () => ({
        id: `cand-${dbState.candidates.length + 1}`,
        userId: null,
        contactReference: null,
        contactChannel: null,
        source: "giới thiệu bởi cộng đồng loa",
        targetCommunity: "ha-noi",
        status: "prospect",
        assignedOperatorId: null,
        invitedAt: null,
        registeredAt: null,
        verifiedAt: null,
        firstListingAt: null,
        qualityListingCount: 0,
        lastContactAt: null,
        notes: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
    AuditEvent: makeModel("AuditEvent", dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      actorId: null,
      subjectId: null,
      reason: null,
      policyVersion: null,
      sessionId: null,
      detail: null,
      ipHash: null,
      createdAt: NOW,
    })),
    SellerVerification: makeModel("SellerVerification", dbState.verifications, () => ({
      id: `sv-${dbState.verifications.length + 1}`,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    Listing: makeModel("Listing", dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      status: "approved",
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };

  return {
    db: {
      orm: { public: models },
      // Task 4 actions KHÔNG dùng tx (conditional updateAll đơn row; sync chạy
      // global db sau tx — corrections #22) — passthrough cho an toàn type.
      transaction: async (fn: (tx: { orm: { public: typeof models } }) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── audit-event — BẢN THẬT bọc spy (assert ROW, không chỉ spy) ────────────────

vi.mock("@/src/lib/audit-event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/audit-event")>();
  return {
    ...actual,
    auditEvent: vi.fn(actual.auditEvent),
    auditEventTx: vi.fn(actual.auditEventTx),
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import { createHash } from "node:crypto";
import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import { auditEvent } from "@/src/lib/audit-event";
import { revalidatePath } from "next/cache";
import {
  FOUNDING_SELLER_CANDIDATE_STATUSES,
  MANUALLY_SETTABLE_STATUSES,
  canTransitionCandidate,
} from "@/src/lib/founding-seller-vocab";
import {
  assignCandidateOperatorAction,
  recordCandidateContactAction,
  syncCandidateFunnelAction,
  updateCandidateNotesAction,
  updateCandidateStatusAction,
  updateQualityListingCountAction,
} from "@/src/lib/actions/founding-sellers";

const auditSpy = vi.mocked(auditEvent);
const revalidateMock = vi.mocked(revalidatePath);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

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

const ADMIN_OPS = mkUser({ id: "admin-ops", email: "ops@loaviet.test", name: "Ops", role: "admin", adminRole: "operations_admin" });
const ADMIN_SUPER = mkUser({ id: "admin-super", email: "super@loaviet.test", name: "Super", role: "admin", adminRole: "super_admin" });
const ADMIN_MOD = mkUser({ id: "admin-mod", email: "mod@loaviet.test", name: "Mod", role: "admin", adminRole: "moderator" });
const ADMIN_SUPPORT = mkUser({ id: "admin-support", email: "support@loaviet.test", name: "Support", role: "admin", adminRole: "support" });
const ADMIN_ANALYST = mkUser({ id: "admin-analyst", email: "analyst@loaviet.test", name: "Analyst", role: "admin", adminRole: "analyst" });

const login = (user: Row, opts?: { isAdmin?: boolean }): string => {
  const id = `sess-${user.id}`;
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

/** Candidate fixture — row reference TRỰC TIẾP (updateAll mutate tại chỗ). */
const seedCandidate = (over: Partial<Row> = {}): Row & { id: string } => {
  const row: Row = {
    id: `cand-${dbState.candidates.length + 1}`,
    userId: "user-seller",
    contactReference: "seller.moi@loaviet.test",
    contactChannel: "email",
    source: "giới thiệu bởi cộng đồng loa",
    targetCommunity: "ha-noi",
    status: "verified",
    assignedOperatorId: null,
    invitedAt: null,
    registeredAt: "2026-10-02T00:00:00.000Z",
    verifiedAt: "2026-10-04T00:00:00.000Z",
    firstListingAt: null,
    qualityListingCount: 0,
    lastContactAt: null,
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
  dbState.candidates.push(row);
  return row as Row & { id: string };
};

/** SellerVerification fixture cho ground-truth sync. */
const seedVerification = (userId: string, status: string): Row => {
  const row: Row = {
    id: `sv-${dbState.verifications.length + 1}`,
    userId,
    status,
    method: "operations_review",
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  dbState.verifications.push(row);
  return row;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.candidates.length = 0;
  dbState.audits.length = 0;
  dbState.verifications.length = 0;
  dbState.listings.length = 0;
  dbState.beforeCandidateUpdateAll = null;
  dbState.users.push(
    { ...ADMIN_OPS },
    { ...ADMIN_SUPER },
    { ...ADMIN_MOD },
    { ...ADMIN_SUPPORT },
    { ...ADMIN_ANALYST },
  );
  cookieState.store.clear();
  auditSpy.mockClear();
  revalidateMock.mockClear();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. syncCandidateFunnelAction (S5 — đường DUY NHẤT operator chạy sync) ──

describe("syncCandidateFunnelAction — requireCapability(beta_cohort.manage)", () => {
  it("linked candidate + ground truth tiến → sync chạy + audit founding_seller.funnel_synced (detail from→to)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "registered", verifiedAt: null });
    seedVerification(candidate.userId as string, "pending");
    await syncCandidateFunnelAction(fd({ candidateId: candidate.id }));
    expect(candidate.status).toBe("verification_pending"); // registered → verification_pending
    expect(dbState.audits).toHaveLength(1);
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.funnel_synced");
    expect(audit.actorId).toBe(ADMIN_OPS.id);
    expect(audit.resourceType).toBe("FoundingSellerCandidate");
    expect(audit.resourceId).toBe(candidate.id);
    expect(audit.sessionId).toBe("sess-admin-ops");
    expect(audit.detail).toBe("registered→verification_pending"); // codes only — KHÔNG PII
    expect(revalidateMock).toHaveBeenCalledWith("/admin/beta-cohort");
  });

  it("sync unchanged (ground truth không cho tiến) → KHÔNG audit (corrections #22)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "verification_pending" });
    seedVerification(candidate.userId as string, "pending"); // target = hiện tại
    await syncCandidateFunnelAction(fd({ candidateId: candidate.id }));
    expect(candidate.status).toBe("verification_pending");
    expect(dbState.audits).toHaveLength(0); // unchanged sync — KHÔNG audit churn
  });

  it("unlinked candidate (userId null — prospect chưa có tài khoản) → no-op, KHÔNG audit", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ userId: null, status: "prospect", registeredAt: null });
    await syncCandidateFunnelAction(fd({ candidateId: candidate.id }));
    expect(candidate.status).toBe("prospect"); // không đụng gì
    expect(dbState.audits).toHaveLength(0);
  });

  it("candidate thiếu → NOT_FOUND", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    await expect(syncCandidateFunnelAction(fd({ candidateId: "khong-ton-tai" }))).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(dbState.audits).toHaveLength(0);
  });

  it.each([
    ["moderator", ADMIN_MOD],
    ["support", ADMIN_SUPPORT],
    ["analyst", ADMIN_ANALYST],
  ])("%s → FORBIDDEN, không sync, không audit (Review Focus 4)", async (_label, admin) => {
    login(admin as Row, { isAdmin: true });
    const candidate = seedCandidate({ status: "registered" });
    seedVerification(candidate.userId as string, "pending");
    await expect(syncCandidateFunnelAction(fd({ candidateId: candidate.id }))).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(candidate.status).toBe("registered"); // KHÔNG sync
    expect(dbState.audits).toHaveLength(0);
  });

  it("session adminRole nhưng chưa qua MFA (isAdmin=false) → FORBIDDEN (corrections #21)", async () => {
    login(ADMIN_OPS); // consumer session
    const candidate = seedCandidate({ status: "registered" });
    await expect(syncCandidateFunnelAction(fd({ candidateId: candidate.id }))).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(candidate.status).toBe("registered");
  });
});

// ─── 2. updateCandidateStatusAction ──────────────────────────────────────────

describe("updateCandidateStatusAction — manual transitions (PROVISIONAL FD-3)", () => {
  it("operations_admin + legal pair verified → concierge_onboarding (concierge_started) → status updated + audit reason TYPED (spec §5.10 chain)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "verified" });
    await updateCandidateStatusAction(
      fd({ candidateId: candidate.id, toStatus: "concierge_onboarding", reasonCode: "concierge_started" }),
    );
    expect(candidate.status).toBe("concierge_onboarding");
    expect(dbState.audits).toHaveLength(1);
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.status_changed");
    expect(audit.reason).toBe("concierge_started"); // reason code TYPED — không free text
    expect(audit.actorId).toBe(ADMIN_OPS.id);
    expect(audit.resourceType).toBe("FoundingSellerCandidate");
    expect(audit.resourceId).toBe(candidate.id);
    expect(audit.sessionId).toBe("sess-admin-ops");
    expect(audit.detail).toBe("verified→concierge_onboarding");
    expect(revalidateMock).toHaveBeenCalledWith("/admin/beta-cohort");
  });

  it("first_listing → active_founding_seller (quality_sample_passed) → allowed — §12.1 manual sampling là quyết định operator", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "first_listing", firstListingAt: "2026-10-05T00:00:00.000Z" });
    await updateCandidateStatusAction(
      fd({ candidateId: candidate.id, toStatus: "active_founding_seller", reasonCode: "quality_sample_passed" }),
    );
    expect(candidate.status).toBe("active_founding_seller");
    // A3: KHÔNG tự set qualityListingCount khi vào active_founding_seller
    expect(candidate.qualityListingCount).toBe(0);
    expect(dbState.audits).toHaveLength(1);
    expect((dbState.audits[0] as Row).reason).toBe("quality_sample_passed");
  });

  /** Mọi cặp (from, to) với to ∈ MANUALLY_SETTABLE nhưng NGOÀI bảng transition. */
  const ILLEGAL_MANUAL_PAIRS = FOUNDING_SELLER_CANDIDATE_STATUSES.flatMap((from) =>
    MANUALLY_SETTABLE_STATUSES.filter((to) => !canTransitionCandidate(from, to)).map(
      (to) => [from, to] as const,
    ),
  );

  it("bảng illegal pairs không rỗng (sanity — pin có ý)", () => {
    expect(ILLEGAL_MANUAL_PAIRS.length).toBeGreaterThan(0);
    // A5 — reactivation từ inactive là founder policy, KHÔNG phát minh
    expect(ILLEGAL_MANUAL_PAIRS).toContainEqual(["inactive", "active_founding_seller"]);
    // exited terminal
    expect(ILLEGAL_MANUAL_PAIRS).toContainEqual(["exited", "exited"]);
  });

  it.each(ILLEGAL_MANUAL_PAIRS)(
    "illegal pair %s → %s → INVALID_TRANSITION, không mutation, không audit",
    async (from, to) => {
      login(ADMIN_OPS, { isAdmin: true });
      const candidate = seedCandidate({ status: from });
      await expect(
        updateCandidateStatusAction(
          fd({ candidateId: candidate.id, toStatus: to, reasonCode: "operator_correction" }),
        ),
      ).rejects.toThrow("INVALID_TRANSITION");
      expect(candidate.status).toBe(from); // KHÔNG mutation
      expect(dbState.audits).toHaveLength(0);
    },
  );

  it.each([
    "prospect",
    "invited",
    "registered",
    "verification_pending",
    "verified",
    "first_listing",
  ])(
    "toStatus %s KHÔNG manually settable → STATUS_NOT_MANUALLY_SETTABLE (fail closed chống fake funnel)",
    async (to) => {
      login(ADMIN_OPS, { isAdmin: true });
      const candidate = seedCandidate({ status: "verified" });
      await expect(
        updateCandidateStatusAction(
          fd({ candidateId: candidate.id, toStatus: to, reasonCode: "operator_correction" }),
        ),
      ).rejects.toThrow("STATUS_NOT_MANUALLY_SETTABLE");
      expect(candidate.status).toBe("verified");
      expect(dbState.audits).toHaveLength(0);
    },
  );

  it.each([
    ["moderator", ADMIN_MOD],
    ["support", ADMIN_SUPPORT],
    ["analyst", ADMIN_ANALYST],
  ])("%s → FORBIDDEN, không mutation, không audit (Review Focus 4)", async (_label, admin) => {
    login(admin as Row, { isAdmin: true });
    const candidate = seedCandidate({ status: "verified" });
    await expect(
      updateCandidateStatusAction(
        fd({ candidateId: candidate.id, toStatus: "concierge_onboarding", reasonCode: "concierge_started" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(candidate.status).toBe("verified");
    expect(dbState.audits).toHaveLength(0);
  });

  it("session adminRole nhưng chưa qua MFA (isAdmin=false) → FORBIDDEN (corrections #21)", async () => {
    login(ADMIN_OPS); // consumer session
    const candidate = seedCandidate({ status: "verified" });
    await expect(
      updateCandidateStatusAction(
        fd({ candidateId: candidate.id, toStatus: "concierge_onboarding", reasonCode: "concierge_started" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(candidate.status).toBe("verified");
  });

  it("reasonCode ngoài vocabulary → typed error, zero writes", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "verified" });
    await expect(
      updateCandidateStatusAction(
        fd({ candidateId: candidate.id, toStatus: "concierge_onboarding", reasonCode: "vi-sao-lai-the" }),
      ),
    ).rejects.toThrow("INVALID_REASON_CODE");
    expect(candidate.status).toBe("verified");
    expect(dbState.audits).toHaveLength(0);
  });

  it("note quá cap (4000) → typed error, zero writes", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "verified" });
    await expect(
      updateCandidateStatusAction(
        fd({
          candidateId: candidate.id,
          toStatus: "concierge_onboarding",
          reasonCode: "concierge_started",
          note: "a".repeat(4001),
        }),
      ),
    ).rejects.toThrow("NOTE_TOO_LONG");
    expect(candidate.status).toBe("verified");
    expect(dbState.audits).toHaveLength(0);
  });

  it("note → CHỈ vào AuditEvent.detail qua redactDetail — KHÔNG append vào candidate.notes (corrections #23)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "verified", notes: null });
    await updateCandidateStatusAction(
      fd({
        candidateId: candidate.id,
        toStatus: "concierge_onboarding",
        reasonCode: "concierge_started",
        note: "đã email seller.moi@loaviet.test về checklist",
      }),
    );
    expect(candidate.status).toBe("concierge_onboarding");
    expect(candidate.notes).toBeNull(); // notes CHỈ được viết bởi updateCandidateNotesAction
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.status_changed");
    expect(String(audit.detail)).toContain("[REDACTED_EMAIL]"); // note redacted trong detail
    expect(String(audit.detail)).not.toContain("seller.moi@loaviet.test");
  });

  it("concurrent second move → CANDIDATE_ALREADY_MOVED (atomic claim — §10.1)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ status: "verified" });
    dbState.beforeCandidateUpdateAll = () => {
      candidate.status = "inactive"; // operator khác move giữa read và CAS
    };
    await expect(
      updateCandidateStatusAction(
        fd({ candidateId: candidate.id, toStatus: "concierge_onboarding", reasonCode: "concierge_started" }),
      ),
    ).rejects.toThrow("CANDIDATE_ALREADY_MOVED");
    expect(candidate.status).toBe("inactive"); // move của request khác đứng
    expect(dbState.audits).toHaveLength(0);
  });

  it("candidate thiếu → NOT_FOUND", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    await expect(
      updateCandidateStatusAction(
        fd({ candidateId: "khong-ton-tai", toStatus: "concierge_onboarding", reasonCode: "concierge_started" }),
      ),
    ).rejects.toThrow("NOT_FOUND");
    expect(dbState.audits).toHaveLength(0);
  });

  it("super_admin cũng được (ma trận Batch 2) — KHÔNG step-up: session chưa steppedUp vẫn thành công", async () => {
    login(ADMIN_SUPER, { isAdmin: true }); // steppedUpAt null — plain requireCapability
    const candidate = seedCandidate({ status: "verified" });
    await updateCandidateStatusAction(
      fd({ candidateId: candidate.id, toStatus: "concierge_onboarding", reasonCode: "concierge_started" }),
    );
    expect(candidate.status).toBe("concierge_onboarding");
    expect(dbState.audits).toHaveLength(1);
  });
});

// ─── 3. assignCandidateOperatorAction ─────────────────────────────────────────

describe("assignCandidateOperatorAction", () => {
  it("operator hợp lệ (operations_admin) → assigned + audit founding_seller.operator_assigned", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ assignedOperatorId: null });
    await assignCandidateOperatorAction(fd({ candidateId: candidate.id, operatorId: ADMIN_SUPER.id }));
    expect(candidate.assignedOperatorId).toBe(ADMIN_SUPER.id);
    expect(dbState.audits).toHaveLength(1);
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.operator_assigned");
    expect(audit.actorId).toBe(ADMIN_OPS.id);
    expect(audit.resourceType).toBe("FoundingSellerCandidate");
    expect(audit.resourceId).toBe(candidate.id);
    expect(String(audit.detail)).toContain(ADMIN_SUPER.id); // ids only
  });

  it("analyst làm operator → ASSIGNEE_NOT_ELIGIBLE (Batch 3 assign precedent), không mutation", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ assignedOperatorId: null });
    await expect(
      assignCandidateOperatorAction(fd({ candidateId: candidate.id, operatorId: ADMIN_ANALYST.id })),
    ).rejects.toThrow("ASSIGNEE_NOT_ELIGIBLE");
    expect(candidate.assignedOperatorId).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("operator user thiếu → ASSIGNEE_NOT_ELIGIBLE (fail closed)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ assignedOperatorId: null });
    await expect(
      assignCandidateOperatorAction(fd({ candidateId: candidate.id, operatorId: "user-khong-co" })),
    ).rejects.toThrow("ASSIGNEE_NOT_ELIGIBLE");
    expect(candidate.assignedOperatorId).toBeNull();
  });

  it("operatorId rỗng → unassign (null) + audit (corrections #23)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ assignedOperatorId: ADMIN_SUPER.id });
    await assignCandidateOperatorAction(fd({ candidateId: candidate.id, operatorId: "" }));
    expect(candidate.assignedOperatorId).toBeNull();
    expect(dbState.audits).toHaveLength(1);
    expect((dbState.audits[0] as Row).action).toBe("founding_seller.operator_assigned");
  });

  it("candidate thiếu → NOT_FOUND (0-row updateAll)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    await expect(
      assignCandidateOperatorAction(fd({ candidateId: "khong-ton-tai", operatorId: ADMIN_SUPER.id })),
    ).rejects.toThrow("NOT_FOUND");
    expect(dbState.audits).toHaveLength(0);
  });

  it("moderator → FORBIDDEN, không mutation", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const candidate = seedCandidate({ assignedOperatorId: null });
    await expect(
      assignCandidateOperatorAction(fd({ candidateId: candidate.id, operatorId: ADMIN_SUPER.id })),
    ).rejects.toThrow("FORBIDDEN");
    expect(candidate.assignedOperatorId).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 4. recordCandidateContactAction ─────────────────────────────────────────

describe("recordCandidateContactAction", () => {
  it("lastContactAt set + audit founding_seller.contact_recorded", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ lastContactAt: null });
    await recordCandidateContactAction(fd({ candidateId: candidate.id }));
    expect(candidate.lastContactAt).not.toBeNull();
    expect(Date.parse(candidate.lastContactAt as string)).toBeGreaterThan(Date.now() - 60_000);
    expect(dbState.audits).toHaveLength(1);
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.contact_recorded");
    expect(audit.actorId).toBe(ADMIN_OPS.id);
    expect(audit.resourceType).toBe("FoundingSellerCandidate");
    expect(audit.resourceId).toBe(candidate.id);
  });

  it("note redacted — email trong note lưu MASKED trong AuditEvent.detail (§4.8)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ lastContactAt: null });
    await recordCandidateContactAction(
      fd({ candidateId: candidate.id, note: "đã gọi cho seller.moi@loaviet.test" }),
    );
    expect(candidate.lastContactAt).not.toBeNull();
    const audit = dbState.audits[0] as Row;
    expect(String(audit.detail)).toContain("[REDACTED_EMAIL]");
    expect(String(audit.detail)).not.toContain("seller.moi@loaviet.test");
    // KHÔNG error/object nào khác chứa raw contact
    expect(JSON.stringify(dbState.audits)).not.toContain("seller.moi@loaviet.test");
  });

  it("candidate thiếu → NOT_FOUND", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    await expect(recordCandidateContactAction(fd({ candidateId: "khong-ton-tai" }))).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(dbState.audits).toHaveLength(0);
  });

  it("moderator → FORBIDDEN, không mutation", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const candidate = seedCandidate({ lastContactAt: null });
    await expect(recordCandidateContactAction(fd({ candidateId: candidate.id }))).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(candidate.lastContactAt).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 5. updateCandidateNotesAction (useActionState state) ─────────────────────

describe("updateCandidateNotesAction", () => {
  it("notes stored redacted (email → [REDACTED_EMAIL]) + audit founding_seller.notes_updated (detail ids only)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ notes: null });
    const state = await updateCandidateNotesAction(
      {},
      fd({ candidateId: candidate.id, notes: "liên hệ qua seller.moi@loaviet.test lần đầu" }),
    );
    expect(state.error).toBeUndefined();
    expect(candidate.notes).toBe("liên hệ qua [REDACTED_EMAIL] lần đầu");
    expect(dbState.audits).toHaveLength(1);
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.notes_updated");
    expect(audit.resourceId).toBe(candidate.id);
    expect(String(audit.detail)).not.toContain("seller.moi@loaviet.test"); // detail ids only
  });

  it("notes rỗng → clear (null)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ notes: "ghi chú cũ" });
    const state = await updateCandidateNotesAction({}, fd({ candidateId: candidate.id, notes: "" }));
    expect(state.error).toBeUndefined();
    expect(candidate.notes).toBeNull();
  });

  it("quá cap (4000) → form error NOTE_TOO_LONG, không write", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ notes: null });
    const state = await updateCandidateNotesAction(
      {},
      fd({ candidateId: candidate.id, notes: "a".repeat(4001) }),
    );
    expect(state.error).toBe("NOTE_TOO_LONG");
    expect(candidate.notes).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });

  it("candidate thiếu → form error NOT_FOUND", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const state = await updateCandidateNotesAction({}, fd({ candidateId: "khong-ton-tai", notes: "x" }));
    expect(state.error).toBe("NOT_FOUND");
    expect(dbState.audits).toHaveLength(0);
  });

  it("moderator → FORBIDDEN (throw — không write)", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const candidate = seedCandidate({ notes: null });
    await expect(
      updateCandidateNotesAction({}, fd({ candidateId: candidate.id, notes: "ghi chú" })),
    ).rejects.toThrow("FORBIDDEN");
    expect(candidate.notes).toBeNull();
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 6. updateQualityListingCountAction ──────────────────────────────────────

describe("updateQualityListingCountAction", () => {
  it("count set + audit founding_seller.quality_count_set (detail ids + count)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ qualityListingCount: 0 });
    await updateQualityListingCountAction(fd({ candidateId: candidate.id, count: "7" }));
    expect(candidate.qualityListingCount).toBe(7);
    expect(dbState.audits).toHaveLength(1);
    const audit = dbState.audits[0] as Row;
    expect(audit.action).toBe("founding_seller.quality_count_set");
    expect(audit.actorId).toBe(ADMIN_OPS.id);
    expect(audit.resourceType).toBe("FoundingSellerCandidate");
    expect(audit.resourceId).toBe(candidate.id);
    expect(String(audit.detail)).toContain("count:7");
  });

  it.each([
    ["negative", "-1"],
    ["non-integer", "2.5"],
    ["garbage", "bay"],
    ["empty", ""],
  ])("count %s → typed error INVALID_COUNT, không write", async (_label, count) => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate({ qualityListingCount: 3 });
    await expect(
      updateQualityListingCountAction(fd({ candidateId: candidate.id, count })),
    ).rejects.toThrow("INVALID_COUNT");
    expect(candidate.qualityListingCount).toBe(3); // KHÔNG mutation
    expect(dbState.audits).toHaveLength(0);
  });

  it("candidate thiếu → NOT_FOUND", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    await expect(
      updateQualityListingCountAction(fd({ candidateId: "khong-ton-tai", count: "5" })),
    ).rejects.toThrow("NOT_FOUND");
    expect(dbState.audits).toHaveLength(0);
  });

  it("moderator → FORBIDDEN, không mutation", async () => {
    login(ADMIN_MOD, { isAdmin: true });
    const candidate = seedCandidate({ qualityListingCount: 0 });
    await expect(
      updateQualityListingCountAction(fd({ candidateId: candidate.id, count: "5" })),
    ).rejects.toThrow("FORBIDDEN");
    expect(candidate.qualityListingCount).toBe(0);
    expect(dbState.audits).toHaveLength(0);
  });
});

// ─── 7. Source contracts (A3 + không step-up + Next 16 E352) ──────────────────

describe("source contracts", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

  it("qualityListingCount KHÔNG BAO GIỜ auto-compute (A3) — writer duy nhất là action ops + default 0 lúc create", () => {
    const src = read("src/lib/actions/founding-sellers.ts");
    // write site = dòng code (bỏ comment doc A3)
    const lines = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("qualityListingCount") && !l.startsWith("*") && !l.startsWith("//"));
    // đúng 2 write site: create default 0 (Task 3) + updateQualityListingCountAction (Task 4)
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("qualityListingCount: 0,");
    expect(lines[1]).toBe("qualityListingCount: countParsed.data,");
    // domain module: KHÔNG write (chỉ comment A3)
    const domain = read("src/lib/founding-sellers.ts");
    expect(domain).not.toMatch(/qualityListingCount\s*[:=]/);
  });

  it("KHÔNG step-up — action file không gọi requireCapabilityWithStepUp (Global Constraints — §4.11/§5.4.2)", () => {
    const src = read("src/lib/actions/founding-sellers.ts");
    expect(src).not.toMatch(/requireCapabilityWithStepUp\(/); // không call site nào
  });

  it("action file: chỉ async function + type export (Next 16 E352), không console.*", () => {
    const src = read("src/lib/actions/founding-sellers.ts");
    expect(/^export const /m.test(src)).toBe(false);
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)/);
  });

  it("constants.ts: FOUNDING_SELLER_STATUS_BADGE appended — đủ 10 trạng thái §5.10, LISTING_STATUS_BADGE giữ nguyên", () => {
    const src = read("src/lib/constants.ts");
    expect(src).toContain("export const FOUNDING_SELLER_STATUS_BADGE: Record<string, string> = {");
    for (const status of FOUNDING_SELLER_CANDIDATE_STATUSES) {
      expect(src).toMatch(new RegExp(`^\\s*${status}: "bg-`, "m"));
    }
    // map hiện có KHÔNG đụng (T4 file order — append only)
    expect(src).toContain("export const LISTING_STATUS_BADGE");
    expect(src).toContain('removed: "bg-red-500/15 text-red-400"');
    // labels sống ở founding-seller-vocab.ts — KHÔNG duplicate trong constants
    expect(src).not.toContain("Tiềm năng");
  });
});
