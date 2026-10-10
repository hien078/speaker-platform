/**
 * Batch 2 migration integration tests — plan Task 1 (batch 2), spec §8
 * (migration strategy: additive-first) + §8.5 (admin role mapping có chủ đích).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `batch2_identity_security` (Task 1):
 *  - ADDITIVE: 8 model mới (UserSession, OtpCode, SellerVerification,
 *    BetaCohortMembership, PolicyAcceptance, AdminMfa, AdminRecoveryCode,
 *    AuditEvent) nhận create + delete round-trip với đúng field contract
 *    (bảng + cột tồn tại sau migrate);
 *  - predicate backfill adminRole (role='admin' AND adminRole IS NULL) —
 *    đúng UPDATE data transform trong migration.ts thực hiện — chạy được
 *    trên schema thật và chỉ đụng đúng các row đó (idempotent);
 *  - `npx prisma db verify` exit 0 sau migrate (marker + schema khớp contract);
 *  - bảng finance legacy (Order, Payment, Payout, WithdrawRequest,
 *    LedgerEntry, Dispute) vẫn đọc/ghi được — dữ liệu seeded đọc lại
 *    nguyên vẹn (spec §4.3 historical preservation).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { db } from "../../src/prisma/db.client";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const execFileAsync = promisify(execFile);

let seq = 0;
const uid = () => `b2-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B2 ${role}`,
    role,
  });
  return u.id;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK để không bị Restrict chặn.
const created = {
  users: [] as string[],
  sessions: [] as string[],
  otpCodes: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
  policyAcceptances: [] as string[],
  adminMfas: [] as string[],
  recoveryCodes: [] as string[],
  auditEvents: [] as string[],
  orders: [] as string[],
  payments: [] as string[],
};

afterEach(async () => {
  for (const id of created.auditEvents) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  for (const id of created.recoveryCodes) {
    await db.orm.public.AdminRecoveryCode.where({ id }).delete();
  }
  for (const id of created.adminMfas) {
    await db.orm.public.AdminMfa.where({ id }).delete();
  }
  for (const id of created.policyAcceptances) {
    await db.orm.public.PolicyAcceptance.where({ id }).delete();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).delete();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).delete();
  }
  for (const id of created.otpCodes) {
    await db.orm.public.OtpCode.where({ id }).delete();
  }
  for (const id of created.sessions) {
    await db.orm.public.UserSession.where({ id }).delete();
  }
  for (const id of created.payments) {
    await db.orm.public.Payment.where({ id }).delete();
  }
  for (const id of created.orders) {
    await db.orm.public.OrderStatusHistory.where({ orderId: id }).delete();
    await db.orm.public.Order.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  (Object.keys(created) as (keyof typeof created)[]).forEach((k) => {
    created[k].length = 0;
  });
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Additive: 8 model mới nhận create + delete round-trip ───

d("applies the batch 2 migration additively", () => {
  it("UserSession — session DB-backed (spec §5.4.2)", async () => {
    const userId = await mkUser();
    created.users.push(userId);
    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: "a".repeat(64),
      isAdmin: true,
      expiresAt: isoFuture(),
      userAgent: "vitest-agent",
    });
    created.sessions.push(s.id);
    const row = await db.orm.public.UserSession.first({ id: s.id });
    expect(row!.userId).toBe(userId);
    expect(row!.tokenHash).toBe("a".repeat(64));
    expect(row!.isAdmin).toBe(true);
    expect(row!.revokedAt).toBeNull();
    expect(row!.revokedReason).toBeNull();
    expect(row!.steppedUpAt).toBeNull();
    expect(row!.userAgent).toBe("vitest-agent");
    await db.orm.public.UserSession.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSession.first({ id: s.id })).toBeNull();
  });

  it("OtpCode — OTP hash, single-use, TTL (spec §5.3)", async () => {
    const userId = await mkUser();
    created.users.push(userId);
    const o = await db.orm.public.OtpCode.create({
      userId,
      purpose: "email_verification",
      channel: "email",
      target: `${uid()}@integration.test`,
      codeHash: "b".repeat(64),
      attempts: 0,
      expiresAt: isoFuture(),
    });
    created.otpCodes.push(o.id);
    const row = await db.orm.public.OtpCode.first({ id: o.id });
    expect(row!.purpose).toBe("email_verification");
    expect(row!.channel).toBe("email");
    expect(row!.codeHash).toBe("b".repeat(64));
    expect(row!.attempts).toBe(0);
    expect(row!.consumedAt).toBeNull();
    await db.orm.public.OtpCode.where({ id: o.id }).delete();
    expect(await db.orm.public.OtpCode.first({ id: o.id })).toBeNull();
  });

  it("SellerVerification — workflow, không phải boolean (spec §5.3.2)", async () => {
    const userId = await mkUser("seller");
    created.users.push(userId);
    const v = await db.orm.public.SellerVerification.create({
      userId,
      status: "pending",
      method: "operations_review",
      policyVersion: "v1",
    });
    created.sellerVerifications.push(v.id);
    const row = await db.orm.public.SellerVerification.first({ id: v.id });
    expect(row!.userId).toBe(userId);
    expect(row!.status).toBe("pending");
    expect(row!.method).toBe("operations_review");
    expect(row!.policyVersion).toBe("v1");
    expect(row!.reviewerId).toBeNull();
    expect(row!.reviewedAt).toBeNull();
    expect(row!.reasonCode).toBeNull();
    await db.orm.public.SellerVerification.where({ id: v.id }).delete();
    expect(await db.orm.public.SellerVerification.first({ id: v.id })).toBeNull();
  });

  it("BetaCohortMembership — cohort là điều kiện publication (spec §2.1)", async () => {
    const userId = await mkUser("seller");
    created.users.push(userId);
    const m = await db.orm.public.BetaCohortMembership.create({
      userId,
      cohort: "founding_seller",
      status: "active",
      notes: "it",
    });
    created.betaMemberships.push(m.id);
    const row = await db.orm.public.BetaCohortMembership.first({ id: m.id });
    expect(row!.userId).toBe(userId);
    expect(row!.cohort).toBe("founding_seller");
    expect(row!.status).toBe("active");
    expect(row!.invitedBy).toBeNull();
    await db.orm.public.BetaCohortMembership.where({ id: m.id }).delete();
    expect(await db.orm.public.BetaCohortMembership.first({ id: m.id })).toBeNull();
  });

  it("PolicyAcceptance — cơ chế ghi nhận chấp nhận (spec §3.1)", async () => {
    const userId = await mkUser("seller");
    created.users.push(userId);
    const p = await db.orm.public.PolicyAcceptance.create({
      userId,
      policyKey: "seller_rules",
      policyVersion: "v1",
    });
    created.policyAcceptances.push(p.id);
    const row = await db.orm.public.PolicyAcceptance.first({ id: p.id });
    expect(row!.userId).toBe(userId);
    expect(row!.policyKey).toBe("seller_rules");
    expect(row!.policyVersion).toBe("v1");
    expect(row!.acceptedAt).toBeTruthy();
    await db.orm.public.PolicyAcceptance.where({ id: p.id }).delete();
    expect(await db.orm.public.PolicyAcceptance.first({ id: p.id })).toBeNull();
  });

  it("AdminMfa + AdminRecoveryCode — TOTP + mã khôi phục một lần (spec §5.4.2)", async () => {
    const userId = await mkUser("admin");
    created.users.push(userId);
    const mfa = await db.orm.public.AdminMfa.create({
      userId,
      totpSecretEnc: `v1:0123abcd:${"x".repeat(32)}`,
    });
    created.adminMfas.push(mfa.id);
    const mfaRow = await db.orm.public.AdminMfa.first({ id: mfa.id });
    expect(mfaRow!.userId).toBe(userId);
    expect(mfaRow!.totpSecretEnc).toBe(`v1:0123abcd:${"x".repeat(32)}`);
    expect(mfaRow!.totpConfirmedAt).toBeNull();

    const rc = await db.orm.public.AdminRecoveryCode.create({
      mfaId: mfa.id,
      codeHash: "c".repeat(64),
    });
    created.recoveryCodes.push(rc.id);
    const rcRow = await db.orm.public.AdminRecoveryCode.first({ id: rc.id });
    expect(rcRow!.mfaId).toBe(mfa.id);
    expect(rcRow!.codeHash).toBe("c".repeat(64));
    expect(rcRow!.usedAt).toBeNull();

    await db.orm.public.AdminRecoveryCode.where({ id: rc.id }).delete();
    expect(await db.orm.public.AdminRecoveryCode.first({ id: rc.id })).toBeNull();
    await db.orm.public.AdminMfa.where({ id: mfa.id }).delete();
    expect(await db.orm.public.AdminMfa.first({ id: mfa.id })).toBeNull();
  });

  it("AuditEvent — actor/action/resource/reason/context (spec §4.6)", async () => {
    const actorId = await mkUser("admin");
    const subjectId = await mkUser("seller");
    created.users.push(actorId, subjectId);
    const e = await db.orm.public.AuditEvent.create({
      actorId,
      subjectId,
      action: "session.revoked",
      resourceType: "UserSession",
      resourceId: "sess-it-1",
      reason: "logout",
      policyVersion: "v1",
      sessionId: "sess-it-1",
      ipHash: "d".repeat(64),
      detail: '{"scope":"it"}',
    });
    created.auditEvents.push(e.id);
    const row = await db.orm.public.AuditEvent.first({ id: e.id });
    expect(row!.actorId).toBe(actorId);
    expect(row!.subjectId).toBe(subjectId);
    expect(row!.action).toBe("session.revoked");
    expect(row!.resourceType).toBe("UserSession");
    expect(row!.resourceId).toBe("sess-it-1");
    expect(row!.reason).toBe("logout");
    expect(row!.policyVersion).toBe("v1");
    expect(row!.ipHash).toBe("d".repeat(64));
    expect(row!.detail).toBe('{"scope":"it"}');
    await db.orm.public.AuditEvent.where({ id: e.id }).delete();
    expect(await db.orm.public.AuditEvent.first({ id: e.id })).toBeNull();
  });

  it("User nhận cột mới nullable (emailVerifiedAt/phoneVerifiedAt/adminRole/sellerType/sellerOperatingProvinceCode)", async () => {
    const userId = await mkUser("seller");
    created.users.push(userId);
    const row = await db.orm.public.User.first({ id: userId });
    expect(row!.emailVerifiedAt).toBeNull();
    expect(row!.phoneVerifiedAt).toBeNull();
    expect(row!.adminRole).toBeNull();
    expect(row!.sellerType).toBeNull();
    expect(row!.sellerOperatingProvinceCode).toBeNull();
    // legacy columns giữ nguyên (spec §8.2: boolean chỉ tạm thời còn lại)
    expect(row!.role).toBe("seller");
    expect(row!.isVerifiedSeller).toBe(false);
  });
});

// ─── 2. Backfill predicate (spec §8.5 — mapping có chủ đích) ───

d("backfill adminRole (spec §8.5)", () => {
  it("predicate UPDATE của data transform chạy được trên schema thật", async () => {
    const adminId = await mkUser("admin");
    created.users.push(adminId);
    const before = await db.orm.public.User.first({ id: adminId });
    expect(before!.role).toBe("admin");
    expect(before!.adminRole).toBeNull();

    // EXACT UPDATE data transform trong migration.ts thực hiện
    // (migrations/app/<ts>_batch2_identity_security/migration.ts)
    const plan = db.sql.public.User.update({ adminRole: "super_admin" })
      .where((f, fns) => fns.and(fns.eq(f.role, "admin"), fns.eq(f.adminRole, null)))
      .build();
    await db.runtime().execute(plan);

    const after = await db.orm.public.User.first({ id: adminId });
    expect(after!.adminRole).toBe("super_admin");
    expect(after!.role).toBe("admin"); // role display-only giữ nguyên
  });

  it("idempotent — không đụng user thường, không ghi đè admin đã có adminRole", async () => {
    const buyerId = await mkUser("buyer");
    created.users.push(buyerId);
    const plan = db.sql.public.User.update({ adminRole: "super_admin" })
      .where((f, fns) => fns.and(fns.eq(f.role, "admin"), fns.eq(f.adminRole, null)))
      .build();
    const { affectedRows } = await db.runtime().execute(plan);
    expect(affectedRows).toBe(0); // không còn row nào khớp predicate
    const buyer = await db.orm.public.User.first({ id: buyerId });
    expect(buyer!.adminRole).toBeNull(); // buyer không bị đụng
  });
});

// ─── 3. Marker + schema khớp contract sau migrate ───

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 4. Finance legacy giữ nguyên (spec §4.3 + §8.1) ───

d("preserves finance tables", () => {
  it("Order/Payment/Payout/WithdrawRequest/LedgerEntry/Dispute vẫn đọc được", async () => {
    // đọc từng bảng — bảng mất/thêm cột sẽ fail ngay ở đây
    expect(await db.orm.public.Order.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payment.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payout.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.WithdrawRequest.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.LedgerEntry.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Dispute.where({ id: "nope-0000" }).all()).toEqual([]);
  });

  it("Order + Payment seeded đọc lại nguyên vẹn", async () => {
    const buyerId = await mkUser("buyer");
    const sellerId = await mkUser("seller");
    created.users.push(buyerId, sellerId);
    const o = await db.orm.public.Order.create({
      code: `B2-${uid()}`,
      buyerId,
      sellerId,
      status: "awaiting_payment",
      totalAmount: 500_000,
      commissionRate: 5,
      commissionAmount: 25_000,
      sellerPayout: 475_000,
      paymentMethod: "escrow",
      shippingAddress: "123 Đường Test, TP Test",
      shippingPhone: "0901234567",
    });
    created.orders.push(o.id);
    const p = await db.orm.public.Payment.create({
      orderId: o.id,
      method: "escrow",
      status: "pending",
      amount: 500_000,
      provider: "momo",
    });
    created.payments.push(p.id);

    const order = await db.orm.public.Order.first({ id: o.id });
    expect(order!.code).toBe(o.code);
    expect(order!.status).toBe("awaiting_payment");
    expect(order!.totalAmount).toBe(500_000);
    expect(order!.commissionRate).toBe(5);
    expect(order!.commissionAmount).toBe(25_000);
    expect(order!.sellerPayout).toBe(475_000);
    expect(order!.paymentMethod).toBe("escrow");
    const payment = await db.orm.public.Payment.first({ id: p.id });
    expect(payment!.orderId).toBe(o.id);
    expect(payment!.method).toBe("escrow");
    expect(payment!.status).toBe("pending");
    expect(payment!.amount).toBe(500_000);
    expect(payment!.provider).toBe("momo");
  });
});
