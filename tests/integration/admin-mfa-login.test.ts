/**
 * Admin MFA login — integration tests (plan Task 8, spec §5.3/§5.4.2).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh) — KHÔNG chạy trong `npm test`.
 * Unit tests (tests/unit/admin-mfa*.test.ts) chứng minh logic với db mock; ở đây
 * chạy FULL FLOW against DB THẬT với module THẬT (bcrypt, session, audit,
 * admin-mfa AES-256-GCM, otpauth TOTP):
 *
 *  1. enroll → row AdminMfa mã hóa + 10 hash mã khôi phục; enroll lần hai → null.
 *  2. login KHÔNG mã → { mfaRequired: true }, KHÔNG có row UserSession.
 *  3. login TOTP đúng → row UserSession isAdmin=true, TTL 12 giờ (spec §5.4.2).
 *  4. login mã khôi phục → session + mã đánh dấu usedAt + audit
 *     "admin.mfa_recovery_code_used" (spec §4.6).
 *  5. DÙNG LẠI mã khôi phục đó → sai mã, KHÔNG session mới (single-use).
 *
 * `next/headers` mock (cookie store điều khiển được — cookies() ngoài request
 * scope không chạy được) + `next/navigation` mock (redirect throw NEXT_REDIRECT);
 * phần DB/bcrypt/session/audit/totp là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── Cookie store điều khiển được (next/headers) ─────────────────────────────

const cookieState = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

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
import { ADMIN_SESSION_TTL_HOURS } from "../../src/lib/session";
import { enrollAdminMfa, decryptTotpSecret, verifyAdminMfaCode } from "../../src/lib/admin-mfa";
import { hotpCode } from "../../src/lib/totp";
import { loginAction } from "../../src/lib/actions/auth";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const KEY_32B = Buffer.alloc(32, 0x44).toString("base64");

let seq = 0;
const uid = () => `b2-mfa-${Date.now()}-${seq++}`;

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

// dọn đúng dữ liệu test mình tạo (DB scratch) — user cuối (cascade lo session/
// mfa/codes/cart), AuditEvent giữ lại cũng được nhưng dọn cho sạch.
const created = { users: [] as string[], audits: [] as string[] };

afterEach(async () => {
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  for (const id of created.audits) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  created.users.length = 0;
  created.audits.length = 0;
  cookieState.store.clear();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_32B);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

d("admin MFA full flow trên DB thật", () => {
  it("enroll → mã hóa + 10 hash; enroll lần hai refuse; login không mã → mfaRequired không session", async () => {
    const password = "mật-khẩu-tích-hợp";
    const admin = await db.orm.public.User.create({
      email: `${uid()}@integration.test`,
      passwordHash: await hashPassword(password),
      name: "B2 MFA Admin",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(admin.id);

    // ── enroll: secret mã hóa + 10 mã khôi phục hash ──
    const enrolled = await enrollAdminMfa(admin.id);
    expect(enrolled).not.toBeNull();
    const { secretBase32, uri, recoveryCodes } = enrolled!;
    expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(recoveryCodes).toHaveLength(10);

    const mfaRow = await db.orm.public.AdminMfa.first({ userId: admin.id });
    expect(mfaRow).not.toBeNull();
    expect(mfaRow!.totpSecretEnc).not.toBe(secretBase32);
    expect(mfaRow!.totpConfirmedAt).not.toBeNull();
    // round-trip decrypt với key đã stub
    expect(decryptTotpSecret(mfaRow!.totpSecretEnc)).toBe(secretBase32);

    const codeRows = await db.orm.public.AdminRecoveryCode.where({ mfaId: mfaRow!.id }).all();
    expect(codeRows).toHaveLength(10);
    for (const row of codeRows) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.usedAt).toBeNull();
      expect(recoveryCodes.includes(row.codeHash)).toBe(false);
    }

    // enroll lần hai → refuse (null) — reset qua bootstrap (Task 11)
    expect(await enrollAdminMfa(admin.id)).toBeNull();

    // ── login KHÔNG mã → mfaRequired, KHÔNG session ──
    const sessionsBefore = await db.orm.public.UserSession.where({ userId: admin.id }).all();
    expect(sessionsBefore).toHaveLength(0);

    const challenge = await loginAction({}, loginForm(admin.email, password));
    expect(challenge.mfaRequired).toBe(true);
    expect(challenge.error).toBeUndefined();
    expect(await db.orm.public.UserSession.where({ userId: admin.id }).all()).toHaveLength(0);

    // ── login TOTP SAI → error, không session ──
    const wrong = await loginAction({}, loginForm(admin.email, password, "000000"));
    expect(wrong.error).toContain("Mã xác thực không đúng");
    expect(await db.orm.public.UserSession.where({ userId: admin.id }).all()).toHaveLength(0);
  });

  it("login TOTP đúng → session isAdmin=true TTL 12 giờ; mã khôi phục → session + usedAt + audit; dùng lại → fail", async () => {
    const password = "mật-khẩu-tích-hợp-2";
    const admin = await db.orm.public.User.create({
      email: `${uid()}@integration.test`,
      passwordHash: await hashPassword(password),
      name: "B2 MFA Admin 2",
      role: "admin",
      adminRole: "super_admin",
    });
    created.users.push(admin.id);

    const { secretBase32, recoveryCodes } = (await enrollAdminMfa(admin.id))!;

    // ── TOTP đúng → session 12h isAdmin ──
    const url = await loginOk(admin.email, password, hotpCode(secretBase32, nowCounter()));
    expect(url).toBe("/");

    const rows = await db.orm.public.UserSession.where({ userId: admin.id }).all();
    expect(rows).toHaveLength(1);
    const session = rows[0]!;
    expect(session.isAdmin).toBe(true);
    expect(session.revokedAt).toBeNull();
    const ttlMs = Date.parse(session.expiresAt) - Date.parse(session.createdAt);
    expect(Math.abs(ttlMs - ADMIN_SESSION_TTL_HOURS * 3_600_000)).toBeLessThan(60_000);
    expect(ADMIN_SESSION_TTL_HOURS).toBe(12);

    // cookie đã set (token opaque — không phải JWT)
    expect(cookieState.store.get("sp_session")).toBeTruthy();

    // ── mã khôi phục → session mới + mã dùng MỘT lần + audit ──
    const code = recoveryCodes[0]!;
    const url2 = await loginOk(admin.email, password, code);
    expect(url2).toBe("/");
    expect(await db.orm.public.UserSession.where({ userId: admin.id }).all()).toHaveLength(2);

    const codeRow = await db.orm.public.AdminRecoveryCode
      .where({ mfaId: (await db.orm.public.AdminMfa.first({ userId: admin.id }))!.id })
      .all();
    const used = codeRow.filter((r) => r.usedAt !== null);
    expect(used).toHaveLength(1);

    const audits = await db.orm.public.AuditEvent
      .where({ action: "admin.mfa_recovery_code_used", actorId: admin.id })
      .all();
    expect(audits).toHaveLength(1);
    for (const a of audits) created.audits.push(a.id);
    expect(JSON.stringify(audits)).not.toContain(code); // spec §4.8 — không mã thô

    // ── dùng LẠI mã đó → sai mã, KHÔNG session mới ──
    const reuse = await loginAction({}, loginForm(admin.email, password, code));
    expect(reuse.error).toContain("Mã xác thực không đúng");
    expect(await db.orm.public.UserSession.where({ userId: admin.id }).all()).toHaveLength(2);

    // verifyAdminMfaCode trực tiếp cũng xác nhận single-use
    expect(await verifyAdminMfaCode(admin.id, code)).toBeNull();
  });
});

// ─── helper nội bộ ─────────────────────────────────────────────────────────────

function loginForm(email: string, password: string, mfaCode?: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  if (mfaCode !== undefined) fd.set("mfaCode", mfaCode);
  return fd;
}
