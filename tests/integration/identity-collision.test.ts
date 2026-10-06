/**
 * Identity collision integration tests — plan Task 6 (identity-collision gate),
 * spec §5.3.1 + review fix (verification flow CHỈ xác minh kênh ĐANG LƯU; change
 * confirm cần step-up mật khẩu; revocation chạy TRÊN tx).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit test (tests/unit/verification-actions.test.ts + profile-actions.test.ts)
 * chứng minh logic với db mock; ở đây chứng minh cùng hợp đồng against DB THẬT:
 *
 *  1. User.email unique constraint reject insert trùng email (raw create
 *     throw — và isUniqueConstraintViolation phân loại đúng SQLSTATE 23505,
 *     cùng helper confirmEmailChangeAction dùng để map → EMAIL_TAKEN).
 *  2. Hai tài khoản không thể cùng giữ MỘT phone ĐÃ XÁC MINH qua đường action:
 *     A (số đang lưu P, chưa verified) verify P thành công; B (cũng lưu P,
 *     chưa verified) confirm → PHONE_ALREADY_VERIFIED, B giữ nguyên.
 *  3. Đổi email tới địa chỉ đã bị chiếm: fail ở ranh giới ACTION (pre-check
 *     EMAIL_TAKEN, không tốn OTP) VÀ ở ranh giới DB (race giữa request và
 *     confirm → constraint 23505 trong tx → typed EMAIL_TAKEN, tx rollback,
 *     email giữ nguyên).
 *  4. (Review fix LOW #5) changePasswordAction: hash + revocation trong MỘT
 *     transaction, revocation chạy TRÊN tx — session khác bị revoke reason
 *     "password_change", session hiện tại sống, trên DB thật.
 *
 * next/headers mock (cookie store điều khiển được — createSession/requireUser
 * cần cookies() ngoài request scope); next/cache mock (revalidatePath).
 * OTP delivery GIỮ BẢN THẬT in-memory (NODE_ENV=test) — trích mã qua
 * peekDevOtpInbox, đúng seam dev/test (Task 3); phần DB là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── Cookie store điều khiển được (next/headers) ─────────────────────────────
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
  // headers() cho rate limit (clientIpFromHeaders) + audit ipHash
  headers: vi.fn(async () => new Headers()),
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { peekDevOtpInbox } from "../../src/lib/verification-delivery";
import {
  requestPhoneVerificationAction,
  confirmPhoneVerificationAction,
  requestEmailChangeAction,
  confirmEmailChangeAction,
  changePasswordAction,
} from "../../src/lib/actions/verification";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD = "integration-password-123";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

let seq = 0;
const uid = () => `b2-id-${Date.now()}-${seq++}`;
/** Phone VN hợp lệ duy nhất mỗi lần gọi (0 + 10 chữ số). */
const mkPhone = () => `09${String(100_000_000 + seq++).padStart(9, "0")}`;

async function mkUser(email: string): Promise<string> {
  const u = await db.orm.public.User.create({
    email,
    passwordHash: PASSWORD_HASH,
    name: "B2 Identity",
    role: "buyer",
  });
  return u.id;
}

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Đăng nhập user trên cookie store mock — session thật trong DB scratch. */
const login = async (userId: string): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId);
};

const createdUsers: string[] = [];

/** Xoá AuditEvent (SetNull) trước, rồi user (cascade session/otp/notification). */
async function cleanupUser(userId: string): Promise<void> {
  const events = await db.orm.public.AuditEvent.where({ actorId: userId }).all();
  await db.orm.public.User.where({ id: userId }).delete();
  for (const e of events) {
    await db.orm.public.AuditEvent.where({ id: e.id }).delete();
  }
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  for (const id of createdUsers) {
    await cleanupUser(id);
  }
  createdUsers.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Unique constraint email — ranh giới DB ───────────────────────────────

d("User.email unique constraint (ranh giới DB)", () => {
  it("raw create trùng email → throw + isUniqueConstraintViolation true (chuẩn SQLSTATE)", async () => {
    const email = `${uid()}@integration.test`;
    const id1 = await mkUser(email);
    createdUsers.push(id1);

    let err: unknown;
    try {
      await db.orm.public.User.create({
        email, // trùng
        passwordHash: "x",
        name: "Dup",
        role: "buyer",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // cùng helper confirmEmailChangeAction dùng để map 23505 → EMAIL_TAKEN
    expect(isUniqueConstraintViolation(err)).toBe(true);
  });
});

// ─── 2. Phone collision qua đường action (spec §5.3.1) ────────────────────────

d("identity collision qua đường action (spec §5.3.1)", () => {
  it("hai tài khoản không thể cùng giữ MỘT phone đã xác minh — không merge, không update", async () => {
    const a = await mkUser(`${uid()}@integration.test`);
    const b = await mkUser(`${uid()}@integration.test`);
    createdUsers.push(a, b);
    const P = mkPhone();

    // A đặt số P (chưa verified — như profile set) rồi verify SỐ ĐANG LƯU
    await db.orm.public.User.where({ id: a }).update({ phone: P });
    await login(a);
    // formData nhồi số KHÁC — action phải BỎ QUA (target derive từ DB)
    const req1 = await requestPhoneVerificationAction({}, fd({ phone: "0999999999" }));
    expect(req1.error).toBeUndefined();
    const code1 = peekDevOtpInbox(P, "phone_verification", "phone");
    expect(code1).toBeTruthy(); // mã đi tới P (số đang lưu), KHÔNG phải 0999999999
    const conf1 = await confirmPhoneVerificationAction({}, fd({ code: code1! }));
    expect(conf1.error).toBeUndefined();

    const rowA = await db.orm.public.User.first({ id: a });
    expect(rowA!.phone).toBe(P);
    expect(rowA!.phoneVerifiedAt).not.toBeNull();

    // B cũng lưu P (chưa verified) — mã hợp lệ (B request chính đáng cho SỐ ĐANG
    // LƯU của B), nhưng collision re-check trong tx chặn: typed error, KHÔNG merge
    await db.orm.public.User.where({ id: b }).update({ phone: P });
    await login(b);
    const req2 = await requestPhoneVerificationAction({}, new FormData());
    expect(req2.error).toBeUndefined();
    const code2 = peekDevOtpInbox(P, "phone_verification", "phone");
    expect(code2).toBeTruthy();
    const conf2 = await confirmPhoneVerificationAction({}, fd({ code: code2! }));
    expect(conf2.code).toBe("PHONE_ALREADY_VERIFIED");

    const rowB = await db.orm.public.User.first({ id: b });
    expect(rowB!.phoneVerifiedAt).toBeNull();
    expect(rowB!.phone).toBe(P); // số vẫn lưu (unverified) — KHÔNG bị strip, KHÔNG merge
    // A — chủ sở hữu hợp pháp — giữ nguyên tuyệt đối
    const rowA2 = await db.orm.public.User.first({ id: a });
    expect(rowA2!.phone).toBe(P);
    expect(rowA2!.phoneVerifiedAt).toBe(rowA!.phoneVerifiedAt);
  });
});

// ─── 3. Đổi email — cả hai ranh giới (action pre-check + DB constraint) ─────

d("đổi email — unique constraint ở cả hai ranh giới", () => {
  it("ranh giới ACTION: email đã có người dùng → EMAIL_TAKEN, không tốn OTP", async () => {
    const c = await mkUser(`${uid()}@integration.test`);
    const taken = `${uid()}@integration.test`;
    const other = await mkUser(taken);
    createdUsers.push(c, other);

    await login(c);
    const state = await requestEmailChangeAction(
      {},
      fd({ newEmail: taken, currentPassword: PASSWORD }),
    );
    expect(state.code).toBe("EMAIL_TAKEN");
    // pre-check chặn TRƯỚC khi tạo OTP — không mã mồ côi
    const otps = await db.orm.public.OtpCode
      .where({ userId: c, purpose: "email_verification", target: taken })
      .all();
    expect(otps).toHaveLength(0);
  });

  it("ranh giới DB: race giữa request và confirm → constraint 23505 → typed EMAIL_TAKEN, tx rollback", async () => {
    const originalEmail = `${uid()}@integration.test`;
    const c = await mkUser(originalEmail);
    const freeEmail = `${uid()}@integration.test`;
    createdUsers.push(c);

    // request lúc email còn tự do → mã gửi tới email mới (bước step-up + OTP)
    await login(c);
    const req = await requestEmailChangeAction(
      {},
      fd({ newEmail: freeEmail, currentPassword: PASSWORD }),
    );
    expect(req.error).toBeUndefined();
    const code = peekDevOtpInbox(freeEmail, "email_verification", "email");
    expect(code).toBeTruthy();

    // race: tài khoản khác chiếm email đó TRƯỚC khi confirm (pre-check đã qua)
    const squatter = await mkUser(freeEmail);
    createdUsers.push(squatter);

    const conf = await confirmEmailChangeAction(
      {},
      fd({ newEmail: freeEmail, code: code!, currentPassword: PASSWORD }),
    );
    expect(conf.code).toBe("EMAIL_TAKEN");

    // tx rollback: email + emailVerifiedAt của c giữ nguyên
    const rowC = await db.orm.public.User.first({ id: c });
    expect(rowC!.email).toBe(originalEmail);
    expect(rowC!.emailVerifiedAt).toBeNull();
  });
});

// ─── 4. changePasswordAction — hash + revocation trong MỘT tx (review fix) ────

d("changePasswordAction — revocation trên tx (DB thật)", () => {
  it("hash mới + session KHÁC revoked reason password_change, session hiện tại sống", async () => {
    const c = await mkUser(`${uid()}@integration.test`);
    createdUsers.push(c);

    // 3 session "thiết bị khác" thật trong DB
    await createSession(c);
    await createSession(c);
    await createSession(c);

    // login(c) xoá cookie + tạo session MỚI — session hiện tại của action
    await login(c);
    const rowsBefore = await db.orm.public.UserSession.where({ userId: c }).all();
    expect(rowsBefore).toHaveLength(4);

    const state = await changePasswordAction(
      {},
      fd({ currentPassword: PASSWORD, newPassword: "integration-password-456" }),
    );
    expect(state.error).toBeUndefined();

    const rowsAfter = await db.orm.public.UserSession.where({ userId: c }).all();
    const revoked = rowsAfter.filter((r) => r.revokedAt !== null);
    const alive = rowsAfter.filter((r) => r.revokedAt === null);
    // MỌI session khác (3 session "thiết bị khác") bị revoke với đúng reason
    expect(revoked).toHaveLength(3);
    for (const r of revoked) expect(r.revokedReason).toBe("password_change");
    // session hiện tại (của login cuối) sống
    expect(alive).toHaveLength(1);

    // hash mới thật (bcrypt verify)
    const rowC = await db.orm.public.User.first({ id: c });
    expect(await bcrypt.compare("integration-password-456", rowC!.passwordHash)).toBe(true);
  });
});
