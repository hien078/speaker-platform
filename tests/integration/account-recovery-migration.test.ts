/**
 * Account recovery request migration integration tests — Task E (founder
 * FD-R3 2026-10-13: two-person admin-assisted account recovery — production
 * không có OTP provider, hand-set passwordHash bị cấm).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `account_recovery_request` (commit 1):
 *  - ADDITIVE: AccountRecoveryRequest nhận create + read round-trip với đúng
 *    field contract (checksPassed/check booleans/phoneVerifiedAtSnapshot/
 *    phoneHash/status/requestedBy/decidedBy/decidedAt/expiresAt/
 *    resetTokenHash/resetTokenExpiresAt/consumedAt); enum mới nhận đủ 6 giá
 *    trị (requested|approved|rejected|cancelled|expired|consumed); KHÔNG cột
 *    nào bị thêm vào bảng hiện có (User chỉ nhận relation declarations —
 *    zero `column.` ops);
 *  - CHECK `account_recovery_checks_range`: checksPassed ngoài 2..3 bị từ
 *    chối (23514) — hợp đồng ≥ 2/3 câu đúng của founder, DB chặn cả khi
 *    action bị bypass;
 *  - PARTIAL UNIQUE `account_recovery_one_open`: MỘT row mở (requested, HOẶC
 *    approved-unconsumed) duy nhất per user — đóng race double-request; row
 *    rejected/cancelled/expired/consumed cùng sống (audit trail);
 *  - ops.json: mọi op additive — chỉ create/createIndex/foreignKey; zero
 *    destructive, zero data transform, zero `column.` op; đúng MỘT op index
 *    account_recovery_one_open (tên wire + hash suffix); predicate render
 *    PHẢI quote cột camelCase (`"status" = 'requested'` — corrections item 5
 *    batch 7 precedent); KHÔNG op nào chạm bảng finance;
 *  - `npx prisma db verify` exit 0 sau migrate;
 *  - bảng finance legacy vẫn đọc được (spec §4.3/§8.1);
 *  - Batch 2 tables nhận create + read round-trip — migration không làm xáo
 *    trộn graph batch trước.
 *
 * FK decisions (theo design Task E):
 *  - AccountRecoveryRequest.userId onDelete: Restrict (tường minh — row
 *    recovery là audit trail, sống qua mọi product flow; KHÔNG cascade);
 *  - requestedById/decidedById SetNull (Batch 3 UserSuspension precedent —
 *    row sống qua admin deletion tương lai).
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";

import { db } from "../../src/prisma/db.client";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const execFileAsync = promisify(execFile);

let seq = 0;
const uid = () => `arr-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `ARR ${role}`,
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

/** Bắt check violation (23514) — checksPassed ngoài 2..3. */
async function expectCheckViolation(fn: () => Promise<unknown>): Promise<SqlQueryError> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(SqlQueryError.is(err)).toBe(true);
  const q = err as SqlQueryError;
  expect(q.sqlState).toBe("23514"); // check_violation
  return q;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: AccountRecoveryRequest TRƯỚC User (userId Restrict).
const created = {
  users: [] as string[],
  requests: [] as string[],
  auditEvents: [] as string[],
  sessions: [] as string[],
  orders: [] as string[],
  payments: [] as string[],
};

afterEach(async () => {
  for (const id of created.requests) {
    await db.orm.public.AccountRecoveryRequest.where({ id }).delete();
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

/** Row AccountRecoveryRequest tối thiểu hợp lệ — checksPassed 2..3 (CHECK). */
function mkRequestRow(userId: string, over: Record<string, unknown> = {}) {
  return {
    userId,
    checksPassed: 2,
    checkListingTitle: true,
    checkProvince: true,
    checkRegistrationMonth: false,
    phoneVerifiedAtSnapshot: new Date().toISOString(),
    phoneHash: "a".repeat(64), // HMAC hex — KHÔNG BAO GIỜ phone thô
    status: "requested" as const,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ...over,
  };
}

// ─── 1. Additive: AccountRecoveryRequest round-trip ─────────────────────────

d("applies the account recovery migration additively", () => {
  it("AccountRecoveryRequest — create + read round-trip với đủ field contract", async () => {
    const subjectId = await mkUser("buyer"); // người được khôi phục
    const requesterId = await mkUser("admin"); // admin A — requestedBy
    const deciderId = await mkUser("admin"); // admin B — decidedBy
    created.users.push(subjectId, requesterId, deciderId);

    // full field contract — phoneHash/resetTokenHash là HMAC hex (KHÔNG thô)
    const r = await db.orm.public.AccountRecoveryRequest.create({
      ...mkRequestRow(subjectId),
      requestedById: requesterId,
      requestedAt: new Date().toISOString(),
    });
    created.requests.push(r.id);

    const row = await db.orm.public.AccountRecoveryRequest.first({ id: r.id });
    expect(row!.userId).toBe(subjectId);
    expect(row!.checksPassed).toBe(2);
    expect(row!.checkListingTitle).toBe(true);
    expect(row!.checkProvince).toBe(true);
    expect(row!.checkRegistrationMonth).toBe(false);
    expect(row!.phoneVerifiedAtSnapshot).toBeTruthy();
    expect(row!.phoneHash).toBe("a".repeat(64));
    expect(row!.status).toBe("requested");
    expect(row!.requestedById).toBe(requesterId);
    expect(row!.requestedAt).toBeTruthy();
    expect(row!.decidedById).toBeNull();
    expect(row!.decidedAt).toBeNull();
    expect(row!.expiresAt).toBeTruthy();
    expect(row!.resetTokenHash).toBeNull(); // CHỈ set lúc approve
    expect(row!.resetTokenExpiresAt).toBeNull();
    expect(row!.consumedAt).toBeNull();
    expect(row!.createdAt).toBeTruthy();
    expect(row!.updatedAt).toBeTruthy();

    // create tối thiểu — requestedBy nullable (row sống qua admin deletion),
    // status @default(requested)
    const minimal = await db.orm.public.AccountRecoveryRequest.create(
      mkRequestRow(subjectId, { status: "rejected", phoneHash: "b".repeat(64) }),
    );
    created.requests.push(minimal.id);
    const minRow = await db.orm.public.AccountRecoveryRequest.first({ id: minimal.id });
    expect(minRow!.requestedById).toBeNull();
    expect(minRow!.status).toBe("rejected");
  });

  it("status nhận đủ 6 giá trị (account_recovery_status) — expired/consumed là giá trị thật", async () => {
    for (const status of [
      "requested",
      "approved",
      "rejected",
      "cancelled",
      "expired",
      "consumed",
    ] as const) {
      const subjectId = await mkUser();
      created.users.push(subjectId);
      const r = await db.orm.public.AccountRecoveryRequest.create(
        mkRequestRow(subjectId, { status, phoneHash: `s-${status}-${uid()}`.slice(0, 64) }),
      );
      created.requests.push(r.id);
      expect(
        (await db.orm.public.AccountRecoveryRequest.first({ id: r.id }))!.status,
      ).toBe(status);
    }
  });

  it("approved row mang resetTokenHash + resetTokenExpiresAt + consumedAt (single-use)", async () => {
    const subjectId = await mkUser();
    created.users.push(subjectId);
    const r = await db.orm.public.AccountRecoveryRequest.create(
      mkRequestRow(subjectId, {
        status: "approved",
        phoneHash: "c".repeat(64),
        resetTokenHash: "d".repeat(64),
        resetTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    );
    created.requests.push(r.id);
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: r.id });
    expect(row!.resetTokenHash).toBe("d".repeat(64));
    expect(row!.resetTokenExpiresAt).toBeTruthy();
    expect(row!.consumedAt).toBeNull();
    // consume — set consumedAt (single-use), status chuyển consumed
    await db.orm.public.AccountRecoveryRequest.where({ id: r.id }).updateAll({
      status: "consumed",
      consumedAt: new Date().toISOString(),
    });
    const consumed = await db.orm.public.AccountRecoveryRequest.first({ id: r.id });
    expect(consumed!.status).toBe("consumed");
    expect(consumed!.consumedAt).toBeTruthy();
  });
});

// ─── 2. CHECK account_recovery_checks_range (2..3) ──────────────────────────

d("CHECK account_recovery_checks_range holds", () => {
  it("checksPassed 0 / 1 / 4 bị từ chối (23514) — DB chặn cả khi action bị bypass", async () => {
    for (const bad of [0, 1, 4]) {
      const subjectId = await mkUser();
      created.users.push(subjectId);
      const err = await expectCheckViolation(() =>
        db.orm.public.AccountRecoveryRequest.create(
          mkRequestRow(subjectId, { checksPassed: bad }),
        ),
      );
      expect(err.constraint).toMatch(/^account_recovery_checks_range_/);
      expect(err.table).toBe("AccountRecoveryRequest");
    }
  });

  it("checksPassed 2 và 3 được chấp nhận (founder FD-R3: ≥ 2/3 câu đúng)", async () => {
    for (const ok of [2, 3]) {
      const subjectId = await mkUser();
      created.users.push(subjectId);
      const r = await db.orm.public.AccountRecoveryRequest.create(
        mkRequestRow(subjectId, { checksPassed: ok }),
      );
      created.requests.push(r.id);
      expect(
        (await db.orm.public.AccountRecoveryRequest.first({ id: r.id }))!.checksPassed,
      ).toBe(ok);
    }
  });
});

// ─── 3. Partial unique account_recovery_one_open ────────────────────────────

d("partial unique account_recovery_one_open holds", () => {
  it("MỘT row mở duy nhất per user; rejected/cancelled/expired/consumed cùng sống", async () => {
    const subjectId = await mkUser();
    created.users.push(subjectId);

    // row requested ĐẦU TIÊN
    const requested = await db.orm.public.AccountRecoveryRequest.create(
      mkRequestRow(subjectId, { phoneHash: `h-a-${uid()}`.slice(0, 64) }),
    );
    created.requests.push(requested.id);

    // row requested THỨ HAI cùng user → 23505 (partial unique — index chỉ
    // cover status='requested' OR approved-unconsumed)
    const err = await expectUniqueViolation(() =>
      db.orm.public.AccountRecoveryRequest.create(
        mkRequestRow(subjectId, { phoneHash: `h-b-${uid()}`.slice(0, 64) }),
      ),
    );
    // tên wire + hash suffix (prefix match — precedent corrections item 9 b7)
    expect(err.constraint).toMatch(/^account_recovery_one_open_/);
    expect(err.table).toBe("AccountRecoveryRequest");

    // row KHÔNG mở cùng sống (audit trail — rejected/cancelled/expired/consumed)
    for (const status of ["rejected", "cancelled", "expired", "consumed"] as const) {
      const row = await db.orm.public.AccountRecoveryRequest.create(
        mkRequestRow(subjectId, {
          status,
          phoneHash: `h-${status}-${uid()}`.slice(0, 64),
          ...(status === "consumed" ? { consumedAt: new Date().toISOString() } : {}),
        }),
      );
      created.requests.push(row.id);
      expect(
        (await db.orm.public.AccountRecoveryRequest.first({ id: row.id }))!.status,
      ).toBe(status);
    }

    // row requested cho USER KHÁC tự do (index là per user)
    const otherUser = await mkUser();
    created.users.push(otherUser);
    const otherUserRow = await db.orm.public.AccountRecoveryRequest.create(
      mkRequestRow(otherUser, { phoneHash: `h-other-${uid()}`.slice(0, 64) }),
    );
    created.requests.push(otherUserRow.id);
    expect(
      (await db.orm.public.AccountRecoveryRequest.first({ id: otherUserRow.id }))!.userId,
    ).toBe(otherUser);
  });

  it("approved-unconsumed cũng chiếm slot (một link reset sống tối đa per user)", async () => {
    const subjectId = await mkUser();
    created.users.push(subjectId);
    const approved = await db.orm.public.AccountRecoveryRequest.create(
      mkRequestRow(subjectId, {
        status: "approved",
        phoneHash: `h-ap-${uid()}`.slice(0, 64),
        resetTokenHash: "e".repeat(64),
        resetTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    );
    created.requests.push(approved.id);

    // requested mới cùng user → 23505 (approved-unconsumed còn mở)
    const err = await expectUniqueViolation(() =>
      db.orm.public.AccountRecoveryRequest.create(
        mkRequestRow(subjectId, { phoneHash: `h-ap2-${uid()}`.slice(0, 64) }),
      ),
    );
    expect(err.constraint).toMatch(/^account_recovery_one_open_/);

    // consume xong → slot mở lại (consumed không còn trong predicate)
    await db.orm.public.AccountRecoveryRequest.where({ id: approved.id }).updateAll({
      status: "consumed",
      consumedAt: new Date().toISOString(),
    });
    const after = await db.orm.public.AccountRecoveryRequest.create(
      mkRequestRow(subjectId, { phoneHash: `h-ap3-${uid()}`.slice(0, 64) }),
    );
    created.requests.push(after.id);
    expect(
      (await db.orm.public.AccountRecoveryRequest.first({ id: after.id }))!.status,
    ).toBe("requested");
  });
});

// ─── 4. ops.json package contract ─────────────────────────────────────────────

d("migration ops package contract", () => {
  it("mọi op additive — 1 bảng mới, zero column., zero destructive/data, một account_recovery_one_open, không finance", async () => {
    // đọc ops.json của package — nguồn chân thực planner render
    const migrationsAppDir = fileURLToPath(new URL("../../migrations/app/", import.meta.url));
    const dirName = readdirSync(migrationsAppDir).find((e) =>
      /_account_recovery_request$/.test(e),
    );
    expect(dirName).toBeTruthy(); // package chưa render → fail (đúng ở Step RED)
    const ops = JSON.parse(
      readFileSync(join(migrationsAppDir, dirName!, "ops.json"), "utf8"),
    ) as Array<{ id: string; label: string; operationClass: string; execute?: Array<{ sql: string }> }>;

    // 1 bảng mới — toàn bộ op "table." là CREATE (không drop bảng nào)
    const tableOps = ops.filter((o) => o.id.startsWith("table."));
    expect(tableOps.map((o) => o.id)).toEqual(["table.AccountRecoveryRequest"]);
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

    // partial unique index account_recovery_one_open render — đúng MỘT op,
    // tên wire + hash suffix
    const oneOpenOps = ops.filter((o) =>
      /^index\.AccountRecoveryRequest\.account_recovery_one_open_/i.test(o.id),
    );
    expect(oneOpenOps).toHaveLength(1);

    // predicate render PHẢI quote cột camelCase + giá trị enum (precedent
    // corrections item 5 b7: unquoted folds trong Postgres → index chết im)
    const oneOpenSql = (oneOpenOps[0]!.execute ?? []).map((s) => s.sql).join("\n");
    expect(oneOpenSql).toContain("CREATE UNIQUE INDEX");
    expect(oneOpenSql).toContain(`"status" = 'requested'`);
    expect(oneOpenSql).toContain(`"status" = 'approved'`);
    expect(oneOpenSql).toContain(`"consumedAt" IS NULL`);
    expect(oneOpenSql).toContain(`"userId"`);

    // CHECK account_recovery_checks_range render TRONG createTable
    // (checkExpression trong constraints — KHÔNG phải op riêng): assert
    // presence trong migration.ts của package — runtime 23514 test bên trên
    // chứng minh constraint sống trong DB.
    const migrationTs = readFileSync(join(migrationsAppDir, dirName!, "migration.ts"), "utf8");
    expect(migrationTs).toMatch(/checkExpression\(\s*'account_recovery_checks_range_/);

    // KHÔNG op nào chạm bảng finance (Global rules — no finance table)
    const FINANCE_TABLES =
      /Order|Payment|Payout|WithdrawRequest|LedgerEntry|Dispute|Cart|CartItem|Offer|ExchangeOffer|Wallet/i;
    for (const op of ops) {
      expect(op.id, `op finance: ${op.id}`).not.toMatch(FINANCE_TABLES);
    }
  });
});

// ─── 5. Marker + schema khớp contract sau migrate ─────────────────────────────

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 6. Finance legacy giữ nguyên (spec §4.3 + §8.1) ───────────────────────────

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
      code: `ARR-${uid()}`,
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

// ─── 7. Batch 2 tables nhận create + read round-trip (graph không xáo trộn) ────

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
      action: "account.manual_recovery_requested",
      reason: "typed_reason_code",
    });
    created.auditEvents.push(ae.id);
    expect((await db.orm.public.AuditEvent.first({ id: ae.id }))!.action).toBe(
      "account.manual_recovery_requested",
    );

    // delete round-trip — migration không làm xáo trộn graph Batch 2
    await db.orm.public.UserSession.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSession.first({ id: s.id })).toBeNull();
    await db.orm.public.AuditEvent.where({ id: ae.id }).delete();
    expect(await db.orm.public.AuditEvent.first({ id: ae.id })).toBeNull();
  });
});
