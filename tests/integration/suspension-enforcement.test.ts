/**
 * Suspension enforcement — integration tests (Batch 3 plan Task 5, spec §7.8 +
 * §5.4.2 + §4.4) — chạy trên scratch DB (scripts/test-integration.sh: container
 * riêng + `prisma db migrate --to production` + dọn). KHÔNG chạy trong
 * `npm test`.
 *
 * Unit tests (tests/unit/suspension-actions.test.ts, publication-gate,
 * seller-verification-policy, seller-verification-actions) chứng minh logic
 * với db mock; ở đây chứng minh CÙNG hợp đồng against DB THẬT với module THẬT
 * (session, rbac step-up + MFA thật, moderation guards, publication gate,
 * audit, notify, suspendUserAction/liftSuspensionAction, chat actions + route):
 *
 *  1. suspend (operations_admin + TOTP step-up thật) → seller bị chặn chat
 *     (startConversationAction + POST) MỖI ACTION với session CÒN SỐNG
 *     (P1/A2: KHÔNG revoke session — guard đọc FRESH từ DB mỗi action; gọi
 *     lần hai vẫn chặn — không cache); publication gate
 *     { ok: false, missing: ["account_not_suspended"] } (yêu cầu thứ 8);
 *     submitSellerVerificationAction → typed error; ModerationAction +
 *     AuditEvent + Notification appended.
 *  2. lift (KHÔNG step-up — hướng khôi phục) → chat mở lại + gate
 *     { ok: true, missing: [] } + row lifted với liftReasonCode/liftedBy.
 *  3. Concurrent double-suspend → ĐÚNG MỘT episode active (partial index
 *     `user_suspension_one_active`), loser USER_ALREADY_SUSPENDED — không có
 *     đường silent-success (violation throw ra khỏi callback, tx rollback).
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/rbac/admin-mfa/policy/audit/notify là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// ─── Cookie store điều khiển được (next/headers) — session THẬT ──────────────

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
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

import { db } from "../../src/prisma/db.client";
import { SESSION_COOKIE, createSession, getSessionFromCookie } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { resetTotpReplayProtection, enrollAdminMfa } from "../../src/lib/admin-mfa";
import { hotpCode } from "../../src/lib/totp";
import { checkSellerPublicationRequirements } from "../../src/lib/seller-verification-policy";
import { suspendUserAction, liftSuspensionAction } from "../../src/lib/actions/moderation";
import { startConversationAction } from "../../src/lib/actions/chat";
import { submitSellerVerificationAction } from "../../src/lib/actions/seller-verification";
import { GET, POST } from "../../app/api/chat/[id]/route";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const KEY_32B = Buffer.alloc(32, 0x44).toString("base64");

let seq = 0;
const uid = () => `b3-susp-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller", over?: Record<string, unknown>): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B3 Susp ${seq}`,
    role,
    ...over,
  });
  created.users.push(u.id);
  return u.id;
}

/** Seller đủ 7 yêu cầu Batch 2 (KHÔNG tính suspension — yêu cầu thứ 8). */
async function seedSevenRequirements(sellerId: string): Promise<void> {
  await db.orm.public.User.where({ id: sellerId }).update({
    emailVerifiedAt: new Date().toISOString(),
    phoneVerifiedAt: new Date().toISOString(),
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
  });
  await db.orm.public.PolicyAcceptance.create({
    userId: sellerId,
    policyKey: "seller_rules",
    policyVersion: "v1",
  });
  await db.orm.public.BetaCohortMembership.create({
    userId: sellerId,
    cohort: "founding_seller",
    status: "active",
  });
  await db.orm.public.SellerVerification.create({
    userId: sellerId,
    status: "verified",
    method: "operations_review",
    submittedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    policyVersion: "v1",
  });
}

async function mkListing(sellerId: string): Promise<string> {
  const cat = await db.orm.public.Category.create({
    name: `Danh mục ${uid()}`,
    slug: `cat-${uid()}`,
  });
  created.categories.push(cat.id);
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.id,
    title: `Loa ${uid()}`,
    slug: `loa-${uid()}`,
    description: "integration test",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
  });
  created.listings.push(l.id);
  return l.id;
}

async function mkConversation(listingId: string, buyerId: string, sellerId: string): Promise<string> {
  const c = await db.orm.public.Conversation.create({ listingId, buyerId, sellerId });
  created.conversations.push(c.id);
  return c.id;
}

/** Session THẬT cho user — trả token cookie để switch giữa các user. */
async function loginAs(userId: string, opts?: { isAdmin?: boolean }): Promise<string> {
  await createSession(userId, opts);
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

const setSession = (token: string): void => {
  cookieState.store.set(SESSION_COOKIE, token);
};

/** Đánh dấu step-up TƯƠI cho session MỚI NHẤT của user (qua row thật). */
async function stepUpCurrentSession(userId: string): Promise<void> {
  const rows = await db.orm.public.UserSession.where({ userId })
    .orderBy((s) => s.createdAt.desc())
    .all();
  const current = rows[0];
  if (!current) throw new Error("no session to step up");
  await db.orm.public.UserSession.where({ id: current.id }).updateAll({
    steppedUpAt: new Date().toISOString(),
  });
}

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** POST /api/chat/[id] — route invocation TRỰC TIẾP. */
const postMessage = (convoId: string, body: string): Promise<Response> =>
  POST(
    new Request(`http://local/api/chat/${convoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof POST>[1],
  );

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref).
// UserSuspension.user là Restrict → xóa suspension TRƯỚC user; ModerationAction
// (SetNull) + AuditEvent (SetNull) + Notification (Cascade) theo actor/user.
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  conversations: [] as string[],
  suspensions: [] as string[],
};

async function cleanupUser(userId: string): Promise<void> {
  await db.orm.public.UserSuspension.where({ userId }).delete();
  await db.orm.public.ModerationAction.where({ actorId: userId }).delete();
  await db.orm.public.ModerationAction.where({ targetId: userId }).delete();
  await db.orm.public.AuditEvent.where({ actorId: userId }).delete();
  await db.orm.public.AuditEvent.where({ subjectId: userId }).delete();
  await db.orm.public.Notification.where({ userId }).delete();
  await db.orm.public.SellerVerification.where({ userId }).delete();
  await db.orm.public.PolicyAcceptance.where({ userId }).delete();
  await db.orm.public.BetaCohortMembership.where({ userId }).delete();
  await db.orm.public.UserSession.where({ userId }).delete();
  await db.orm.public.AdminMfa.where({ userId }).delete();
  await db.orm.public.User.where({ id: userId }).delete();
}

afterEach(async () => {
  for (const id of created.conversations) {
    await db.orm.public.Conversation.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.users) {
    await cleanupUser(id);
  }
  created.conversations.length = 0;
  created.listings.length = 0;
  created.categories.length = 0;
  created.users.length = 0;
  cookieState.store.clear();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
  resetRateLimits();
  resetTotpReplayProtection();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Fixtures admin MFA ──────────────────────────────────────────────────────

const nowCounter = () => Math.floor(Date.now() / 30_000);

/** operations_admin + MFA enrollment — trả mã TOTP hiện tại. */
async function mkOpsAdmin(): Promise<{ id: string; totp: () => string }> {
  const id = await mkUser("buyer", { adminRole: "operations_admin", role: "admin" });
  const enrolled = await enrollAdminMfa(id);
  if (enrolled === null) throw new Error("enrollAdminMfa failed (integration fixture)");
  const secret = enrolled.secretBase32;
  return { id, totp: () => hotpCode(secret, nowCounter()) };
}

d("suspension enforcement trên DB thật (spec §7.8 — P1: session KHÔNG bị revoke)", () => {
  it("suspend → chat denied + gate missing account_not_suspended — với session CÒN SỐNG; gọi lần hai vẫn chặn (fresh from DB)", async () => {
    const sellerX = await mkUser("seller"); // người bị đình chỉ (đủ 7 yêu cầu)
    await seedSevenRequirements(sellerX);
    const sellerY = await mkUser("seller"); // counterpart — chủ tin đăng
    const listingY = await mkListing(sellerY);
    const listingY2 = await mkListing(sellerY); // path "hội thoại mới"
    const convo = await mkConversation(listingY, sellerX, sellerY);

    const xTok = await loginAs(sellerX);
    const ops = await mkOpsAdmin();
    const opsTok = await loginAs(ops.id, { isAdmin: true });

    // trước suspend: gate pass (đủ 8 — chưa có suspension)
    const before = await checkSellerPublicationRequirements(sellerX);
    expect(before).toEqual({ ok: true, missing: [] });

    // suspend qua ACTION THẬT — operations_admin + TOTP step-up thật (A9)
    setSession(opsTok);
    await suspendUserAction(
      fd({ userId: sellerX, reasonCode: "confirmed_abuse", totpCode: ops.totp() }),
    );

    // row suspension active + history + audit + notify (spec §4.6/§5.5)
    const susp = await db.orm.public.UserSuspension
      .where({ userId: sellerX, status: "active" })
      .first();
    expect(susp).not.toBeNull();
    expect(susp!.reasonCode).toBe("confirmed_abuse");
    expect(susp!.suspendedById).toBe(ops.id);
    const act = await db.orm.public.ModerationAction
      .where({ actionType: "user.suspended", targetId: sellerX })
      .first();
    expect(act).not.toBeNull();
    expect(act!.actorId).toBe(ops.id);
    const audit = await db.orm.public.AuditEvent
      .where({ action: "moderation.user_suspended", subjectId: sellerX })
      .first();
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(ops.id);
    expect(audit!.reason).toBe("confirmed_abuse");
    const notif = await db.orm.public.Notification
      .where({ userId: sellerX, kind: "moderation" })
      .first();
    expect(notif).not.toBeNull();

    // P1: session của X VẪN SỐNG — KHÔNG revoke (guard là enforcement)
    setSession(xTok);
    expect(await getSessionFromCookie()).not.toBeNull();

    // chat denied MỖI ACTION (actor-side §7.8): hội thoại mới + tin nhắn
    await expect(startConversationAction(fd({ listingId: listingY2 }))).rejects.toThrow(
      "ACCOUNT_SUSPENDED",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listingY2, buyerId: sellerX }).first(),
    ).toBeNull();
    const denied = await postMessage(convo, "bị đình chỉ vẫn thử gửi");
    expect(denied.status).toBe(403);
    expect(await (denied.json() as Promise<{ error: string }>)).toMatchObject({
      error: "ACCOUNT_SUSPENDED",
    });

    // lần gọi THỨ HAI (app-level call mới, không cache) → vẫn chặn —
    // enforcement đọc FRESH từ DB, không từ session state
    await expect(startConversationAction(fd({ listingId: listingY2 }))).rejects.toThrow(
      "ACCOUNT_SUSPENDED",
    );
    const denied2 = await postMessage(convo, "thử lần nữa");
    expect(denied2.status).toBe(403);

    // GET lịch sử vẫn đọc được (block/suspension KHÔNG xóa dữ liệu — §5.5)
    const got = await GET(
      new Request(`http://local/api/chat/${convo}`),
      { params: Promise.resolve({ id: convo }) } as unknown as Parameters<typeof GET>[1],
    );
    expect(got.status).toBe(200);

    // publication gate: CHỈ thiếu yêu cầu thứ 8 (spec §7.8)
    const gated = await checkSellerPublicationRequirements(sellerX);
    expect(gated).toEqual({ ok: false, missing: ["account_not_suspended"] });

    // submit verification → typed error (suspended user không vào queue)
    const submitState = await submitSellerVerificationAction({}, fd({ acceptSellerRules: "on" }));
    expect(submitState.error).toBeTruthy();
    expect(submitState.error).toContain("đình chỉ");
    expect(submitState.code).toBe("REQUIREMENTS_MISSING");
    expect(
      await db.orm.public.SellerVerification.where({ userId: sellerX }).first(),
    ).not.toBeNull(); // row verified cũ còn nguyên — KHÔNG tạo row mới

    // lift qua ACTION THẬT (KHÔNG step-up — hướng khôi phục) → mọi thứ mở lại
    setSession(opsTok);
    await liftSuspensionAction(
      fd({ suspensionId: susp!.id, reasonCode: "other_reviewed_reason" }),
    );

    const liftedRow = await db.orm.public.UserSuspension.where({ id: susp!.id }).first();
    expect(liftedRow).toMatchObject({
      status: "lifted",
      liftReasonCode: "other_reviewed_reason",
      liftedById: ops.id,
    });
    const liftAct = await db.orm.public.ModerationAction
      .where({ actionType: "user.suspension_lifted", targetId: sellerX })
      .first();
    expect(liftAct).not.toBeNull();
    const liftAudit = await db.orm.public.AuditEvent
      .where({ action: "moderation.user_suspension_lifted", subjectId: sellerX })
      .first();
    expect(liftAudit).not.toBeNull();

    // chat mở lại — session cũ vẫn sống (P1: không cần login lại)
    setSession(xTok);
    const afterLift = await postMessage(convo, "sau khi được gỡ đình chỉ");
    expect(afterLift.status).toBe(200);
    await expect(startConversationAction(fd({ listingId: listingY2 }))).rejects.toThrow(
      "NEXT_REDIRECT", // tạo hội thoại thành công → redirect
    );
    const newConvo = await db.orm.public.Conversation
      .where({ listingId: listingY2, buyerId: sellerX })
      .first();
    expect(newConvo).not.toBeNull();
    created.conversations.push(newConvo!.id);

    // gate pass lại (yêu cầu thứ 8 thỏa — episode lifted không còn chặn)
    const restored = await checkSellerPublicationRequirements(sellerX);
    expect(restored).toEqual({ ok: true, missing: [] });
  });

  it("concurrent double-suspend → ĐÚNG MỘT episode active, loser USER_ALREADY_SUSPENDED (không silent-success)", async () => {
    const target = await mkUser("buyer");
    const ops = await mkOpsAdmin();
    const opsTok = await loginAs(ops.id, { isAdmin: true });
    // step-up TƯƠI trực tiếp trên row session (hai call song song dùng chung
    // một mã TOTP sẽ replay-fail ở verify — fresh step-up bỏ qua verify)
    await stepUpCurrentSession(ops.id);
    setSession(opsTok);

    const form = () => fd({ userId: target, reasonCode: "confirmed_abuse" });
    const [r1, r2] = await Promise.allSettled([
      suspendUserAction(form()),
      suspendUserAction(form()),
    ]);

    // ĐÚNG MỘT thắng — partial index user_suspension_one_active (Task 1) đóng
    // race: loser throw ra khỏi tx callback, classify NGOÀI → typed error
    const results = [r1, r2];
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /USER_ALREADY_SUSPENDED/,
    );

    // đọc lại SAU khi cả hai settle: đúng MỘT episode active (không có đường
    // aborted-tx-becomes-commit — violation được throw ra, KHÔNG catch-and-return)
    const active = await db.orm.public.UserSuspension
      .where({ userId: target, status: "active" })
      .all();
    expect(active).toHaveLength(1);
    // ModerationAction/AuditEvent của loser KHÔNG được append (tx rollback)
    const acts = await db.orm.public.ModerationAction
      .where({ actionType: "user.suspended", targetId: target })
      .all();
    expect(acts).toHaveLength(1);
    const audits = await db.orm.public.AuditEvent
      .where({ action: "moderation.user_suspended", subjectId: target })
      .all();
    expect(audits).toHaveLength(1);
  });
});
