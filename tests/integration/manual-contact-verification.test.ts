/**
 * Manual contact verification — integration tests (zero-cost launch Task A,
 * founder 2026-10-12) — chạy trên scratch DB (scripts/test-integration.sh:
 * container riêng + `prisma db migrate --to production` + dọn). KHÔNG chạy
 * trong `npm test`.
 *
 * Chứng minh CÙNG hợp đồng unit (tests/unit/manual-contact-verification.test.ts)
 * against DB THẬT với module THẬT (session/rbac step-up, HMAC hkdfKey label
 * "manual-contact-target", partial unique manual_contact_one_requested,
 * CAS updateAll, auditEventTx trong tx):
 *
 *  1. End-to-end phone: A request → B approve → phoneVerifiedAt set (CHỈ khi
 *     null) → invitee nhận lời mời kênh phone ĐƯỢC (channel binding
 *     acceptInviteAction pass — trước đó INVITE_CHANNEL_UNVERIFIED, token
 *     chưa consume vì refusal trước claim).
 *  2. Two-person rule: A KHÔNG tự duyệt request mình mở (SAME_PERSON_FORBIDDEN
 *     — row giữ nguyên requested, verifiedAt null); admin KHÔNG mở request
 *     cho CHÍNH MÌNH (SELF_VERIFICATION_FORBIDDEN — không row nào được tạo).
 *  3. CONTACT_CHANGED: đổi số giữa request/decide → B approve refuse (hash
 *     không khớp), row giữ nguyên requested, verifiedAt null.
 *  4. EXPIRED (no cron): expiresAt quá khứ → B approve refuse; request MỚI
 *     flip row cũ sang 'expired' trong tx (partial unique không chặn vĩnh
 *     viễn) + row mới requested sống.
 *  5. OPEN_REQUEST_EXISTS: request thứ hai cùng (userId, channel) khi còn
 *     row requested chưa quyết → typed error (partial unique là ranh giới
 *     cuối — test đơn độc pre-check path).
 *  6. PHONE_ALREADY_VERIFIED: số đã được verified bởi tài khoản khác → B
 *     approve refuse (uniqueness danh tính verified — cùng hợp đồng OTP
 *     confirm path), KHÔNG merge, verifiedAt của subject giữ null.
 *  7. Reject: B reject → row rejected, verifiedAt null (KHÔNG set).
 *  8. Cancel: chỉ requester hủy được (NOT_REQUESTER cho admin B); sau cancel
 *     B approve → ALREADY_DECIDED.
 *  9. Audit (§4.6/§4.8): mọi flow ghi contact.manual_verify_* trong cùng tx
 *     — detail chỉ ids/channel/method/decision, KHÔNG BAO GIỜ chứa số/email
 *     thô hay note; note lưu ĐÃ redactDetail.
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope); DB/session/rbac/HMAC/rate-limit thật toàn
 * bộ. AUTH_SECRET + NEXT_PUBLIC_APP_URL stub trong beforeEach
 * (test-integration.sh chỉ set DATABASE_URL).
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

// ─── Cookie store điều khiển được (next/headers) — session THẬT ───────────────

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
import { BETA_INVITE_COOKIE, betaInviteTokenHash } from "../../src/lib/founding-sellers";
import {
  acceptInviteAction,
  createCandidateAction,
  inviteCandidateAction,
} from "../../src/lib/actions/founding-sellers";
import {
  cancelManualContactVerificationAction,
  decideManualContactVerificationAction,
  requestManualContactVerificationAction,
} from "../../src/lib/actions/manual-contact-verification";
import { manualContactTargetHash } from "../../src/lib/manual-contact-verification";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `mcv-${Date.now()}-${seq++}`;

/**
 * Số VN hợp lệ ( /^0\d{9,10}$/ ) UNIQUE mỗi call — seed Date.now() để khác nhau
 * qua CÁC RUN (leftover run fail không đâm uniqueness check của run sau).
 */
let phoneSeq = Number(String(Date.now()).slice(-6)) * 10;
const vnPhone = (): string => `09${String(10_000_000 + phoneSeq++).slice(-8)}`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const created = {
  users: [] as string[],
  candidates: [] as string[],
  tokens: [] as string[],
};

/** User thường (subject) — phone hợp lệ VN, CHƯA verified. */
async function mkSubject(over: {
  phone?: string;
  phoneVerifiedAt?: string | null;
  emailVerifiedAt?: string | null;
} = {}): Promise<{ id: string; email: string; phone: string }> {
  const email = `${uid()}@integration.test`;
  const phone = over.phone ?? vnPhone();
  const u = await db.orm.public.User.create({
    email,
    passwordHash: "x",
    name: `MCV subject ${seq}`,
    role: "buyer",
    phone,
    emailVerifiedAt: over.emailVerifiedAt ?? null,
    phoneVerifiedAt: over.phoneVerifiedAt ?? null,
  });
  created.users.push(u.id);
  return { id: u.id, email, phone };
}

/** Admin (super/ops — contact.verify_manual, ma trận §5.4.1). */
async function mkAdmin(role: "super_admin" | "operations_admin" = "super_admin"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `admin-${uid()}@integration.test`,
    passwordHash: "x",
    name: `MCV admin ${seq}`,
    role: "admin",
    adminRole: role,
  });
  created.users.push(u.id);
  return u.id;
}

/** Session THẬT (isAdmin) — trả token cookie. */
async function loginAs(userId: string): Promise<string> {
  await createSession(userId, { isAdmin: true });
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

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

const setSession = (token: string): void => {
  cookieState.store.set(SESSION_COOKIE, token);
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** acceptInviteAction throw NEXT_REDIRECT ở happy path — coi như thành công. */
async function acceptInvite(form: FormData): Promise<FormState> {
  try {
    return await acceptInviteAction({}, form);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) return {};
    throw e;
  }
}

/** Admin A mở request cho subject (session đã step-up). */
async function openRequest(
  adminToken: string,
  subjectId: string,
  channel: "email" | "phone",
  method: string = "phone_call",
): Promise<{ state: FormState; rowId: string | null }> {
  setSession(adminToken);
  const state = await requestManualContactVerificationAction(
    {},
    fd({ userId: subjectId, channel, method }),
  );
  const row = await db.orm.public.ManualContactVerification
    .where({ userId: subjectId, channel })
    .where((v) => v.status.eq("requested"))
    .first();
  return { state, rowId: row?.id ?? null };
}

type FormState = { error?: string; success?: string };

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: ManualContactVerification (userId Restrict) TRƯỚC User;
// BetaInviteToken (candidateId Restrict) TRƯỚC FoundingSellerCandidate.
// deleteAll() (KHÔNG phải delete() — delete() xóa đúng MỘT row đầu khớp,
// một user có thể có N verification row).
async function cleanupUser(userId: string): Promise<void> {
  await db.orm.public.ManualContactVerification.where({ userId }).deleteAll();
  await db.orm.public.ManualContactVerification.where({ requestedById: userId }).deleteAll();
  await db.orm.public.ManualContactVerification.where({ decidedById: userId }).deleteAll();
  await db.orm.public.AuditEvent.where({ actorId: userId }).deleteAll();
  await db.orm.public.AuditEvent.where({ subjectId: userId }).deleteAll();
  await db.orm.public.Notification.where({ userId }).deleteAll();
  await db.orm.public.BetaCohortMembership.where({ userId }).deleteAll();
  await db.orm.public.UserSession.where({ userId }).deleteAll();
  await db.orm.public.User.where({ id: userId }).delete();
}

afterEach(async () => {
  for (const id of created.tokens) {
    await db.orm.public.BetaInviteToken.where({ id }).delete();
  }
  for (const id of created.candidates) {
    await db.orm.public.FoundingSellerCandidate.where({ id }).delete();
  }
  for (const id of created.users) {
    await cleanupUser(id);
  }
  (Object.keys(created) as (keyof typeof created)[]).forEach((k) => {
    created[k].length = 0;
  });
  cookieState.store.clear();
  resetRateLimits();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://beta.loaviet.test");
});

afterAll(async () => {
  await db.close();
});

// ─── 1. End-to-end phone: request → approve → invite accept pass ─────────────

d("manual contact verification — end-to-end (phone channel)", () => {
  it(
    "A request → B approve → phoneVerifiedAt set → invitee phone-channel accept pass (trước đó UNVERIFIED)",
    { timeout: 120_000 },
    async () => {
      const subject = await mkSubject();
      const adminA = await mkAdmin("super_admin");
      const adminB = await mkAdmin("operations_admin");
      const opsInvite = await mkAdmin("operations_admin"); // mời (beta_cohort.manage)

      // ── invite kênh phone cho subject (ops console Batch 7)
      await loginAs(opsInvite);
      await stepUpCurrentSession(opsInvite); // không cần (beta_cohort.manage không step-up) — nhưng vô hại
      const candState = await createCandidateAction(
        {},
        fd({
          contactReference: subject.phone,
          contactChannel: "phone",
          source: "integration test tuyển nguồn",
          targetCommunity: "ha-noi",
        }),
      );
      expect(candState.error, JSON.stringify(candState)).toBeUndefined();
      const candidate = await db.orm.public.FoundingSellerCandidate.first({
        contactReference: subject.phone,
      });
      expect(candidate).not.toBeNull();
      created.candidates.push(candidate!.id);
      const inviteState = await inviteCandidateAction({}, fd({ candidateId: candidate!.id }));
      expect(inviteState.error, JSON.stringify(inviteState)).toBeUndefined();
      const rawToken = inviteState.inviteUrl!.split("/").pop()!;
      const tokenRow = await db.orm.public.BetaInviteToken.first({
        tokenHash: betaInviteTokenHash(rawToken),
      });
      expect(tokenRow).not.toBeNull();
      created.tokens.push(tokenRow!.id);

      // ── subject nhận lời mời TRƯỚC khi verified → INVITE_CHANNEL_UNVERIFIED
      //    (refusal TRƯỚC claim — token chưa consume)
      await loginAs(subject.id);
      cookieState.store.set(BETA_INVITE_COOKIE, rawToken);
      const before = await acceptInvite(fd({}));
      expect(before.error).toBe("INVITE_CHANNEL_UNVERIFIED");
      const tokenAfterRefusal = await db.orm.public.BetaInviteToken.first({ id: tokenRow!.id });
      expect(tokenAfterRefusal!.consumedAt).toBeNull(); // chưa burn

      // ── A request (super_admin, step-up tươi)
      const tokenA = await loginAs(adminA);
      await stepUpCurrentSession(adminA);
      const req = await openRequest(tokenA, subject.id, "phone", "phone_call");
      expect(req.state.error, JSON.stringify(req.state)).toBeUndefined();
      expect(req.state.success).toBeTruthy();
      expect(req.rowId).not.toBeNull();

      // row lưu HMAC của giá trị CHUẨN HÓA — KHÔNG BAO GIỜ số thô
      const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
      expect(row!.targetHash).toBe(manualContactTargetHash(subject.phone));
      expect(row!.targetHash).not.toBe(subject.phone);
      expect(row!.targetHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.status).toBe("requested");
      expect(row!.requestedById).toBe(adminA);
      expect(row!.decidedById).toBeNull();
      // expiresAt = requestedAt + 24h (± vài ms drift giữa hai lần đọc đồng hồ)
      const ttlMs = Date.parse(row!.expiresAt) - Date.parse(row!.requestedAt);
      expect(ttlMs).toBeGreaterThanOrEqual(24 * 3_600_000 - 5_000);
      expect(ttlMs).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);

      // ── B approve (ops, ≠ A, ≠ subject — step-up tươi)
      await loginAs(adminB);
      await stepUpCurrentSession(adminB);
      const approved = await decideManualContactVerificationAction(
        {},
        fd({ verificationId: req.rowId!, decision: "approve" }),
      );
      expect(approved.error, JSON.stringify(approved)).toBeUndefined();

      // verifiedAt set đúng MỘT lần; row approved + decidedBy B
      const subjectRow = await db.orm.public.User.first({ id: subject.id });
      expect(subjectRow!.phoneVerifiedAt).not.toBeNull();
      const rowAfter = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
      expect(rowAfter!.status).toBe("approved");
      expect(rowAfter!.decidedById).toBe(adminB);
      expect(rowAfter!.decidedAt).not.toBeNull();

      // ── subject nhận lời mời LẠI → pass (channel binding phone_verified)
      //    (loginAs(adminB) ở trên đã đè session cookie — đăng nhập lại subject)
      const subjectToken2 = await loginAs(subject.id);
      expect(subjectToken2).toBeTruthy();
      cookieState.store.set(BETA_INVITE_COOKIE, rawToken);
      const after = await acceptInvite(fd({}));
      expect(after.error, JSON.stringify(after)).toBeUndefined();
      const membership = await db.orm.public.BetaCohortMembership.first({
        userId: subject.id,
        cohort: "founding_seller",
      });
      expect(membership!.status).toBe("active");
      expect(membership!.acceptedAt).not.toBeNull();
    },
  );

  it("email channel: A request → B approve → emailVerifiedAt set (unique constraint của chính chủ)", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "email", "other");
    expect(req.state.error, JSON.stringify(req.state)).toBeUndefined();

    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const approved = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(approved.error, JSON.stringify(approved)).toBeUndefined();
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.emailVerifiedAt).not.toBeNull();
  });
});

// ─── 2. Two-person rule ──────────────────────────────────────────────────────

d("manual contact verification — two-person rule", () => {
  it("A KHÔNG tự duyệt request mình mở — SAME_PERSON_FORBIDDEN, row giữ nguyên, verifiedAt null", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    // A tự duyệt → refuse
    const self = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(self.error).toBe("SAME_PERSON_FORBIDDEN");
    const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(row!.status).toBe("requested"); // KHÔNG quyết
    expect(row!.decidedById).toBeNull();
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.phoneVerifiedAt).toBeNull();
  });

  it("admin KHÔNG mở request cho CHÍNH MÌNH — SELF_VERIFICATION_FORBIDDEN, không row nào được tạo", async () => {
    const adminA = await mkAdmin();
    await loginAs(adminA);
    await stepUpCurrentSession(adminA);

    const selfReq = await requestManualContactVerificationAction(
      {},
      fd({ userId: adminA, channel: "phone", method: "phone_call" }),
    );
    expect(selfReq.error).toBe("SELF_VERIFICATION_FORBIDDEN");
    const rows = await db.orm.public.ManualContactVerification.where({
      userId: adminA,
    }).all();
    expect(rows).toHaveLength(0);
  });

  it("B === subject (admin duyệt liên hệ của chính mình do ai đó mở hộ) → SELF_VERIFICATION_FORBIDDEN", async () => {
    // admin B là subject: A mở request cho B (B là admin có phone) — B tự duyệt → refuse
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    // B cần phone hợp lệ để A mở request kênh phone
    await db.orm.public.User.where({ id: adminB }).update({ phone: vnPhone() });

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, adminB, "phone");
    expect(req.state.error).toBeUndefined();

    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const self = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(self.error).toBe("SELF_VERIFICATION_FORBIDDEN");
    const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(row!.status).toBe("requested");
    const bRow = await db.orm.public.User.first({ id: adminB });
    expect(bRow!.phoneVerifiedAt).toBeNull();
  });
});

// ─── 3. CONTACT_CHANGED ──────────────────────────────────────────────────────

d("manual contact verification — contact changed between request and decide", () => {
  it("đổi số sau request → B approve refuse CONTACT_CHANGED, row giữ nguyên, verifiedAt null", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    // subject ĐỔI SỐ giữa request và decide (profile flow — chưa verified nên được phép)
    const newPhone = vnPhone();
    await db.orm.public.User.where({ id: subject.id }).update({ phone: newPhone });

    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(decided.error).toBe("CONTACT_CHANGED");
    const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(row!.status).toBe("requested"); // tx abort — quyết định KHÔNG persist
    expect(row!.decidedById).toBeNull();
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.phoneVerifiedAt).toBeNull(); // KHÔNG verify số mới chưa từng xác nhận
  });
});

// ─── 4. EXPIRED (no cron) + re-request ──────────────────────────────────────

d("manual contact verification — expiry on read (no cron)", () => {
  it("expiresAt quá khứ → B approve refuse EXPIRED; request MỚI flip row cũ sang expired + tạo row mới", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    // giả lập hết hạn (no cron — row giữ status requested, expiresAt quá khứ)
    await db.orm.public.ManualContactVerification.where({ id: req.rowId! }).updateAll({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    // B approve → EXPIRED (CAS expiresAt > now chặn)
    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(decided.error).toBe("EXPIRED");
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.phoneVerifiedAt).toBeNull();

    // A mở request MỚI → row cũ flip 'expired' (partial unique không chặn vĩnh viễn)
    const tokenA2 = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req2 = await openRequest(tokenA2, subject.id, "phone");
    expect(req2.state.error, JSON.stringify(req2.state)).toBeUndefined();
    expect(req2.rowId).not.toBeNull();
    expect(req2.rowId).not.toBe(req.rowId); // row MỚI — không tái dùng row cũ
    const oldRow = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(oldRow!.status).toBe("expired"); // row cũ flip — GIỮ làm audit trail
    const newRow = await db.orm.public.ManualContactVerification.first({ id: req2.rowId! });
    expect(newRow!.status).toBe("requested");

    // B approve row MỚI → pass
    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const approved = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req2.rowId!, decision: "approve" }),
    );
    expect(approved.error, JSON.stringify(approved)).toBeUndefined();
    const subjectRow2 = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow2!.phoneVerifiedAt).not.toBeNull();
  });
});

// ─── 5. OPEN_REQUEST_EXISTS (partial unique) ─────────────────────────────────

d("manual contact verification — one open request per (userId, channel)", () => {
  it("request thứ hai cùng kênh khi còn row requested → OPEN_REQUEST_EXISTS; kênh khác tự do", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    // request thứ hai cùng (subject, phone) → typed error (pre-check path)
    const dup = await requestManualContactVerificationAction(
      {},
      fd({ userId: subject.id, channel: "phone", method: "video_call" }),
    );
    expect(dup.error).toBe("OPEN_REQUEST_EXISTS");
    const count = await db.orm.public.ManualContactVerification
      .where({ userId: subject.id, channel: "phone" })
      .aggregate((a) => ({ c: a.count() }));
    expect(count.c).toBe(1); // KHÔNG row thứ hai

    // kênh KHÁC (email) tự do — index là per (userId, channel)
    const emailReq = await requestManualContactVerificationAction(
      {},
      fd({ userId: subject.id, channel: "email", method: "other" }),
    );
    expect(emailReq.error, JSON.stringify(emailReq)).toBeUndefined();
  });

  it("kênh đã verified → ALREADY_VERIFIED; chưa có số → PHONE_NOT_ON_FILE", async () => {
    const verifiedSubject = await mkSubject({ phoneVerifiedAt: new Date().toISOString() });
    const noPhoneSubject = await mkSubject();
    await db.orm.public.User.where({ id: noPhoneSubject.id }).update({ phone: null });
    const adminA = await mkAdmin();

    await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const already = await requestManualContactVerificationAction(
      {},
      fd({ userId: verifiedSubject.id, channel: "phone", method: "phone_call" }),
    );
    expect(already.error).toBe("ALREADY_VERIFIED");
    const noPhone = await requestManualContactVerificationAction(
      {},
      fd({ userId: noPhoneSubject.id, channel: "phone", method: "phone_call" }),
    );
    expect(noPhone.error).toBe("PHONE_NOT_ON_FILE");
  });
});

// ─── 6. PHONE_ALREADY_VERIFIED (uniqueness danh tính verified) ────────────────

d("manual contact verification — verified-identifier uniqueness (OTP confirm path contract)", () => {
  it("số đã verified bởi tài khoản khác → B approve refuse PHONE_ALREADY_VERIFIED, KHÔNG merge", async () => {
    // chủ thật của số: tài khoản khác đã verified cùng số
    const owner = await mkSubject({ phoneVerifiedAt: new Date().toISOString() });
    // subject: đổi sang số của owner (chưa verified nên profile cho phép)
    const subject = await mkSubject();
    await db.orm.public.User.where({ id: subject.id }).update({ phone: owner.phone });

    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(decided.error).toBe("PHONE_ALREADY_VERIFIED");
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.phoneVerifiedAt).toBeNull(); // KHÔNG merge — số là của owner
    const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(row!.status).toBe("requested"); // tx abort
  });
});

// ─── 7. Reject ───────────────────────────────────────────────────────────────

d("manual contact verification — reject", () => {
  it("B reject → row rejected, verifiedAt null (KHÔNG set)", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const rejected = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "reject" }),
    );
    expect(rejected.error, JSON.stringify(rejected)).toBeUndefined();
    const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(row!.status).toBe("rejected");
    expect(row!.decidedById).toBe(adminB);
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.phoneVerifiedAt).toBeNull();

    // quyết định lần hai → ALREADY_DECIDED
    const again = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(again.error).toBe("ALREADY_DECIDED");
  });
});

// ─── 8. Cancel ────────────────────────────────────────────────────────────────

d("manual contact verification — cancel (requester only)", () => {
  it("B (không phải requester) cancel → NOT_REQUESTER; A cancel → row cancelled; B approve sau đó → ALREADY_DECIDED", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRequest(tokenA, subject.id, "phone");
    expect(req.state.error).toBeUndefined();

    // B không phải người mở → không được hủy
    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const bCancel = await cancelManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId! }),
    );
    expect(bCancel.error).toBe("NOT_REQUESTER");
    const rowMid = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(rowMid!.status).toBe("requested");

    // A (người mở) hủy → cancelled
    await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const aCancel = await cancelManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId! }),
    );
    expect(aCancel.error, JSON.stringify(aCancel)).toBeUndefined();
    const row = await db.orm.public.ManualContactVerification.first({ id: req.rowId! });
    expect(row!.status).toBe("cancelled");

    // B approve sau cancel → ALREADY_DECIDED (KHÔNG quyết request đã hủy)
    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: req.rowId!, decision: "approve" }),
    );
    expect(decided.error).toBe("ALREADY_DECIDED");
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.phoneVerifiedAt).toBeNull();
  });
});

// ─── 9. Audit — trong tx, KHÔNG raw PII ──────────────────────────────────────

d("manual contact verification — audit rows (§4.6/§4.8)", () => {
  it("mọi flow ghi contact.manual_verify_* — detail chỉ ids/channel/method/decision, KHÔNG số/email thô, KHÔNG note", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    // request kèm note chứa PII giả — note phải được redactDetail TRƯỚC khi lưu
    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    setSession(tokenA);
    const reqState = await requestManualContactVerificationAction(
      {},
      fd({
        userId: subject.id,
        channel: "phone",
        method: "phone_call",
        note: `gọi số ${subject.phone} xác minh`,
      }),
    );
    expect(reqState.error, JSON.stringify(reqState)).toBeUndefined();
    const row = await db.orm.public.ManualContactVerification
      .where({ userId: subject.id, channel: "phone" })
      .where((v) => v.status.eq("requested"))
      .first();
    expect(row).not.toBeNull();
    // note ĐÃ redact (số thô bị mask — belt-and-braces redactDetail)
    expect(row!.note).not.toContain(subject.phone);
    expect(row!.note).toContain("[REDACTED_PHONE]");

    await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const approved = await decideManualContactVerificationAction(
      {},
      fd({ verificationId: row!.id, decision: "approve" }),
    );
    expect(approved.error, JSON.stringify(approved)).toBeUndefined();

    // audit rows: requested + approved (trong tx — sống sót vì tx commit)
    const events = await db.orm.public.AuditEvent
      .where({ subjectId: subject.id })
      .where((e) => e.action.in([
        "contact.manual_verify_requested",
        "contact.manual_verify_approved",
        "contact.manual_verify_rejected",
        "contact.manual_verify_cancelled",
      ]))
      .all();
    expect(events.map((e) => e.action).sort()).toEqual([
      "contact.manual_verify_approved",
      "contact.manual_verify_requested",
    ]);
    for (const e of events) {
      expect(e.resourceType).toBe("ManualContactVerification");
      expect(e.resourceId).toBe(row!.id);
      // detail chỉ channel/method/decision — KHÔNG BAO GIỜ số/email/note thô
      expect(e.detail).toContain("channel=phone");
      expect(e.detail).toContain("method=phone_call");
      expect(e.detail).not.toContain(subject.phone);
      expect(e.detail).not.toContain(subject.email);
      expect(e.detail).not.toContain("[REDACTED_PHONE]"); // note không nhân bản vào audit
      expect(e.detail).not.toMatch(/@\w+\./); // không email shape
    }
    // actor đúng người (A request, B approve — two-person rule trong audit)
    const requested = events.find((e) => e.action === "contact.manual_verify_requested")!;
    const approvedEv = events.find((e) => e.action === "contact.manual_verify_approved")!;
    expect(requested.actorId).toBe(adminA);
    expect(approvedEv.actorId).toBe(adminB);
    expect(approvedEv.detail).toContain("decision=approve");
  });
});
