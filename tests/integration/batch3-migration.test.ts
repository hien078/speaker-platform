/**
 * Batch 3 migration integration tests — plan Task 1 (batch 3), spec §8
 * (migration strategy: additive-first) + §5.5/§5.5.1 (trust & safety models)
 * + §7.8 (suspension) + §9 Batch 3.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `batch3_trust_safety` (Task 1):
 *  - ADDITIVE: 7 model mới (AbuseReport, ModerationCase, ModerationEvidence,
 *    ModerationAction, UserBlock, UserSuspension, Appeal) nhận create + read
 *    round-trip với đúng field contract; create + DELETE round-trip cho mọi
 *    model TRỪ ModerationEvidence — evidence không có delete path trong
 *    product flow (spec §5.5.1 immutable) và test giữ nguyên posture đó;
 *  - ENUM: ModerationCase nhận đủ 7 state §5.5 + 3 priority; AbuseReport nhận
 *    đủ 9 reason code §5.5 + 3 target type (loop create + read back);
 *  - R2: Listing nhận status "removed" (giá trị enum mới — Batch 3 là first
 *    writer); ops.json của migration chỉ chứa create/createIndex + cặp
 *    DROP+ADD của Listing_status_check_* (BLOCKING-2 — pg/text enum value
 *    sống trong CHECK constraint nên thêm value render lại constraint —
 *    additive in effect), KHÔNG drop/alter cột/bảng nào đang có;
 *  - UNIQUE: UserBlock (blockerId, blockedId), Appeal.caseId (one-to-one),
 *    AbuseReport (caseId, reporterId) chặn duplicate; 2 partial unique index
 *    (một case active duy nhất per (target, reason) — closed case cùng key
 *    cùng tồn tại được; một suspension active duy nhất per user — lifted
 *    cùng tồn tại được) chặn đúng race (Task 4/5);
 *  - `npx prisma db verify` exit 0 sau migrate (marker + schema khớp contract);
 *  - bảng finance legacy (Order, Payment, Payout, WithdrawRequest,
 *    LedgerEntry, Dispute) + Batch 2 (UserSession, SellerVerification,
 *    BetaCohortMembership, AuditEvent) vẫn đọc/ghi được (spec §4.3).
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
const uid = () => `b3-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B3 ${role}`,
    role,
  });
  return u.id;
}

async function mkCase(targetId: string): Promise<string> {
  const c = await db.orm.public.ModerationCase.create({
    targetType: "listing",
    targetId,
    reasonCategory: "suspected_scam",
  });
  return c.id;
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
// thứ tự ngược FK để không bị Restrict chặn. ModerationEvidence KHÔNG bao giờ
// bị delete (spec §5.5.1 — immutable từ product flow; test giữ posture đó) —
// case giữ evidence đi kèm và được bỏ qua khi dọn (DB scratch bị vứt sau run).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  appeals: [] as string[],
  moderationActions: [] as string[],
  abuseReports: [] as string[],
  userBlocks: [] as string[],
  userSuspensions: [] as string[],
  moderationCases: [] as string[], // case KHÔNG giữ evidence — dọn được
  moderationCasesWithEvidence: [] as string[], // giữ lại — evidence không delete
  sessions: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
  auditEvents: [] as string[],
  orders: [] as string[],
  payments: [] as string[],
};

afterEach(async () => {
  for (const id of created.appeals) {
    await db.orm.public.Appeal.where({ id }).delete();
  }
  for (const id of created.moderationActions) {
    await db.orm.public.ModerationAction.where({ id }).delete();
  }
  for (const id of created.abuseReports) {
    await db.orm.public.AbuseReport.where({ id }).delete();
  }
  for (const id of created.userBlocks) {
    await db.orm.public.UserBlock.where({ id }).delete();
  }
  for (const id of created.userSuspensions) {
    await db.orm.public.UserSuspension.where({ id }).delete();
  }
  for (const id of created.moderationCases) {
    await db.orm.public.ModerationCase.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.auditEvents) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).delete();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).delete();
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

// ─── 1. Additive: 7 model mới nhận create + read (+ delete) round-trip ───

d("applies the batch 3 migration additively", () => {
  it("AbuseReport — typed reason + case linkage (spec §5.5)", async () => {
    const reporterId = await mkUser();
    created.users.push(reporterId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCases.push(caseId);
    const r = await db.orm.public.AbuseReport.create({
      reporterId,
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCode: "suspected_scam",
      note: "ghi chú người báo cáo",
      caseId,
    });
    created.abuseReports.push(r.id);
    const row = await db.orm.public.AbuseReport.first({ id: r.id });
    expect(row!.reporterId).toBe(reporterId);
    expect(row!.targetType).toBe("listing");
    expect(row!.reasonCode).toBe("suspected_scam");
    expect(row!.note).toBe("ghi chú người báo cáo");
    expect(row!.caseId).toBe(caseId);
    expect(row!.createdAt).toBeTruthy();
    await db.orm.public.AbuseReport.where({ id: r.id }).delete();
    expect(await db.orm.public.AbuseReport.first({ id: r.id })).toBeNull();
  });

  it("ModerationCase — state/priority/assignment (spec §5.5)", async () => {
    const moderatorId = await mkUser("admin");
    created.users.push(moderatorId);
    const c = await db.orm.public.ModerationCase.create({
      targetType: "user",
      targetId: `user-${uid()}`,
      state: "triaged",
      priority: "high",
      assignedModeratorId: moderatorId,
      reasonCategory: "harassment",
    });
    created.moderationCases.push(c.id);
    const row = await db.orm.public.ModerationCase.first({ id: c.id });
    expect(row!.targetType).toBe("user");
    expect(row!.state).toBe("triaged");
    expect(row!.priority).toBe("high");
    expect(row!.assignedModeratorId).toBe(moderatorId);
    expect(row!.reasonCategory).toBe("harassment");
    expect(row!.createdAt).toBeTruthy();
    expect(row!.updatedAt).toBeTruthy();
    await db.orm.public.ModerationCase.where({ id: c.id }).delete();
    expect(await db.orm.public.ModerationCase.first({ id: c.id })).toBeNull();
  });

  it("ModerationEvidence — snapshot jsonb bất biến, create + read ONLY (spec §5.5.1)", async () => {
    const subjectId = await mkUser("seller");
    const reporterId = await mkUser();
    created.users.push(subjectId, reporterId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCasesWithEvidence.push(caseId); // KHÔNG dọn — evidence không delete
    const snapshot = {
      kind: "listing",
      id: `listing-${uid()}`,
      title: "JBL Charge 5",
      price: 1_500_000,
      capturedAt: new Date().toISOString(),
    };
    const e = await db.orm.public.ModerationEvidence.create({
      caseId,
      sourceResourceType: "listing",
      sourceResourceId: snapshot.id,
      relevantSnapshot: snapshot,
      subjectUserId: subjectId,
      reporterUserId: reporterId,
      classification: "suspected_scam",
    });
    const row = await db.orm.public.ModerationEvidence.first({ id: e.id });
    expect(row!.caseId).toBe(caseId);
    expect(row!.sourceResourceType).toBe("listing");
    expect(row!.sourceResourceId).toBe(snapshot.id);
    expect(row!.relevantSnapshot).toEqual(snapshot); // jsonb deep-equal
    expect(row!.subjectUserId).toBe(subjectId);
    expect(row!.reporterUserId).toBe(reporterId);
    expect(row!.classification).toBe("suspected_scam");
    expect(row!.capturedAt).toBeTruthy();
    // KHÔNG delete — evidence không có delete path trong product flow (§5.5.1)
  });

  it("ModerationAction — case-scoped history, actor nullable (spec §5.5)", async () => {
    const actorId = await mkUser("admin");
    created.users.push(actorId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCases.push(caseId);
    const a = await db.orm.public.ModerationAction.create({
      caseId,
      actorId,
      actionType: "case.transitioned",
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCode: "policy_violation_confirmed",
      note: "đã qua redactDetail",
    });
    created.moderationActions.push(a.id);
    const row = await db.orm.public.ModerationAction.first({ id: a.id });
    expect(row!.caseId).toBe(caseId);
    expect(row!.actorId).toBe(actorId);
    expect(row!.actionType).toBe("case.transitioned");
    expect(row!.targetType).toBe("listing");
    expect(row!.reasonCode).toBe("policy_violation_confirmed");
    expect(row!.note).toBe("đã qua redactDetail");
    expect(row!.createdAt).toBeTruthy();
    await db.orm.public.ModerationAction.where({ id: a.id }).delete();
    expect(await db.orm.public.ModerationAction.first({ id: a.id })).toBeNull();
  });

  it("UserBlock — directional data (spec §5.5)", async () => {
    const blockerId = await mkUser();
    const blockedId = await mkUser();
    created.users.push(blockerId, blockedId);
    const b = await db.orm.public.UserBlock.create({ blockerId, blockedId });
    created.userBlocks.push(b.id);
    const row = await db.orm.public.UserBlock.first({ id: b.id });
    expect(row!.blockerId).toBe(blockerId);
    expect(row!.blockedId).toBe(blockedId);
    expect(row!.createdAt).toBeTruthy();
    await db.orm.public.UserBlock.where({ id: b.id }).delete();
    expect(await db.orm.public.UserBlock.first({ id: b.id })).toBeNull();
  });

  it("UserSuspension — episode active → lifted, typed reason (spec §7.8)", async () => {
    const userId = await mkUser("seller");
    const actorId = await mkUser("admin");
    created.users.push(userId, actorId);
    const s = await db.orm.public.UserSuspension.create({
      userId,
      reasonCode: "confirmed_abuse",
      suspendedById: actorId,
    });
    created.userSuspensions.push(s.id);
    const row = await db.orm.public.UserSuspension.first({ id: s.id });
    expect(row!.userId).toBe(userId);
    expect(row!.status).toBe("active"); // default
    expect(row!.reasonCode).toBe("confirmed_abuse");
    expect(row!.suspendedById).toBe(actorId);
    expect(row!.liftedAt).toBeNull();
    expect(row!.liftReasonCode).toBeNull();
    expect(row!.suspendedAt).toBeTruthy();
    await db.orm.public.UserSuspension.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSuspension.first({ id: s.id })).toBeNull();
  });

  it("Appeal — foundation one-to-one với case (spec §9 Batch 3)", async () => {
    const appellantId = await mkUser();
    created.users.push(appellantId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCases.push(caseId);
    const ap = await db.orm.public.Appeal.create({
      caseId,
      appellantId,
      statement: "lời trình bày của subject",
    });
    created.appeals.push(ap.id);
    const row = await db.orm.public.Appeal.first({ id: ap.id });
    expect(row!.caseId).toBe(caseId);
    expect(row!.appellantId).toBe(appellantId);
    expect(row!.statement).toBe("lời trình bày của subject");
    expect(row!.state).toBe("submitted"); // default
    expect(row!.closedAt).toBeNull();
    expect(row!.createdAt).toBeTruthy();
    expect(row!.updatedAt).toBeTruthy();
    await db.orm.public.Appeal.where({ id: ap.id }).delete();
    expect(await db.orm.public.Appeal.first({ id: ap.id })).toBeNull();
  });
});

// ─── 2. Enum values khớp spec §5.5 (loop create + read back) ───

d("enum values match the spec", () => {
  const CASE_STATES = [
    "open",
    "triaged",
    "investigating",
    "actioned",
    "dismissed",
    "appealed",
    "closed",
  ] as const;
  const PRIORITIES = ["low", "normal", "high"] as const;
  const REASONS = [
    "suspected_scam",
    "harassment",
    "spam",
    "counterfeit_claim",
    "misleading_listing",
    "prohibited_content",
    "unsafe_behavior",
    "identity_impersonation",
    "other",
  ] as const;
  it("ModerationCase nhận đủ 7 state §5.5", async () => {
    for (const state of CASE_STATES) {
      const c = await db.orm.public.ModerationCase.create({
        targetType: "listing",
        targetId: `listing-${uid()}`,
        state,
        reasonCategory: "other",
      });
      created.moderationCases.push(c.id);
      const row = await db.orm.public.ModerationCase.first({ id: c.id });
      expect(row!.state).toBe(state);
    }
  });

  it("ModerationCase nhận đủ 3 priority", async () => {
    for (const priority of PRIORITIES) {
      const c = await db.orm.public.ModerationCase.create({
        targetType: "listing",
        targetId: `listing-${uid()}`,
        priority,
        reasonCategory: "other",
      });
      created.moderationCases.push(c.id);
      const row = await db.orm.public.ModerationCase.first({ id: c.id });
      expect(row!.priority).toBe(priority);
    }
  });

  it("AbuseReport nhận đủ 9 reason code §5.5", async () => {
    const reporterId = await mkUser();
    created.users.push(reporterId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCases.push(caseId);
    for (const reasonCode of REASONS) {
      // xóa sau mỗi vòng lặp — free lại (caseId, reporterId) cho lần kế
      const r = await db.orm.public.AbuseReport.create({
        reporterId,
        targetType: "listing",
        targetId: `listing-${uid()}`,
        reasonCode,
        caseId,
      });
      const row = await db.orm.public.AbuseReport.first({ id: r.id });
      expect(row!.reasonCode).toBe(reasonCode);
      await db.orm.public.AbuseReport.where({ id: r.id }).delete();
    }
  });

  it("AbuseReport nhận đủ 3 target type", async () => {
    const reporterId = await mkUser();
    created.users.push(reporterId);
    const caseId = await mkCase(`user-${uid()}`);
    created.moderationCases.push(caseId);
    for (const targetType of ["listing", "user", "message"] as const) {
      const r = await db.orm.public.AbuseReport.create({
        reporterId,
        targetType,
        targetId: `${targetType}-${uid()}`,
        reasonCode: "other",
        caseId,
      });
      const row = await db.orm.public.AbuseReport.first({ id: r.id });
      expect(row!.targetType).toBe(targetType);
      await db.orm.public.AbuseReport.where({ id: r.id }).delete();
    }
  });
});

// ─── 3. R2: listing_status gains removed — additive in effect ───

d("listing_status gains removed (R2)", () => {
  it("Listing nhận status 'removed' (create + read back)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const cat = await db.orm.public.Category.create({
      name: `B3 cat ${uid()}`,
      slug: `b3-cat-${uid()}`,
    });
    created.categories.push(cat.id);
    const l = await db.orm.public.Listing.create({
      sellerId,
      categoryId: cat.id,
      title: `Loa B3 ${uid()}`,
      slug: `loa-b3-${uid()}`,
      description: "removed by moderation",
      condition: "good",
      price: 1_000_000,
      status: "removed", // R2 — giá trị enum mới của Batch 3
      city: "Hà Nội",
    });
    created.listings.push(l.id);
    const row = await db.orm.public.Listing.first({ id: l.id });
    expect(row!.status).toBe("removed");
    await db.orm.public.Listing.where({ id: l.id }).delete();
    expect(await db.orm.public.Listing.first({ id: l.id })).toBeNull();
  });

  it("migration ops: chỉ create/createIndex + cặp Listing_status_check_* DROP+ADD (BLOCKING-2)", async () => {
    // đọc ops.json của package batch3 — nguồn chân thực planner render
    const migrationsAppDir = fileURLToPath(new URL("../../migrations/app/", import.meta.url));
    const dirName = readdirSync(migrationsAppDir).find((e) => /_batch3_trust_safety$/.test(e));
    expect(dirName).toBeTruthy(); // package chưa render → fail (đúng ở Step 2 TDD)
    const ops = JSON.parse(
      readFileSync(join(migrationsAppDir, dirName!, "ops.json"), "utf8"),
    ) as Array<{
      id: string;
      label: string;
      operationClass: string;
    }>;

    // 7 bảng mới — toàn bộ op "table." là CREATE (không drop bảng nào)
    const tableOps = ops.filter((o) => o.id.startsWith("table."));
    const createdTables = tableOps.map((o) => o.id);
    expect(
      createdTables.filter((t) =>
        ["table.AbuseReport", "table.ModerationCase", "table.ModerationEvidence",
         "table.ModerationAction", "table.UserBlock", "table.UserSuspension",
         "table.Appeal"].includes(t),
      ),
    ).toHaveLength(7);
    expect(tableOps.filter((o) => /drop/i.test(o.label))).toEqual([]);

    // KHÔNG op cột nào — Batch 3 không thêm cột vào bảng hiện có (User chỉ
    // khai báo relation); mọi drop/alter cột/bảng là plan violation
    expect(ops.filter((o) => o.id.startsWith("column."))).toEqual([]);

    // cặp DROP+ADD của Listing_status_check_* — EXPECTED (BLOCKING-2): pg/text
    // enum value sống trong CHECK constraint nên thêm 'removed' render lại
    // constraint — additive in effect, classify và đi tiếp.
    // (op DROP mang id "dropCheckConstraint.Listing.…", op ADD mang
    // "checkConstraint.Listing.…" — khớp cả hai prefix, case-insensitive)
    const listingCheckRe = /^(drop)?checkconstraint\.listing\.listing_status_check_/i;
    const listingCheckOps = ops.filter((o) => listingCheckRe.test(o.id));
    expect(listingCheckOps).toHaveLength(2);
    expect(listingCheckOps.filter((o) => /drop/i.test(o.label))).toHaveLength(1);
    expect(listingCheckOps.filter((o) => /add/i.test(o.label))).toHaveLength(1);

    // mọi op "destructive" (drop/alter) đều phải là 1 thành viên của cặp trên —
    // không drop/alter cột/bảng/index nào đang có khác
    const destructive = ops.filter((o) => o.operationClass === "destructive");
    for (const op of destructive) {
      expect(op.id).toMatch(listingCheckRe);
    }
    // mọi op drop/alter theo label cũng phải thuộc cặp trên
    for (const op of ops.filter((o) => /drop|alter/i.test(o.label))) {
      expect(op.id).toMatch(listingCheckRe);
    }

    // không data transform — Batch 3 không có backfill (§8.6 thỏa nôm na)
    expect(ops.filter((o) => o.operationClass === "data")).toEqual([]);
  });
});

// ─── 4. Unique constraints + partial unique index đóng race ───

d("unique constraints hold", () => {
  it("UserBlock trùng (blockerId, blockedId) → 23505", async () => {
    const blockerId = await mkUser();
    const blockedId = await mkUser();
    created.users.push(blockerId, blockedId);
    const b = await db.orm.public.UserBlock.create({ blockerId, blockedId });
    created.userBlocks.push(b.id);
    const err = await expectUniqueViolation(() =>
      db.orm.public.UserBlock.create({ blockerId, blockedId }),
    );
    expect(err.constraint).toBe("UserBlock_blockerId_blockedId_key");
  });

  it("Appeal thứ hai cùng caseId → 23505 (one-to-one)", async () => {
    const appellantId = await mkUser();
    created.users.push(appellantId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCases.push(caseId);
    const ap = await db.orm.public.Appeal.create({ caseId, appellantId });
    created.appeals.push(ap.id);
    const err = await expectUniqueViolation(() =>
      db.orm.public.Appeal.create({ caseId, appellantId }),
    );
    expect(err.constraint).toBe("Appeal_caseId_key");
  });

  it("AbuseReport trùng (caseId, reporterId) → 23505", async () => {
    const reporterId = await mkUser();
    created.users.push(reporterId);
    const caseId = await mkCase(`listing-${uid()}`);
    created.moderationCases.push(caseId);
    const r = await db.orm.public.AbuseReport.create({
      reporterId,
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCode: "suspected_scam",
      caseId,
    });
    created.abuseReports.push(r.id);
    const err = await expectUniqueViolation(() =>
      db.orm.public.AbuseReport.create({
        reporterId,
        targetType: "listing",
        targetId: `listing-${uid()}`,
        reasonCode: "harassment",
        caseId,
      }),
    );
    expect(err.constraint).toBe("AbuseReport_caseId_reporterId_key");
  });

  it("ModerationCase: 1 case active duy nhất per (target, reason) — closed case cùng key vẫn sống", async () => {
    const targetId = `listing-${uid()}`;
    // case CLOSED cùng key — ngoài predicate partial index → tạo được
    const closed = await db.orm.public.ModerationCase.create({
      targetType: "listing",
      targetId,
      state: "closed",
      reasonCategory: "suspected_scam",
    });
    created.moderationCases.push(closed.id);
    // case active ĐẦU TIÊN cùng key → được (closed kia không chặn)
    const active = await db.orm.public.ModerationCase.create({
      targetType: "listing",
      targetId,
      state: "open",
      reasonCategory: "suspected_scam",
    });
    created.moderationCases.push(active.id);
    // case active THỨ HAI cùng key → 23505 (partial unique index)
    const err = await expectUniqueViolation(() =>
      db.orm.public.ModerationCase.create({
        targetType: "listing",
        targetId,
        state: "investigating", // vẫn active-state → bị chặn
        reasonCategory: "suspected_scam",
      }),
    );
    expect(err.constraint).toMatch(/^moderation_case_one_active_per_target_reason/);
    // cả hai row đầu vẫn đọc được — race đóng bằng index, không phải xóa
    expect(await db.orm.public.ModerationCase.first({ id: closed.id })).not.toBeNull();
    expect(await db.orm.public.ModerationCase.first({ id: active.id })).not.toBeNull();
  });

  it("UserSuspension: 1 episode active duy nhất per user — lifted cùng tồn tại được", async () => {
    const userId = await mkUser("seller");
    const actorId = await mkUser("admin");
    created.users.push(userId, actorId);
    // episode LIFTED — ngoài predicate → tạo được
    const lifted = await db.orm.public.UserSuspension.create({
      userId,
      status: "lifted",
      reasonCode: "confirmed_spam",
      suspendedById: actorId,
      liftedById: actorId,
      liftedAt: isoFuture(),
      liftReasonCode: "other_reviewed_reason",
    });
    created.userSuspensions.push(lifted.id);
    // episode ACTIVE đầu tiên → được
    const active = await db.orm.public.UserSuspension.create({
      userId,
      reasonCode: "confirmed_abuse",
      suspendedById: actorId,
    });
    created.userSuspensions.push(active.id);
    // episode active THỨ HAI → 23505 (partial unique index)
    const err = await expectUniqueViolation(() =>
      db.orm.public.UserSuspension.create({
        userId,
        reasonCode: "terms_violation",
        suspendedById: actorId,
      }),
    );
    expect(err.constraint).toMatch(/^user_suspension_one_active/);
    expect(await db.orm.public.UserSuspension.first({ id: lifted.id })).not.toBeNull();
    expect(await db.orm.public.UserSuspension.first({ id: active.id })).not.toBeNull();
  });
});

// ─── 5. Marker + schema khớp contract sau migrate ───

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 6. Finance legacy + Batch 2 giữ nguyên (spec §4.3 + §8.1) ───

d("preserves finance and batch 2 tables", () => {
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
      code: `B3-${uid()}`,
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
    expect(order!.commissionAmount).toBe(25_000);
    expect(order!.sellerPayout).toBe(475_000);
    const payment = await db.orm.public.Payment.first({ id: p.id });
    expect(payment!.orderId).toBe(o.id);
    expect(payment!.status).toBe("pending");
    expect(payment!.amount).toBe(500_000);
  });

  it("UserSession/SellerVerification/BetaCohortMembership/AuditEvent (Batch 2) vẫn create + read", async () => {
    const userId = await mkUser("seller");
    const actorId = await mkUser("admin");
    created.users.push(userId, actorId);

    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: "e".repeat(64),
      isAdmin: false,
      expiresAt: isoFuture(),
    });
    created.sessions.push(s.id);
    expect((await db.orm.public.UserSession.first({ id: s.id }))!.tokenHash).toBe("e".repeat(64));

    const v = await db.orm.public.SellerVerification.create({
      userId,
      status: "pending",
      method: "operations_review",
      policyVersion: "v1",
    });
    created.sellerVerifications.push(v.id);
    expect((await db.orm.public.SellerVerification.first({ id: v.id }))!.status).toBe("pending");

    const m = await db.orm.public.BetaCohortMembership.create({
      userId,
      cohort: "founding_seller",
      status: "active",
    });
    created.betaMemberships.push(m.id);
    expect((await db.orm.public.BetaCohortMembership.first({ id: m.id }))!.cohort).toBe(
      "founding_seller",
    );

    const e = await db.orm.public.AuditEvent.create({
      actorId,
      subjectId: userId,
      action: "moderation.user_suspended",
      resourceType: "User",
      resourceId: userId,
      reason: "confirmed_abuse",
      sessionId: s.id,
      ipHash: "f".repeat(64),
      detail: '{"scope":"it"}',
    });
    created.auditEvents.push(e.id);
    const row = await db.orm.public.AuditEvent.first({ id: e.id });
    expect(row!.action).toBe("moderation.user_suspended");
    expect(row!.reason).toBe("confirmed_abuse");
  });
});
