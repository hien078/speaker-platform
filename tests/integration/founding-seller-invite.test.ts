/**
 * Founding seller invitation flow — integration tests (Batch 7 plan Task 3 —
 * spec §9 Batch 7 Gate "invite acceptance", §2.1, §4.8, §7.1, §7.3, §8.4,
 * §10.1; corrections 2026-10-08 items 10/12/14/22/24/26/32) — chạy trên scratch
 * DB (scripts/test-integration.sh: container riêng + `prisma db migrate --to
 * production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/founding-seller-invite.test.ts) chứng minh logic với
 * db mock + tx rollback mô phỏng; ở đây chứng minh CÙNG hợp đồng against DB
 * THẬT với module THẬT (session/auth/rbac, HMAC hkdfKey, partial unique index
 * beta_invite_one_active, @@unique(userId, cohort), atomic claim, funnel sync,
 * telemetry emission):
 *
 *  1. End-to-end (spec §9 Gate): candidate → invite → accept → membership
 *     {founding_seller, active, acceptedAt} + candidate registered + userId
 *     link + token consumedAt — VÀ checkSellerPublicationRequirements
 *     (Batch 2) chuyển founding_seller_membership_active từ missing →
 *     satisfied (CHỈ leg membership di chuyển — các yêu cầu khác vẫn missing).
 *  2. Single-use: accept lần hai cùng token → INVITE_INVALID, không membership
 *     thứ hai (atomic claim thật).
 *  3. Channel binding (Review Focus 2): email verified KHÁC →
 *     INVITE_CHANNEL_MISMATCH, không membership, token VẪN chưa consume
 *     (refusal trước claim — B3); email match nhưng CHƯA verify →
 *     INVITE_CHANNEL_UNVERIFIED → set emailVerifiedAt → accept pass (Batch 2
 *     verification flow là con đường sửa).
 *  4. Expiry thật: expiresAt quá khứ → INVITE_INVALID.
 *  5. Revocation + re-issue: revoke → invite lại → token cũ INVITE_INVALID,
 *     token mới hoạt động (partial index giữ đúng MỘT active).
 *  6. Suspension (§7.3/S10): UserSuspension active → INVITE_ACCOUNT_SUSPENDED,
 *     không membership, token chưa consume.
 *  7. Telemetry (§4.8 end-to-end): seller_invited (actor null — issuance) /
 *     seller_registered + beta_membership_activated (actorPseudonym ≠ userId
 *     thô — corrections #26: PRODUCT_EVENT_PSEUDONYM_KEY stub để row THẬT được
 *     tạo) — KHÔNG row nào chứa contact string.
 *
 * `next/headers` mock (cookie store điều khiển được — createSession +
 * sp_invite cần cookies() ngoài request scope) + `next/navigation` mock
 * (redirect throw); phần DB/session/auth/rbac/HMAC/rate-limit/funnel là thật
 * toàn bộ. AUTH_SECRET + PRODUCT_EVENT_PSEUDONYM_KEY stub trong beforeEach
 * (test-integration.sh chỉ set DATABASE_URL — corrections #26).
 *
 * Cleanup (corrections #32): BetaInviteToken.candidate là Restrict → xóa
 * token TRƯỚC candidate; BetaCohortMembership/UserSession/Notification/
 * AuditEvent(SetNull) theo user.
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

// ─── Cookie store điều khiển được (next/headers) — session THẬT + sp_invite ────

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
    // acceptInviteAction delete theo object form { name, path } (corrections
    // #35 — delete phải mang path /invite) — mock chấp nhận cả hai dạng.
    delete: (arg: string | { name: string }) => {
      cookieState.store.delete(typeof arg === "string" ? arg : arg.name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

import { db } from "../../src/prisma/db.client";
import { SESSION_COOKIE, createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { checkSellerPublicationRequirements } from "../../src/lib/seller-verification-policy";
import {
  BETA_INVITE_COOKIE,
  betaInviteTokenHash,
} from "../../src/lib/founding-sellers";
import {
  acceptInviteAction,
  createCandidateAction,
  inviteCandidateAction,
  revokeInviteAction,
} from "../../src/lib/actions/founding-sellers";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `b7-inv-${Date.now()}-${seq++}`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const created = {
  users: [] as string[],
  candidates: [] as string[],
  tokens: [] as string[],
  suspensions: [] as string[],
};

/** User thường (invitee) — email unique per test (S7 pre-check global). */
async function mkUser(over: {
  email?: string;
  emailVerifiedAt?: string | null;
  phone?: string | null;
  phoneVerifiedAt?: string | null;
} = {}): Promise<{ id: string; email: string }> {
  const email = over.email ?? `${uid()}@integration.test`;
  const u = await db.orm.public.User.create({
    email,
    passwordHash: "x",
    name: `B7 invitee ${seq}`,
    role: "buyer",
    phone: over.phone ?? null,
    emailVerifiedAt: over.emailVerifiedAt ?? null,
    phoneVerifiedAt: over.phoneVerifiedAt ?? null,
  });
  created.users.push(u.id);
  return { id: u.id, email };
}

/** Operations admin (Batch 2 matrix: beta_cohort.manage) — session MFA. */
async function mkOpsAdmin(): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `ops-${uid()}@integration.test`,
    passwordHash: "x",
    name: `B7 ops ${seq}`,
    role: "admin",
    adminRole: "operations_admin",
  });
  created.users.push(u.id);
  return u.id;
}

/** Session THẬT — trả token cookie để switch giữa các user. */
async function loginAs(userId: string, isAdmin = false): Promise<string> {
  await createSession(userId, { isAdmin });
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

const setSession = (token: string) => cookieState.store.set(SESSION_COOKIE, token);
const setInviteCookie = (token: string) => cookieState.store.set(BETA_INVITE_COOKIE, token);
const clearCookies = () => cookieState.store.clear();

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Tạo candidate + issue invite với session ops — trả raw token + rows. */
async function issueInvite(opts: {
  opsToken: string;
  contact: string;
  channel?: "email" | "phone";
}): Promise<{ token: string; candidateId: string; tokenRowId: string }> {
  setSession(opts.opsToken);
  const createdState = await createCandidateAction(
    {},
    fd({
      contactReference: opts.contact,
      contactChannel: opts.channel ?? "email",
      source: "integration test tuyển nguồn",
      targetCommunity: "ha-noi",
    }),
  );
  if (createdState.error !== undefined) throw new Error(`createCandidate failed: ${createdState.error}`);
  const candidate = await db.orm.public.FoundingSellerCandidate.first({
    contactReference: opts.contact,
  });
  if (candidate === null) throw new Error("candidate row thiếu sau create");
  created.candidates.push(candidate.id);

  const inviteState = await inviteCandidateAction({}, fd({ candidateId: candidate.id }));
  if (inviteState.error !== undefined || inviteState.inviteUrl === undefined) {
    throw new Error(`invite failed: ${JSON.stringify(inviteState)}`);
  }
  const token = inviteState.inviteUrl.split("/").pop()!;
  const tokenRow = await db.orm.public.BetaInviteToken.first({
    tokenHash: betaInviteTokenHash(token),
  });
  if (tokenRow === null) throw new Error("token row thiếu sau invite");
  created.tokens.push(tokenRow.id);
  return { token, candidateId: candidate.id, tokenRowId: tokenRow.id };
}

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

async function membershipCount(userId: string): Promise<number> {
  const agg = await db.orm.public.BetaCohortMembership.where({ userId }).aggregate((a) => ({
    c: a.count(),
  }));
  return agg.c;
}

// ─── Cleanup (corrections #32: token TRƯỚC candidate — Restrict FK) ────────────

afterEach(async () => {
  for (const id of created.suspensions) {
    await db.orm.public.UserSuspension.where({ id }).delete();
  }
  for (const id of created.tokens) {
    await db.orm.public.BetaInviteToken.where({ id }).delete();
  }
  for (const id of created.candidates) {
    await db.orm.public.FoundingSellerCandidate.where({ id }).delete();
  }
  for (const id of created.users) {
    // BetaCohortMembership/UserSession/Notification cascade; AuditEvent
    // actor/subject SetNull; SellerVerification KHÔNG onDelete (Restrict) →
    // xóa verification TRƯỚC user (chat-hardening precedent).
    await db.orm.public.SellerVerification.where({ userId: id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  created.suspensions.length = 0;
  created.tokens.length = 0;
  created.candidates.length = 0;
  created.users.length = 0;
  clearCookies();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  // corrections #26 — emit core KHÔNG ghi row khi thiếu key (silent no-op);
  // test này assert ROW ProductEvent tồn tại → stub base64 đúng 32 byte.
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://beta.loaviet.test");
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. End-to-end (spec §9 Gate "invite acceptance") ─────────────────────────

d("founding seller invitation flow trên DB thật (Batch 7 Task 3)", () => {
  it("end-to-end: candidate → invite → accept → membership active + publication requirement membership leg di chuyển", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token, candidateId, tokenRowId } = await issueInvite({ opsToken, contact });

    // token row lưu HMAC — KHÔNG BAO GIỜ token thô (Review Focus 1)
    const tokenRow = await db.orm.public.BetaInviteToken.first({ id: tokenRowId });
    expect(tokenRow!.tokenHash).toBe(betaInviteTokenHash(token));
    expect(tokenRow!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenRow!.tokenHash).not.toBe(token);
    expect(tokenRow!.target).toBe(contact);
    expect(tokenRow!.issuedById).toBe(ops);

    // invitee — email === target, ĐÃ verify
    const invitee = await mkUser({ email: contact, emailVerifiedAt: new Date().toISOString() });
    await loginAs(invitee.id);
    setInviteCookie(token);

    // trước acceptance: founding_seller_membership_active đang missing
    const before = await checkSellerPublicationRequirements(invitee.id);
    expect(before.missing).toContain("founding_seller_membership_active");

    const state = await acceptQuiet();
    expect(state.redirected).toBe("NEXT_REDIRECT:/sell");

    // membership — spec §9 Gate
    const membership = await db.orm.public.BetaCohortMembership.first({
      userId: invitee.id,
      cohort: "founding_seller",
    });
    expect(membership).not.toBeNull();
    expect(membership!.status).toBe("active");
    expect(membership!.acceptedAt).not.toBeNull();
    expect(membership!.invitedBy).toBe(ops);

    // candidate link + registered
    const candidate = await db.orm.public.FoundingSellerCandidate.first({ id: candidateId });
    expect(candidate!.userId).toBe(invitee.id);
    expect(candidate!.status).toBe("registered");
    expect(candidate!.registeredAt).not.toBeNull();

    // token single-use
    const consumed = await db.orm.public.BetaInviteToken.first({ id: tokenRowId });
    expect(consumed!.consumedAt).not.toBeNull();

    // publication requirement: CHỈ leg membership di chuyển (các yêu cầu khác
    // vẫn missing — invitee chưa khai báo gì)
    const after = await checkSellerPublicationRequirements(invitee.id);
    expect(after.missing).not.toContain("founding_seller_membership_active");
    const moved = before.missing.filter((r) => !after.missing.includes(r));
    expect(moved).toEqual(["founding_seller_membership_active"]);

    // cookie cleared
    expect(cookieState.store.has(BETA_INVITE_COOKIE)).toBe(false);
  });

  it("single-use thật: accept lần hai cùng token → INVITE_INVALID, không membership thứ hai", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token } = await issueInvite({ opsToken, contact });
    const invitee = await mkUser({ email: contact, emailVerifiedAt: new Date().toISOString() });
    const inviteeToken = await loginAs(invitee.id);
    setInviteCookie(token);
    await acceptQuiet();

    // lần hai — token đã consume
    setSession(inviteeToken);
    setInviteCookie(token);
    const state2 = await acceptQuiet();
    expect(state2.error).toBe("INVITE_INVALID");
    expect(await membershipCount(invitee.id)).toBe(1);
  });

  it("channel binding: email verified KHÁC → INVITE_CHANNEL_MISMATCH, không membership, token VẪN chưa consume (B3)", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token, tokenRowId } = await issueInvite({ opsToken, contact });
    // invitee có email verified KHÁC (đã verify — chỉ sai địa chỉ)
    const other = await mkUser({
      email: `khac-${uid()}@integration.test`,
      emailVerifiedAt: new Date().toISOString(),
    });
    await loginAs(other.id);
    setInviteCookie(token);
    const state = await acceptQuiet();
    expect(state.error).toBe("INVITE_CHANNEL_MISMATCH");
    expect(await membershipCount(other.id)).toBe(0);
    // refusal TRƯỚC claim — token chưa burn (Review Focus 2)
    const tokenRow = await db.orm.public.BetaInviteToken.first({ id: tokenRowId });
    expect(tokenRow!.consumedAt).toBeNull();
  });

  it("email match nhưng CHƯA verify → INVITE_CHANNEL_UNVERIFIED → verify xong → accept pass (Batch 2 flow là con đường sửa)", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token } = await issueInvite({ opsToken, contact });
    const invitee = await mkUser({ email: contact, emailVerifiedAt: null });
    const inviteeToken = await loginAs(invitee.id);
    setInviteCookie(token);
    const state = await acceptQuiet();
    expect(state.error).toBe("INVITE_CHANNEL_UNVERIFIED");
    expect(await membershipCount(invitee.id)).toBe(0);

    // verify email (giả lập Batch 2 flow) → accept pass
    await db.orm.public.User.where({ id: invitee.id }).updateAll({
      emailVerifiedAt: new Date().toISOString(),
    });
    setSession(inviteeToken);
    setInviteCookie(token);
    const state2 = await acceptQuiet();
    expect(state2.redirected).toBe("NEXT_REDIRECT:/sell");
    expect(await membershipCount(invitee.id)).toBe(1);
  });

  it("expired thật: expiresAt quá khứ → INVITE_INVALID (real expiry boundary)", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token, tokenRowId } = await issueInvite({ opsToken, contact });
    await db.orm.public.BetaInviteToken.where({ id: tokenRowId }).updateAll({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const invitee = await mkUser({ email: contact, emailVerifiedAt: new Date().toISOString() });
    await loginAs(invitee.id);
    setInviteCookie(token);
    const state = await acceptQuiet();
    expect(state.error).toBe("INVITE_INVALID");
    expect(await membershipCount(invitee.id)).toBe(0);
  });

  it("revocation + re-issue: revoke → invite lại → token cũ INVITE_INVALID, token mới hoạt động (partial index giữ MỘT active)", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const first = await issueInvite({ opsToken, contact });

    // revoke token đầu
    setSession(opsToken);
    await revokeInviteAction(fd({ tokenId: first.tokenRowId }));
    const revokedRow = await db.orm.public.BetaInviteToken.first({ id: first.tokenRowId });
    expect(revokedRow!.revokedAt).not.toBeNull();

    // invite lại — token mới
    const candidate = await db.orm.public.FoundingSellerCandidate.first({ id: first.candidateId });
    const inviteState2 = await inviteCandidateAction({}, fd({ candidateId: candidate!.id }));
    expect(inviteState2.error).toBeUndefined();
    const token2 = inviteState2.inviteUrl!.split("/").pop()!;
    const tokenRow2 = await db.orm.public.BetaInviteToken.first({
      tokenHash: betaInviteTokenHash(token2),
    });
    created.tokens.push(tokenRow2!.id);

    // đúng MỘT active (partial index beta_invite_one_active)
    const active = await db.orm.public.BetaInviteToken.where({ candidateId: candidate!.id })
      .where((t) => t.consumedAt.isNull())
      .where((t) => t.revokedAt.isNull())
      .all();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(tokenRow2!.id);

    // token cũ INVITE_INVALID
    const invitee = await mkUser({ email: contact, emailVerifiedAt: new Date().toISOString() });
    await loginAs(invitee.id);
    setInviteCookie(first.token);
    const stateOld = await acceptQuiet();
    expect(stateOld.error).toBe("INVITE_INVALID");
    expect(await membershipCount(invitee.id)).toBe(0);

    // token mới hoạt động
    setInviteCookie(token2);
    const stateNew = await acceptQuiet();
    expect(stateNew.redirected).toBe("NEXT_REDIRECT:/sell");
    expect(await membershipCount(invitee.id)).toBe(1);
  });

  it("suspension thật (§7.3/S10): UserSuspension active → INVITE_ACCOUNT_SUSPENDED, không membership, token chưa consume", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token, tokenRowId } = await issueInvite({ opsToken, contact });
    const invitee = await mkUser({ email: contact, emailVerifiedAt: new Date().toISOString() });
    const suspension = await db.orm.public.UserSuspension.create({
      userId: invitee.id,
      status: "active",
      reasonCode: "spam",
      suspendedAt: new Date().toISOString(),
    });
    created.suspensions.push(suspension.id);
    await loginAs(invitee.id);
    setInviteCookie(token);
    const state = await acceptQuiet();
    expect(state.error).toBe("INVITE_ACCOUNT_SUSPENDED");
    expect(await membershipCount(invitee.id)).toBe(0);
    const tokenRow = await db.orm.public.BetaInviteToken.first({ id: tokenRowId });
    expect(tokenRow!.consumedAt).toBeNull();
  });

  it("telemetry §4.8 end-to-end: seller_invited (actor null) + seller_registered + beta_membership_activated (actorPseudonym ≠ userId thô) — KHÔNG row nào chứa contact string", async () => {
    const ops = await mkOpsAdmin();
    const opsToken = await loginAs(ops, true);
    const contact = `${uid()}@integration.test`;
    const { token } = await issueInvite({ opsToken, contact });
    const invitee = await mkUser({ email: contact, emailVerifiedAt: new Date().toISOString() });
    await loginAs(invitee.id);
    setInviteCookie(token);
    await acceptQuiet();

    // seller_invited — issuance, actor null (prospect chưa có tài khoản)
    const invitedRows = await db.orm.public.ProductEvent.where({ name: "seller_invited" }).all();
    expect(invitedRows.length).toBeGreaterThanOrEqual(1);
    const invited = invitedRows[0]!;
    expect(invited.actorPseudonym).toBeNull(); // actorId null → không có pseudonym
    expect(invited.provinceCode).toBe("ha-noi");

    // seller_registered + beta_membership_activated — actor PSEUDONYM (không id thô)
    const registeredRows = await db.orm.public.ProductEvent.where({
      name: "seller_registered",
    }).all();
    expect(registeredRows.length).toBeGreaterThanOrEqual(1);
    const registered = registeredRows[0]!;
    expect(registered.actorPseudonym).not.toBeNull();
    expect(registered.actorPseudonym).not.toBe(invitee.id); // HMAC — không id thô
    expect(registered.provinceCode).toBe("ha-noi");

    const activatedRows = await db.orm.public.ProductEvent.where({
      name: "beta_membership_activated",
    }).all();
    expect(activatedRows.length).toBeGreaterThanOrEqual(1);
    expect(activatedRows[0]!.actorPseudonym).not.toBe(invitee.id);

    // §4.8 end-to-end: KHÔNG row ProductEvent nào chứa contact string —
    // scan mọi cột + metadata JSON của CẢ ba loại event vừa tạo
    const allRows = await db.orm.public.ProductEvent.all();
    const relevant = allRows.filter(
      (r) =>
        r.name === "seller_invited" || r.name === "seller_registered" || r.name === "beta_membership_activated",
    );
    expect(relevant.length).toBeGreaterThanOrEqual(3);
    for (const row of relevant) {
      expect(JSON.stringify(row)).not.toContain(contact);
    }
  });
});
