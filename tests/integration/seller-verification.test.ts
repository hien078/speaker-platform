/**
 * SellerVerification workflow — integration tests (plan Task 10, spec §5.3.2/
 * §5.3.3/§8.2/§8.6) — chạy trên scratch DB (scripts/test-integration.sh).
 * KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/seller-verification-*.test.ts, publication-gate,
 * beta-cohort) chứng minh logic với db mock; ở đây chứng minh CÙNG hợp đồng
 * against DB THẬT với module THẬT (session, rbac step-up, policy gate,
 * audit, notify):
 *
 *  1. Backfill script (spec §8.2/§8.6): dry-run báo cáo ứng viên; --apply tạo
 *     row migrated_legacy_verified; chạy lại --apply idempotent (0 row mới);
 *     AuditEvent "seller_verification.backfill" (actor null) được ghi.
 *  2. Full happy path: seed user → verify email/phone (timestamps) → declare
 *     (seller type + mã tỉnh 34 đơn vị FD-1) → grant founding_seller active →
 *     submit (row pending + PolicyAcceptance cùng tx) → review verified
 *     (atomic claim, step-up) → checkSellerPublicationRequirements
 *     { ok: true, missing: [] }.
 *  3. Revoke → gate chặn (missing operations_review_verified) → submit lại →
 *     review lại verified → gate pass (vòng lặp thu hồi/tái xác minh).
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/rbac/policy/audit là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── Cookie store điều khiển được (next/headers) ──────────────────────────────

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
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
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { checkSellerPublicationRequirements } from "../../src/lib/seller-verification-policy";
import {
  declareSellerProfileAction,
  submitSellerVerificationAction,
  reviewSellerVerificationAction,
} from "../../src/lib/actions/seller-verification";
import { setBetaMembershipAction } from "../../src/lib/actions/beta-cohort";
import { backfill } from "../../scripts/backfill-seller-verification";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = () => `b2-sv-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller" | "admin", over?: { adminRole?: string }): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: `B2 SV ${role}`,
    role,
    ...(over?.adminRole ? { adminRole: over.adminRole as "operations_admin" } : {}),
  });
  return u.id;
}

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Đăng nhập user trên cookie store mock — session thật trong DB scratch. */
const login = async (userId: string, opts?: { isAdmin?: boolean }): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId, opts);
};

/** Đánh dấu step-up tươi cho session HIỆN TẠI của user (qua row thật). */
const stepUpCurrentSession = async (userId: string): Promise<void> => {
  const rows = await db.orm.public.UserSession.where({ userId }).orderBy((s) => s.createdAt.desc()).all();
  const current = rows[0];
  if (!current) throw new Error("no session to step up");
  await db.orm.public.UserSession.where({ id: current.id }).updateAll({
    steppedUpAt: new Date().toISOString(),
  });
};

const created = { users: [] as string[] };

/** Dọn: AuditEvent (SetNull) + SellerVerification (Restrict) trước, rồi user. */
async function cleanupUser(userId: string): Promise<void> {
  await db.orm.public.AuditEvent.where({ actorId: userId }).delete();
  await db.orm.public.AuditEvent.where({ subjectId: userId }).delete();
  await db.orm.public.SellerVerification.where({ userId }).delete();
  await db.orm.public.User.where({ id: userId }).delete();
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  for (const id of created.users) {
    await cleanupUser(id);
  }
  created.users.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Backfill script (spec §8.2/§8.6) ──────────────────────────────────────

d("backfill SellerVerification từ legacy isVerifiedSeller (spec §8.2/§8.6)", () => {
  it("dry-run báo cáo ứng viên; --apply tạo row idempotent + audit actor null", async () => {
    const legacy = await mkUser("seller");
    await db.orm.public.User.where({ id: legacy }).update({ isVerifiedSeller: true });
    created.users.push(legacy);

    // dry-run: KHÔNG tạo row nào
    const dry = await backfill(false);
    expect(dry.mode).toBe("dry-run");
    expect(dry.createdCount).toBe(0);
    expect(dry.pendingIds).toContain(legacy);
    expect(await db.orm.public.SellerVerification.first({ userId: legacy })).toBeNull();

    // apply: tạo row migrated_legacy_verified
    const applied = await backfill(true);
    expect(applied.mode).toBe("apply");
    expect(applied.pendingIds).toContain(legacy);
    expect(applied.createdCount).toBeGreaterThanOrEqual(1);
    const row = await db.orm.public.SellerVerification.first({ userId: legacy });
    expect(row).toMatchObject({
      userId: legacy,
      status: "verified",
      method: "operations_review",
      reasonCode: "migrated_legacy_verified",
      policyVersion: "v1",
      reviewerId: null,
    });
    expect(row!.note).toContain("legacy isVerifiedSeller");
    expect(row!.reviewedAt).not.toBeNull();

    // audit "seller_verification.backfill" — actor null (system/offline script)
    const evt = await db.orm.public.AuditEvent
      .where({ action: "seller_verification.backfill" })
      .orderBy((e) => e.createdAt.desc())
      .first();
    expect(evt).not.toBeNull();
    expect(evt!.actorId).toBeNull();
    expect(evt!.reason).toBe("migrated_legacy_verified");
    expect(evt!.detail).toMatch(/count=\d+/);

    // apply LẦN HAI: idempotent — ứng viên đã có row, 0 row mới
    const reapplied = await backfill(true);
    expect(reapplied.pendingIds).not.toContain(legacy);
    const rows = await db.orm.public.SellerVerification.where({ userId: legacy }).all();
    expect(rows).toHaveLength(1); // vẫn MỘT row — không nhân bản
  });

  it("row migrated verified MỘT MÌNH KHÔNG thỏa publication gate (spec §8.2/§8.4)", async () => {
    const legacy = await mkUser("seller");
    await db.orm.public.User.where({ id: legacy }).update({ isVerifiedSeller: true });
    created.users.push(legacy);

    await backfill(true);

    // boolean legacy KHÔNG cấp quyền: thiếu email/phone/khai báo/rules/membership
    const check = await checkSellerPublicationRequirements(legacy);
    expect(check.ok).toBe(false);
    expect(check.missing).not.toContain("operations_review_verified"); // row verified có rồi
    expect(check.missing).toContain("email_verified");
    expect(check.missing).toContain("founding_seller_membership_active");
  });
});

// ─── 2. Full happy path (spec §5.3.2/§5.3.3) ──────────────────────────────────

d("full happy path — declare → grant → submit → review → gate (DB thật)", () => {
  it("đủ 7 yêu cầu → checkSellerPublicationRequirements { ok: true, missing: [] }", async () => {
    const seller = await mkUser("seller");
    const admin = await mkUser("admin", { adminRole: "operations_admin" });
    created.users.push(seller, admin);

    // verify email/phone (Task 6 đã test riêng — ở đây set timestamps trực tiếp)
    await db.orm.public.User.where({ id: seller }).update({
      emailVerifiedAt: new Date().toISOString(),
      phoneVerifiedAt: new Date().toISOString(),
    });

    // declare: seller type + mã tỉnh canonical (FD-1)
    await login(seller);
    const declared = await declareSellerProfileAction(
      {},
      fd({ sellerType: "individual", operatingProvinceCode: "ho-chi-minh" }),
    );
    expect(declared.error).toBeUndefined();

    // grant founding_seller active (admin, beta_cohort.manage)
    await login(admin, { isAdmin: true });
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "active" }),
    );

    // submit: row pending + PolicyAcceptance(seller_rules, v1)
    await login(seller);
    const submitted = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));
    expect(submitted.error).toBeUndefined();
    const pendingRow = await db.orm.public.SellerVerification.first({ userId: seller });
    expect(pendingRow!.status).toBe("pending");
    const acceptance = await db.orm.public.PolicyAcceptance
      .first({ userId: seller, policyKey: "seller_rules", policyVersion: "v1" });
    expect(acceptance).not.toBeNull();

    // review verified — atomic claim + step-up tươi (không cần TOTP trong test)
    await login(admin, { isAdmin: true });
    await stepUpCurrentSession(admin);
    await reviewSellerVerificationAction(
      fd({ userId: seller, decision: "verified", reasonCode: "requirements_met", note: "IT: đủ v1" }),
    );
    const verifiedRow = await db.orm.public.SellerVerification.first({ userId: seller });
    expect(verifiedRow!.status).toBe("verified");
    expect(verifiedRow!.reviewerId).toBe(admin);
    expect(verifiedRow!.reasonCode).toBe("requirements_met");
    expect(verifiedRow!.policyVersion).toBe("v1");

    // audit "seller_verification.reviewed" với reason + policyVersion
    const evt = await db.orm.public.AuditEvent
      .where({ action: "seller_verification.reviewed", subjectId: seller })
      .first();
    expect(evt).toMatchObject({ actorId: admin, reason: "requirements_met", policyVersion: "v1" });

    // gate: ĐỦ cả 7
    const check = await checkSellerPublicationRequirements(seller);
    expect(check).toEqual({ ok: true, missing: [] });
  });
});

// ─── 3. Revoke → gate chặn → tái xác minh (spec §7.3/§5.3.3) ──────────────────

d("revoke → gate blocks → re-submit → re-verify → gate passes", () => {
  it("thu hồi chặn publication NGAY; tái xác minh mở lại", async () => {
    const seller = await mkUser("seller");
    const admin = await mkUser("admin", { adminRole: "operations_admin" });
    created.users.push(seller, admin);

    // setup đầy đủ (như happy path — rút gọn)
    await db.orm.public.User.where({ id: seller }).update({
      emailVerifiedAt: new Date().toISOString(),
      phoneVerifiedAt: new Date().toISOString(),
    });
    await login(seller);
    await declareSellerProfileAction(
      {},
      fd({ sellerType: "individual", operatingProvinceCode: "ha-noi" }),
    );
    await login(admin, { isAdmin: true });
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "active" }),
    );
    await login(seller);
    await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));
    await login(admin, { isAdmin: true });
    await stepUpCurrentSession(admin);
    await reviewSellerVerificationAction(
      fd({ userId: seller, decision: "verified", reasonCode: "requirements_met" }),
    );
    expect((await checkSellerPublicationRequirements(seller)).ok).toBe(true);

    // REVOKE (verified → revoked — capability seller.verification.revoke)
    await reviewSellerVerificationAction(
      fd({ userId: seller, decision: "revoked", reasonCode: "abuse_case_unresolved" }),
    );
    const revokedRow = await db.orm.public.SellerVerification.first({ userId: seller });
    expect(revokedRow!.status).toBe("revoked");

    // gate chặn NGAY (revoked-seller publication bypass — Review Focus 2)
    const blocked = await checkSellerPublicationRequirements(seller);
    expect(blocked.ok).toBe(false);
    expect(blocked.missing).toEqual(["operations_review_verified"]);

    // seller gửi lại hồ sơ (revoked → pending) → review lại → gate pass
    await login(seller);
    const resubmitted = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));
    expect(resubmitted.error).toBeUndefined();
    const pendingAgain = await db.orm.public.SellerVerification.first({ userId: seller });
    expect(pendingAgain!.status).toBe("pending");

    await login(admin, { isAdmin: true });
    await stepUpCurrentSession(admin);
    await reviewSellerVerificationAction(
      fd({ userId: seller, decision: "verified", reasonCode: "requirements_met" }),
    );
    const reverified = await db.orm.public.SellerVerification.first({ userId: seller });
    expect(reverified!.status).toBe("verified");
    expect((await checkSellerPublicationRequirements(seller)).ok).toBe(true);
  });

  it("quyết định THỨ HAI trên row đã review → VERIFICATION_ALREADY_REVIEWED (atomic claim)", async () => {
    const seller = await mkUser("seller");
    const admin = await mkUser("admin", { adminRole: "operations_admin" });
    created.users.push(seller, admin);

    await db.orm.public.User.where({ id: seller }).update({
      emailVerifiedAt: new Date().toISOString(),
      phoneVerifiedAt: new Date().toISOString(),
    });
    await login(seller);
    await declareSellerProfileAction(
      {},
      fd({ sellerType: "individual", operatingProvinceCode: "da-nang" }),
    );
    await login(admin, { isAdmin: true });
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "active" }),
    );
    await login(seller);
    await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));

    await login(admin, { isAdmin: true });
    await stepUpCurrentSession(admin);
    await reviewSellerVerificationAction(
      fd({ userId: seller, decision: "verified", reasonCode: "requirements_met" }),
    );

    // quyết định thứ hai — row không còn pending → typed error, KHÔNG ghi đè
    await expect(
      reviewSellerVerificationAction(
        fd({ userId: seller, decision: "verified", reasonCode: "requirements_met" }),
      ),
    ).rejects.toThrow("VERIFICATION_ALREADY_REVIEWED");

    const row = await db.orm.public.SellerVerification.first({ userId: seller });
    expect(row!.status).toBe("verified");
    expect(row!.reasonCode).toBe("requirements_met");
    expect(row!.reviewerId).toBe(admin); // quyết định ĐẦU giữ nguyên
  });
});
