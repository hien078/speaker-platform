/**
 * Manual contact verification migration integration tests — zero-cost launch
 * Task A (founder 2026-10-12: no paid OTP provider; two-person manual contact
 * verification thay block psql runbook §6 cho mục đích này).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `manual_contact_verification` (commit 1):
 *  - ADDITIVE: ManualContactVerification nhận create + read round-trip với
 *    đúng field contract (channel/targetHash/method/note/status/requestedBy/
 *    requestedAt/decidedBy/decidedAt/expiresAt); 3 enum mới nhận đủ giá trị
 *    (channel email|phone; method phone_call|in_person|video_call|other;
 *    status requested|approved|rejected|cancelled|expired); KHÔNG cột nào
 *    bị thêm vào bảng hiện có (User chỉ nhận relation declarations — zero
 *    `column.` ops);
 *  - PARTIAL UNIQUE `manual_contact_one_requested`: MỘT row `requested` duy nhất
 *    per (userId, channel) — đóng race double-request; row approved/rejected/
 *    cancelled cùng sống (audit trail); kênh khác cùng user tự do;
 *  - ops.json: mọi op additive — chỉ create/createIndex/unique/foreignKey;
 *    zero destructive, zero data transform, zero `column.` op; đúng MỘT op
 *    index manual_contact_one_requested (tên wire + hash suffix); predicate
 *    render PHẢI quote cột camelCase (`"status" = 'requested'` — unquoted
 *    status folds thành status… vẫn ok nhưng camelCase quote là pin precedent
 *    corrections item 5 batch 7); KHÔNG op nào chạm bảng finance;
 *  - `npx prisma db verify` exit 0 sau migrate;
 *  - bảng finance legacy vẫn đọc được (spec §4.3/§8.1);
 *  - Batch 2–7 tables nhận create + read round-trip — migration không làm
 *    xáo trộn graph batch trước.
 *
 * FK decisions (theo design Task A):
 *  - ManualContactVerification.userId onDelete: Restrict (tường minh — row
 *    verification sống qua mọi product flow; KHÔNG cascade);
 *  - requestedById/decidedById SetNull (Batch 3 UserSuspension precedent —
 *    row sống qua admin deletion tương lai).
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { isUniqueConstraintViolation, SqlQueryError } from "@prisma/orm-family-sql/errors";

import { db } from "../../src/prisma/db.client";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const execFileAsync = promisify(execFile);

let seq = 0;
const uid = () => `mcv-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `MCV ${role}`,
    role,
  });
  return u.id;
}

/** Bắt unique violation (23505) — trả error để assert constraint name. */
async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<SqlQueryError> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(isUniqueConstraintViolation(err)).toBe(true); // SQLSTATE 23505 chuẩn
  expect(SqlQueryError.is(err)).toBe(true);
  return err as SqlQueryError;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: ManualContactVerification TRƯỚC User (userId Restrict).
const created = {
  users: [] as string[],
  verifications: [] as string[],
  auditEvents: [] as string[],
  sessions: [] as string[],
  orders: [] as string[],
  payments: [] as string[],
};

afterEach(async () => {
  for (const id of created.verifications) {
    await db.orm.public.ManualContactVerification.where({ id }).delete();
  }
  for (const id of created.auditEvents) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  for (const id of created.sessions) {
    await db.orm.public.UserSession.where({ id }).delete();
  }
  // payments/orders TRƯỚC users — Order FK Restrict chặn delete user còn
  // order (thứ tự ngược FK, cùng precedent batch5-migration.test.ts)
  for (const id of created.payments) {
    await db.orm.public.Payment.where({ id }).delete();
  }
  for (const id of created.orders) {
    await db.orm.public.OrderStatusHistory.where({ orderId: id }).delete();
    await db.orm.public.Order.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.Notification.where({ userId: id }).delete();
    await db.orm.public.User.where({ id }).delete();
  }
  (Object.keys(created) as (keyof typeof created)[]).forEach((k) => {
    created[k].length = 0;
  });
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Additive: ManualContactVerification round-trip ───────────────────────

d("applies the manual contact verification migration additively", () => {
  it("ManualContactVerification — create + read round-trip với đủ field contract", async () => {
    const subjectId = await mkUser("seller"); // người được xác minh
    const requesterId = await mkUser("admin"); // admin A — requestedBy
    created.users.push(subjectId, requesterId);

    // full field contract — targetHash là HMAC hex (KHÔNG BAO GIỜ giá trị thô)
    const v = await db.orm.public.ManualContactVerification.create({
      userId: subjectId,
      channel: "phone",
      targetHash: "a".repeat(64), // HMAC-SHA256 hex — hash của normalizePhone(subject.phone)
      method: "phone_call",
      note: "gọi điện xác minh số máy — note đã redactDetail",
      status: "requested",
      requestedById: requesterId,
      requestedAt: new Date().toISOString(),
      decidedById: null,
      decidedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    created.verifications.push(v.id);

    const row = await db.orm.public.ManualContactVerification.first({ id: v.id });
    expect(row!.userId).toBe(subjectId);
    expect(row!.channel).toBe("phone");
    expect(row!.targetHash).toBe("a".repeat(64));
    expect(row!.method).toBe("phone_call");
    expect(row!.note).toBe("gọi điện xác minh số máy — note đã redactDetail");
    expect(row!.status).toBe("requested");
    expect(row!.requestedById).toBe(requesterId);
    expect(row!.requestedAt).toBeTruthy();
    expect(row!.decidedById).toBeNull();
    expect(row!.decidedAt).toBeNull();
    expect(row!.expiresAt).toBeTruthy();
    expect(row!.createdAt).toBeTruthy();
    expect(row!.updatedAt).toBeTruthy();

    // create tối thiểu — mọi cột khác nullable/defaulted (additive-only):
    // requestedBy nullable (row sống qua admin deletion), note nullable,
    // status @default(requested)
    const minimal = await db.orm.public.ManualContactVerification.create({
      userId: subjectId,
      channel: "email",
      targetHash: "b".repeat(64),
      method: "other",
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    created.verifications.push(minimal.id);
    const minRow = await db.orm.public.ManualContactVerification.first({ id: minimal.id });
    expect(minRow!.status).toBe("requested"); // @default(requested)
    expect(minRow!.requestedById).toBeNull();
    expect(minRow!.note).toBeNull();
    expect(minRow!.decidedAt).toBeNull();
  });

  it("channel nhận đủ email + phone (manual_contact_channel)", async () => {
    for (const channel of ["email", "phone"] as const) {
      const subjectId = await mkUser();
      created.users.push(subjectId);
      const v = await db.orm.public.ManualContactVerification.create({
        userId: subjectId,
        channel,
        targetHash: `${channel}-${uid()}`,
        method: "in_person",
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
      created.verifications.push(v.id);
      expect(
        (await db.orm.public.ManualContactVerification.first({ id: v.id }))!.channel,
      ).toBe(channel);
    }
  });

  it("method nhận đủ 4 giá trị (manual_contact_method)", async () => {
    for (const method of ["phone_call", "in_person", "video_call", "other"] as const) {
      const subjectId = await mkUser();
      created.users.push(subjectId);
      const v = await db.orm.public.ManualContactVerification.create({
        userId: subjectId,
        channel: "phone",
        targetHash: `m-${method}-${uid()}`,
        method,
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
      created.verifications.push(v.id);
      expect(
        (await db.orm.public.ManualContactVerification.first({ id: v.id }))!.method,
      ).toBe(method);
    }
  });

  it("status nhận đủ 5 giá trị (manual_contact_status) — expired là giá trị reserved (read-path tự tính theo expiresAt)", async () => {
    for (const status of ["requested", "approved", "rejected", "cancelled", "expired"] as const) {
      const subjectId = await mkUser();
      created.users.push(subjectId);
      const v = await db.orm.public.ManualContactVerification.create({
        userId: subjectId,
        channel: "email",
        targetHash: `s-${status}-${uid()}`,
        method: "other",
        status,
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
      created.verifications.push(v.id);
      expect(
        (await db.orm.public.ManualContactVerification.first({ id: v.id }))!.status,
      ).toBe(status);
    }
  });
});

// ─── 2. Partial unique manual_contact_one_requested ───────────────────────────

d("partial unique manual_contact_one_requested holds", () => {
  it("MỘT row requested duy nhất per (userId, channel); approved/rejected/cancelled cùng sống", async () => {
    const subjectId = await mkUser();
    created.users.push(subjectId);

    // row requested ĐẦU TIÊN
    const requested = await db.orm.public.ManualContactVerification.create({
      userId: subjectId,
      channel: "phone",
      targetHash: `h-a-${uid()}`,
      method: "phone_call",
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    created.verifications.push(requested.id);

    // row requested THỨ HAI cùng (userId, channel) → 23505 (partial unique —
    // index chỉ cover status = 'requested')
    const err = await expectUniqueViolation(() =>
      db.orm.public.ManualContactVerification.create({
        userId: subjectId,
        channel: "phone",
        targetHash: `h-b-${uid()}`,
        method: "video_call",
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      }),
    );
    // tên wire + hash suffix (prefix match — precedent corrections item 9 b7)
    expect(err.constraint).toMatch(/^manual_contact_one_requested_/);
    expect(err.table).toBe("ManualContactVerification");

    // row KHÔNG requested cùng sống (audit trail — approved/rejected/cancelled)
    for (const status of ["approved", "rejected", "cancelled"] as const) {
      const row = await db.orm.public.ManualContactVerification.create({
        userId: subjectId,
        channel: "phone",
        targetHash: `h-${status}-${uid()}`,
        method: "other",
        status,
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
      created.verifications.push(row.id);
      expect(
        (await db.orm.public.ManualContactVerification.first({ id: row.id }))!.status,
      ).toBe(status);
    }

    // row requested cho KÊNH KHÁC cùng user tự do (index là per (userId, channel))
    const otherChannel = await db.orm.public.ManualContactVerification.create({
      userId: subjectId,
      channel: "email",
      targetHash: `h-email-${uid()}`,
      method: "other",
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    created.verifications.push(otherChannel.id);
    expect(
      (await db.orm.public.ManualContactVerification.first({ id: otherChannel.id }))!.channel,
    ).toBe("email");

    // row requested cho USER KHÁC tự do (index là per user)
    const otherUser = await mkUser();
    created.users.push(otherUser);
    const otherUserRow = await db.orm.public.ManualContactVerification.create({
      userId: otherUser,
      channel: "phone",
      targetHash: `h-other-${uid()}`,
      method: "phone_call",
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    created.verifications.push(otherUserRow.id);
    expect(
      (await db.orm.public.ManualContactVerification.first({ id: otherUserRow.id }))!.userId,
    ).toBe(otherUser);
  });
});

// ─── 3. ops.json package contract ─────────────────────────────────────────────

d("migration ops package contract", () => {
  it("mọi op additive — 1 bảng mới, zero column., zero destructive/data, một manual_contact_one_requested, không finance", async () => {
    // đọc ops.json của package — nguồn chân thực planner render
    const migrationsAppDir = fileURLToPath(new URL("../../migrations/app/", import.meta.url));
    const dirName = readdirSync(migrationsAppDir).find((e) =>
      /_manual_contact_verification$/.test(e),
    );
    expect(dirName).toBeTruthy(); // package chưa render → fail (đúng ở Step RED)
    const ops = JSON.parse(
      readFileSync(join(migrationsAppDir, dirName!, "ops.json"), "utf8"),
    ) as Array<{ id: string; label: string; operationClass: string; execute?: Array<{ sql: string }> }>;

    // 1 bảng mới — toàn bộ op "table." là CREATE (không drop bảng nào)
    const tableOps = ops.filter((o) => o.id.startsWith("table."));
    expect(tableOps.map((o) => o.id)).toEqual(["table.ManualContactVerification"]);
    expect(tableOps.filter((o) => /drop|alter/i.test(o.label))).toEqual([]);

    // KHÔNG cột nào bị thêm vào bảng hiện có (User chỉ nhận relation
    // declarations — KHÔNG cột mới)
    expect(ops.filter((o) => o.id.startsWith("column."))).toEqual([]);

    // zero destructive (additive-only), zero data transform (không backfill —
    // feature mới, không có row cũ), không cặp Listing_status_check_*
    expect(ops.filter((o) => o.operationClass === "destructive")).toEqual([]);
    expect(ops.filter((o) => o.operationClass === "data")).toEqual([]);
    expect(ops.filter((o) => /drop|alter/i.test(o.label))).toEqual([]);
    expect(ops.filter((o) => /listing_status_check/i.test(o.id))).toEqual([]);

    // partial unique index manual_contact_one_requested render — đúng MỘT op,
    // tên wire + hash suffix
    const oneRequestedOps = ops.filter((o) =>
      /^index\.ManualContactVerification\.manual_contact_one_requested_/i.test(o.id),
    );
    expect(oneRequestedOps).toHaveLength(1);

    // predicate render PHẢI quote cột camelCase + giá trị enum (precedent
    // corrections item 5 b7: unquoted folds trong Postgres → index chết im)
    const oneRequestedSql = (oneRequestedOps[0]!.execute ?? []).map((s) => s.sql).join("\n");
    expect(oneRequestedSql).toContain("CREATE UNIQUE INDEX");
    expect(oneRequestedSql).toContain(`"status" = 'requested'`);
    expect(oneRequestedSql).toContain(`"userId"`);
    expect(oneRequestedSql).toContain(`"channel"`);

    // KHÔNG op nào chạm bảng finance (Global rules — no finance table)
    const FINANCE_TABLES =
      /Order|Payment|Payout|WithdrawRequest|LedgerEntry|Dispute|Cart|CartItem|Offer|ExchangeOffer|Wallet/i;
    for (const op of ops) {
      expect(op.id, `op finance: ${op.id}`).not.toMatch(FINANCE_TABLES);
    }
  });
});

// ─── 4. Marker + schema khớp contract sau migrate ─────────────────────────────

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 5. Finance legacy giữ nguyên (spec §4.3 + §8.1) ───────────────────────────

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
      code: `MCV-${uid()}`,
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
    const payment = await db.orm.public.Payment.first({ id: p.id });
    expect(payment!.orderId).toBe(o.id);
    expect(payment!.amount).toBe(500_000);
  });
});

// ─── 6. Batch 2 tables nhận create + read round-trip (graph không xáo trộn) ────

d("preserves batch 2 tables", () => {
  it("UserSession/AuditEvent round-trip", async () => {
    const userId = await mkUser();
    created.users.push(userId);

    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: `hash-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.sessions.push(s.id);
    expect((await db.orm.public.UserSession.first({ id: s.id }))!.tokenHash).toBe(s.tokenHash);

    const ae = await db.orm.public.AuditEvent.create({
      actorId: userId,
      action: "contact.manual_verify_requested",
      reason: "typed_reason_code",
    });
    created.auditEvents.push(ae.id);
    expect((await db.orm.public.AuditEvent.first({ id: ae.id }))!.action).toBe(
      "contact.manual_verify_requested",
    );

    // delete round-trip — migration không làm xáo trộn graph Batch 2
    await db.orm.public.UserSession.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSession.first({ id: s.id })).toBeNull();
    await db.orm.public.AuditEvent.where({ id: ae.id }).delete();
    expect(await db.orm.public.AuditEvent.first({ id: ae.id })).toBeNull();
  });
});
