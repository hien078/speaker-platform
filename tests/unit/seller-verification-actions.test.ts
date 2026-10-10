/**
 * SellerVerification workflow actions (plan Task 10 — spec §5.3.2/§5.3.3,
 * §4.5, §4.6, §7.3) — unit tests.
 *
 * Hợp đồng (plan Task 10 Step 1 + Review Focus 4/5):
 *  1. submitSellerVerificationAction: thiếu prerequisite → error LIỆT KÊ
 *     chúng, KHÔNG tạo row; đủ (trừ operations_review_verified) → row
 *     status=pending + PolicyAcceptance(seller_rules, v1) CÙNG tx + audit
 *     "seller_verification.submitted".
 *  2. declareSellerProfileAction: khai báo seller type + mã tỉnh (FD-1 —
 *     validate theo registry 34 đơn vị) + audit "seller_profile.declared".
 *  3. reviewSellerVerificationAction: operations_admin + mã step-up →
 *     status=verified + audit "seller_verification.reviewed" (reasonCode +
 *     policyVersion) + notify seller (copy §6.2 trung tính).
 *  4. (Review Focus 4) moderator/support KHÔNG có seller.verify → FORBIDDEN,
 *     không mutation, không audit.
 *  5. decision=revoked đòi capability seller.verification.revoke —
 *     operations_admin có, moderator KHÔNG.
 *  6. (Review Focus 5) quyết định THỨ HAI trên row đã được review →
 *     VERIFICATION_ALREADY_REVIEWED (atomic claim theo status).
 *  7. Step-up cũ/không kèm totpCode → STEP_UP_REQUIRED, không mutation.
 *
 * Cơ chế mock như admin-session-actions.test.ts: server-only + next/cache +
 * next/navigation (redirect throw) + next/headers (headers/cookies điều khiển
 * được) + db.client in-memory (User/UserSession(include user)/SellerVerification/
 * PolicyAcceptance/BetaCohortMembership/AuditEvent/Notification/AdminMfa/
 * AdminRecoveryCode). session.ts/rbac.ts/admin-mfa.ts/totp.ts/audit-event.ts/
 * seller-verification-policy.ts GIỮ BẢN THẬT — login qua COOKIE THẬT, guards
 * chạy đúng code production; policy đọc FRESH từ store mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
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

// ─── db.client mock — in-memory 8 model ───────────────────────────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  verifications: [] as Array<Record<string, unknown>>,
  acceptances: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  mfas: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
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
          // IN ở cấp FIELD — đúng signature thật: .where((v) => v.status.in([...]))
          in: (values: readonly unknown[]) => Array.isArray(values) && values.includes(row[field]),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[], defaults?: () => Row, attach?: (row: Row) => void) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
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
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
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
    SellerVerification: makeModel(dbState.verifications, () => ({
      id: `sv-${dbState.verifications.length + 1}`,
      method: "operations_review",
      submittedAt: null,
      reviewedAt: null,
      reviewerId: null,
      reasonCode: null,
      note: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    PolicyAcceptance: makeModel(dbState.acceptances, () => ({
      id: `pa-${dbState.acceptances.length + 1}`,
      acceptedAt: new Date().toISOString(),
    })),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      id: `bcm-${dbState.memberships.length + 1}`,
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    AuditEvent: makeModel(dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
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
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── Imports (SAU mock) ───────────────────────────────────────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { resetTotpReplayProtection, enrollAdminMfa } from "@/src/lib/admin-mfa";
import { hotpCode } from "@/src/lib/totp";
import { SESSION_COOKIE } from "@/src/lib/session";
import {
  declareSellerProfileAction,
  submitSellerVerificationAction,
  reviewSellerVerificationAction,
} from "@/src/lib/actions/seller-verification";

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

/** Seller ĐỦ 6 prerequisite (trừ operations_review_verified). */
const SELLER = mkUser({
  id: "seller-1",
  email: "seller@loaviet.test",
  name: "Seller",
  role: "seller",
  emailVerifiedAt: "2026-10-01T00:00:00.000Z",
  phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
  sellerType: "individual",
  sellerOperatingProvinceCode: "ha-noi",
});

/** Nạp seller + membership founding_seller active (prerequisite của submit). */
const seedSeller = (over?: Partial<Row>): Row & { id: string } => {
  const row = { ...SELLER, ...over };
  dbState.users.push(row);
  dbState.memberships.push({
    id: `bcm-${dbState.memberships.length + 1}`,
    userId: row.id,
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
  return row;
};

/** SellerVerification row trực tiếp (mô phỏng đã submit). */
const seedVerification = (status: string, over?: Partial<Row>): Row => {
  const row: Row = {
    id: `sv-${dbState.verifications.length + 1}`,
    userId: SELLER.id,
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
    ...over,
  };
  dbState.verifications.push(row);
  return row;
};

/** Login THẬT qua cookie — session.ts đọc cookie store, hash, tra row. */
const login = (user: Row, opts?: { sessionId?: string; isAdmin?: boolean; steppedUpAt?: string }): string => {
  const id = opts?.sessionId ?? `sess-${user.id}`;
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

/** Session admin MFA + step-up TƯƠI (≤15 phút) — không cần totpCode. */
const STEPPED_UP = () => new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.verifications.length = 0;
  dbState.acceptances.length = 0;
  dbState.memberships.length = 0;
  dbState.audits.length = 0;
  dbState.notifications.length = 0;
  dbState.mfas.length = 0;
  dbState.codes.length = 0;
  dbState.users.push({ ...ADMIN_SUPER }, { ...ADMIN_OPS }, { ...ADMIN_MOD }, { ...ADMIN_SUPPORT });
  cookieState.store.clear();
  headerState.headers = new Headers();
  enrolled = null;
  resetRateLimits();
  resetTotpReplayProtection();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. declareSellerProfileAction ───────────────────────────────────────────

describe("declareSellerProfileAction — khai báo seller type + mã tỉnh (FD-1)", () => {
  it("khai báo hợp lệ → update User + audit 'seller_profile.declared'", async () => {
    const seller = seedSeller({ sellerType: null, sellerOperatingProvinceCode: null });
    login(seller);

    const state = await declareSellerProfileAction(
      {},
      fd({ sellerType: "business", operatingProvinceCode: "ho-chi-minh" }),
    );

    expect(state.error).toBeUndefined();
    const row = dbState.users.find((u) => u.id === seller.id)!;
    expect(row.sellerType).toBe("business");
    expect(row.sellerOperatingProvinceCode).toBe("ho-chi-minh");
    const evt = dbState.audits.find((r) => r.action === "seller_profile.declared");
    expect(evt).toMatchObject({
      actorId: seller.id,
      subjectId: seller.id,
      resourceType: "User",
      resourceId: seller.id,
    });
    // KHÔNG PII trong detail (spec §4.8) — chỉ typed values
    expect(JSON.stringify(evt)).not.toContain("seller@loaviet.test");
  });

  it("mã tỉnh ngoài registry 34 đơn vị (63 tỉnh cũ) → error, không update", async () => {
    const seller = seedSeller({ sellerType: null, sellerOperatingProvinceCode: null });
    login(seller);

    const state = await declareSellerProfileAction(
      {},
      fd({ sellerType: "individual", operatingProvinceCode: "Thừa Thiên Huế" }),
    );

    expect(state.error).toBeTruthy();
    const row = dbState.users.find((u) => u.id === seller.id)!;
    expect(row.sellerOperatingProvinceCode).toBeNull();
    expect(dbState.audits.filter((r) => r.action === "seller_profile.declared")).toHaveLength(0);
  });

  it("sellerType sai enum → error, không update", async () => {
    const seller = seedSeller({ sellerType: null, sellerOperatingProvinceCode: null });
    login(seller);

    const state = await declareSellerProfileAction(
      {},
      fd({ sellerType: "enterprise", operatingProvinceCode: "ha-noi" }),
    );

    expect(state.error).toBeTruthy();
    expect(dbState.users.find((u) => u.id === seller.id)!.sellerType).toBeNull();
  });

  it("chưa đăng nhập → NEXT_REDIRECT (requireUser), không đụng db", async () => {
    cookieState.store.clear();

    await expect(
      declareSellerProfileAction({}, fd({ sellerType: "individual", operatingProvinceCode: "ha-noi" })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(dbState.audits).toHaveLength(0);
  });

  // ─── Review fix M2 — khai báo đổi sau khi verified ─────────────────────────

  it("(M2) khai báo KHÔNG đổi → no-op: không update, không đụng verification, không audit", async () => {
    const seller = seedSeller({ sellerType: "individual", sellerOperatingProvinceCode: "ha-noi" });
    const row = seedVerification("verified", { reasonCode: "requirements_met" });
    login(seller);
    const auditsBefore = dbState.audits.length;

    const state = await declareSellerProfileAction(
      {},
      fd({ sellerType: "individual", operatingProvinceCode: "ha-noi" }),
    );

    expect(state.error).toBeUndefined();
    expect(row.status).toBe("verified"); // KHÔNG bị chuyển needs_review
    expect(dbState.audits).toHaveLength(auditsBefore); // không audit mới
  });

  it("(M2) đổi sellerType khi đang verified → verification chuyển needs_review (CAS) + audit + notify", async () => {
    const seller = seedSeller({ sellerType: "individual", sellerOperatingProvinceCode: "ha-noi" });
    const row = seedVerification("verified", { reasonCode: "requirements_met", reviewedAt: "2026-10-01T00:00:00.000Z" });
    login(seller);

    const state = await declareSellerProfileAction(
      {},
      fd({ sellerType: "business", operatingProvinceCode: "ha-noi" }),
    );

    expect(state.error).toBeUndefined();
    expect(dbState.users.find((u) => u.id === seller.id)!.sellerType).toBe("business");
    // verification: verified → needs_review (fail closed — gate chặn tới khi ops quyết lại)
    expect(row.status).toBe("needs_review");
    expect(row.reasonCode).toBe("identity_information_inconsistent");
    const evt = dbState.audits.find((r) => r.action === "seller_verification.declaration_changed");
    expect(evt).toMatchObject({
      actorId: seller.id,
      subjectId: seller.id,
      resourceType: "SellerVerification",
      resourceId: row.id,
      reason: "identity_information_inconsistent",
      policyVersion: "v1",
    });
    // seller được báo (notify) — không bị bỏ mặc trong bóng tối
    const notif = dbState.notifications.find((r) => r.userId === seller.id);
    expect(notif).toBeTruthy();
    expect(notif!.link).toBe("/sell/verification");
  });

  it("(M2) đổi mã tỉnh khi đang verified → cũng chuyển needs_review", async () => {
    const seller = seedSeller({ sellerType: "individual", sellerOperatingProvinceCode: "ha-noi" });
    const row = seedVerification("verified", { reasonCode: "requirements_met" });
    login(seller);

    await declareSellerProfileAction(
      {},
      fd({ sellerType: "individual", operatingProvinceCode: "da-nang" }),
    );

    expect(row.status).toBe("needs_review");
  });

  it("(M2) đổi khai báo khi CHƯA verified → verification không bị đụng (không có gì để invalidate)", async () => {
    const seller = seedSeller({ sellerType: "individual", sellerOperatingProvinceCode: "ha-noi" });
    const row = seedVerification("pending");
    login(seller);

    await declareSellerProfileAction(
      {},
      fd({ sellerType: "business", operatingProvinceCode: "ho-chi-minh" }),
    );

    expect(row.status).toBe("pending"); // pending không phải verified — không chuyển
  });

  it("(M2) gate CHẶN ngay sau khi khai báo đổi (fail closed — needs_review ≠ verified)", async () => {
    // dùng policy thật: sau khi declare đổi + verification needs_review →
    // checkSellerPublicationRequirements thiếu operations_review_verified
    const { checkSellerPublicationRequirements } = await import("@/src/lib/seller-verification-policy");
    const seller = seedSeller({
      sellerType: "individual",
      sellerOperatingProvinceCode: "ha-noi",
      emailVerifiedAt: "2026-10-01T00:00:00.000Z",
      phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
    });
    dbState.acceptances.push({
      id: `pa-${dbState.acceptances.length + 1}`,
      userId: seller.id,
      policyKey: "seller_rules",
      policyVersion: "v1",
      acceptedAt: new Date().toISOString(),
    });
    seedVerification("verified", { reasonCode: "requirements_met" });
    login(seller);

    // trước khi đổi: đủ cả 7
    const before = await checkSellerPublicationRequirements(seller.id);
    expect(before.ok).toBe(true);

    await declareSellerProfileAction(
      {},
      fd({ sellerType: "business", operatingProvinceCode: "ha-noi" }),
    );

    // sau khi đổi: gate chặn (operations_review_verified thiếu)
    const after = await checkSellerPublicationRequirements(seller.id);
    expect(after.ok).toBe(false);
    expect(after.missing).toEqual(["operations_review_verified"]);
  });
});

// ─── 2. submitSellerVerificationAction ───────────────────────────────────────

describe("submitSellerVerificationAction — gửi hồ sơ (spec §5.3.2)", () => {
  it("thiếu prerequisite → error LIỆT KÊ chúng, KHÔNG tạo row, KHÔNG ghi nhận rules", async () => {
    const seller = seedSeller({ emailVerifiedAt: null, sellerType: null });
    login(seller);

    const state = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("email"); // liệt kê yêu cầu thiếu
    expect(dbState.verifications).toHaveLength(0);
    expect(dbState.acceptances).toHaveLength(0);
    expect(dbState.audits.filter((r) => r.action === "seller_verification.submitted")).toHaveLength(0);
  });

  it("chưa tick đồng ý Seller Rules → error, không row", async () => {
    const seller = seedSeller();
    login(seller);

    const state = await submitSellerVerificationAction({}, new FormData());

    expect(state.error).toBeTruthy();
    expect(dbState.verifications).toHaveLength(0);
    expect(dbState.acceptances).toHaveLength(0);
  });

  it("đủ prerequisite → row status=pending + PolicyAcceptance(seller_rules,v1) + audit", async () => {
    const seller = seedSeller();
    login(seller);

    const state = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));

    expect(state.error).toBeUndefined();
    expect(dbState.verifications).toHaveLength(1);
    const row = dbState.verifications[0]!;
    expect(row).toMatchObject({
      userId: seller.id,
      status: "pending",
      method: "operations_review",
      policyVersion: "v1",
    });
    expect(row.submittedAt).not.toBeNull();
    expect(dbState.acceptances).toHaveLength(1);
    expect(dbState.acceptances[0]).toMatchObject({
      userId: seller.id,
      policyKey: "seller_rules",
      policyVersion: "v1",
    });
    const evt = dbState.audits.find((r) => r.action === "seller_verification.submitted");
    expect(evt).toMatchObject({
      actorId: seller.id,
      subjectId: seller.id,
      policyVersion: "v1",
      resourceType: "SellerVerification",
    });
  });

  it("idempotent: submit lại khi đang pending → không tạo row thứ hai", async () => {
    const seller = seedSeller();
    login(seller);

    await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));
    await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));

    expect(dbState.verifications).toHaveLength(1);
    expect(dbState.acceptances).toHaveLength(1); // unique(userId, key, version)
  });

  it("từ rejected/needs_review/revoked → submit lại chuyển về pending (CAS theo status đã đọc)", async () => {
    const seller = seedSeller();
    login(seller);
    const row = seedVerification("rejected", { reasonCode: "duplicate_account_risk" });

    const state = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));

    expect(state.error).toBeUndefined();
    expect(dbState.verifications).toHaveLength(1);
    expect(row.status).toBe("pending");
    expect(row.submittedAt).not.toBeNull();
    expect(row.reasonCode).toBeNull(); // quyết định cũ thuộc về AuditEvent history
  });

  it("đã verified → submit là no-op thân thiện, không reset gì", async () => {
    const seller = seedSeller();
    login(seller);
    const row = seedVerification("verified", { reviewedAt: "2026-10-01T00:00:00.000Z", reasonCode: "requirements_met" });

    const state = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));

    expect(state.error).toBeUndefined();
    expect(row.status).toBe("verified"); // KHÔNG bị đá về pending
    expect(row.reasonCode).toBe("requirements_met");
  });
});

// ─── 3. reviewSellerVerificationAction — quyết định của operations ────────────

describe("reviewSellerVerificationAction — quyết định (spec §5.3.3)", () => {
  it("operations_admin + mã step-up → status=verified + audit reasonCode/policyVersion + notify §6.2", async () => {
    const seller = seedSeller();
    seedVerification("pending");
    enrolled = await enrollAdminMfa(ADMIN_OPS.id);
    login(ADMIN_OPS, { isAdmin: true }); // chưa step-up — dùng totpCode

    await reviewSellerVerificationAction(
      fd({
        userId: seller.id,
        decision: "verified",
        reasonCode: "requirements_met",
        note: "Đủ yêu cầu v1",
        totpCode: currentTotp(),
      }),
    );

    const row = dbState.verifications[0]!;
    expect(row.status).toBe("verified");
    expect(row.reviewerId).toBe(ADMIN_OPS.id);
    expect(row.reviewedAt).not.toBeNull();
    expect(row.reasonCode).toBe("requirements_met");
    expect(row.policyVersion).toBe("v1");
    const evt = dbState.audits.find((r) => r.action === "seller_verification.reviewed");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: seller.id,
      reason: "requirements_met",
      policyVersion: "v1",
      resourceType: "SellerVerification",
    });
    // notify seller — copy trung tính §6.2, KHÔNG bảo đảm
    const notif = dbState.notifications.find((r) => r.userId === seller.id);
    expect(notif).toBeTruthy();
    expect(JSON.stringify(notif)).not.toMatch(/bảo đảm|đảm bảo|bảo vệ/i);
  });

  it("step-up TƯƠI (≤15 phút) → qua không cần totpCode", async () => {
    const seller = seedSeller();
    seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: seller.id, decision: "needs_review", reasonCode: "business_claim_needs_evidence" }),
    );

    expect(dbState.verifications[0]!.status).toBe("needs_review");
  });

  it("(Review Focus 4) moderator → FORBIDDEN, không mutation, không audit", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_MOD, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("FORBIDDEN");

    expect(row.status).toBe("pending");
    expect(dbState.audits.filter((r) => r.action === "seller_verification.reviewed")).toHaveLength(0);
  });

  it("(Review Focus 4) support → FORBIDDEN", async () => {
    const seller = seedSeller();
    seedVerification("pending");
    login(ADMIN_SUPPORT, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
  });

  it("decision=revoked đòi seller.verification.revoke — operations_admin CÓ", async () => {
    const seller = seedSeller();
    const row = seedVerification("verified", { reasonCode: "requirements_met" });
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: seller.id, decision: "revoked", reasonCode: "abuse_case_unresolved" }),
    );

    expect(row.status).toBe("revoked");
    expect(row.reasonCode).toBe("abuse_case_unresolved");
  });

  it("decision=revoked — moderator KHÔNG có seller.verification.revoke → FORBIDDEN, row giữ nguyên", async () => {
    const seller = seedSeller();
    const row = seedVerification("verified", { reasonCode: "requirements_met" });
    login(ADMIN_MOD, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "revoked", reasonCode: "abuse_case_unresolved" }),
      ),
    ).rejects.toThrow("FORBIDDEN");

    expect(row.status).toBe("verified");
  });

  it("(Review Focus 5) quyết định THỨ HAI trên row đã review → VERIFICATION_ALREADY_REVIEWED", async () => {
    const seller = seedSeller();
    seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    // quyết định thứ nhất claim pending → verified
    await reviewSellerVerificationAction(
      fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
    );
    expect(dbState.verifications[0]!.status).toBe("verified");

    // quyết định thứ hai (đồng thời/sau đó) — row không còn pending → typed error
    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("VERIFICATION_ALREADY_REVIEWED");

    // row KHÔNG bị quyết định thứ hai ghi đè (reviewer/reason giữ của lần đầu)
    expect(dbState.verifications[0]!).toMatchObject({
      status: "verified",
      reasonCode: "requirements_met",
      reviewerId: ADMIN_OPS.id,
    });
  });

  it("review trên row KHÔNG tồn tại → VERIFICATION_ALREADY_REVIEWED (0 row claim)", async () => {
    const seller = seedSeller();
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("VERIFICATION_ALREADY_REVIEWED");
  });

  it("revoke trên row CHƯA verified (đang pending) → VERIFICATION_ALREADY_REVIEWED (chỉ verified→revoked)", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "revoked", reasonCode: "abuse_case_unresolved" }),
      ),
    ).rejects.toThrow("VERIFICATION_ALREADY_REVIEWED");

    expect(row.status).toBe("pending");
  });

  it("step-up cũ + KHÔNG totpCode → STEP_UP_REQUIRED, không mutation (admin step-up gate)", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true }); // chưa từng step-up

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("STEP_UP_REQUIRED");

    expect(row.status).toBe("pending");
    expect(dbState.audits.filter((r) => r.action === "seller_verification.reviewed")).toHaveLength(0);
  });

  it("decision/reasonCode ngoài enum → error validation, không mutation", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "super_verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow();

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "vì anh ấy dễ thương" }),
      ),
    ).rejects.toThrow();

    expect(row.status).toBe("pending");
  });

  it("session adminRole nhưng session CHƯA qua MFA (isAdmin=false) → FORBIDDEN (review fix #1)", async () => {
    const seller = seedSeller();
    seedVerification("pending");
    login(ADMIN_OPS); // isAdmin: false — consumer session

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
  });
});

// ─── 3b. Review fix M1 — needs_review không còn ngõ chết ─────────────────────

describe("reviewSellerVerificationAction — needs_review có đường ra (M1)", () => {
  it("quyết định CUỐI (verified) claim từ row needs_review", async () => {
    const seller = seedSeller();
    const row = seedVerification("needs_review", { reasonCode: "business_claim_needs_evidence" });
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: seller.id, decision: "verified", reasonCode: "requirements_met" }),
    );

    expect(row.status).toBe("verified");
    expect(row.reasonCode).toBe("requirements_met");
  });

  it("quyết định CUỐI (rejected) claim từ row needs_review", async () => {
    const seller = seedSeller();
    const row = seedVerification("needs_review");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: seller.id, decision: "rejected", reasonCode: "duplicate_account_risk" }),
    );

    expect(row.status).toBe("rejected");
  });

  it("decision=needs_review CHỈ claim từ pending (đánh dấu lại needs_review → ALREADY_REVIEWED)", async () => {
    const seller = seedSeller();
    const row = seedVerification("needs_review");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "needs_review", reasonCode: "manual_risk_review" }),
      ),
    ).rejects.toThrow("VERIFICATION_ALREADY_REVIEWED");

    expect(row.status).toBe("needs_review"); // giữ nguyên
  });

  it("revoked vẫn CHỈ claim từ verified (không phải từ needs_review)", async () => {
    const seller = seedSeller();
    const row = seedVerification("needs_review");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "revoked", reasonCode: "abuse_case_unresolved" }),
      ),
    ).rejects.toThrow("VERIFICATION_ALREADY_REVIEWED");

    expect(row.status).toBe("needs_review");
  });
});

// ─── 3c. Review fix M3 — tự duyệt / tự cấp ────────────────────────────────────

describe("reviewSellerVerificationAction — SELF-REVIEW bị chặn (M3)", () => {
  it("admin duyệt CHÍNH MÌNH → SELF_REVIEW_FORBIDDEN, không mutation, không audit", async () => {
    // admin-ops cũng là một seller có hồ sơ pending
    const opsAsSeller = mkUser({
      id: "admin-ops",
      email: "ops@loaviet.test",
      name: "Ops",
      role: "admin",
      adminRole: "operations_admin",
      emailVerifiedAt: "2026-10-01T00:00:00.000Z",
      phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
      sellerType: "individual",
      sellerOperatingProvinceCode: "ha-noi",
    });
    dbState.users.length = 0;
    dbState.users.push(opsAsSeller);
    const row = seedVerification("pending");
    dbState.memberships.length = 0;
    login(opsAsSeller, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: "admin-ops", decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("SELF_REVIEW_FORBIDDEN");

    expect(row.status).toBe("pending");
    expect(dbState.audits.filter((r) => r.action === "seller_verification.reviewed")).toHaveLength(0);
  });
});

// ─── 3d. Review fix L2 — reason code tương thích quyết định ───────────────────

describe("reviewSellerVerificationAction — reason code map (L2, PROVISIONAL)", () => {
  it("migrated_legacy_verified bị từ chối khỏi MỌI quyết định người (chỉ backfill dùng)", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "migrated_legacy_verified" }),
      ),
    ).rejects.toThrow("REASON_CODE_INCOMPATIBLE");

    expect(row.status).toBe("pending"); // không mutation
  });

  it("verified + duplicate_account_risk → REASON_CODE_INCOMPATIBLE (cặp vô nghĩa)", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "verified", reasonCode: "duplicate_account_risk" }),
      ),
    ).rejects.toThrow("REASON_CODE_INCOMPATIBLE");

    expect(row.status).toBe("pending");
  });

  it("rejected + requirements_met → REASON_CODE_INCOMPATIBLE (requirements_met chỉ dành verified)", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller.id, decision: "rejected", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("REASON_CODE_INCOMPATIBLE");

    expect(row.status).toBe("pending");
  });

  it("cặp HỢP LỆ theo map vẫn pass (needs_review + business_claim_needs_evidence)", async () => {
    const seller = seedSeller();
    const row = seedVerification("pending");
    login(ADMIN_OPS, { isAdmin: true, steppedUpAt: STEPPED_UP() });

    await reviewSellerVerificationAction(
      fd({ userId: seller.id, decision: "needs_review", reasonCode: "business_claim_needs_evidence" }),
    );

    expect(row.status).toBe("needs_review");
    expect(row.reasonCode).toBe("business_claim_needs_evidence");
  });
});
