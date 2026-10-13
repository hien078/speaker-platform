/**
 * Manual account recovery — integration tests (Task E, founder FD-R3
 * 2026-10-13) — chạy trên scratch DB (scripts/test-integration.sh: container
 * riêng + `prisma db migrate --to production` + dọn). KHÔNG chạy trong
 * `npm test`.
 *
 * Chứng minh CÙNG hợp đồng unit (tests/unit/manual-account-recovery.test.ts)
 * against DB THẬT với module THẬT (session/rbac step-up, HMAC hkdfKey labels
 * "account-recovery-phone"/"account-recovery-reset-token", partial unique
 * account_recovery_one_open, CAS updateAll, auditEventTx trong tx):
 *
 *  1. End-to-end: A request (2/3 checks + attestation) → B approve → resetUrl
 *     MỘT lần (token thô CHỈ trong state trả về) → MỌI session subject bị
 *     thu hồi TRONG tx approve → user consume qua cookie HttpOnly (public —
 *     KHÔNG session) → mật khẩu mới (verifyPassword — hashPassword thật,
 *     KHÔNG hand-set) + row consumed + cookie xóa.
 *  2. Two-person rule: A KHÔNG tự duyệt (SAME_PERSON_FORBIDDEN); KHÔNG mở
 *     cho chính mình (SELF_RECOVERY_FORBIDDEN); B === subject → refuse
 *     (SELF_RECOVERY_FORBIDDEN — row cài tay, decide-side tự chặn kể cả khi
 *     request-side bị bypass); subject là admin → ADMIN_SUBJECT_FORBIDDEN
 *     (khôi phục admin thuộc bootstrap runbook — MFA reset).
 *  3. Guards request: < 2/3 checks → CHECKS_INSUFFICIENT (0 câu và 1 câu);
 *     thiếu attestation → ATTESTATION_REQUIRED; phone chưa verified →
 *     PHONE_NOT_VERIFIED (cuộc gọi PHẢI tới số ĐÃ XÁC MINH); 3/3 cũng mở
 *     được (checksPassed=3).
 *  4. CONTACT_CHANGED: đổi số giữa request/decide → approve refuse (hash +
 *     phoneVerifiedAtSnapshot không khớp), row giữ nguyên, session subject
 *     KHÔNG bị thu hồi (tx abort — quyết định KHÔNG gắn với số chưa từng
 *     out-of-band).
 *  5. EXPIRED (no cron): expiresAt quá khứ → approve refuse; request MỚI flip
 *     row cũ sang 'expired' trong tx của mình (partial unique
 *     account_recovery_one_open KHÔNG chặn vĩnh viễn user).
 *  6. Token single-use + expiring: consume lần hai → CÙNG lỗi chung
 *     (KHÔNG oracle, KHÔNG đổi mật khẩu lần nữa); resetTokenExpiresAt quá
 *     khứ → CÙNG lỗi chung; row approved-unconsumed token hết hạn được
 *     request mới flip sang 'expired'.
 *  7. Forged token: đúng shape nhưng rác / sai shape / KHÔNG cookie → CÙNG
 *     lỗi chung, KHÔNG side effect (row KHÔNG consume, mật khẩu KHÔNG đổi).
 *  8. OPEN_REQUEST_EXISTS: request thứ hai khi còn row requested → typed
 *     error; approved-unconsumed token còn hạn CŨNG chiếm slot (một link
 *     reset sống tối đa per user).
 *  9. Reject + Cancel: reject KHÔNG issue token; cancel chỉ requester
 *     (NOT_REQUESTER cho admin B); quyết định sau cancel → ALREADY_DECIDED.
 * 10. Audit (§4.6/§4.8): mọi flow ghi account.manual_recovery_* trong cùng
 *     tx — detail chỉ checks/decision, actor đúng vai (A request, B decide,
 *     subject consume), KHÔNG BAO GIỜ phone/email/token thô.
 * 11. Raw token KHÔNG bao giờ persisted: MỌI row AccountRecoveryRequest +
 *     AuditEvent của subject không chứa token thô; resetTokenHash là HMAC
 *     keyed (không reverses).
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope; consume đọc token từ cookie); DB/session/
 * rbac/HMAC/rate-limit thật toàn bộ. AUTH_SECRET + NEXT_PUBLIC_APP_URL stub
 * trong beforeEach (test-integration.sh chỉ set DATABASE_URL).
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
import { verifyPassword } from "../../src/lib/auth";
import { normalizePhone } from "../../src/lib/otp";
import {
  MANUAL_RECOVERY_CHECKS,
  MANUAL_RECOVERY_COOKIE,
  accountRecoveryPhoneHash,
  accountRecoveryResetTokenHash,
} from "../../src/lib/manual-account-recovery";
import {
  cancelManualAccountRecoveryAction,
  consumeManualAccountRecoveryAction,
  decideManualAccountRecoveryAction,
  requestManualAccountRecoveryAction,
} from "../../src/lib/actions/manual-account-recovery";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `mar-${Date.now()}-${seq++}`;

/**
 * Số VN hợp lệ ( /^0\d{9,10}$/ ) UNIQUE mỗi call — seed Date.now() để khác nhau
 * qua CÁC RUN (leftover run fail không đâm uniqueness check của run sau).
 */
let phoneSeq = Number(String(Date.now()).slice(-6)) * 10;
const vnPhone = (): string => `09${String(10_000_000 + phoneSeq++).slice(-8)}`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const created = { users: [] as string[] };

/**
 * User thường (subject) — phone VN hợp lệ + ĐÃ verified (procedure yêu cầu:
 * cuộc gọi phải tới số ĐÃ XÁC MINH). passwordHash "x" (bcrypt rác — mọi
 * verifyPassword fail; consume phải THAY nó bằng hash thật).
 */
async function mkSubject(over: {
  phone?: string;
  phoneVerifiedAt?: string | null;
} = {}): Promise<{ id: string; email: string; phone: string; phoneVerifiedAt: string | null }> {
  const email = `${uid()}@integration.test`;
  const phone = over.phone ?? vnPhone();
  // KHÔNG dùng `??` — nó nuốt cả null tường minh (subject CHƯA verified là
  // chính test case); chỉ default khi key vắng.
  const phoneVerifiedAt =
    over.phoneVerifiedAt === undefined ? new Date().toISOString() : over.phoneVerifiedAt;
  const u = await db.orm.public.User.create({
    email,
    passwordHash: "x",
    name: `MAR subject ${seq}`,
    role: "buyer",
    phone,
    emailVerifiedAt: null,
    phoneVerifiedAt,
  });
  created.users.push(u.id);
  return { id: u.id, email, phone, phoneVerifiedAt };
}

/** Admin (super/ops — account.recover_manual, ma trận §5.4.1). */
async function mkAdmin(role: "super_admin" | "operations_admin" = "super_admin"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `admin-${uid()}@integration.test`,
    passwordHash: "x",
    name: `MAR admin ${seq}`,
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

type FormState = { error?: string; success?: string; resetUrl?: string };

/** Admin A mở request cho subject (session đã step-up) — mặc định 2/3 checks + attestation. */
async function openRecovery(
  adminToken: string,
  subjectId: string,
  over: { checks?: readonly string[]; attested?: boolean } = {},
): Promise<{ state: FormState; rowId: string | null }> {
  setSession(adminToken);
  const form = fd({ userId: subjectId });
  for (const check of over.checks ?? ["check_listing_title", "check_province"]) {
    form.set(check, "on");
  }
  if (over.attested !== false) form.set("attestedCall", "on");
  const state = await requestManualAccountRecoveryAction({}, form);
  const row = await db.orm.public.AccountRecoveryRequest
    .where({ userId: subjectId })
    .where((r) => r.status.eq("requested"))
    .first();
  return { state, rowId: row?.id ?? null };
}

/** Admin B quyết định (approve mặc định). */
async function decideAs(
  adminToken: string,
  requestId: string,
  decision: "approve" | "reject" = "approve",
): Promise<FormState> {
  setSession(adminToken);
  return decideManualAccountRecoveryAction({}, fd({ requestId, decision }));
}

/** User consume qua cookie HttpOnly (public — KHÔNG session). */
async function consumeWithToken(token: string | null, newPassword: string): Promise<FormState> {
  if (token === null) cookieState.store.delete(MANUAL_RECOVERY_COOKIE);
  else cookieState.store.set(MANUAL_RECOVERY_COOKIE, token);
  return consumeManualAccountRecoveryAction({}, fd({ newPassword }));
}

/** A request → B approve → trả { requestId, rawToken } (chuẩn bị consume). */
async function approveFlow(
  subject: { id: string },
  adminA: string,
  adminB: string,
): Promise<{ requestId: string; rawToken: string }> {
  const tokenA = await loginAs(adminA);
  await stepUpCurrentSession(adminA);
  const req = await openRecovery(tokenA, subject.id);
  expect(req.state.error, JSON.stringify(req.state)).toBeUndefined();
  expect(req.rowId).not.toBeNull();
  const tokenB = await loginAs(adminB);
  await stepUpCurrentSession(adminB);
  const approved = await decideAs(tokenB, req.rowId!, "approve");
  expect(approved.error, JSON.stringify(approved)).toBeUndefined();
  expect(approved.resetUrl).toBeTruthy();
  return { requestId: req.rowId!, rawToken: approved.resetUrl!.split("/").pop()! };
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: AccountRecoveryRequest (userId Restrict) TRƯỚC User;
// AuditEvent (actor/subject) TRƯỚC User. deleteAll() — một user có thể có
// N row recovery (requested → expired → requested... qua các test).
async function cleanupUser(userId: string): Promise<void> {
  await db.orm.public.AccountRecoveryRequest.where({ userId }).deleteAll();
  await db.orm.public.AccountRecoveryRequest.where({ requestedById: userId }).deleteAll();
  await db.orm.public.AccountRecoveryRequest.where({ decidedById: userId }).deleteAll();
  await db.orm.public.AuditEvent.where({ actorId: userId }).deleteAll();
  await db.orm.public.AuditEvent.where({ subjectId: userId }).deleteAll();
  await db.orm.public.Notification.where({ userId }).deleteAll();
  await db.orm.public.UserSession.where({ userId }).deleteAll();
  await db.orm.public.User.where({ id: userId }).delete();
}

afterEach(async () => {
  for (const id of created.users) {
    await cleanupUser(id);
  }
  created.users.length = 0;
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

// ─── 1. End-to-end (two-person) ──────────────────────────────────────────────

d("manual account recovery — end-to-end (two-person)", () => {
  it(
    "A request → B approve → resetUrl MỘT lần + MỌI session thu hồi → user consume → mật khẩu mới + row consumed + cookie xóa",
    { timeout: 120_000 },
    async () => {
      const subject = await mkSubject();
      const adminA = await mkAdmin("super_admin");
      const adminB = await mkAdmin("operations_admin");

      // subject giữ 2 session sống (chứng minh approve thu hồi TẤT CẢ)
      await loginAs(subject.id);
      await loginAs(subject.id);
      const sessionsBefore = await db.orm.public.UserSession.where({ userId: subject.id }).all();
      expect(sessionsBefore.length).toBeGreaterThanOrEqual(2);
      for (const s of sessionsBefore) expect(s.revokedAt).toBeNull();

      // ── A mở request (2/3 checks + attestation, step-up tươi)
      const tokenA = await loginAs(adminA);
      await stepUpCurrentSession(adminA);
      const req = await openRecovery(tokenA, subject.id);
      expect(req.state.error, JSON.stringify(req.state)).toBeUndefined();
      expect(req.state.success).toBeTruthy();
      expect(req.rowId).not.toBeNull();

      const row = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
      expect(row!.status).toBe("requested");
      expect(row!.requestedById).toBe(adminA);
      expect(row!.decidedById).toBeNull();
      expect(row!.checksPassed).toBe(2);
      expect(row!.checkListingTitle).toBe(true);
      expect(row!.checkProvince).toBe(true);
      expect(row!.checkRegistrationMonth).toBe(false);
      // phoneHash = HMAC của phone CHUẨN HÓA — KHÔNG BAO GIỜ số thô
      expect(row!.phoneHash).toBe(accountRecoveryPhoneHash(normalizePhone(subject.phone)));
      expect(row!.phoneHash).not.toBe(subject.phone);
      expect(row!.phoneHash).toMatch(/^[0-9a-f]{64}$/);
      // snapshot phoneVerifiedAt của subject LÚC request (approve so lại) —
      // DB trả timestamptz dạng text riêng ("+00"), so NGHĨA (instant), không so chuỗi
      expect(subject.phoneVerifiedAt).not.toBeNull(); // fixture mặc định đã verified
      expect(Date.parse(row!.phoneVerifiedAtSnapshot)).toBe(Date.parse(subject.phoneVerifiedAt!));
      expect(row!.resetTokenHash).toBeNull(); // token CHƯA issue
      // expiresAt = requestedAt + 24h (± vài ms drift giữa hai lần đọc đồng hồ)
      const ttlMs = Date.parse(row!.expiresAt) - Date.parse(row!.requestedAt);
      expect(ttlMs).toBeGreaterThanOrEqual(24 * 3_600_000 - 5_000);
      expect(ttlMs).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);

      // ── B approve (ops, ≠ A, ≠ subject — step-up tươi)
      const tokenB = await loginAs(adminB);
      await stepUpCurrentSession(adminB);
      const approved = await decideAs(tokenB, req.rowId!, "approve");
      expect(approved.error, JSON.stringify(approved)).toBeUndefined();
      // URL reset MỘT LẦN — appUrl stub + token 43-char base64url
      expect(approved.resetUrl).toMatch(
        /^https:\/\/beta\.loaviet\.test\/recover\/manual\/[A-Za-z0-9_-]{43}$/,
      );

      const rowAfter = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
      expect(rowAfter!.status).toBe("approved");
      expect(rowAfter!.decidedById).toBe(adminB);
      expect(rowAfter!.decidedAt).not.toBeNull();
      const rawToken = approved.resetUrl!.split("/").pop()!;
      // DB lưu CHỈ HMAC keyed của token — KHÔNG token thô
      expect(rowAfter!.resetTokenHash).toBe(accountRecoveryResetTokenHash(rawToken));
      expect(rowAfter!.resetTokenHash).not.toBe(rawToken);
      // resetTokenExpiresAt = decidedAt + 30 phút
      const tokenTtlMs =
        Date.parse(rowAfter!.resetTokenExpiresAt!) - Date.parse(rowAfter!.decidedAt!);
      expect(tokenTtlMs).toBeGreaterThanOrEqual(30 * 60_000 - 5_000);
      expect(tokenTtlMs).toBeLessThanOrEqual(30 * 60_000 + 5_000);

      // MỌI session của subject bị thu hồi TRONG tx approve (containment —
      // kẻ đang giữ session cũ mất tác quyền NGAY, trước cả khi user đặt
      // được mật khẩu mới)
      const sessionsAfter = await db.orm.public.UserSession.where({ userId: subject.id }).all();
      expect(sessionsAfter.length).toBeGreaterThanOrEqual(2);
      for (const s of sessionsAfter) {
        expect(s.revokedAt).not.toBeNull();
        expect(s.revokedReason).toBe("manual_account_recovery");
      }

      // ── user consume qua cookie HttpOnly (public — KHÔNG session/capability)
      const newPassword = "mat-khau-moi-123";
      const consumed = await consumeWithToken(rawToken, newPassword);
      expect(consumed.error, JSON.stringify(consumed)).toBeUndefined();
      expect(consumed.success).toBeTruthy();

      const rowConsumed = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
      expect(rowConsumed!.status).toBe("consumed");
      expect(rowConsumed!.consumedAt).not.toBeNull();

      // mật khẩu mới hoạt động (hashPassword thật trong action — KHÔNG hand-set)
      const subjectRow = await db.orm.public.User.first({ id: subject.id });
      expect(subjectRow!.passwordHash).not.toBe("x");
      await expect(verifyPassword(newPassword, subjectRow!.passwordHash!)).resolves.toBe(true);

      // cookie đã xóa sau consume (token đã burn — belt-and-suspenders)
      expect(cookieState.store.get(MANUAL_RECOVERY_COOKIE)).toBeUndefined();
    },
  );
});

// ─── 2. Two-person rule ──────────────────────────────────────────────────────

d("manual account recovery — two-person rule", () => {
  it("A KHÔNG tự duyệt request mình mở — SAME_PERSON_FORBIDDEN, row giữ nguyên, KHÔNG token", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    // A tự duyệt → refuse (mọi admin giữ capability đều step-up được —
    // ranh giới là NGƯỜI KHÁC, không phải mã)
    const self = await decideAs(tokenA, req.rowId!, "approve");
    expect(self.error).toBe("SAME_PERSON_FORBIDDEN");
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(row!.status).toBe("requested"); // KHÔNG quyết
    expect(row!.decidedById).toBeNull();
    expect(row!.resetTokenHash).toBeNull();
  });

  it("admin KHÔNG mở request cho CHÍNH MÌNH — SELF_RECOVERY_FORBIDDEN, không row nào được tạo", async () => {
    const adminA = await mkAdmin();
    await loginAs(adminA); // side effect: session cookie (token không dùng trực tiếp)
    await stepUpCurrentSession(adminA);

    const form = fd({ userId: adminA, attestedCall: "on" });
    for (const check of MANUAL_RECOVERY_CHECKS) form.set(`check_${check}`, "on");
    const selfReq = await requestManualAccountRecoveryAction({}, form);
    expect(selfReq.error).toBe("SELF_RECOVERY_FORBIDDEN");
    const rows = await db.orm.public.AccountRecoveryRequest.where({ userId: adminA }).all();
    expect(rows).toHaveLength(0);
  });

  it("B === subject (admin duyệt khôi phục cho chính mình, row cài tay) → SELF_RECOVERY_FORBIDDEN", async () => {
    // Request-side đã chặn admin subject (ADMIN_SUBJECT_FORBIDDEN) — decide-side
    // phải TỰ chặn kể cả khi row tồn tại bởi bypass/lỗi khác (defense in depth).
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    const nowIso = new Date().toISOString();
    const inserted = await db.orm.public.AccountRecoveryRequest.create({
      userId: adminB, // subject là chính admin B
      checksPassed: 2,
      checkListingTitle: true,
      checkProvince: true,
      checkRegistrationMonth: false,
      phoneVerifiedAtSnapshot: nowIso,
      phoneHash: accountRecoveryPhoneHash(normalizePhone(vnPhone())),
      status: "requested",
      requestedById: adminA,
      requestedAt: nowIso,
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });

    const tokenB = await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const self = await decideAs(tokenB, inserted.id, "approve");
    expect(self.error).toBe("SELF_RECOVERY_FORBIDDEN");
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: inserted.id });
    expect(row!.status).toBe("requested");
    expect(row!.resetTokenHash).toBeNull();
  });

  it("subject là ADMIN account → ADMIN_SUBJECT_FORBIDDEN (khôi phục admin thuộc bootstrap runbook)", async () => {
    const adminA = await mkAdmin();
    const adminC = await mkAdmin("operations_admin");
    // admin C có phone ĐÃ verified — chặn vì là admin, không phải vì thiếu phone
    await db.orm.public.User.where({ id: adminC }).update({
      phone: vnPhone(),
      phoneVerifiedAt: new Date().toISOString(),
    });

    await loginAs(adminA); // side effect: session cookie
    await stepUpCurrentSession(adminA);
    const form = fd({ userId: adminC, attestedCall: "on" });
    for (const check of MANUAL_RECOVERY_CHECKS) form.set(`check_${check}`, "on");
    const refused = await requestManualAccountRecoveryAction({}, form);
    expect(refused.error).toBe("ADMIN_SUBJECT_FORBIDDEN");
    const rows = await db.orm.public.AccountRecoveryRequest.where({ userId: adminC }).all();
    expect(rows).toHaveLength(0);
  });
});

// ─── 3. Request guards (checks + attestation + phone verified) ────────────────

d("manual account recovery — request guards", () => {
  it("1/3 câu → CHECKS_INSUFFICIENT; 0/3 → CHECKS_INSUFFICIENT; thiếu attestation → ATTESTATION_REQUIRED", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);

    const one = await openRecovery(tokenA, subject.id, {
      checks: ["check_listing_title"],
    });
    expect(one.state.error).toBe("CHECKS_INSUFFICIENT");
    const zero = await openRecovery(tokenA, subject.id, { checks: [] });
    expect(zero.state.error).toBe("CHECKS_INSUFFICIENT");
    const noAttest = await openRecovery(tokenA, subject.id, { attested: false });
    expect(noAttest.state.error).toBe("ATTESTATION_REQUIRED");
    const rows = await db.orm.public.AccountRecoveryRequest.where({ userId: subject.id }).all();
    expect(rows).toHaveLength(0); // KHÔNG row nào được tạo
  });

  it("3/3 câu cũng mở được (checksPassed=3); phone chưa verified → PHONE_NOT_VERIFIED; phone null → PHONE_NOT_VERIFIED", async () => {
    const subject = await mkSubject();
    const unverified = await mkSubject({ phoneVerifiedAt: null });
    const noPhone = await mkSubject();
    await db.orm.public.User.where({ id: noPhone.id }).update({ phone: null });
    const adminA = await mkAdmin();
    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);

    // 3/3 + attestation → pass (hợp đồng 2..3 — DB CHECK 2..3)
    const allThree = fd({ userId: subject.id, attestedCall: "on" });
    for (const check of MANUAL_RECOVERY_CHECKS) allThree.set(`check_${check}`, "on");
    const okState = await requestManualAccountRecoveryAction({}, allThree);
    expect(okState.error, JSON.stringify(okState)).toBeUndefined();
    const row = await db.orm.public.AccountRecoveryRequest.where({ userId: subject.id }).first();
    expect(row!.checksPassed).toBe(3);

    // phone chưa verified → procedure KHÔNG dùng được (cuộc gọi phải tới số đã xác minh)
    const un = await openRecovery(tokenA, unverified.id);
    expect(un.state.error).toBe("PHONE_NOT_VERIFIED");
    const np = await openRecovery(tokenA, noPhone.id);
    expect(np.state.error).toBe("PHONE_NOT_VERIFIED");
  });
});

// ─── 4. CONTACT_CHANGED ──────────────────────────────────────────────────────

d("manual account recovery — contact changed between request and decide", () => {
  it("đổi SỐ sau request → B approve refuse CONTACT_CHANGED, row giữ nguyên, session KHÔNG thu hồi", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    await loginAs(subject.id); // session sống — phải KHÔNG bị thu hồi khi refuse

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    // subject ĐỔI SỐ giữa request và decide (profile flow — chưa verified thì bị
    // reset; đây là đổi raw value → hash không khớp)
    await db.orm.public.User.where({ id: subject.id }).update({ phone: vnPhone() });

    const tokenB = await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideAs(tokenB, req.rowId!, "approve");
    expect(decided.error).toBe("CONTACT_CHANGED");
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(row!.status).toBe("requested"); // tx abort — quyết định KHÔNG persist
    expect(row!.decidedById).toBeNull();
    expect(row!.resetTokenHash).toBeNull();
    // session subject NGUYÊN VẸN — quyết định bị từ chối KHÔNG thu hồi
    const sessions = await db.orm.public.UserSession.where({ userId: subject.id }).all();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) expect(s.revokedAt).toBeNull();
  });

  it("re-verify cùng số (phoneVerifiedAt đổi) giữa request/decide → CONTACT_CHANGED (snapshot không khớp)", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    // cùng số, nhưng phoneVerifiedAt đổi (re-verify) → snapshot không khớp —
    // quyết định phải gắn với CHÍNH xác nhận đã nghe điện thoại
    await db.orm.public.User.where({ id: subject.id }).update({
      phoneVerifiedAt: new Date().toISOString(),
    });

    const tokenB = await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideAs(tokenB, req.rowId!, "approve");
    expect(decided.error).toBe("CONTACT_CHANGED");
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(row!.status).toBe("requested");
  });
});

// ─── 5. EXPIRED (no cron) + re-request ────────────────────────────────────────

d("manual account recovery — expiry on read (no cron)", () => {
  it("expiresAt quá khứ → B approve refuse EXPIRED; request MỚI flip row cũ sang expired + tạo row mới", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    // giả lập hết hạn (no cron — row giữ status requested, expiresAt quá khứ)
    await db.orm.public.AccountRecoveryRequest.where({ id: req.rowId! }).updateAll({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    // B approve → EXPIRED (CAS expiresAt > now chặn)
    const tokenB = await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideAs(tokenB, req.rowId!, "approve");
    expect(decided.error).toBe("EXPIRED");

    // A mở request MỚI → row cũ flip 'expired' (partial unique không chặn vĩnh viễn)
    const tokenA2 = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req2 = await openRecovery(tokenA2, subject.id);
    expect(req2.state.error, JSON.stringify(req2.state)).toBeUndefined();
    expect(req2.rowId).not.toBeNull();
    expect(req2.rowId).not.toBe(req.rowId); // row MỚI — không tái dùng row cũ
    const oldRow = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(oldRow!.status).toBe("expired"); // row cũ flip — GIỮ làm audit trail
    const newRow = await db.orm.public.AccountRecoveryRequest.first({ id: req2.rowId! });
    expect(newRow!.status).toBe("requested");
  });
});

// ─── 6. Reset token single-use + expiring ────────────────────────────────────

d("manual account recovery — reset token single-use + expiring", () => {
  it("consume lần HAI với cùng token → CÙNG lỗi chung, KHÔNG đổi mật khẩu lần nữa", { timeout: 120_000 }, async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    const { requestId, rawToken } = await approveFlow(subject, adminA, adminB);

    const first = await consumeWithToken(rawToken, "mat-khau-mot-123");
    expect(first.error, JSON.stringify(first)).toBeUndefined();
    const hashAfterFirst = (await db.orm.public.User.first({ id: subject.id }))!.passwordHash;
    await expect(verifyPassword("mat-khau-mot-123", hashAfterFirst!)).resolves.toBe(true);

    // token đã burn — consume lại → CÙNG lỗi chung (KHÔNG oracle "đã dùng rồi")
    const second = await consumeWithToken(rawToken, "mat-khau-hai-456");
    expect(second.error).toContain("không còn hiệu lực");
    const hashAfterSecond = (await db.orm.public.User.first({ id: subject.id }))!.passwordHash;
    expect(hashAfterSecond).toBe(hashAfterFirst); // KHÔNG đổi lần nữa
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: requestId });
    expect(row!.status).toBe("consumed");
  });

  it("resetTokenExpiresAt quá khứ → consume refuse (CÙNG lỗi chung); request MỚI flip row sang expired", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    const { requestId, rawToken } = await approveFlow(subject, adminA, adminB);

    // giả lập token hết hạn 30 phút (row giữ status approved)
    await db.orm.public.AccountRecoveryRequest.where({ id: requestId }).updateAll({
      resetTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const consumed = await consumeWithToken(rawToken, "mat-khau-moi-123");
    expect(consumed.error).toContain("không còn hiệu lực"); // CÙNG lỗi chung
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: requestId });
    expect(row!.status).toBe("approved"); // KHÔNG consume — CAS chặn quá hạn
    expect(row!.consumedAt).toBeNull();
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.passwordHash).toBe("x"); // KHÔNG đổi mật khẩu

    // request MỚI → row approved-unconsumed-token-hết-hạn flip 'expired'
    const tokenA2 = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req2 = await openRecovery(tokenA2, subject.id);
    expect(req2.state.error, JSON.stringify(req2.state)).toBeUndefined();
    const oldRow = await db.orm.public.AccountRecoveryRequest.first({ id: requestId });
    expect(oldRow!.status).toBe("expired");
  });
});

// ─── 7. Forged token (enumeration-safe) ───────────────────────────────────────

d("manual account recovery — forged token (enumeration-safe)", () => {
  it("token đúng shape nhưng rác → CÙNG lỗi chung; KHÔNG side effect nào", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    const { requestId } = await approveFlow(subject, adminA, adminB);

    const forged = "A".repeat(43); // đúng shape base64url — KHÔNG có row nào
    const consumed = await consumeWithToken(forged, "mat-khau-gi-do-789");
    expect(consumed.error).toContain("không còn hiệu lực");
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: requestId });
    expect(row!.status).toBe("approved"); // KHÔNG consume
    expect(row!.consumedAt).toBeNull();
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.passwordHash).toBe("x"); // KHÔNG đổi mật khẩu
  });

  it("token sai shape + KHÔNG cookie → CÙNG lỗi chung (mọi lý do fail như nhau §7.7)", async () => {
    const short = await consumeWithToken("short-garbage", "mat-khau-gi-do-789");
    expect(short.error).toContain("không còn hiệu lực");
    const noCookie = await consumeWithToken(null, "mat-khau-gi-do-789");
    expect(noCookie.error).toContain("không còn hiệu lực");
  });
});

// ─── 8. OPEN_REQUEST_EXISTS (partial unique) ──────────────────────────────────

d("manual account recovery — one open request per user (partial unique)", () => {
  it("request thứ hai khi còn row requested → OPEN_REQUEST_EXISTS; KHÔNG row thứ hai", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    const dup = await openRecovery(tokenA, subject.id);
    expect(dup.state.error).toBe("OPEN_REQUEST_EXISTS");
    const count = await db.orm.public.AccountRecoveryRequest
      .where({ userId: subject.id })
      .aggregate((a) => ({ c: a.count() }));
    expect(count.c).toBe(1);
  });

  it("approved-unconsumed token còn hạn CŨNG chiếm slot → OPEN_REQUEST_EXISTS (một link reset sống tối đa)", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    await approveFlow(subject, adminA, adminB);

    const tokenA2 = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const dup = await openRecovery(tokenA2, subject.id);
    expect(dup.state.error).toBe("OPEN_REQUEST_EXISTS");
  });
});

// ─── 9. Reject + Cancel ──────────────────────────────────────────────────────

d("manual account recovery — reject + cancel", () => {
  it("B reject → row rejected, KHÔNG issue token; quyết định lần hai → ALREADY_DECIDED", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    const tokenB = await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const rejected = await decideAs(tokenB, req.rowId!, "reject");
    expect(rejected.error, JSON.stringify(rejected)).toBeUndefined();
    expect(rejected.resetUrl).toBeUndefined(); // reject KHÔNG issue link reset
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(row!.status).toBe("rejected");
    expect(row!.decidedById).toBe(adminB);
    expect(row!.resetTokenHash).toBeNull();
    expect(row!.resetTokenExpiresAt).toBeNull();

    const again = await decideAs(tokenB, req.rowId!, "approve");
    expect(again.error).toBe("ALREADY_DECIDED");
  });

  it("B (không phải requester) cancel → NOT_REQUESTER; A cancel → cancelled; B approve sau đó → ALREADY_DECIDED", async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");

    const tokenA = await loginAs(adminA);
    await stepUpCurrentSession(adminA);
    const req = await openRecovery(tokenA, subject.id);
    expect(req.state.error).toBeUndefined();

    // B không phải người mở → không được hủy
    await loginAs(adminB); // side effect: session cookie
    await stepUpCurrentSession(adminB);
    const bCancel = await cancelManualAccountRecoveryAction({}, fd({ requestId: req.rowId! }));
    expect(bCancel.error).toBe("NOT_REQUESTER");
    const rowMid = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(rowMid!.status).toBe("requested");

    // A (người mở) hủy → cancelled
    await loginAs(adminA); // side effect: session cookie
    await stepUpCurrentSession(adminA);
    const aCancel = await cancelManualAccountRecoveryAction({}, fd({ requestId: req.rowId! }));
    expect(aCancel.error, JSON.stringify(aCancel)).toBeUndefined();
    const row = await db.orm.public.AccountRecoveryRequest.first({ id: req.rowId! });
    expect(row!.status).toBe("cancelled");

    // B approve sau cancel → ALREADY_DECIDED (KHÔNG quyết request đã hủy)
    const tokenB2 = await loginAs(adminB);
    await stepUpCurrentSession(adminB);
    const decided = await decideAs(tokenB2, req.rowId!, "approve");
    expect(decided.error).toBe("ALREADY_DECIDED");
    const subjectRow = await db.orm.public.User.first({ id: subject.id });
    expect(subjectRow!.passwordHash).toBe("x"); // KHÔNG có gì xảy ra với subject
  });
});

// ─── 10. Audit — trong tx, KHÔNG raw PII ─────────────────────────────────────

d("manual account recovery — audit rows (§4.6/§4.8)", () => {
  it(
    "mọi flow ghi account.manual_recovery_* — actor đúng vai (A/B/subject), detail chỉ checks/decision, KHÔNG phone/email/token thô",
    { timeout: 120_000 },
    async () => {
      const subject = await mkSubject();
      const adminA = await mkAdmin();
      const adminB = await mkAdmin("operations_admin");
      const { requestId, rawToken } = await approveFlow(subject, adminA, adminB);
      const consumed = await consumeWithToken(rawToken, "mat-khau-audit-123");
      expect(consumed.error, JSON.stringify(consumed)).toBeUndefined();

      const events = await db.orm.public.AuditEvent
        .where({ subjectId: subject.id })
        .where((e) => e.action.in([
          "account.manual_recovery_requested",
          "account.manual_recovery_approved",
          "account.manual_recovery_rejected",
          "account.manual_recovery_cancelled",
          "account.manual_recovery_consumed",
        ]))
        .all();
      expect(events.map((e) => e.action).sort()).toEqual([
        "account.manual_recovery_approved",
        "account.manual_recovery_consumed",
        "account.manual_recovery_requested",
      ]);
      for (const e of events) {
        expect(e.resourceType).toBe("AccountRecoveryRequest");
        expect(e.resourceId).toBe(requestId);
        // detail KHÔNG BAO GIỜ phone/email/token thô (§4.8)
        expect(e.detail ?? "").not.toContain(subject.phone);
        expect(e.detail ?? "").not.toContain(subject.email);
        expect(e.detail ?? "").not.toContain(rawToken);
        expect(e.detail ?? "").not.toMatch(/0\d{9}/); // không phone shape
      }
      // actor đúng vai — two-person rule + self-consume trong audit
      const requested = events.find((e) => e.action === "account.manual_recovery_requested")!;
      const approvedEv = events.find((e) => e.action === "account.manual_recovery_approved")!;
      const consumedEv = events.find((e) => e.action === "account.manual_recovery_consumed")!;
      expect(requested.actorId).toBe(adminA); // A mở
      expect(approvedEv.actorId).toBe(adminB); // B duyệt (≠ A — two-person)
      expect(consumedEv.actorId).toBe(subject.id); // user TỰ consume (public)
      expect(requested.detail).toContain("checks=2");
      expect(approvedEv.detail).toContain("decision=approve");
      expect(approvedEv.detail).toContain("checks=2");
      expect(consumedEv.reason).toBe("manual_two_person_link");
    },
  );
});

// ─── 11. Raw token KHÔNG bao giờ persisted ────────────────────────────────────

d("manual account recovery — raw token KHÔNG bao giờ persisted (§4.8)", () => {
  it("MỌI row AccountRecoveryRequest + AuditEvent của subject KHÔNG chứa token thô; resetTokenHash là HMAC", { timeout: 120_000 }, async () => {
    const subject = await mkSubject();
    const adminA = await mkAdmin();
    const adminB = await mkAdmin("operations_admin");
    const { requestId, rawToken } = await approveFlow(subject, adminA, adminB);
    const consumed = await consumeWithToken(rawToken, "mat-khau-persist-123");
    expect(consumed.error, JSON.stringify(consumed)).toBeUndefined();

    // MỌI row recovery của subject — token thô không tồn tại nơi nào trong DB
    const rows = await db.orm.public.AccountRecoveryRequest.where({ userId: subject.id }).all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(rawToken);
    }
    const approvedRow = rows.find((r) => r.id === requestId)!;
    expect(approvedRow.resetTokenHash).toBe(accountRecoveryResetTokenHash(rawToken)); // CHỈ HMAC
    expect(approvedRow.phoneHash).toBe(accountRecoveryPhoneHash(normalizePhone(subject.phone)));

    // MỌI audit event — token thô không vào audit (§4.8)
    const events = await db.orm.public.AuditEvent.where({ subjectId: subject.id }).all();
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(rawToken);
    }
  });
});
