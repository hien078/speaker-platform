/**
 * Admin bootstrap + MFA-lockout recovery — integration tests (plan Task 11,
 * spec §5.4.2 "Bootstrap and recovery procedures must be documented and tested
 * to avoid permanent administrator lockout"). Chạy trên scratch DB
 * (scripts/test-integration.sh) — KHÔNG chạy trong `npm test`.
 *
 * Đây là RUNBOOK ĐÃ EXERCISE: tests/integration/admin-bootstrap.test.ts đi
 * THEO TỪNG bước docs/operations/admin-bootstrap-recovery-runbook.md —
 * lệnh trong runbook chính là các hàm export của scripts/admin-bootstrap.ts
 * mà test gọi (promoteUser/enrollMfa/resetMfa), against DB THẬT với module
 * THẬT (bcrypt, session, AES-256-GCM envelope, otpauth TOTP, audit):
 *
 *  1. promote: dry-run báo cáo (không mutate) → --apply đặt adminRole +
 *     User.role="admin" + thu hồi MỌI session của đích (reason
 *     admin_role_changed — buộc login lại qua MFA) + audit
 *     admin.bootstrap.promote (actor null) → chạy lại IDEMPOTENT (no-op).
 *     Kèm predicate backfill của migration Task 1: user role="admin" +
 *     adminRole=null được EXACT UPDATE của data transform nâng super_admin.
 *  2. mfa-enroll --apply: secret + otpauth:// URI + 10 mã khôi phục; DB lưu
 *     secret ĐÃ MÃ HÓA (envelope v1:<keyId>:…) + 10 hash (không mã thô);
 *     enroll lần hai không reset → null (refuse); audit
 *     admin.bootstrap.mfa_enrolled (detail chỉ count).
 *  3. login path (Task 8 helpers): enrolled admin KHÔNG mã → mfaRequired
 *     (không session); TOTP đúng → session isAdmin=true 12h; mã khôi phục →
 *     session + mã đánh dấu usedAt + audit; DÙNG LẠI mã đó → fail (single-use
 *     qua ĐÚNG login path thật).
 *  4. mfa-reset --apply (lockout → recovery): xoá AdminMfa (cascade 10 hash)
 *     + thu hồi MỌI session (reason admin_mfa_reset) + audit → login chỉ mật
 *     khẩu bị chặn MFA_ENROLLMENT_REQUIRED (fail closed) → re-enroll hoạt
 *     động → login TOTP mới thành công (vòng lặp lockout → recovery ĐÓNG).
 *  5. D2 race-safe guard: HAI demote chéo song song 2 super_admin cuối
 *     (Promise.allSettled) → đúng MỘT thành công, ≥1 super_admin còn lại —
 *     assertNotLastSuperAdminTx lock mọi row super_admin (no-op update),
 *     tx sau unblock thấy row tx trước ĐÃ demote (Postgres re-eval WHERE).
 *  6. D6 gỡ quyền quản trị (--role none): adminRole null + User.role restore
 *     theo marker (SellerVerification row → "seller") + thu hồi session +
 *     audit to=none; gỡ super_admin cuối bị guard chặn; idempotent no-op.
 *  7. D5: mfa-enroll refuse user KHÔNG có adminRole (NOT_AN_ADMIN) —
 *     enrollment + audit trong cùng tx chỉ dành cho tài khoản quản trị.
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw
 * NEXT_REDIRECT); phần DB/bcrypt/session/audit/admin-mfa/totp là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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

// ─── redirect throw NEXT_REDIRECT (login thành công không "trả về" — throw) ───

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import { db } from "../../src/prisma/db.client";
import { hashPassword } from "../../src/lib/auth";
import { createSession, ADMIN_SESSION_TTL_HOURS } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { resetTotpReplayProtection } from "../../src/lib/admin-mfa";
import { hotpCode } from "../../src/lib/totp";
import { loginAction } from "../../src/lib/actions/auth";
import { promoteUser, enrollMfa, resetMfa } from "../../scripts/admin-bootstrap";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const KEY_32B = Buffer.alloc(32, 0x44).toString("base64");

let seq = 0;
const uid = () => `b2-boot-${Date.now()}-${seq++}`;
const nowCounter = () => Math.floor(Date.now() / 30_000);

/** loginAction thành công → throw NEXT_REDIRECT — bắt để assert side effect. */
const loginOk = async (email: string, password: string, mfaCode?: string): Promise<string> => {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  if (mfaCode !== undefined) fd.set("mfaCode", mfaCode);
  let redirectUrl = "";
  try {
    await loginAction({}, fd);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("NEXT_REDIRECT:")) redirectUrl = msg.slice("NEXT_REDIRECT:".length);
    else throw e;
  }
  return redirectUrl;
};

// dọn đúng dữ liệu test mình tạo (DB scratch) — AuditEvent (SetNull) dọn theo
// actor/subject trước, user cascade lo session/mfa/codes.
const created = { users: [] as string[] };

afterEach(async () => {
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).delete();
    await db.orm.public.AuditEvent.where({ subjectId: id }).delete();
    // SellerVerification (Restrict FK) phải đi TRƯỚC user — D6 test tạo row marker
    await db.orm.public.SellerVerification.where({ userId: id }).delete();
    await db.orm.public.User.where({ id }).delete();
  }
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

d("admin bootstrap runbook — promote → enroll → login → lockout → reset → re-enroll (DB thật)", () => {
  it("promote: dry-run báo cáo → --apply đặt adminRole + role=admin + thu hồi mọi session + audit → idempotent; kèm predicate backfill Task 1", async () => {
    const email = `${uid()}@integration.test`;
    const user = await db.orm.public.User.create({
      email,
      passwordHash: await hashPassword("mật-khẩu-bootstrap"),
      name: "B2 Bootstrap Founder",
      role: "buyer",
    });
    created.users.push(user.id);

    // Session active của user (sẽ bị promote thu hồi — buộc login lại qua MFA)
    await createSession(user.id);
    const before = await db.orm.public.UserSession.where({ userId: user.id }).all();
    expect(before).toHaveLength(1);
    expect(before[0]!.revokedAt).toBeNull();

    // ── dry-run: KHÔNG mutate gì ──
    const dry = await promoteUser(email, "operations_admin", false);
    expect(dry.mode).toBe("dry-run");
    expect(dry.changed).toBe(false);
    expect(dry.priorAdminRole).toBeNull();
    const afterDry = await db.orm.public.User.first({ id: user.id });
    expect(afterDry!.adminRole).toBeNull(); // chưa đụng gì
    expect((await db.orm.public.UserSession.where({ userId: user.id }).all())[0]!.revokedAt).toBeNull();

    // ── --apply: adminRole + role="admin" + thu hồi session + audit ──
    const applied = await promoteUser(email, "operations_admin", true);
    expect(applied.mode).toBe("apply");
    expect(applied.changed).toBe(true);
    expect(applied.sessionsRevoked).toBe(1);

    const promoted = await db.orm.public.User.first({ id: user.id });
    expect(promoted!.adminRole).toBe("operations_admin");
    expect(promoted!.role).toBe("admin"); // display-only (spec §8.5)

    const sessions = await db.orm.public.UserSession.where({ userId: user.id }).all();
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[0]!.revokedReason).toBe("admin_role_changed");

    const audits = await db.orm.public.AuditEvent
      .where({ action: "admin.bootstrap.promote", subjectId: user.id })
      .all();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBeNull(); // offline script — actor null
    expect(audits[0]!.reason).toBe("bootstrap_role_set");
    expect(audits[0]!.detail).toBe("from=none to=operations_admin;sessionsRevoked=1");

    // ── idempotent: chạy lại cùng role → no-op, KHÔNG audit mới ──
    const again = await promoteUser(email, "operations_admin", true);
    expect(again.changed).toBe(false);
    expect(
      await db.orm.public.AuditEvent.where({ action: "admin.bootstrap.promote", subjectId: user.id }).all(),
    ).toHaveLength(1);

    // ── last-super-admin guard: hạ super_admin cuối cùng bị từ chối ──
    await promoteUser(email, "super_admin", true); // nâng lên super_admin (đi lên)
    const superRow = await db.orm.public.User.first({ id: user.id });
    expect(superRow!.adminRole).toBe("super_admin");
    // user này là super_admin DUY NHẤT trong DB scratch → hạ bị chặn
    await expect(promoteUser(email, "moderator", true)).rejects.toThrow("LAST_SUPER_ADMIN");
    const stillSuper = await db.orm.public.User.first({ id: user.id });
    expect(stillSuper!.adminRole).toBe("super_admin"); // KHÔNG mutation

    // ── predicate backfill của migration Task 1 (spec §8.5): user legacy
    //    role="admin" + adminRole=null được EXACT UPDATE của data transform
    //    nâng super_admin (chứng minh end-to-end đường promote dùng để
    //    bootstrap admin đầu tiên từ tài khoản legacy) ──
    const legacy = await db.orm.public.User.create({
      email: `${uid()}@integration.test`,
      passwordHash: "x",
      name: "B2 Legacy Admin",
      role: "admin",
      adminRole: null,
    });
    created.users.push(legacy.id);
    const plan = db.sql.public.User.update({ adminRole: "super_admin" })
      .where((f, fns) => fns.and(fns.eq(f.role, "admin"), fns.eq(f.adminRole, null)))
      .build();
    await db.runtime().execute(plan);
    const legacyAfter = await db.orm.public.User.first({ id: legacy.id });
    expect(legacyAfter!.adminRole).toBe("super_admin");
    expect(legacyAfter!.role).toBe("admin"); // role display-only giữ nguyên
  });

  it("mfa-enroll --apply: secret + 10 mã khôi phục (in MỘT LẦN cho operator); DB lưu secret mã hóa + 10 hash; enroll lần hai → null (refuse)", async () => {
    const email = `${uid()}@integration.test`;
    const user = await db.orm.public.User.create({
      email,
      passwordHash: await hashPassword("mật-khẩu-bootstrap-2"),
      name: "B2 Bootstrap Admin 2",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(user.id);

    // dry-run: KHÔNG mutate, KHÔNG trả secret
    const dry = await enrollMfa(email, false);
    expect(dry).toBeNull();
    expect(await db.orm.public.AdminMfa.first({ userId: user.id })).toBeNull();

    // ── --apply: secret + URI + 10 mã khôi phục ──
    const enrolled = await enrollMfa(email, true);
    expect(enrolled).not.toBeNull();
    const { secretBase32, uri, recoveryCodes } = enrolled!;
    expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(recoveryCodes).toHaveLength(10);

    // DB: secret ĐÃ MÃ HÓA (envelope v1:<keyId>:… — không phải base32 thô)
    const mfaRow = await db.orm.public.AdminMfa.first({ userId: user.id });
    expect(mfaRow!.totpSecretEnc).not.toBe(secretBase32);
    expect(mfaRow!.totpSecretEnc).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(mfaRow!.totpConfirmedAt).not.toBeNull();

    // 10 hash mã khôi phục — KHÔNG bao giờ mã thô (spec §4.8)
    const codeRows = await db.orm.public.AdminRecoveryCode.where({ mfaId: mfaRow!.id }).all();
    expect(codeRows).toHaveLength(10);
    for (const row of codeRows) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCodes.includes(row.codeHash)).toBe(false);
      expect(row.usedAt).toBeNull();
    }

    // audit: actor null, detail CHỈ count — không chứa mã thô/secret
    const audits = await db.orm.public.AuditEvent
      .where({ action: "admin.bootstrap.mfa_enrolled", subjectId: user.id })
      .all();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBeNull();
    expect(audits[0]!.detail).toBe("recoveryCodes=10");
    expect(JSON.stringify(audits)).not.toContain(secretBase32);
    expect(JSON.stringify(audits)).not.toContain(recoveryCodes[0]!);

    // ── enroll lần hai KHÔNG reset → null (refuse — không enroll đè) ──
    expect(await enrollMfa(email, true)).toBeNull();
  });

  it("login path: không mã → mfaRequired (không session); TOTP → session isAdmin 12h; mã khôi phục → session + usedAt + audit; dùng lại → fail (single-use)", async () => {
    const password = "mật-khẩu-bootstrap-3";
    const email = `${uid()}@integration.test`;
    const user = await db.orm.public.User.create({
      email,
      passwordHash: await hashPassword(password),
      name: "B2 Bootstrap Admin 3",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(user.id);
    const { secretBase32, recoveryCodes } = (await enrollMfa(email, true))!;

    // ── KHÔNG mã → mfaRequired, KHÔNG session (fail closed) ──
    const fdNoCode = new FormData();
    fdNoCode.set("email", email);
    fdNoCode.set("password", password);
    const challenge = await loginAction({}, fdNoCode);
    expect(challenge.mfaRequired).toBe(true);
    expect(await db.orm.public.UserSession.where({ userId: user.id }).all()).toHaveLength(0);

    // ── TOTP đúng → session isAdmin=true, TTL 12 giờ (spec §5.4.2) ──
    const totpCode = hotpCode(secretBase32, nowCounter());
    const url = await loginOk(email, password, totpCode);
    expect(url).toBe("/");

    const rows = await db.orm.public.UserSession.where({ userId: user.id }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isAdmin).toBe(true);
    const ttlMs = Date.parse(rows[0]!.expiresAt) - Date.parse(rows[0]!.createdAt);
    expect(Math.abs(ttlMs - ADMIN_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);

    // ── mã khôi phục → session mới + mã đánh dấu usedAt + audit ──
    const code = recoveryCodes[0]!;
    const url2 = await loginOk(email, password, code);
    expect(url2).toBe("/");
    expect(await db.orm.public.UserSession.where({ userId: user.id }).all()).toHaveLength(2);

    const mfaRow = (await db.orm.public.AdminMfa.first({ userId: user.id }))!;
    const used = (await db.orm.public.AdminRecoveryCode.where({ mfaId: mfaRow.id }).all())
      .filter((r) => r.usedAt !== null);
    expect(used).toHaveLength(1);

    const audits = await db.orm.public.AuditEvent
      .where({ action: "admin.mfa_recovery_code_used", actorId: user.id })
      .all();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(code); // spec §4.8 — không mã thô

    // ── DÙNG LẠI mã đó → sai mã, KHÔNG session mới (single-use qua login thật) ──
    const fdReuse = new FormData();
    fdReuse.set("email", email);
    fdReuse.set("password", password);
    fdReuse.set("mfaCode", code);
    const reuse = await loginAction({}, fdReuse);
    expect(reuse.error).toContain("Mã xác thực không đúng");
    expect(await db.orm.public.UserSession.where({ userId: user.id }).all()).toHaveLength(2);
  });

  it("mfa-reset --apply: xoá AdminMfa + thu hồi MỌI session + audit → login chỉ mật khẩu bị chặn MFA_ENROLLMENT_REQUIRED → re-enroll → login TOTP mới OK (vòng lặp lockout → recovery ĐÓNG)", async () => {
    const password = "mật-khẩu-bootstrap-4";
    const email = `${uid()}@integration.test`;
    const user = await db.orm.public.User.create({
      email,
      passwordHash: await hashPassword(password),
      name: "B2 Bootstrap Admin 4",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(user.id);
    const first = (await enrollMfa(email, true))!;
    const mfaRowBefore = (await db.orm.public.AdminMfa.first({ userId: user.id }))!;

    // Admin đang login ở 2 thiết bị (session thật qua createSession)
    await createSession(user.id, { isAdmin: true });
    await createSession(user.id, { isAdmin: true });
    expect(
      (await db.orm.public.UserSession.where({ userId: user.id }).all()),
    ).toHaveLength(2);

    // ── mfa-reset --apply: xoá MFA + thu hồi MỌI session + audit ──
    const report = await resetMfa(email, true);
    expect(report.mode).toBe("apply");
    expect(report.reset).toBe(true);
    expect(report.sessionsRevoked).toBe(2);

    expect(await db.orm.public.AdminMfa.first({ userId: user.id })).toBeNull();
    // cascade: 10 hash mã khôi phục đi theo mfa (onDelete: Cascade — Task 1)
    expect(
      await db.orm.public.AdminRecoveryCode.where({ mfaId: mfaRowBefore.id }).all(),
    ).toEqual([]);
    const sessions = await db.orm.public.UserSession.where({ userId: user.id }).all();
    for (const s of sessions) {
      expect(s.revokedAt).not.toBeNull();
      expect(s.revokedReason).toBe("admin_mfa_reset");
    }

    const audits = await db.orm.public.AuditEvent
      .where({ action: "admin.bootstrap.mfa_reset", subjectId: user.id })
      .all();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBeNull();
    expect(audits[0]!.detail).toBe("sessionsRevoked=2");

    // ── lockout state: login chỉ mật khẩu bị chặn MFA_ENROLLMENT_REQUIRED ──
    const fdLocked = new FormData();
    fdLocked.set("email", email);
    fdLocked.set("password", password);
    const locked = await loginAction({}, fdLocked);
    expect(locked.error).toContain("MFA_ENROLLMENT_REQUIRED");
    expect(
      await db.orm.public.UserSession.where({ userId: user.id }).where((s) => s.revokedAt.isNull()).all(),
    ).toHaveLength(0);

    // ── re-enroll hoạt động (secret MỚI — mã cũ đã chết cùng row cũ) ──
    const reenrolled = await enrollMfa(email, true);
    expect(reenrolled).not.toBeNull();
    expect(reenrolled!.secretBase32).not.toBe(first.secretBase32);
    expect(reenrolled!.recoveryCodes).toHaveLength(10);

    // ── login bằng TOTP MỚI → session admin mới (vòng lặp ĐÓNG) ──
    const url = await loginOk(email, password, hotpCode(reenrolled!.secretBase32, nowCounter()));
    expect(url).toBe("/");
    const rows = await db.orm.public.UserSession
      .where({ userId: user.id })
      .where((s) => s.revokedAt.isNull())
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isAdmin).toBe(true);
  });

  it("D2 race-safe guard: HAI demote chéo song song 2 super_admin cuối → đúng MỘT thành công, ≥1 super_admin còn lại (row-lock)", async () => {
    const emailA = `${uid()}@integration.test`;
    const emailB = `${uid()}@integration.test`;
    const a = await db.orm.public.User.create({
      email: emailA,
      passwordHash: "x",
      name: "B2 Race A",
      role: "admin",
      adminRole: "super_admin",
    });
    const b = await db.orm.public.User.create({
      email: emailB,
      passwordHash: "x",
      name: "B2 Race B",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(a.id, b.id);

    // TIỀN ĐIỀN: A và B là 2 super_admin DUY NHẤT (test khác đã dọn) — nếu có
    // super_admin sót lại thì cả hai demote đều hợp lệ và test fail ồn đúng nghĩa.
    const supersBefore = await db.orm.public.User.where({ adminRole: "super_admin" }).all();
    expect(supersBefore.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

    // Hai tx demote chéo CÙNG LÚC: A → operations_admin, B → moderator.
    // Guard (assertNotLastSuperAdminTx) lock mọi row super_admin bằng no-op
    // update → tx sau block; khi unblock, Postgres re-eval WHERE thấy row của
    // tx trước ĐÃ demote → count 0 → LAST_SUPER_ADMIN → rollback.
    const [rA, rB] = await Promise.allSettled([
      promoteUser(emailA, "operations_admin", true),
      promoteUser(emailB, "moderator", true),
    ]);

    const fulfilled = [rA, rB].filter((r) => r.status === "fulfilled");
    const rejected = [rA, rB].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // đúng MỘT thắng
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toContain("LAST_SUPER_ADMIN");

    // ≥1 super_admin còn lại — đúng người demote THẤT BẠI (tx thắng đã hạ người kia)
    const aAfter = await db.orm.public.User.first({ id: a.id });
    const bAfter = await db.orm.public.User.first({ id: b.id });
    const remaining = [aAfter!, bAfter!].filter((u) => u.adminRole === "super_admin");
    expect(remaining).toHaveLength(1);
    const loserId = remaining[0]!.id;
    const loserEmail = loserId === a.id ? emailA : emailB;
    // người còn lại chính là người bị từ chối (tx thắng đã demote người kia)
    const winnerReport = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof promoteUser>>>).value;
    expect(winnerReport.userId).not.toBe(loserId);
    // và loser KHÔNG bị đụng gì (rollback sạch)
    expect(loserId === a.id ? aAfter!.adminRole : bAfter!.adminRole).toBe("super_admin");
    // chạy lại demote của loser giờ hợp lệ (còn đúng 1 super_admin khác? KHÔNG —
    // loser là super_admin cuối → vẫn bị guard chặn)
    await expect(promoteUser(loserEmail, "analyst", true)).rejects.toThrow("LAST_SUPER_ADMIN");
  });

  it("D6 gỡ quyền quản trị (--role none): adminRole null + role restore theo marker + thu hồi session + audit to=none; gỡ super_admin cuối bị guard chặn", async () => {
    const emailSuper = `${uid()}@integration.test`;
    const superAdmin = await db.orm.public.User.create({
      email: emailSuper,
      passwordHash: "x",
      name: "B2 Remove Super",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(superAdmin.id);

    // Legacy admin display "admin" + CÓ SellerVerification row → restore "seller"
    const emailLegacy = `${uid()}@integration.test`;
    const legacy = await db.orm.public.User.create({
      email: emailLegacy,
      passwordHash: "x",
      name: "B2 Remove Legacy",
      role: "admin",
      adminRole: "moderator",
    });
    created.users.push(legacy.id);
    await db.orm.public.SellerVerification.create({
      userId: legacy.id,
      status: "verified",
      method: "operations_review",
      policyVersion: "v1",
    });
    await createSession(legacy.id); // session sẽ bị thu hồi khi gỡ quyền

    // ── gỡ quyền của legacy moderator (còn super_admin khác → cho qua) ──
    const report = await promoteUser(emailLegacy, "none", true);
    expect(report.mode).toBe("apply");
    expect(report.changed).toBe(true);
    expect(report.newRole).toBeNull();

    const legacyAfter = await db.orm.public.User.first({ id: legacy.id });
    expect(legacyAfter!.adminRole).toBeNull(); // hết quyền quản trị
    expect(legacyAfter!.role).toBe("seller"); // restore theo marker (D6)
    const legacySessions = await db.orm.public.UserSession.where({ userId: legacy.id }).all();
    expect(legacySessions[0]!.revokedAt).not.toBeNull();
    expect(legacySessions[0]!.revokedReason).toBe("admin_role_changed");
    const audits = await db.orm.public.AuditEvent
      .where({ action: "admin.bootstrap.promote", subjectId: legacy.id })
      .all();
    expect(audits[0]!.detail).toBe("from=moderator to=none;sessionsRevoked=1");

    // ── idempotent: gỡ lại user không còn adminRole → no-op ──
    const again = await promoteUser(emailLegacy, "none", true);
    expect(again.changed).toBe(false);

    // ── gỡ super_admin DUY NHẤT còn lại → guard chặn (D2 helper dùng chung) ──
    await expect(promoteUser(emailSuper, "none", true)).rejects.toThrow("LAST_SUPER_ADMIN");
    const superAfter = await db.orm.public.User.first({ id: superAdmin.id });
    expect(superAfter!.adminRole).toBe("super_admin"); // KHÔNG mutation
  });

  it("D5: mfa-enroll refuse user KHÔNG có adminRole (NOT_AN_ADMIN) — enrollment chỉ dành cho tài khoản quản trị", async () => {
    const email = `${uid()}@integration.test`;
    const buyer = await db.orm.public.User.create({
      email,
      passwordHash: "x",
      name: "B2 Not An Admin",
      role: "buyer",
      adminRole: null,
    });
    created.users.push(buyer.id);

    await expect(enrollMfa(email, true)).rejects.toThrow("NOT_AN_ADMIN");
    // KHÔNG enroll gì — fail closed
    expect(await db.orm.public.AdminMfa.first({ userId: buyer.id })).toBeNull();
    expect(
      await db.orm.public.AuditEvent.where({ subjectId: buyer.id }).all(),
    ).toEqual([]);
  });
});
