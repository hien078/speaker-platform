/**
 * Founding seller invitation flow — candidate + invite issuance + acceptance
 * + telemetry (Batch 7 plan Task 3 — spec §9 Batch 7 "invitation flow", §2.1,
 * §4.6, §4.8, §7.1, §7.3, §7.6, §8.4, §10.1; corrections 2026-10-08 items
 * 7–15, 20, 22, 24–26, 34–36 + P1–P5).
 *
 * Hợp đồng (plan Task 3 Step 1 — mỗi case map một dòng plan):
 *  1. createCandidateAction: operations_admin/super_admin → row normalized +
 *     prospect + audit; moderator/support/analyst/non-admin → FORBIDDEN
 *     (real RBAC — corrections #21: KHÔNG mock rbac, login qua UserSession row
 *     + cookie); province sai (isProvinceCode false — FD-1 slug) → form error;
 *     phone sai format → form error (normalizePhone throw caught); duplicate
 *     (contactChannel, contactReference) trên candidate chưa inactive/exited →
 *     CANDIDATE_CONTACT_EXISTS; cùng contact trên candidate exited → allowed;
 *     audit detail KHÔNG chứa contact (§4.8); contact của chính operator →
 *     CANDIDATE_CONTACT_IS_OPERATOR (corrections #20 — P3).
 *  2. inviteCandidateAction: prospect → token row lưu HMAC 64-hex (KHÔNG bao
 *     giờ token thô), candidate → invited + invitedAt, audit
 *     founding_seller.invite_issued, inviteUrl TUYỆT ĐỐI trả MỘT LẦN
 *     (NEXT_PUBLIC_APP_URL prefix — corrections #36: thiếu →
 *     APP_URL_UNCONFIGURED, không token); re-invite revoke token cũ
 *     (idempotent — đúng MỘT active); rate limit 21st/hour → form error
 *     (§7.1); candidate đã registered → INVALID_STATE; thiếu → NOT_FOUND;
 *     contact null → CONTACT_REQUIRED; seller_invited emit actorId null +
 *     provinceCode only (KHÔNG contact — §4.8) SAU commit (S1); concurrent
 *     re-invite 23505 beta_invite_one_active_<hash> → INVITE_ALREADY_ISSUED
 *     + revoke cũ KHÔNG persist (tx abort — Global Constraints); 23505 khác /
 *     non-23505 → rethrow (fail closed); contact của chính operator →
 *     CANDIDATE_CONTACT_IS_OPERATOR.
 *  3. revokeInviteAction: active → revokedAt + audit; đã consume → no-op
 *     không audit churn; thiếu → no-op; moderator → FORBIDDEN.
 *  4. acceptInviteAction (guard order cố định — corrections #10):
 *     no session → redirect /login?next=/invite TOKENLESS, zero db call;
 *     rate limit 11th/10min → RATE_LIMITED không consume (per-user bucket;
 *     IP bucket CHỈ khi TRUST_PROXY_HEADERS=true — corrections #15, test cả
 *     hai nhánh); no cookie → INVITE_INVALID, không đụng invite state; token
 *     trong formData BỊ IGNORE (S1); unknown/expired/revoked/consumed →
 *     INVITE_INVALID BYTE-IDENTICAL (enumeration-safe); concurrent consume
 *     (claim 0-row) → INVITE_INVALID (atomic claim); email mismatch →
 *     INVITE_CHANNEL_MISMATCH không consume; matching nhưng emailVerifiedAt
 *     null → INVITE_CHANNEL_UNVERIFIED không consume; phone channel:
 *     matching verified pass / unverified / mismatch / phone rác
 *     (normalizePhone throw → MISMATCH — corrections #14); suspension active
 *     → INVITE_ACCOUNT_SUSPENDED không consume (isUserSuspended delegation —
 *     S10); self-issue (issuedById === user.id) → INVITE_SELF_ISSUED không
 *     consume, TRƯỚC channel binding (corrections #10/#20 — P3); membership
 *     invited → active + acceptedAt + beta_membership_activated EMITTED;
 *     membership active (admin-granted) → MỘT row, acceptedAt fill khi null,
 *     KHÔNG emit; membership suspended/exited →
 *     INVITE_MEMBERSHIP_NOT_ACCEPTABLE TRƯỚC claim (token không burn);
 *     membership active + expiresAt quá khứ → INVITE_MEMBERSHIP_NOT_ACCEPTABLE
 *     (P4); candidate linked user khác → INVITE_INVALID; candidate
 *     inactive/exited/registered → INVITE_INVALID; 23505
 *     BetaCohortMembership_userId_cohort_key → INVITE_INVALID + consumedAt
 *     KHÔNG persist (tx abort); 23503/plain Error → RETHROW (fail closed);
 *     happy path: membership {founding_seller, active, acceptedAt,
 *     invitedBy: issuer} + candidate registered + userId link + audit
 *     founding_seller.invite_accepted + cookie cleared + seller_registered
 *     emit (actor = user, sessionId thô — corrections #26) + funnel sync chạy
 *     SAU commit (corrections #22) + notify kind "cohort" + redirect /sell
 *     NGOÀI catch; notify lỗi db → action vẫn thành công + captureError MÃ
 *     CHUỖI (corrections #25).
 *  5. Token secrecy end-to-end (Review Focus 1): sau full flow, KHÔNG row
 *     BetaInviteToken nào chứa token thô; KHÔNG console/captureError/audit/
 *     telemetry payload nào chứa token thô.
 *  6. Landing route handler (corrections #7/#13): rate limit invite-landing
 *     TRƯỚC db read (31st → 429); garbage shape → redirect /invite KHÔNG
 *     cookie, zero db call; token hợp lệ → 303 + Set-Cookie sp_invite
 *     (httpOnly, path /invite, maxAge 900) + Referrer-Policy no-referrer,
 *     KHÔNG side effect nào trên token row (bots unfurl GET link này);
 *     token invalid/expired/revoked/consumed → redirect KHÔNG cookie.
 *  7. /invite page (S1): không cookie → thông báo chung "Lời mời không còn
 *     hiệu lực"; cookie hợp lệ + đã đăng nhập → render InviteAcceptForm;
 *     chưa đăng nhập → CTA /login?next=/invite TOKENLESS; KHÔNG render token
 *     thô hay contact reference (§4.8).
 *  8. Source contracts: action file không export const (Next 16 E352),
 *     không console.*; next.config.ts /invite/:token no-referrer (KHÔNG
 *     :path* — corrections #8) + /uploads block giữ nguyên; accept form
 *     không hidden token; route handler không side effect ngoài cookie.
 *
 * Cơ chế mock (Global Constraints stubbing recipe + corrections #21): rbac/
 * auth/session GIỮ BẢN THẬT (login qua UserSession row + cookie thật trên
 * next/headers mock); db.client in-memory (User/UserSession(include user)/
 * FoundingSellerCandidate/BetaInviteToken/BetaCohortMembership/AuditEvent/
 * UserSuspension/SellerVerification/Listing/Notification/ProductEvent) với
 * transaction CÓ ROLLBACK (in-place restore khi callback throw — mô phỏng
 * Postgres abort: catch-and-return trong callback là silent-success bug,
 * Global Constraints) + hook beforeTx (mô phỏng concurrent commit giữa
 * pre-read và tx) + fail hooks (SqlQueryError THẬT — corrections #24).
 * moderation/product-events/notify/audit-event GIỮ BẢN THẬT bọc spy
 * (delegation pin + assert ROW tồn tại, không chỉ spy — corrections #26).
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

// ─── next/headers mock — cookie store ĐIỀU KHIỂN ĐƯỢC (sp_invite) ──────────────

const headerState = vi.hoisted(() => ({ headers: new Headers() }));
const cookieState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** Mọi đối số delete — pin corrections #35 (delete phải mang path /invite). */
  deletes: [] as Array<string | { name: string; path?: string }>,
}));

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
    delete: (arg: string | { name: string; path?: string }) => {
      cookieState.deletes.push(arg);
      cookieState.store.delete(typeof arg === "string" ? arg : arg.name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

// ─── observability spy — silence console + assert KHÔNG token thô ─────────────

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── db.client mock — in-memory 11 model + transaction CÓ ROLLBACK ────────────

type Row = Record<string, unknown>;
type Pred = ((proxy: unknown) => unknown) | Row;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  sessions: [] as Row[],
  candidates: [] as Row[],
  tokens: [] as Row[],
  memberships: [] as Row[],
  audits: [] as Row[],
  suspensions: [] as Row[],
  verifications: [] as Row[],
  listings: [] as Row[],
  notifications: [] as Row[],
  events: [] as Row[], // ProductEvent rows — emit core THẬT ghi vào đây
  calls: [] as string[], // mọi terminal op — pin "zero db call" theo model
  fail: {} as {
    tokenCreate?: unknown;
    membershipCreate?: unknown;
    candidateCreate?: unknown;
  },
  /** Hook chạy ĐẦU tx — mô phỏng concurrent commit giữa pre-read và tx. */
  beforeTx: null as (() => void) | null,
  txCommitted: false,
  /** S1 pin: trạng thái LÚC emitProductEvent được gọi. */
  txCommittedAtEmit: null as boolean | null,
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

  /** Model in-memory — label để pin call theo model ("BetaInviteToken.create"). */
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
        dbState.calls.push(`${label}.first`);
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        if (includeRel === "user" && attachUser) attachUser(copy);
        return copy;
      },
      all: async () => {
        dbState.calls.push(`${label}.all`);
        return rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r }));
      },
      updateAll: async (data: Row) => {
        dbState.calls.push(`${label}.updateAll`);
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        dbState.calls.push(`${label}.create`);
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
      delete: async () => {
        dbState.calls.push(`${label}.delete`);
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
    FoundingSellerCandidate: (() => {
      const base = makeModel(
        "FoundingSellerCandidate",
        dbState.candidates,
        () => ({
          id: `cand-${dbState.candidates.length + 1}`,
          userId: null,
          contactReference: null,
          contactChannel: null,
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
      );
      return {
        ...base,
        create: async (data: Row) => {
          dbState.calls.push("FoundingSellerCandidate.create");
          if (dbState.fail.candidateCreate !== undefined) throw dbState.fail.candidateCreate;
          return base.create(data);
        },
      };
    })(),
    BetaInviteToken: (() => {
      const base = makeModel(
        "BetaInviteToken",
        dbState.tokens,
        () => ({
          id: `tok-${dbState.tokens.length + 1}`,
          issuedById: null,
          consumedAt: null,
          revokedAt: null,
          createdAt: NOW,
        }),
      );
      return {
        ...base,
        create: async (data: Row) => {
          dbState.calls.push("BetaInviteToken.create");
          if (dbState.fail.tokenCreate !== undefined) throw dbState.fail.tokenCreate;
          // Partial unique index beta_invite_one_active_<hash> (Task 1): MỘT
          // token active (chưa consume, chưa revoke) duy nhất per candidate —
          // tên render kèm hash suffix NHƯ Postgres thật (corrections #24).
          const dup = dbState.tokens.find(
            (r) => r.candidateId === data.candidateId && r.consumedAt === null && r.revokedAt === null,
          );
          if (dup !== undefined) {
            throw new SqlQueryError("mock partial unique index violation (beta_invite_one_active)", {
              sqlState: "23505",
              constraint: "beta_invite_one_active_deadbeef",
            });
          }
          return base.create(data);
        },
      };
    })(),
    BetaCohortMembership: (() => {
      const base = makeModel(
        "BetaCohortMembership",
        dbState.memberships,
        () => ({
          id: `mem-${dbState.memberships.length + 1}`,
          invitedBy: null,
          invitedAt: null,
          acceptedAt: null,
          expiresAt: null,
          notes: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      return {
        ...base,
        create: async (data: Row) => {
          dbState.calls.push("BetaCohortMembership.create");
          if (dbState.fail.membershipCreate !== undefined) throw dbState.fail.membershipCreate;
          // @@unique(userId, cohort) — BetaCohortMembership_userId_cohort_key.
          const dup = dbState.memberships.find(
            (r) => r.userId === data.userId && r.cohort === data.cohort,
          );
          if (dup !== undefined) {
            throw new SqlQueryError("mock unique violation (BetaCohortMembership_userId_cohort_key)", {
              sqlState: "23505",
              constraint: "BetaCohortMembership_userId_cohort_key",
            });
          }
          return base.create(data);
        },
      };
    })(),
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
    UserSuspension: makeModel("UserSuspension", dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
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
    Notification: makeModel("Notification", dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      readAt: null,
      createdAt: NOW,
    })),
    ProductEvent: makeModel("ProductEvent", dbState.events, () => ({
      id: `pe-${dbState.events.length + 1}`,
      occurredAt: NOW,
    })),
  };

  const STORE_KEYS = [
    "users",
    "sessions",
    "candidates",
    "tokens",
    "memberships",
    "audits",
    "suspensions",
    "verifications",
    "listings",
    "notifications",
    "events",
  ] as const;

  /** Rollback IN-PLACE giữ identity row — reference ngoài tx đọc được trạng thái hoàn tác. */
  const restoreStore = (rows: Row[], snap: Row[]) => {
    if (rows.length > snap.length) rows.splice(snap.length); // row tạo trong tx — bỏ
    snap.forEach((before, i) => {
      const current = rows[i];
      if (current === undefined) {
        rows[i] = structuredClone(before); // row bị delete trong tx — hoàn lại
        return;
      }
      for (const key of Object.keys(current)) if (!(key in before)) delete current[key];
      Object.assign(current, before);
    });
  };

  return {
    db: {
      orm: { public: models },
      // Tx mock CÓ ROLLBACK (Global Constraints): callback throw → MỌI write
      // trong tx bị hoàn tác (Postgres abort — COMMIT thành ROLLBACK), KHÔNG
      // bao giờ silent-success. beforeTx chạy TRƯỚC snapshot — concurrent
      // commit của request khác sống sót qua rollback của tx mình.
      transaction: async (fn: (tx: { orm: { public: typeof models } }) => Promise<unknown>) => {
        dbState.txCommitted = false;
        dbState.beforeTx?.();
        const snap = Object.fromEntries(STORE_KEYS.map((k) => [k, structuredClone(dbState[k])]));
        try {
          const result = await fn({ orm: { public: { ...models } } });
          dbState.txCommitted = true;
          return result;
        } catch (e) {
          for (const k of STORE_KEYS) restoreStore(dbState[k] as Row[], snap[k] as Row[]);
          throw e;
        }
      },
    },
  };
});

// ─── moderation/product-events/notify/audit-event — BẢN THẬT bọc spy ──────────

vi.mock("@/src/lib/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/moderation")>();
  return { ...actual, isUserSuspended: vi.fn(actual.isUserSuspended) };
});

vi.mock("@/src/lib/product-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/product-events")>();
  return {
    ...actual,
    emitProductEvent: vi.fn(
      async (input: Parameters<typeof actual.emitProductEvent>[0]): Promise<void> => {
        dbState.txCommittedAtEmit = dbState.txCommitted;
        return actual.emitProductEvent(input);
      },
    ),
  };
});

vi.mock("@/src/lib/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/notify")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});

vi.mock("@/src/lib/audit-event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/audit-event")>();
  return {
    ...actual,
    auditEvent: vi.fn(actual.auditEvent),
    auditEventTx: vi.fn(actual.auditEventTx),
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import { isUserSuspended } from "@/src/lib/moderation";
import { emitProductEvent } from "@/src/lib/product-events";
import { notify } from "@/src/lib/notify";
import { auditEventTx } from "@/src/lib/audit-event";
import { captureError } from "@/src/lib/observability";
import {
  BETA_INVITE_COOKIE,
  BETA_INVITE_COOKIE_PATH,
  betaInviteTokenHash,
} from "@/src/lib/founding-sellers";
import {
  acceptInviteAction,
  createCandidateAction,
  inviteCandidateAction,
  revokeInviteAction,
} from "@/src/lib/actions/founding-sellers";
import * as inviteLandingRoute from "../../app/invite/[token]/route";
import * as invitePage from "../../app/invite/page";
import { InviteAcceptForm } from "../../src/components/invite-accept-form";

const emitSpy = vi.mocked(emitProductEvent);
const notifySpy = vi.mocked(notify);
const auditTxSpy = vi.mocked(auditEventTx);
const suspendedSpy = vi.mocked(isUserSuspended);
const captureErrorMock = vi.mocked(captureError);

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
/** Invitee — buyer thường, email đã verify. */
const INVITEE = mkUser({
  id: "user-invitee",
  email: "seller.moi@loaviet.test",
  name: "Người Mời",
  emailVerifiedAt: "2026-09-02T00:00:00.000Z",
});

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

/** Candidate fixture — contact đã chuẩn hóa, status tùy case. */
const seedCandidate = (over: Partial<Row> = {}): Row & { id: string } => {
  const row: Row = {
    id: `cand-${dbState.candidates.length + 1}`,
    userId: null,
    contactReference: "seller.moi@loaviet.test",
    contactChannel: "email",
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
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
  dbState.candidates.push(row);
  return row as Row & { id: string };
};

/** Issue invite qua action THẬT — trả về raw token (từ inviteUrl) + row reference. */
const issueInvite = async (
  candidateId: string,
): Promise<{ token: string; tokenRow: Row; inviteUrl: string }> => {
  // Issue cần session admin MFA — lưu lại session hiện tại (vd invitee) rồi restore
  const previousSession = cookieState.store.get(SESSION_COOKIE);
  cookieState.store.clear();
  login(ADMIN_OPS, { isAdmin: true });
  let state: Awaited<ReturnType<typeof inviteCandidateAction>>;
  try {
    state = await inviteCandidateAction({}, fd({ candidateId }));
  } finally {
    cookieState.store.clear();
    if (previousSession !== undefined) cookieState.store.set(SESSION_COOKIE, previousSession);
  }
  if (state.error !== undefined || state.inviteUrl === undefined) {
    throw new Error(`issueInvite failed: ${JSON.stringify(state)}`);
  }
  const token = state.inviteUrl.split("/").pop()!;
  const tokenRow = dbState.tokens.find((r) => r.tokenHash === betaInviteTokenHash(token))!;
  return { token, tokenRow, inviteUrl: state.inviteUrl };
};

const setInviteCookie = (token: string) => cookieState.store.set(BETA_INVITE_COOKIE, token);

/** acceptInviteAction nuốt NEXT_REDIRECT (happy path) — trả form state. */
const acceptQuiet = async (): Promise<Record<string, string | undefined>> => {
  try {
    const state = await acceptInviteAction({}, fd({}));
    return state as Record<string, string | undefined>;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) {
      return { redirected: e.message };
    }
    throw e;
  }
};

/** Tìm element theo type trong React tree (walk cả children của component). */
const findElementOfType = (node: unknown, type: unknown): unknown => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElementOfType(child, type);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (node !== null && typeof node === "object" && "$$typeof" in (node as Row)) {
    const el = node as { type: unknown; props?: { children?: unknown } };
    if (el.type === type) return el;
    return findElementOfType(el.props?.children, type);
  }
  return null;
};

/**
 * Collect mọi string render + href từ React element tree (page test —
 * KHÔNG JSON.stringify: element dev có _owner Fiber circular).
 */
const collectStrings = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return out;
  }
  if ("$$typeof" in (node as Row)) {
    const props = (node as { props?: { children?: unknown; href?: unknown } }).props;
    if (props !== null && typeof props === "object") {
      if (typeof props.href === "string") out.push(props.href);
      collectStrings(props.children, out);
    }
  }
  return out;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://beta.loaviet.test");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.candidates.length = 0;
  dbState.tokens.length = 0;
  dbState.memberships.length = 0;
  dbState.audits.length = 0;
  dbState.suspensions.length = 0;
  dbState.verifications.length = 0;
  dbState.listings.length = 0;
  dbState.notifications.length = 0;
  dbState.events.length = 0;
  dbState.calls.length = 0;
  dbState.fail = {};
  dbState.beforeTx = null;
  dbState.txCommitted = false;
  dbState.txCommittedAtEmit = null;
  dbState.users.push(
    { ...ADMIN_OPS },
    { ...ADMIN_SUPER },
    { ...ADMIN_MOD },
    { ...ADMIN_SUPPORT },
    { ...ADMIN_ANALYST },
    { ...INVITEE },
  );
  cookieState.store.clear();
  cookieState.deletes.length = 0;
  headerState.headers = new Headers();
  emitSpy.mockClear();
  notifySpy.mockClear();
  auditTxSpy.mockClear();
  suspendedSpy.mockClear();
  captureErrorMock.mockClear();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  dbState.beforeTx = null;
});

// ─── 1. createCandidateAction ────────────────────────────────────────────────

describe("createCandidateAction — requireCapability(beta_cohort.manage)", () => {
  it("operations_admin → row normalized + prospect + audit; super_admin → allowed", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const state = await createCandidateAction(
      {},
      fd({
        contactReference: "  Seller.Moi@Loaviet.Test ",
        contactChannel: "email",
        source: "tuyển qua nhóm cộng đồng",
        targetCommunity: "ha-noi",
      }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.candidates).toHaveLength(1);
    const row = dbState.candidates[0]!;
    expect(row.contactReference).toBe("seller.moi@loaviet.test"); // normalizeEmail
    expect(row.status).toBe("prospect");
    expect(row.qualityListingCount).toBe(0);
    expect(row.targetCommunity).toBe("ha-noi");
    expect(dbState.audits).toHaveLength(1);
    expect(dbState.audits[0]!.action).toBe("founding_seller.candidate_created");
    expect(dbState.audits[0]!.resourceType).toBe("FoundingSellerCandidate");
    expect(dbState.audits[0]!.sessionId).toBe("sess-admin-ops");

    // super_admin cũng được (ma trận Batch 2)
    const state2 = await createCandidateAction(
      {},
      fd({ contactReference: "khac@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "hue" }),
    );
    expect(state2.error).toBeUndefined();
    expect(dbState.candidates).toHaveLength(2);
  });

  it.each([
    ["moderator", ADMIN_MOD],
    ["support", ADMIN_SUPPORT],
    ["analyst", ADMIN_ANALYST],
  ])("%s → FORBIDDEN, không row, không audit (Review Focus 4)", async (_label, admin) => {
    login(admin as Row, { isAdmin: true });
    await expect(
      createCandidateAction(
        {},
        fd({ contactReference: "x@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(dbState.candidates).toHaveLength(0);
    expect(dbState.audits).toHaveLength(0);
  });

  it("operations_admin session chưa qua MFA (isAdmin=false) → FORBIDDEN", async () => {
    login(ADMIN_OPS); // consumer session
    await expect(
      createCandidateAction(
        {},
        fd({ contactReference: "x@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(dbState.candidates).toHaveLength(0);
  });

  it("chưa đăng nhập → FORBIDDEN", async () => {
    await expect(
      createCandidateAction(
        {},
        fd({ contactReference: "x@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
  });

  it("province không hợp lệ (isProvinceCode false — FD-1 slug, không numeric) → form error, không row", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const state = await createCandidateAction(
      {},
      fd({ contactReference: "x@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "01" }),
    );
    expect(state.error).toBe("INVALID_PROVINCE");
    expect(dbState.candidates).toHaveLength(0);
  });

  it("phone sai format → form error (normalizePhone throw caught), không row", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const state = await createCandidateAction(
      {},
      fd({ contactReference: "12345", contactChannel: "phone", source: "s", targetCommunity: "ha-noi" }),
    );
    expect(state.error).toBe("INVALID_PHONE_FORMAT");
    expect(dbState.candidates).toHaveLength(0);
  });

  it("phone hợp lệ → normalizePhone (+84 → 0)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const state = await createCandidateAction(
      {},
      fd({ contactReference: "+84 901 234 567", contactChannel: "phone", source: "s", targetCommunity: "ha-noi" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.candidates[0]!.contactReference).toBe("0901234567");
  });

  it("duplicate (contactChannel, contactReference) trên candidate chưa inactive/exited → CANDIDATE_CONTACT_EXISTS, không row mới", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    seedCandidate({ contactReference: "seller.moi@loaviet.test", contactChannel: "email" });
    const state = await createCandidateAction(
      {},
      fd({ contactReference: "seller.moi@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
    );
    expect(state.error).toBe("CANDIDATE_CONTACT_EXISTS");
    expect(dbState.candidates).toHaveLength(1); // chỉ row seed
  });

  it("cùng contact trên candidate exited → allowed (S7 — ops tìm row cũ)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    seedCandidate({ contactReference: "seller.moi@loaviet.test", contactChannel: "email", status: "exited" });
    const state = await createCandidateAction(
      {},
      fd({ contactReference: "seller.moi@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
    );
    expect(state.error).toBeUndefined();
    expect(dbState.candidates).toHaveLength(2);
  });

  it("audit detail KHÔNG chứa contact string (§4.8 — chỉ community code)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    await createCandidateAction(
      {},
      fd({ contactReference: "seller.moi@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
    );
    const detail = String(dbState.audits[0]!.detail ?? "");
    expect(detail).toContain("ha-noi");
    expect(detail).not.toContain("seller.moi@loaviet.test");
    // toàn bộ audit row không chứa contact
    expect(JSON.stringify(dbState.audits)).not.toContain("seller.moi@loaviet.test");
  });

  it("(P3/corrections #20) contact là CHÍNH operator → CANDIDATE_CONTACT_IS_OPERATOR, không row", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const state = await createCandidateAction(
      {},
      fd({ contactReference: "ops@loaviet.test", contactChannel: "email", source: "s", targetCommunity: "ha-noi" }),
    );
    expect(state.error).toBe("CANDIDATE_CONTACT_IS_OPERATOR");
    expect(dbState.candidates).toHaveLength(0);
  });
});

// ─── 2. inviteCandidateAction ────────────────────────────────────────────────

describe("inviteCandidateAction — issuance, token secrecy, rate limit", () => {
  beforeEach(() => {
    login(ADMIN_OPS, { isAdmin: true });
  });

  it("prospect → token row lưu HMAC 64-hex (KHÔNG BAO GIỜ token thô); candidate → invited + invitedAt; audit; inviteUrl tuyệt đối MỘT LẦN", async () => {
    const candidate = seedCandidate();
    const state = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(state.error).toBeUndefined();
    expect(state.inviteUrl).toMatch(/^https:\/\/beta\.loaviet\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = state.inviteUrl!.split("/").pop()!;
    expect(dbState.tokens).toHaveLength(1);
    const row = dbState.tokens[0]!;
    expect(row.tokenHash).toBe(betaInviteTokenHash(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
    expect(row.tokenHash).not.toBe(token);
    expect(Object.values(row).includes(token)).toBe(false); // không giá trị nào = token thô
    expect(row.candidateId).toBe(candidate.id);
    expect(row.channel).toBe("email");
    expect(row.target).toBe("seller.moi@loaviet.test");
    expect(row.issuedById).toBe("admin-ops");
    expect(Date.parse(row.expiresAt as string)).toBeGreaterThan(Date.now());
    const candidateAfter = dbState.candidates[0]!;
    expect(candidateAfter.status).toBe("invited");
    expect(candidateAfter.invitedAt).not.toBeNull();
    expect(dbState.audits).toHaveLength(1);
    expect(dbState.audits[0]!.action).toBe("founding_seller.invite_issued");
    expect(dbState.audits[0]!.resourceType).toBe("BetaInviteToken");
    expect(dbState.audits[0]!.resourceId).toBe(row.id);
  });

  it("re-invite revoke token active cũ + issue token mới — đúng MỘT active (idempotent)", async () => {
    const candidate = seedCandidate();
    const first = await issueInvite(candidate.id);
    expect(first.tokenRow.revokedAt).toBeNull();
    const second = await issueInvite(candidate.id);
    expect(dbState.tokens).toHaveLength(2);
    expect(first.tokenRow.revokedAt).not.toBeNull(); // token cũ bị revoke
    expect(second.tokenRow.revokedAt).toBeNull();
    expect(second.token).not.toBe(first.token);
    const active = dbState.tokens.filter((r) => r.consumedAt === null && r.revokedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.tokenRow.id);
  });

  it("rate limit — lần 21 trong giờ → form error, không token row (§7.1)", async () => {
    const candidate = seedCandidate();
    for (let i = 0; i < 20; i++) {
      const state = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
      expect(state.error).toBeUndefined();
    }
    expect(dbState.tokens).toHaveLength(20);
    const state21 = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(state21.error).toBe("RATE_LIMITED");
    expect(dbState.tokens).toHaveLength(20); // không row mới
  });

  it("candidate đã registered → INVALID_STATE, không token (invite chỉ pre-registration)", async () => {
    const candidate = seedCandidate({ status: "registered" });
    const state = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(state.error).toBe("INVALID_STATE");
    expect(dbState.tokens).toHaveLength(0);
  });

  it("candidate thiếu → NOT_FOUND; contact null → CONTACT_REQUIRED", async () => {
    const missing = await inviteCandidateAction({}, fd({ candidateId: "khong-ton-tai" }));
    expect(missing.error).toBe("NOT_FOUND");
    const candidate = seedCandidate({ contactReference: null, contactChannel: null });
    const noContact = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(noContact.error).toBe("CONTACT_REQUIRED");
    expect(dbState.tokens).toHaveLength(0);
  });

  it("emit seller_invited: actorId null, provinceCode only, KHÔNG contact, SAU commit (S1)", async () => {
    const candidate = seedCandidate();
    await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    const calls = emitSpy.mock.calls.filter((c) => c[0].name === "seller_invited");
    expect(calls).toHaveLength(1);
    const input = calls[0]![0];
    expect(input.actorId).toBeNull(); // prospect chưa có tài khoản
    expect(input.provinceCode).toBe("ha-noi");
    expect(input.metadata).toBeUndefined(); // z.strictObject({}) — corrections #26
    expect(JSON.stringify(input)).not.toContain("seller.moi@loaviet.test");
    expect(dbState.txCommittedAtEmit).toBe(true); // SAU tx resolve
    // ROW tồn tại (corrections #26 — không chỉ spy)
    expect(dbState.events.filter((r) => r.name === "seller_invited")).toHaveLength(1);
  });

  it("concurrent re-invite (23505 beta_invite_one_active_<hash>) → INVITE_ALREADY_ISSUED, revoke cũ KHÔNG persist (tx abort)", async () => {
    const candidate = seedCandidate();
    const first = await issueInvite(candidate.id);
    expect(first.tokenRow.revokedAt).toBeNull();
    // Concurrent request giữ token active khác → create mới vi phạm partial index
    dbState.fail.tokenCreate = new SqlQueryError("mock concurrent active token", {
      sqlState: "23505",
      constraint: "beta_invite_one_active_deadbeef",
    });
    const state = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(state.error).toBe("INVITE_ALREADY_ISSUED");
    // tx abort: revoke của token cũ KHÔNG được persist — vẫn active nguyên vẹn
    expect(first.tokenRow.revokedAt).toBeNull();
    expect(dbState.tokens).toHaveLength(1);
    expect(dbState.audits).toHaveLength(1); // chỉ audit lần invite đầu
  });

  it("23505 constraint KHÁC → rethrow (fail closed — không masquerade)", async () => {
    const candidate = seedCandidate();
    dbState.fail.tokenCreate = new SqlQueryError("mock other unique", {
      sqlState: "23505",
      constraint: "BetaInviteToken_tokenHash_key",
    });
    await expect(inviteCandidateAction({}, fd({ candidateId: candidate.id }))).rejects.toMatchObject(
      { sqlState: "23505", constraint: "BetaInviteToken_tokenHash_key" },
    );
  });

  it("lỗi driver không phải 23505 → rethrow (fail closed)", async () => {
    const candidate = seedCandidate();
    dbState.fail.tokenCreate = new SqlQueryError("mock fk violation", {
      sqlState: "23503",
      constraint: "BetaInviteToken_candidateId_fkey",
    });
    await expect(inviteCandidateAction({}, fd({ candidateId: candidate.id }))).rejects.toMatchObject(
      { sqlState: "23503" },
    );
    expect(dbState.tokens).toHaveLength(0);
  });

  it("(corrections #36) NEXT_PUBLIC_APP_URL thiếu → APP_URL_UNCONFIGURED, không token", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const candidate = seedCandidate();
    const state = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(state.error).toBe("APP_URL_UNCONFIGURED");
    expect(dbState.tokens).toHaveLength(0);
  });

  it("(P3/corrections #20) contact candidate là CHÍNH operator → CANDIDATE_CONTACT_IS_OPERATOR, không token", async () => {
    const candidate = seedCandidate({ contactReference: "ops@loaviet.test" });
    const state = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
    expect(state.error).toBe("CANDIDATE_CONTACT_IS_OPERATOR");
    expect(dbState.tokens).toHaveLength(0);
  });

  it("moderator → FORBIDDEN, không token", async () => {
    cookieState.store.clear();
    login(ADMIN_MOD, { isAdmin: true });
    const candidate = seedCandidate();
    await expect(inviteCandidateAction({}, fd({ candidateId: candidate.id }))).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(dbState.tokens).toHaveLength(0);
  });
});

// ─── 3. revokeInviteAction ───────────────────────────────────────────────────

describe("revokeInviteAction", () => {
  beforeEach(() => {
    login(ADMIN_OPS, { isAdmin: true });
  });

  it("token active → revokedAt set + audit founding_seller.invite_revoked", async () => {
    const candidate = seedCandidate();
    const { tokenRow } = await issueInvite(candidate.id);
    await revokeInviteAction(fd({ tokenId: tokenRow.id as string }));
    expect(tokenRow.revokedAt).not.toBeNull();
    expect(dbState.audits.some((a) => a.action === "founding_seller.invite_revoked")).toBe(true);
  });

  it("token đã consume → no-op idempotent, KHÔNG audit churn", async () => {
    const candidate = seedCandidate();
    const { tokenRow } = await issueInvite(candidate.id);
    tokenRow.consumedAt = new Date().toISOString(); // consume thủ công (giả lập accept)
    const auditsBefore = dbState.audits.length;
    await revokeInviteAction(fd({ tokenId: tokenRow.id as string }));
    expect(tokenRow.revokedAt).toBeNull(); // không revoke token đã consume
    expect(dbState.audits).toHaveLength(auditsBefore); // không audit mới
  });

  it("token không tồn tại → no-op, không audit", async () => {
    const auditsBefore = dbState.audits.length;
    await revokeInviteAction(fd({ tokenId: "khong-ton-tai" }));
    expect(dbState.audits).toHaveLength(auditsBefore);
  });

  it("moderator → FORBIDDEN", async () => {
    const candidate = seedCandidate();
    const { tokenRow } = await issueInvite(candidate.id);
    cookieState.store.clear();
    login(ADMIN_MOD, { isAdmin: true });
    await expect(revokeInviteAction(fd({ tokenId: tokenRow.id as string }))).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(tokenRow.revokedAt).toBeNull();
  });
});

// ─── 4. acceptInviteAction ────────────────────────────────────────────────────

describe("acceptInviteAction — auth, rate limit, enumeration-safe token failures", () => {
  it("chưa đăng nhập → redirect /login?next=/invite TOKENLESS, zero db call", async () => {
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/login?next=/invite");
    expect(dbState.calls).toHaveLength(0);
  });

  it("rate limit — lần 11 trong 10 phút → RATE_LIMITED, không consume thêm (§7.1)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    for (let i = 0; i < 10; i++) {
      // lần đầu thành công (redirect), các lần sau INVITE_INVALID — bucket đếm MỌI attempt
      await acceptQuiet();
    }
    const state11 = await acceptInviteAction({}, fd({}));
    expect(state11.error).toBe("RATE_LIMITED");
  });

  it("IP bucket CHỈ khi TRUST_PROXY_HEADERS=true (corrections #15) — test cả hai nhánh", async () => {
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    const invitee2 = mkUser({
      id: "user-invitee-2",
      email: "seller.moi2@loaviet.test",
      emailVerifiedAt: "2026-09-02T00:00:00.000Z",
    });
    dbState.users.push(invitee2);

    // Nhánh OFF (mặc định): user A 10 attempt → RATE_LIMITED; user B (bucket
    // per-user riêng) KHÔNG bị khóa bởi A — chỉ INVITE_INVALID vì token burn
    login(INVITEE);
    setInviteCookie(token);
    for (let i = 0; i < 10; i++) await acceptQuiet();
    expect((await acceptInviteAction({}, fd({}))).error).toBe("RATE_LIMITED");
    cookieState.store.clear();
    login(invitee2);
    setInviteCookie(token);
    const otherUserState = await acceptInviteAction({}, fd({}));
    expect(otherUserState.error).not.toBe("RATE_LIMITED"); // bucket per-user riêng

    // Nhánh ON: IP bucket chia sẻ "local" → user B bị khóa bởi 10 attempt của A
    resetRateLimits();
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    cookieState.store.clear();
    login(INVITEE);
    setInviteCookie(token);
    for (let i = 0; i < 10; i++) await acceptQuiet();
    cookieState.store.clear();
    login(invitee2);
    setInviteCookie(token);
    const ipLimited = await acceptInviteAction({}, fd({}));
    expect(ipLimited.error).toBe("RATE_LIMITED");
    // afterEach unstubAllEnvs() dọn TRUST_PROXY_HEADERS
  });

  it("không cookie → INVITE_INVALID, KHÔNG đụng invite state; token trong formData BỊ IGNORE (S1)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    dbState.calls.length = 0;
    const state = await acceptInviteAction({}, fd({ token })); // forged token trong form
    expect(state.error).toBe("INVITE_INVALID");
    // fail TRƯỚC khi chạm invite state (session read là duy nhất xảy ra)
    expect(dbState.calls.filter((c) => !c.startsWith("UserSession") && !c.startsWith("User."))).toHaveLength(0);
    expect(dbState.memberships).toHaveLength(0);
  });

  it("unknown token → INVITE_INVALID; expired → INVITE_INVALID; revoked → INVITE_INVALID — BYTE-IDENTICAL", async () => {
    login(INVITEE);
    // unknown — hash không có row
    const unknownToken = "A".repeat(43);
    setInviteCookie(unknownToken);
    const unknownState = await acceptInviteAction({}, fd({}));
    expect(unknownState.error).toBe("INVITE_INVALID");

    // expired
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    const tokenRow = dbState.tokens[0]!;
    tokenRow.expiresAt = new Date(Date.now() - 1_000).toISOString();
    setInviteCookie(token);
    const expiredState = await acceptInviteAction({}, fd({}));
    expect(expiredState.error).toBe("INVITE_INVALID");

    // revoked
    const candidate2 = seedCandidate({ contactReference: "khac@loaviet.test" });
    const second = await issueInvite(candidate2.id);
    second.tokenRow.revokedAt = new Date().toISOString();
    setInviteCookie(second.token);
    const revokedState = await acceptInviteAction({}, fd({}));
    expect(revokedState.error).toBe("INVITE_INVALID");

    // BYTE-IDENTICAL — enumeration-safe (Review Focus 2)
    expect(unknownState.error).toBe(expiredState.error);
    expect(expiredState.error).toBe(revokedState.error);
    expect(unknownState.error).toBe("INVITE_INVALID");
    expect(dbState.memberships).toHaveLength(0);
  });

  it("token consumed bởi request song song → INVITE_INVALID (atomic claim — 0-row updateAll)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    // Concurrent commit giữa pre-read và tx: request khác consume token
    dbState.beforeTx = () => {
      const row = dbState.tokens[0]!;
      row.consumedAt = new Date().toISOString();
    };
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_INVALID");
    expect(dbState.memberships).toHaveLength(0);
    expect(dbState.candidates[0]!.status).toBe("invited"); // candidate không link
  });
});

describe("acceptInviteAction — channel binding (Review Focus 2)", () => {
  it("email mismatch → INVITE_CHANNEL_MISMATCH, không membership, token KHÔNG consume", async () => {
    login(INVITEE);
    const candidate = seedCandidate({ contactReference: "nguoi.khac@loaviet.test" });
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_CHANNEL_MISMATCH");
    expect(dbState.memberships).toHaveLength(0);
    expect(tokenRow.consumedAt).toBeNull(); // refusal TRƯỚC claim — token không burn
  });

  it("email match nhưng emailVerifiedAt null → INVITE_CHANNEL_UNVERIFIED, không membership, token KHÔNG consume", async () => {
    const unverified = mkUser({
      id: "user-unverified",
      email: "seller.moi@loaviet.test",
      emailVerifiedAt: null,
    });
    dbState.users.push(unverified);
    login(unverified);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_CHANNEL_UNVERIFIED");
    expect(dbState.memberships).toHaveLength(0);
    expect(tokenRow.consumedAt).toBeNull();
  });

  it("phone channel: matching verified phone pass; unverified → INVITE_CHANNEL_UNVERIFIED; mismatch → INVITE_CHANNEL_MISMATCH; phone rác → MISMATCH (corrections #14)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    // matching + verified → pass (happy path tới redirect)
    const candidate = seedCandidate({ contactReference: "0901234567", contactChannel: "phone" });
    const { token, tokenRow } = await issueInvite(candidate.id);
    const phoneUser = mkUser({
      id: "user-phone",
      email: "phone@loaviet.test",
      phone: "0901234567",
      phoneVerifiedAt: "2026-09-02T00:00:00.000Z",
    });
    dbState.users.push(phoneUser);
    cookieState.store.clear();
    login(phoneUser);
    setInviteCookie(token);
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");
    expect(dbState.memberships).toHaveLength(1);
    expect(tokenRow.consumedAt).not.toBeNull();

    // unverified phone
    const candidate2 = seedCandidate({ contactReference: "0912345678", contactChannel: "phone" });
    const second = await issueInvite(candidate2.id);
    const unverifiedPhone = mkUser({
      id: "user-phone-unverified",
      email: "phone2@loaviet.test",
      phone: "0912345678",
      phoneVerifiedAt: null,
    });
    dbState.users.push(unverifiedPhone);
    cookieState.store.clear();
    login(unverifiedPhone);
    setInviteCookie(second.token);
    const stateUnverified = await acceptInviteAction({}, fd({}));
    expect(stateUnverified.error).toBe("INVITE_CHANNEL_UNVERIFIED");
    expect(second.tokenRow.consumedAt).toBeNull();

    // mismatched phone
    const candidate3 = seedCandidate({ contactReference: "0934567890", contactChannel: "phone" });
    const third = await issueInvite(candidate3.id);
    setInviteCookie(third.token);
    const stateMismatch = await acceptInviteAction({}, fd({}));
    expect(stateMismatch.error).toBe("INVITE_CHANNEL_MISMATCH");
    expect(third.tokenRow.consumedAt).toBeNull();

    // phone rác trên User (normalizePhone throw) → MISMATCH, KHÔNG 500
    const candidate4 = seedCandidate({ contactReference: "0945678901", contactChannel: "phone" });
    const fourth = await issueInvite(candidate4.id);
    const garbagePhoneUser = mkUser({
      id: "user-phone-garbage",
      email: "phone3@loaviet.test",
      phone: "khong-phai-so",
      phoneVerifiedAt: "2026-09-02T00:00:00.000Z",
    });
    dbState.users.push(garbagePhoneUser);
    cookieState.store.clear();
    login(garbagePhoneUser);
    setInviteCookie(fourth.token);
    const stateGarbage = await acceptInviteAction({}, fd({}));
    expect(stateGarbage.error).toBe("INVITE_CHANNEL_MISMATCH");
    expect(fourth.tokenRow.consumedAt).toBeNull();
  });
});

describe("acceptInviteAction — suspension, self-issue, membership upsert (B3)", () => {
  it("user có UserSuspension active → INVITE_ACCOUNT_SUSPENDED, không membership, token KHÔNG consume (S10 — delegation spy)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.suspensions.push({
      id: "susp-1",
      userId: INVITEE.id,
      status: "active",
      reasonCode: "spam",
      suspendedAt: new Date().toISOString(),
      liftedAt: null,
    });
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_ACCOUNT_SUSPENDED");
    expect(suspendedSpy).toHaveBeenCalledWith(INVITEE.id); // Batch 3 delegation — KHÔNG tự viết lại
    expect(dbState.memberships).toHaveLength(0);
    expect(tokenRow.consumedAt).toBeNull();
  });

  it("(P3/corrections #20) issuedById === user.id → INVITE_SELF_ISSUED TRƯỚC channel binding, không consume, không membership", async () => {
    // admin issue invite cho candidate (contact NGƯỜI KHÁC — issuance-side
    // CANDIDATE_CONTACT_IS_OPERATOR không chặn đường này), rồi TỰ NHẬN.
    // Email admin KHÔNG khớp contact candidate: nếu channel binding chạy
    // TRƯỚC self-issue thì lỗi sẽ là INVITE_CHANNEL_MISMATCH — pin thứ tự
    // corrections #10 (self-issue là bước 4, binding là bước 5).
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate(); // contact seller.moi@loaviet.test (khác admin)
    const { token, tokenRow } = await issueInvite(candidate.id);
    cookieState.store.clear();
    login(ADMIN_OPS); // consumer session của chính admin đó
    setInviteCookie(token);
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_SELF_ISSUED");
    expect(tokenRow.consumedAt).toBeNull();
    expect(dbState.memberships).toHaveLength(0);
  });

  it("membership suspended → INVITE_MEMBERSHIP_NOT_ACCEPTABLE TRƯỚC claim — token KHÔNG burn, không membership mới", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.memberships.push({
      id: "mem-existing",
      userId: INVITEE.id,
      cohort: "founding_seller",
      status: "suspended",
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_MEMBERSHIP_NOT_ACCEPTABLE");
    expect(dbState.memberships).toHaveLength(1); // row cũ nguyên vẹn — không có row mới
    expect((dbState.memberships[0] as Row).status).toBe("suspended");
    expect(tokenRow.consumedAt).toBeNull(); // B3 — refusal trước claim
  });

  it("membership exited → INVITE_MEMBERSHIP_NOT_ACCEPTABLE, token KHÔNG consume", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.memberships.push({
      id: "mem-exited",
      userId: INVITEE.id,
      cohort: "founding_seller",
      status: "exited",
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_MEMBERSHIP_NOT_ACCEPTABLE");
    expect(tokenRow.consumedAt).toBeNull();
  });

  it("(P4) membership active + expiresAt quá khứ → INVITE_MEMBERSHIP_NOT_ACCEPTABLE, token KHÔNG consume, expiresAt KHÔNG bị clear", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.memberships.push({
      id: "mem-expired",
      userId: INVITEE.id,
      cohort: "founding_seller",
      status: "active",
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_MEMBERSHIP_NOT_ACCEPTABLE");
    expect(tokenRow.consumedAt).toBeNull();
    expect((dbState.memberships[0] as Row).expiresAt).not.toBeNull(); // không clear expiresAt
  });

  it("membership invited → active + acceptedAt + beta_membership_activated EMITTED (B3)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.memberships.push({
      id: "mem-invited",
      userId: INVITEE.id,
      cohort: "founding_seller",
      status: "invited",
      invitedBy: "admin-super",
      invitedAt: new Date().toISOString(),
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");
    expect(dbState.memberships).toHaveLength(1); // MỘT row — upsert
    const membership = dbState.memberships[0] as Row;
    expect(membership.status).toBe("active");
    expect(membership.acceptedAt).not.toBeNull();
    expect(membership.invitedBy).toBe("admin-super"); // KHÔNG đụng provenance
    expect(tokenRow.consumedAt).not.toBeNull();
    const activatedCalls = emitSpy.mock.calls.filter((c) => c[0].name === "beta_membership_activated");
    expect(activatedCalls).toHaveLength(1);
    expect(activatedCalls[0]![0].actorId).toBe(INVITEE.id);
    expect(dbState.events.filter((r) => r.name === "beta_membership_activated")).toHaveLength(1);
  });

  it("membership active (admin-granted, Batch 2) → MỘT row, status giữ active, acceptedAt fill khi null, KHÔNG emit activated", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.memberships.push({
      id: "mem-active",
      userId: INVITEE.id,
      cohort: "founding_seller",
      status: "active",
      invitedBy: "admin-super",
      invitedAt: new Date().toISOString(),
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");
    expect(dbState.memberships).toHaveLength(1); // KHÔNG duplicate row
    const membership = dbState.memberships[0] as Row;
    expect(membership.status).toBe("active");
    expect(membership.acceptedAt).not.toBeNull(); // fill khi null
    expect(emitSpy.mock.calls.filter((c) => c[0].name === "beta_membership_activated")).toHaveLength(0); // activated=false
    expect(tokenRow.consumedAt).not.toBeNull(); // token vẫn burn (đã link candidate)
  });

  it("membership active + acceptedAt đã có → giữ nguyên acceptedAt cũ", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    const oldAcceptedAt = "2026-09-01T00:00:00.000Z";
    dbState.memberships.push({
      id: "mem-active-2",
      userId: INVITEE.id,
      cohort: "founding_seller",
      status: "active",
      invitedBy: "admin-super",
      invitedAt: null,
      acceptedAt: oldAcceptedAt,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");
    expect((dbState.memberships[0] as Row).acceptedAt).toBe(oldAcceptedAt);
  });
});

describe("acceptInviteAction — candidate guards + concurrency classify", () => {
  it("candidate linked user KHÁC → INVITE_INVALID, không membership (không existence oracle)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.beforeTx = () => {
      candidate.userId = "user-khac";
    };
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_INVALID");
    expect(dbState.memberships).toHaveLength(0);
    expect(tokenRow.consumedAt).toBeNull(); // tx abort — claim hoàn tác
  });

  it.each([
    ["inactive", "inactive"],
    ["exited", "exited"],
    ["registered", "registered"],
  ])("candidate %s → INVITE_INVALID, không membership (ops-controlled re-entry — A5)", async (_label, status) => {
    login(INVITEE);
    const candidate = seedCandidate(); // prospect
    const { token, tokenRow } = await issueInvite(candidate.id); // → invited
    candidate.status = status; // ép trạng thái (concurrent move / ops move)
    setInviteCookie(token);
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_INVALID");
    expect(dbState.memberships).toHaveLength(0);
    expect(tokenRow.consumedAt).toBeNull();
  });

  it("concurrent acceptance (23505 BetaCohortMembership_userId_cohort_key) → INVITE_INVALID, consumedAt KHÔNG persist (tx abort)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.fail.membershipCreate = new SqlQueryError("mock concurrent membership grant", {
      sqlState: "23505",
      constraint: "BetaCohortMembership_userId_cohort_key",
    });
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_INVALID");
    expect(dbState.memberships).toHaveLength(0);
    expect(tokenRow.consumedAt).toBeNull(); // Global Constraints — KHÔNG silent success
    expect(dbState.candidates[0]!.status).toBe("invited"); // link không persist
  });

  it("23505 constraint khác (FoundingSellerCandidate_userId_key) → INVITE_INVALID (byte-identical)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.fail.membershipCreate = new SqlQueryError("mock candidate link race", {
      sqlState: "23505",
      constraint: "FoundingSellerCandidate_userId_key",
    });
    const state = await acceptInviteAction({}, fd({}));
    expect(state.error).toBe("INVITE_INVALID");
  });

  it("lỗi driver KHÔNG phải 23505 → RETHROW (fail closed — 23503/plain Error không bao giờ thành INVITE_INVALID)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    dbState.fail.membershipCreate = new SqlQueryError("mock fk", {
      sqlState: "23503",
      constraint: "BetaCohortMembership_userId_fkey",
    });
    await expect(acceptInviteAction({}, fd({}))).rejects.toMatchObject({ sqlState: "23503" });
    expect(dbState.memberships).toHaveLength(0);

    // plain Error cũng rethrow
    dbState.fail.membershipCreate = new Error("boom");
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("boom");
  });
});

describe("acceptInviteAction — happy path + telemetry + funnel sync", () => {
  it("valid cookie + matching verified email → membership active + candidate registered + audit + cookie cleared + seller_registered + redirect /sell", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    setInviteCookie(token);

    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");

    // membership — spec §9 Gate "invite acceptance"
    expect(dbState.memberships).toHaveLength(1);
    const membership = dbState.memberships[0] as Row;
    expect(membership.userId).toBe(INVITEE.id);
    expect(membership.cohort).toBe("founding_seller");
    expect(membership.status).toBe("active");
    expect(membership.acceptedAt).not.toBeNull();
    expect(membership.invitedBy).toBe("admin-ops"); // issuer
    expect(membership.invitedAt).toBe(tokenRow.createdAt); // invitedAt từ token row

    // candidate link
    const candidateAfter = dbState.candidates[0] as Row;
    expect(candidateAfter.userId).toBe(INVITEE.id);
    expect(candidateAfter.status).toBe("registered");
    expect(candidateAfter.registeredAt).not.toBeNull();

    // token single-use
    expect(tokenRow.consumedAt).not.toBeNull();

    // audit trong cùng tx (Global Constraints)
    expect(dbState.audits.some((a) => a.action === "founding_seller.invite_accepted")).toBe(true);
    const acceptedAudit = dbState.audits.find((a) => a.action === "founding_seller.invite_accepted")!;
    expect(acceptedAudit.actorId).toBe(INVITEE.id);
    expect(acceptedAudit.subjectId).toBe(INVITEE.id);
    expect(acceptedAudit.resourceType).toBe("BetaInviteToken");
    expect(acceptedAudit.resourceId).toBe(tokenRow.id);

    // cookie cleared — delete phải mang CÙNG path cookie được set
    // (corrections #35: delete(name) mặc định Path=/ — RFC 6265 coi đó là
    // cookie khác, không clear được cookie Path=/invite của route handler)
    expect(cookieState.store.has(BETA_INVITE_COOKIE)).toBe(false);
    expect(cookieState.deletes).toEqual([
      { name: BETA_INVITE_COOKIE, path: BETA_INVITE_COOKIE_PATH },
    ]);

    // telemetry: seller_registered (actor = user, sessionId THÔ — corrections #26)
    const registeredCalls = emitSpy.mock.calls.filter((c) => c[0].name === "seller_registered");
    expect(registeredCalls).toHaveLength(1);
    expect(registeredCalls[0]![0].actorId).toBe(INVITEE.id);
    expect(registeredCalls[0]![0].sessionId).toBe("sess-user-invitee");
    expect(registeredCalls[0]![0].provinceCode).toBe("ha-noi");
    expect(dbState.events.filter((r) => r.name === "seller_registered")).toHaveLength(1);
    // beta_membership_activated — activated=true path
    expect(dbState.events.filter((r) => r.name === "beta_membership_activated")).toHaveLength(1);
    // emission SAU commit
    expect(dbState.txCommittedAtEmit).toBe(true);

    // notify kind "cohort" — neutral copy, KHÔNG contact
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const notifyArgs = notifySpy.mock.calls[0]!;
    expect(notifyArgs[0]).toBe(INVITEE.id);
    expect(notifyArgs[1]).toBe("cohort");
    expect(JSON.stringify(notifyArgs)).not.toContain("seller.moi@loaviet.test");
    expect(dbState.notifications).toHaveLength(1);

    // funnel sync chạy SAU commit (corrections #22) — candidate registered,
    // không có SellerVerification → không đổi gì (idempotent)
    expect(dbState.candidates[0]!.status).toBe("registered");
  });

  it("funnel sync sau acceptance bắt kịp verification đã có TRƯỚC (registered → verification_pending)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    // SellerVerification tồn tại TRƯỚC acceptance (user gửi hồ sơ trước khi nhận lời mời)
    dbState.verifications.push({
      id: "sv-pre",
      userId: INVITEE.id,
      status: "pending",
      method: "operations_review",
      policyVersion: "v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");
    // sync chạy sau link: registered → verification_pending (ground truth)
    expect(dbState.candidates[0]!.status).toBe("verification_pending");
  });

  it("notify lỗi db → action VẪN thành công + captureError MÃ CHUỖI (corrections #25 — KHÔNG error object)", async () => {
    login(INVITEE);
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    setInviteCookie(token);
    const notifyError = new SqlQueryError("mock notify db down", { sqlState: "08006" });
    notifySpy.mockRejectedValueOnce(notifyError);
    await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");
    expect(dbState.memberships).toHaveLength(1); // membership vẫn commit
    expect(captureErrorMock).toHaveBeenCalledWith("cohort", "COHORT_NOTIFY_FAILED", {
      sqlState: "08006",
    });
    // KHÔNG error object trong payload (§4.8 — error.message có thể chứa dữ liệu)
    const payload = JSON.stringify(captureErrorMock.mock.calls[0]![2]);
    expect(payload).not.toContain("mock notify db down");
  });
});

// ─── 5. Token secrecy end-to-end (Review Focus 1) ─────────────────────────────

describe("token secrecy end-to-end — KHÔNG token thô ở bất kỳ đâu", () => {
  it("sau full flow, không row BetaInviteToken nào chứa token thô; không log/audit/telemetry nào chứa token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      login(ADMIN_OPS, { isAdmin: true });
      const candidate = seedCandidate();
      const { token } = await issueInvite(candidate.id);
      cookieState.store.clear();
      login(INVITEE);
      setInviteCookie(token);
      await expect(acceptInviteAction({}, fd({}))).rejects.toThrow("NEXT_REDIRECT:/sell");

      // mọi row token — không giá trị nào bằng token thô
      for (const row of dbState.tokens) {
        for (const value of Object.values(row)) {
          expect(value).not.toBe(token);
        }
      }
      // audit + telemetry + notification — không chứa token
      expect(JSON.stringify(dbState.audits)).not.toContain(token);
      expect(JSON.stringify(dbState.events)).not.toContain(token);
      expect(JSON.stringify(dbState.notifications)).not.toContain(token);
      // console + captureError — không chứa token
      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(token);
      }
      for (const call of captureErrorMock.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(token);
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ─── 6. Landing route handler — app/invite/[token]/route.ts (corrections #7/#13) ──

describe("GET /invite/[token] — landing route handler", () => {
  const mkRequest = (token: string) =>
    new Request(`https://beta.loaviet.test/invite/${encodeURIComponent(token)}`, { method: "GET" });
  const mkCtx = (token: string) => ({ params: Promise.resolve({ token }) });
  const cookiesOf = (res: Response) =>
    (res as unknown as {
      cookies: { get(name: string): { name: string; value: string } | undefined };
    }).cookies;

  it("token hợp lệ → 303 /invite + Set-Cookie sp_invite (httpOnly, path /invite, maxAge 900) + Referrer-Policy no-referrer; KHÔNG side effect trên token row", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    const res = await inviteLandingRoute.GET(mkRequest(token), mkCtx(token));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/invite");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = cookiesOf(res).get(BETA_INVITE_COOKIE);
    expect(cookie?.value).toBe(token);
    const setCookie = res.headers.getSetCookie().join("; ");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/invite");
    expect(setCookie).toContain("Max-Age=900");
    expect(setCookie.toLowerCase()).toContain("samesite=lax"); // Next serialize lowercase
    // KHÔNG side effect — bots unfurl GET link này (corrections #7)
    expect(tokenRow.consumedAt).toBeNull();
    expect(tokenRow.revokedAt).toBeNull();
    expect(dbState.audits.every((a) => a.action !== "founding_seller.invite_accepted")).toBe(true);
  });

  it("token garbage (không 43-char base64url) → 303 /invite KHÔNG cookie, ZERO db call", async () => {
    dbState.calls.length = 0;
    const garbage = "../../traversal";
    const res = await inviteLandingRoute.GET(mkRequest(garbage), mkCtx(garbage));
    expect(res.status).toBe(303);
    expect(cookiesOf(res).get(BETA_INVITE_COOKIE)).toBeUndefined();
    expect(dbState.calls).toHaveLength(0);
  });

  it("token unknown / expired / revoked / consumed → 303 /invite KHÔNG cookie (thông báo chung)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    // unknown
    const unknown = await inviteLandingRoute.GET(mkRequest("A".repeat(43)), mkCtx("A".repeat(43)));
    expect(unknown.status).toBe(303);
    expect(cookiesOf(unknown).get(BETA_INVITE_COOKIE)).toBeUndefined();

    // expired
    const candidate = seedCandidate();
    const { token, tokenRow } = await issueInvite(candidate.id);
    tokenRow.expiresAt = new Date(Date.now() - 1_000).toISOString();
    const expired = await inviteLandingRoute.GET(mkRequest(token), mkCtx(token));
    expect(expired.status).toBe(303);
    expect(cookiesOf(expired).get(BETA_INVITE_COOKIE)).toBeUndefined();

    // revoked
    tokenRow.revokedAt = new Date().toISOString();
    const revoked = await inviteLandingRoute.GET(mkRequest(token), mkCtx(token));
    expect(cookiesOf(revoked).get(BETA_INVITE_COOKIE)).toBeUndefined();

    // consumed
    tokenRow.revokedAt = null;
    tokenRow.consumedAt = new Date().toISOString();
    const consumed = await inviteLandingRoute.GET(mkRequest(token), mkCtx(token));
    expect(cookiesOf(consumed).get(BETA_INVITE_COOKIE)).toBeUndefined();
  });

  it("rate limit invite-landing — GET thứ 31 trong 10 phút → 429 (corrections #13 — oracle không giới hạn là lỗi)", async () => {
    const token = "B".repeat(43);
    for (let i = 0; i < 30; i++) {
      const res = await inviteLandingRoute.GET(mkRequest(token), mkCtx(token));
      expect(res.status).toBe(303); // garbage shape — vẫn qua rate limit bucket
    }
    const res31 = await inviteLandingRoute.GET(mkRequest(token), mkCtx(token));
    expect(res31.status).toBe(429);
    expect(res31.headers.get("retry-after")).not.toBeNull();
  });
});

// ─── 7. /invite page (S1) ─────────────────────────────────────────────────────

describe("app/invite/page.tsx — tokenless invitation page", () => {
  it("không cookie → thông báo chung 'Lời mời không còn hiệu lực', KHÔNG form", async () => {
    const tree = await invitePage.default();
    expect(collectStrings(tree).join(" ")).toContain("Lời mời không còn hiệu lực");
    expect(findElementOfType(tree, InviteAcceptForm)).toBeNull();
  });

  it("cookie hợp lệ + đã đăng nhập → render InviteAcceptForm", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    cookieState.store.clear();
    login(INVITEE);
    setInviteCookie(token);
    const tree = await invitePage.default();
    expect(findElementOfType(tree, InviteAcceptForm)).not.toBeNull();
  });

  it("cookie hợp lệ + chưa đăng nhập → CTA /login?next=/invite TOKENLESS, KHÔNG form", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    cookieState.store.clear(); // bỏ session cookie — chỉ còn invite cookie
    setInviteCookie(token);
    const tree = await invitePage.default();
    expect(findElementOfType(tree, InviteAcceptForm)).toBeNull();
    expect(collectStrings(tree).join(" ")).toContain("/login?next=/invite");
  });

  it("page KHÔNG render token thô hay contact reference (§4.8)", async () => {
    login(ADMIN_OPS, { isAdmin: true });
    const candidate = seedCandidate();
    const { token } = await issueInvite(candidate.id);
    cookieState.store.clear();
    login(INVITEE);
    setInviteCookie(token);
    const tree = await invitePage.default();
    const strings = collectStrings(tree).join(" ");
    expect(strings).not.toContain(token);
    expect(strings).not.toContain("seller.moi@loaviet.test");
  });
});

// ─── 8. Source contracts (Review Focus 1 — no token leak paths) ───────────────

describe("source contracts — token secrecy + cookie flow + no-referrer", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

  it("action file: không export const (Next 16 E352), không console.* — token không vào log/audit/telemetry", () => {
    const src = read("src/lib/actions/founding-sellers.ts");
    expect(/^export const /m.test(src)).toBe(false); // chỉ async function + type
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)/);
    // mọi dòng nhắc token không được là call site log/audit/telemetry
    for (const line of src.split("\n")) {
      if (/token/i.test(line)) {
        expect(/console\.|captureError\(|captureEvent\(|auditEvent(Tx)?\(|emitProductEvent\(/.test(line)).toBe(false);
      }
    }
  });

  it("next.config.ts: /invite/:token có Referrer-Policy no-referrer; /uploads block giữ nguyên; KHÔNG /invite/:path*", () => {
    const src = read("next.config.ts");
    expect(src).toContain('source: "/invite/:token"');
    expect(src).toContain("Referrer-Policy");
    expect(src).toContain("no-referrer");
    expect(src).not.toContain('source: "/invite/:path*"'); // corrections #8 — :path* match cả /invite, phá CSRF
    expect(src).toContain('source: "/uploads/:path*"');
    expect(src).toContain("X-Content-Type-Options");
    expect(src).toContain("default-src 'none'; sandbox");
  });

  it("accept form: KHÔNG hidden input token — action đọc cookie (S1)", () => {
    const src = read("src/components/invite-accept-form.tsx");
    expect(src).not.toMatch(/name=["']token["']/); // không hidden input token
    expect(src).not.toMatch(/cookies\(|next\/headers/); // client KHÔNG đọc cookie trực tiếp
  });

  it("route handler: KHÔNG side effect ngoài cookie (không consume/log/audit)", () => {
    const src = read("app/invite/[token]/route.ts");
    expect(src).not.toContain("consumedAt: ");
    expect(src).not.toContain("revokedAt: ");
    expect(src).not.toMatch(/console\.(log|error|warn)/);
    expect(src).not.toContain("auditEvent");
    expect(src).not.toContain("emitProductEvent");
  });
});
