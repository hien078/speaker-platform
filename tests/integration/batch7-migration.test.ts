/**
 * Batch 7 migration integration tests — plan Task 1 (batch 7), spec §5.10
 * (Founding Seller Operations — FoundingSellerCandidate + BetaInviteToken +
 * 2 enum), §8.4 (Beta Cohort — KHÔNG auto-membership: existing users do not
 * automatically become founding sellers), §9 Batch 7 + §4.3 (historical
 * preservation).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `batch7_cohort_operations` (Task 1):
 *  - ADDITIVE (T3): FoundingSellerCandidate + BetaInviteToken nhận create +
 *    read round-trip với đúng field contract §5.10; 2 enum mới nhận đủ giá
 *    trị spec (10 trạng thái lifecycle §5.10 NGUYÊN VĂN + 2 kênh invite);
 *    KHÔNG cột nào bị thêm vào bảng hiện có (chỉ relation declarations trên
 *    User — zero `column.` ops);
 *  - UNIQUE (Global Constraints — tên constraint cho classify rule):
 *    BetaInviteToken_tokenHash_key (tokenHash @unique — HMAC hex),
 *    FoundingSellerCandidate_userId_key (userId @unique — một candidate per
 *    linked seller; nhiều row NULL userId cùng sống — nhiều prospect),
 *    beta_invite_one_active (PARTIAL unique — một token active [chưa consume,
 *    chưa revoke] duy nhất per candidate, đóng race re-invite; token đã
 *    consume/revoke được GIỮ làm audit trail);
 *  - ops.json (corrections item 4 — mirror batch6 :380-422): mọi op additive —
 *    chỉ create/createIndex/unique/foreignKey; zero destructive, zero data
 *    transform (§8.4 — không auto-membership backfill), zero `column.` op,
 *    không cặp Listing_status_check_* nào (Batch 7 KHÔNG thêm giá trị
 *    listing_status); đúng một op index beta_invite_one_active (tên wire +
 *    hash suffix); KHÔNG op nào chạm bảng finance;
 *  - partial index predicate (corrections item 5): SQL render trong ops.json
 *    chứa `"consumedAt" IS NULL AND "revokedAt" IS NULL` — cột camelCase
 *    PHẢI trong quote (unquoted folds thành consumedat trong Postgres);
 *  - `npx prisma db verify` exit 0 sau migrate;
 *  - bảng finance legacy (Order, Payment, Payout, WithdrawRequest,
 *    LedgerEntry, Dispute) vẫn đọc được + seeded Order+Payment đọc lại
 *    nguyên vẹn (spec §4.3/§8.1);
 *  - Batch 2/3/4/5/6 (UserSession, AuditEvent, BetaCohortMembership,
 *    SellerVerification, UserSuspension, ModerationCase, ListingImageUpload,
 *    ProductEvent, SearchAlias, Deal, DealStatusHistory) nhận create + read
 *    round-trip — migration Batch 7 không làm xáo trộn graph batch trước;
 *  - §8.4 (Review Focus 5): user mới tạo qua raw create KHÔNG nhận
 *    BetaCohortMembership nào (delta assertion — không phải global count),
 *    adminRole/sellerType không bị đụng — không DB trigger/default/transform
 *    nào auto-grant.
 *
 * FK decisions (Legacy Migration Decisions + corrections item 32):
 *  - BetaInviteToken.candidate onDelete: Restrict (tường minh — token row
 *    không bao giờ bị xóa bởi product flow; cleanup test xóa token TRƯỚC
 *    candidate);
 *  - FoundingSellerCandidate.userId/assignedOperatorId + BetaInviteToken.
 *    issuedById SetNull (Batch 3 UserSuspension precedent — row sống qua
 *    admin deletion tương lai).
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
const uid = () => `b7-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B7 ${role}`,
    role,
  });
  return u.id;
}

async function mkCategory(): Promise<string> {
  const c = await db.orm.public.Category.create({
    name: `B7 cat ${uid()}`,
    slug: `b7-cat-${uid()}`,
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
// thứ tự ngược FK: BetaInviteToken TRƯỚC FoundingSellerCandidate (candidate
// Restrict — corrections item 32), Deal trước User (buyer/seller Restrict).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  candidates: [] as string[],
  inviteTokens: [] as string[],
  deals: [] as string[],
  productEvents: [] as string[],
  searchAliases: [] as string[],
  imageUploads: [] as string[],
  abuseReports: [] as string[],
  userBlocks: [] as string[],
  userSuspensions: [] as string[],
  moderationCases: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
  auditEvents: [] as string[],
  sessions: [] as string[],
  ledgerEntries: [] as string[],
  payments: [] as string[],
  payouts: [] as string[],
  orders: [] as string[],
};

afterEach(async () => {
  // BetaInviteToken — candidate Restrict ⇒ PHẢI đứng trước candidate
  // (corrections item 32: token row không bao giờ bị product flow xóa —
  // đây là cleanup fixture test tự tạo, KHÔNG phải product flow)
  for (const id of created.inviteTokens) {
    await db.orm.public.BetaInviteToken.where({ id }).delete();
  }
  for (const id of created.candidates) {
    await db.orm.public.FoundingSellerCandidate.where({ id }).delete();
  }
  // Deal — DealStatusHistory Cascade theo dealId (KHÔNG xóa history riêng)
  for (const id of created.deals) {
    await db.orm.public.Deal.where({ id }).delete();
  }
  // ProductEvent/SearchAlias — KHÔNG FK (Batch 5 precedent)
  for (const id of created.productEvents) {
    await db.orm.public.ProductEvent.where({ id }).delete();
  }
  for (const id of created.searchAliases) {
    await db.orm.public.SearchAlias.where({ id }).delete();
  }
  for (const id of created.imageUploads) {
    await db.orm.public.ListingImageUpload.where({ id }).delete();
  }
  for (const id of created.abuseReports) {
    await db.orm.public.AbuseReport.where({ id }).delete();
  }
  for (const id of created.moderationCases) {
    await db.orm.public.ModerationCase.where({ id }).delete();
  }
  for (const id of created.userBlocks) {
    await db.orm.public.UserBlock.where({ id }).delete();
  }
  for (const id of created.userSuspensions) {
    await db.orm.public.UserSuspension.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).delete();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).delete();
  }
  for (const id of created.auditEvents) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  for (const id of created.sessions) {
    await db.orm.public.UserSession.where({ id }).delete();
  }
  for (const id of created.ledgerEntries) {
    await db.orm.public.LedgerEntry.where({ id }).delete();
  }
  for (const id of created.payments) {
    await db.orm.public.Payment.where({ id }).delete();
  }
  for (const id of created.payouts) {
    await db.orm.public.Payout.where({ id }).delete();
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

// ─── 1. Additive: FoundingSellerCandidate + BetaInviteToken (spec §5.10, T3) ───

d("applies the batch 7 migration additively", () => {
  it("FoundingSellerCandidate — create + read round-trip với đủ field contract §5.10", async () => {
    const userId = await mkUser("seller"); // liên kết SAU khi nhận lời mời
    const operatorId = await mkUser("admin"); // assignedOperator
    created.users.push(userId, operatorId);

    // full field contract §5.10
    const c = await db.orm.public.FoundingSellerCandidate.create({
      userId,
      contactReference: "lienhe@example.com", // ĐÃ CHUẨN HÓA — chỉ để bind invite; render console luôn MASK
      contactChannel: "email",
      source: "Facebook group Loa Việt",
      targetCommunity: "ha-noi", // slug code tỉnh canonical (src/lib/provinces.ts — FD-1)
      status: "invited",
      assignedOperatorId: operatorId,
      invitedAt: isoFuture(),
      registeredAt: null,
      verifiedAt: null,
      firstListingAt: null,
      qualityListingCount: 3, // §12.2 — ops cập nhật thủ công (A3), KHÔNG auto-compute
      lastContactAt: isoFuture(),
      notes: "ops note — redactDetail trước khi lưu (action layer)",
    });
    created.candidates.push(c.id);

    const row = await db.orm.public.FoundingSellerCandidate.first({ id: c.id });
    expect(row!.userId).toBe(userId);
    expect(row!.contactReference).toBe("lienhe@example.com");
    expect(row!.contactChannel).toBe("email");
    expect(row!.source).toBe("Facebook group Loa Việt");
    expect(row!.targetCommunity).toBe("ha-noi");
    expect(row!.status).toBe("invited");
    expect(row!.assignedOperatorId).toBe(operatorId);
    expect(row!.invitedAt).toBeTruthy();
    expect(row!.registeredAt).toBeNull();
    expect(row!.verifiedAt).toBeNull();
    expect(row!.firstListingAt).toBeNull();
    expect(row!.qualityListingCount).toBe(3);
    expect(row!.lastContactAt).toBeTruthy();
    expect(row!.notes).toBe("ops note — redactDetail trước khi lưu (action layer)");
    expect(row!.createdAt).toBeTruthy();
    expect(row!.updatedAt).toBeTruthy();

    // create tối thiểu — mọi cột mới nullable/defaulted (additive-only):
    // prospect chưa có tài khoản (userId null), chưa có contact
    const minimal = await db.orm.public.FoundingSellerCandidate.create({
      source: "Zalo community",
      targetCommunity: "tp-ho-chi-minh",
    });
    created.candidates.push(minimal.id);
    const minRow = await db.orm.public.FoundingSellerCandidate.first({ id: minimal.id });
    expect(minRow!.status).toBe("prospect"); // @default(prospect)
    expect(minRow!.qualityListingCount).toBe(0); // @default(0)
    expect(minRow!.userId).toBeNull(); // prospect chưa có tài khoản
    expect(minRow!.contactReference).toBeNull();
    expect(minRow!.contactChannel).toBeNull();
    expect(minRow!.assignedOperatorId).toBeNull();
    expect(minRow!.invitedAt).toBeNull();
    expect(minRow!.registeredAt).toBeNull();
    expect(minRow!.verifiedAt).toBeNull();
    expect(minRow!.firstListingAt).toBeNull();
    expect(minRow!.lastContactAt).toBeNull();
    expect(minRow!.notes).toBeNull();
  });

  it("FoundingSellerCandidate.status nhận đủ 10 trạng thái lifecycle §5.10 (NGUYÊN VĂN)", async () => {
    // spec §5.10 lifecycle — mười trạng thái, không thêm/bớt (§4.11 non-invention)
    const TEN_STATUSES = [
      "prospect",
      "invited",
      "registered",
      "verification_pending",
      "verified",
      "concierge_onboarding",
      "first_listing",
      "active_founding_seller",
      "inactive",
      "exited",
    ] as const;
    expect(TEN_STATUSES).toHaveLength(10);
    for (const status of TEN_STATUSES) {
      const c = await db.orm.public.FoundingSellerCandidate.create({
        source: `src ${status}`,
        targetCommunity: "ha-noi",
        status,
      });
      created.candidates.push(c.id);
      expect((await db.orm.public.FoundingSellerCandidate.first({ id: c.id }))!.status).toBe(status);
    }
  });

  it("BetaInviteToken — create + read round-trip (HMAC hash, single-use claim, revoke flag)", async () => {
    const issuerId = await mkUser("admin"); // issuedBy — nullable + SetNull
    const linkedUserId = await mkUser("seller");
    created.users.push(issuerId, linkedUserId);
    const candidate = await db.orm.public.FoundingSellerCandidate.create({
      userId: linkedUserId,
      contactReference: "0901234567",
      contactChannel: "phone",
      source: "referral",
      targetCommunity: "da-nang",
      status: "invited",
    });
    created.candidates.push(candidate.id);

    // full field contract — token thô KHÔNG bao giờ lưu, chỉ HMAC keyed
    const t = await db.orm.public.BetaInviteToken.create({
      candidateId: candidate.id,
      channel: "phone",
      target: "0901234567", // đã chuẩn hóa (normalizePhone Batch 2) — bind kênh
      tokenHash: `hmac-${uid()}`, // HMAC-SHA256(token, hkdfKey("beta-invite-hash")) hex
      issuedById: issuerId,
      expiresAt: isoFuture(),
      consumedAt: null,
      revokedAt: null,
    });
    created.inviteTokens.push(t.id);

    const row = await db.orm.public.BetaInviteToken.first({ id: t.id });
    expect(row!.candidateId).toBe(candidate.id);
    expect(row!.channel).toBe("phone");
    expect(row!.target).toBe("0901234567");
    expect(row!.tokenHash).toBe(t.tokenHash);
    expect(row!.issuedById).toBe(issuerId);
    expect(row!.expiresAt).toBeTruthy();
    expect(row!.consumedAt).toBeNull(); // single-use — chưa claim
    expect(row!.revokedAt).toBeNull(); // revoke = flag
    expect(row!.createdAt).toBeTruthy();

    // create tối thiểu — issuedBy nullable (row sống qua admin deletion),
    // consumedAt/revokedAt nullable (token active). Candidate RIÊNG — partial
    // unique beta_invite_one_active chỉ cho MỘT token active per candidate
    // (token full ở trên vẫn active cho candidate của nó).
    const minimalCandidate = await db.orm.public.FoundingSellerCandidate.create({
      source: "src minimal token",
      targetCommunity: "nghe-an",
    });
    created.candidates.push(minimalCandidate.id);
    const minimal = await db.orm.public.BetaInviteToken.create({
      candidateId: minimalCandidate.id,
      channel: "email",
      target: "minimal@example.com",
      tokenHash: `hmac-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.inviteTokens.push(minimal.id);
    const minRow = await db.orm.public.BetaInviteToken.first({ id: minimal.id });
    expect(minRow!.issuedById).toBeNull();
    expect(minRow!.consumedAt).toBeNull();
    expect(minRow!.revokedAt).toBeNull();
  });

  it("BetaInviteToken.channel nhận email + phone (beta_invite_channel)", async () => {
    // MỖI kênh một candidate riêng — partial unique beta_invite_one_active
    // chỉ cho một token active per candidate (hai token active cùng một
    // candidate là re-invite race — case ở describe trên).
    for (const channel of ["email", "phone"] as const) {
      const candidate = await db.orm.public.FoundingSellerCandidate.create({
        source: `src channel ${channel}`,
        targetCommunity: "hai-phong",
      });
      created.candidates.push(candidate.id);
      const t = await db.orm.public.BetaInviteToken.create({
        candidateId: candidate.id,
        channel,
        target: channel === "email" ? "a@example.com" : "0901234567",
        tokenHash: `hmac-${uid()}-${channel}`,
        expiresAt: isoFuture(),
      });
      created.inviteTokens.push(t.id);
      expect((await db.orm.public.BetaInviteToken.first({ id: t.id }))!.channel).toBe(channel);
    }
  });
});

// ─── 2. Unique constraints (tên cho classify rule — Global Constraints) ───

d("unique constraints hold", () => {
  it("BetaInviteToken_tokenHash_key — token trùng hash → 23505 (raw duplicate create)", async () => {
    const candidate = await db.orm.public.FoundingSellerCandidate.create({
      source: "src tokenhash",
      targetCommunity: "ha-noi",
    });
    created.candidates.push(candidate.id);
    const tokenHash = `hmac-dup-${uid()}`;
    const first = await db.orm.public.BetaInviteToken.create({
      candidateId: candidate.id,
      channel: "email",
      target: "a@example.com",
      tokenHash,
      expiresAt: isoFuture(),
    });
    created.inviteTokens.push(first.id);

    // raw create thứ hai cùng tokenHash → 23505 (BetaInviteToken_tokenHash_key)
    const err = await expectUniqueViolation(() =>
      db.orm.public.BetaInviteToken.create({
        candidateId: candidate.id,
        channel: "email",
        target: "a@example.com",
        tokenHash, // trùng
        expiresAt: isoFuture(),
      }),
    );
    expect(err.constraint).toBe("BetaInviteToken_tokenHash_key");
    expect(err.table).toBe("BetaInviteToken");
  });

  it("beta_invite_one_active — một token active duy nhất per candidate; consumed/revoked cùng sống (re-invite race guard)", async () => {
    const candidate = await db.orm.public.FoundingSellerCandidate.create({
      source: "src one-active",
      targetCommunity: "ha-noi",
    });
    created.candidates.push(candidate.id);

    // token active ĐẦU TIÊN
    const active = await db.orm.public.BetaInviteToken.create({
      candidateId: candidate.id,
      channel: "email",
      target: "a@example.com",
      tokenHash: `hmac-a-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.inviteTokens.push(active.id);

    // token THỨ HAI active cùng candidate → 23505 (partial unique index —
    // index chỉ cover consumedAt IS NULL AND revokedAt IS NULL)
    const err = await expectUniqueViolation(() =>
      db.orm.public.BetaInviteToken.create({
        candidateId: candidate.id,
        channel: "email",
        target: "a@example.com",
        tokenHash: `hmac-b-${uid()}`,
        expiresAt: isoFuture(),
      }),
    );
    // tên wire + hash suffix (corrections item 9 — prefix match)
    expect(err.constraint).toMatch(/^beta_invite_one_active_/);
    expect(err.table).toBe("BetaInviteToken");

    // consumed token CÙNG sống (single-use đã claim — audit trail giữ lại)
    const consumed = await db.orm.public.BetaInviteToken.create({
      candidateId: candidate.id,
      channel: "email",
      target: "a@example.com",
      tokenHash: `hmac-c-${uid()}`,
      expiresAt: isoFuture(),
      consumedAt: isoFuture(),
    });
    created.inviteTokens.push(consumed.id);
    expect((await db.orm.public.BetaInviteToken.first({ id: consumed.id }))!.consumedAt).toBeTruthy();

    // revoked token CÙNG sống (re-invite = revoke cũ — audit trail giữ lại)
    const revoked = await db.orm.public.BetaInviteToken.create({
      candidateId: candidate.id,
      channel: "email",
      target: "a@example.com",
      tokenHash: `hmac-d-${uid()}`,
      expiresAt: isoFuture(),
      revokedAt: isoFuture(),
    });
    created.inviteTokens.push(revoked.id);
    expect((await db.orm.public.BetaInviteToken.first({ id: revoked.id }))!.revokedAt).toBeTruthy();

    // consumed + revoked KHÔNG chặn token active MỚI (re-invite hợp lệ khi
    // token active cũ đã consume/revoke) — index chỉ đếm row active.
    // Token `active` ở trên VẪN active ⇒ phải CLAIM (atomic consumedAt —
    // cùng pattern updateAll có điều kiện của action layer) trước khi
    // re-issue; đây cũng là lifecycle thật: consume → mời lại được.
    const claimed = await db.orm.public.BetaInviteToken.where({ id: active.id })
      .where((t) => t.consumedAt.isNull())
      .where((t) => t.revokedAt.isNull())
      .updateAll({ consumedAt: new Date().toISOString() });
    expect(claimed).toHaveLength(1); // CAS — đúng row vừa đọc
    const reissued = await db.orm.public.BetaInviteToken.create({
      candidateId: candidate.id,
      channel: "email",
      target: "a@example.com",
      tokenHash: `hmac-e-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.inviteTokens.push(reissued.id);
    expect((await db.orm.public.BetaInviteToken.first({ id: reissued.id }))!.consumedAt).toBeNull();

    // token active cho candidate KHÁC vẫn tự do (index là per candidate)
    const otherCandidate = await db.orm.public.FoundingSellerCandidate.create({
      source: "src other",
      targetCommunity: "ha-noi",
    });
    created.candidates.push(otherCandidate.id);
    const otherActive = await db.orm.public.BetaInviteToken.create({
      candidateId: otherCandidate.id,
      channel: "email",
      target: "b@example.com",
      tokenHash: `hmac-f-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.inviteTokens.push(otherActive.id);
    expect((await db.orm.public.BetaInviteToken.first({ id: otherActive.id }))!.id).toBe(
      otherActive.id,
    );
  });

  it("FoundingSellerCandidate_userId_key — một candidate per linked seller; nhiều prospect NULL cùng sống", async () => {
    const userId = await mkUser("seller");
    created.users.push(userId);

    const first = await db.orm.public.FoundingSellerCandidate.create({
      userId,
      source: "src linked",
      targetCommunity: "ha-noi",
    });
    created.candidates.push(first.id);

    // candidate THỨ HAI cùng userId → 23505 (FoundingSellerCandidate_userId_key)
    const err = await expectUniqueViolation(() =>
      db.orm.public.FoundingSellerCandidate.create({
        userId, // trùng
        source: "src dup",
        targetCommunity: "ha-noi",
      }),
    );
    expect(err.constraint).toBe("FoundingSellerCandidate_userId_key");
    expect(err.table).toBe("FoundingSellerCandidate");

    // nhiều row NULL userId cùng sống — nhiều prospect chưa có tài khoản
    const prospectA = await db.orm.public.FoundingSellerCandidate.create({
      source: "prospect A",
      targetCommunity: "ha-noi",
    });
    const prospectB = await db.orm.public.FoundingSellerCandidate.create({
      source: "prospect B",
      targetCommunity: "tp-ho-chi-minh",
    });
    created.candidates.push(prospectA.id, prospectB.id);
    expect((await db.orm.public.FoundingSellerCandidate.first({ id: prospectA.id }))!.userId).toBeNull();
    expect((await db.orm.public.FoundingSellerCandidate.first({ id: prospectB.id }))!.userId).toBeNull();
  });
});

// ─── 3. ops.json package contract (corrections item 4 + 5) ───

d("migration ops package contract", () => {
  it("mọi op additive — 2 bảng mới, zero column., zero destructive/data, một beta_invite_one_active, không finance", async () => {
    // đọc ops.json của package batch7 — nguồn chân thực planner render
    const migrationsAppDir = fileURLToPath(new URL("../../migrations/app/", import.meta.url));
    const dirName = readdirSync(migrationsAppDir).find((e) => /_batch7_cohort_operations$/.test(e));
    expect(dirName).toBeTruthy(); // package chưa render → fail (đúng ở Step 2 TDD)
    const ops = JSON.parse(
      readFileSync(join(migrationsAppDir, dirName!, "ops.json"), "utf8"),
    ) as Array<{ id: string; label: string; operationClass: string; execute?: Array<{ sql: string }> }>;

    // 2 bảng mới — toàn bộ op "table." là CREATE (không drop bảng nào)
    const tableOps = ops.filter((o) => o.id.startsWith("table."));
    expect(tableOps.map((o) => o.id).sort()).toEqual(
      ["table.BetaInviteToken", "table.FoundingSellerCandidate"].sort(),
    );
    expect(tableOps.filter((o) => /drop|alter/i.test(o.label))).toEqual([]);

    // KHÔNG cột nào bị thêm vào bảng hiện có (User chỉ nhận relation
    // declarations — KHÔNG cột mới; corrections item 4)
    expect(ops.filter((o) => o.id.startsWith("column."))).toEqual([]);

    // zero destructive (additive-only — halt trên MỌI op destructive),
    // zero data transform (§8.4 — không auto-membership backfill),
    // không cặp Listing_status_check_* (Batch 7 KHÔNG thêm giá trị listing_status)
    expect(ops.filter((o) => o.operationClass === "destructive")).toEqual([]);
    expect(ops.filter((o) => o.operationClass === "data")).toEqual([]);
    expect(ops.filter((o) => /drop|alter/i.test(o.label))).toEqual([]);
    expect(ops.filter((o) => /listing_status_check/i.test(o.id))).toEqual([]);

    // partial unique index beta_invite_one_active render — đúng MỘT op,
    // tên wire + hash suffix (corrections item 4)
    const oneActiveOps = ops.filter((o) => /^index\.BetaInviteToken\.beta_invite_one_active_/i.test(o.id));
    expect(oneActiveOps).toHaveLength(1);

    // corrections item 5 — predicate render PHẢI quote cột camelCase:
    // unquoted consumedAt folds thành consumedat trong Postgres → index
    // không bao giờ khớp → race guard chết im. SQL render trong ops.json
    // phải chứa "consumedAt" IS NULL AND "revokedAt" IS NULL.
    const oneActiveSql = (oneActiveOps[0]!.execute ?? []).map((s) => s.sql).join("\n");
    expect(oneActiveSql).toContain('CREATE UNIQUE INDEX');
    expect(oneActiveSql).toContain('"consumedAt" IS NULL AND "revokedAt" IS NULL');

    // KHÔNG op nào chạm bảng finance (Global rules — no finance table)
    const FINANCE_TABLES =
      /Order|Payment|Payout|WithdrawRequest|LedgerEntry|Dispute|Cart|CartItem|Offer|ExchangeOffer|Wallet/i;
    for (const op of ops) {
      expect(op.id, `op finance: ${op.id}`).not.toMatch(FINANCE_TABLES);
    }
  });
});

// ─── 4. Marker + schema khớp contract sau migrate ───

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 5. Finance legacy giữ nguyên (spec §4.3 + §8.1) ───

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
      code: `B7-${uid()}`,
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

// ─── 6. Batch 2/3/4/5/6 tables nhận create + read round-trip ───

d("preserves batch 2-6 tables", () => {
  it("Batch 2: UserSession/AuditEvent/BetaCohortMembership/SellerVerification round-trip", async () => {
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
      action: "session.revoked",
      reason: "typed_reason_code",
    });
    created.auditEvents.push(ae.id);
    expect((await db.orm.public.AuditEvent.first({ id: ae.id }))!.action).toBe("session.revoked");

    const bm = await db.orm.public.BetaCohortMembership.create({
      userId,
      cohort: "internal",
      status: "active",
    });
    created.betaMemberships.push(bm.id);
    const bmRow = await db.orm.public.BetaCohortMembership.first({ id: bm.id });
    expect(bmRow!.cohort).toBe("internal");
    expect(bmRow!.status).toBe("active");

    const sv = await db.orm.public.SellerVerification.create({
      userId,
      policyVersion: "v1",
    });
    created.sellerVerifications.push(sv.id);
    const svRow = await db.orm.public.SellerVerification.first({ id: sv.id });
    expect(svRow!.status).toBe("pending"); // default
    expect(svRow!.policyVersion).toBe("v1");

    // delete round-trip — migration Batch 7 không làm xáo trộn graph Batch 2
    await db.orm.public.UserSession.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSession.first({ id: s.id })).toBeNull();
    await db.orm.public.AuditEvent.where({ id: ae.id }).delete();
    expect(await db.orm.public.AuditEvent.first({ id: ae.id })).toBeNull();
    await db.orm.public.BetaCohortMembership.where({ id: bm.id }).delete();
    expect(await db.orm.public.BetaCohortMembership.first({ id: bm.id })).toBeNull();
    await db.orm.public.SellerVerification.where({ id: sv.id }).delete();
    expect(await db.orm.public.SellerVerification.first({ id: sv.id })).toBeNull();
  });

  it("Batch 3: UserSuspension/ModerationCase round-trip", async () => {
    const userId = await mkUser("seller");
    const actorId = await mkUser("admin");
    created.users.push(userId, actorId);

    const sus = await db.orm.public.UserSuspension.create({
      userId,
      reasonCode: "confirmed_abuse",
      suspendedById: actorId,
    });
    created.userSuspensions.push(sus.id);
    const susRow = await db.orm.public.UserSuspension.first({ id: sus.id });
    expect(susRow!.status).toBe("active"); // default
    expect(susRow!.reasonCode).toBe("confirmed_abuse");

    const mc = await db.orm.public.ModerationCase.create({
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCategory: "suspected_scam",
    });
    created.moderationCases.push(mc.id);
    const mcRow = await db.orm.public.ModerationCase.first({ id: mc.id });
    expect(mcRow!.state).toBe("open"); // default
    expect(mcRow!.reasonCategory).toBe("suspected_scam");

    // delete round-trip (thứ tự ngược FK: case → suspension)
    await db.orm.public.ModerationCase.where({ id: mc.id }).delete();
    expect(await db.orm.public.ModerationCase.first({ id: mc.id })).toBeNull();
    await db.orm.public.UserSuspension.where({ id: sus.id }).delete();
    expect(await db.orm.public.UserSuspension.first({ id: sus.id })).toBeNull();
  });

  it("Batch 4: ListingImageUpload round-trip", async () => {
    const ownerUserId = await mkUser("seller");
    created.users.push(ownerUserId);
    const up = await db.orm.public.ListingImageUpload.create({
      ownerUserId,
      storageKey: `${uid()}.webp`,
      bytes: 204_800,
      width: 2560,
      height: 1440,
    });
    created.imageUploads.push(up.id);
    const row = await db.orm.public.ListingImageUpload.first({ id: up.id });
    expect(row!.ownerUserId).toBe(ownerUserId);
    expect(row!.bytes).toBe(204_800);
    await db.orm.public.ListingImageUpload.where({ id: up.id }).delete();
    expect(await db.orm.public.ListingImageUpload.first({ id: up.id })).toBeNull();
  });

  it("Batch 5: ProductEvent/SearchAlias round-trip", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listing = await db.orm.public.Listing.create({
      sellerId,
      categoryId,
      title: `Loa B7 ${uid()}`,
      slug: `loa-b7-${uid()}`,
      description: "integration test batch 7",
      condition: "good",
      price: 1_000_000,
      status: "approved",
      city: "Hà Nội",
    });
    created.listings.push(listing.id);

    const ev = await db.orm.public.ProductEvent.create({
      name: "listing_viewed",
      schemaVersion: "1",
      listingId: listing.id,
      metadata: { ownerView: false, fromSearch: true },
    });
    created.productEvents.push(ev.id);
    const evRow = await db.orm.public.ProductEvent.first({ id: ev.id });
    expect(evRow!.name).toBe("listing_viewed");
    expect(evRow!.pseudonymKeyVersion).toBe("1");
    expect(evRow!.isInternal).toBe(false);

    // target=brand ⇒ brandId set (CHECK search_alias_target_ids — Batch 5)
    const brand = await db.orm.public.Brand.create({
      name: `B7 brand ${uid()}`,
      slug: `b7-brand-${uid()}`,
    });
    const alias = await db.orm.public.SearchAlias.create({
      alias: `b7-${uid()}`,
      target: "brand",
      brandId: brand.id,
    });
    created.searchAliases.push(alias.id);
    expect((await db.orm.public.SearchAlias.first({ id: alias.id }))!.target).toBe("brand");

    await db.orm.public.ProductEvent.where({ id: ev.id }).delete();
    expect(await db.orm.public.ProductEvent.first({ id: ev.id })).toBeNull();
    await db.orm.public.SearchAlias.where({ id: alias.id }).delete();
    expect(await db.orm.public.SearchAlias.first({ id: alias.id })).toBeNull();
    await db.orm.public.Brand.where({ id: brand.id }).delete();
    expect(await db.orm.public.Brand.first({ id: brand.id })).toBeNull();
  });

  it("Batch 6: Deal/DealStatusHistory round-trip", async () => {
    const sellerId = await mkUser("seller");
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);

    const deal = await db.orm.public.Deal.create({
      buyerId,
      sellerId,
      agreedPrice: 1_500_000,
      fulfillmentMethod: "meetup",
    });
    created.deals.push(deal.id);
    const dealRow = await db.orm.public.Deal.first({ id: deal.id });
    expect(dealRow!.status).toBe("open"); // default
    expect(dealRow!.agreedPrice).toBe(1_500_000);

    const h = await db.orm.public.DealStatusHistory.create({
      dealId: deal.id,
      status: "open",
      actorId: buyerId,
      note: "buyer:created",
    });
    const hRow = await db.orm.public.DealStatusHistory.first({ id: h.id });
    expect(hRow!.dealId).toBe(deal.id);
    expect(hRow!.status).toBe("open");

    // delete round-trip — history Cascade theo Deal
    await db.orm.public.Deal.where({ id: deal.id }).delete();
    expect(await db.orm.public.Deal.first({ id: deal.id })).toBeNull();
    expect(await db.orm.public.DealStatusHistory.where({ dealId: deal.id }).all()).toEqual([]);
  });
});

// ─── 7. §8.4 — KHÔNG auto-membership (delta assertion, Review Focus 5) ───

d("grants no auto-membership (spec §8.4)", () => {
  it("user mới tạo qua raw create nhận ZERO BetaCohortMembership — không trigger/default/transform auto-grant", async () => {
    const fresh = await db.orm.public.User.create({
      email: `${uid()}@integration.test`,
      passwordHash: "x",
      name: "B7 fresh user",
      role: "seller",
    });
    created.users.push(fresh.id);

    // DELTA assertion (không phải global count — DB scratch chia sẻ thứ tự
    // test của suite): user này nhận đúng 0 membership — §8.4: existing users
    // do not automatically become founding sellers
    const memberships = await db.orm.public.BetaCohortMembership.where({
      userId: fresh.id,
    }).all();
    expect(memberships).toEqual([]);

    // adminRole/sellerType không bị đụng — không default nào tự set
    const row = await db.orm.public.User.first({ id: fresh.id });
    expect(row!.adminRole).toBeNull();
    expect(row!.sellerType).toBeNull();
    expect(row!.role).toBe("seller");
    expect(row!.isVerifiedSeller).toBe(false);
  });
});
