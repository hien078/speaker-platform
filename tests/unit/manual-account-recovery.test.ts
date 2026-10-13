/**
 * Manual account recovery — Task E (founder FD-R3 2026-10-13).
 *
 * Unit contract (không DB — action behavior thuộc integration suite
 * tests/integration/manual-account-recovery.test.ts trên scratch DB):
 *
 *  1. Vocab module `src/lib/manual-account-recovery.ts` (plain module —
 *     import được từ client component + test, KHÔNG server-only):
 *     - accountRecoveryPhoneHash = HMAC-SHA256 hex 64 của phone CHUẨN HÓA
 *       qua hkdfKey("account-recovery-phone") — label RIÊNG domain-separated
 *       (không dùng otp-hash/beta-invite-hash/ip-hash/manual-contact-target),
 *       KHÔNG BAO GIỜ lưu/trả giá trị thô;
 *     - accountRecoveryResetTokenHash = HMAC-SHA256 hex 64 của token qua
 *       hkdfKey("account-recovery-reset-token") — label RIÊNG, token thô
 *       KHÔNG BAO GIỜ lưu/log/audit;
 *     - caps: TTL request 24h, TTL reset token 30 phút, rate limit per admin
 *       + landing + consume, cookie HttpOnly path-scoped 15 phút, token
 *       43-char base64url (reject TRƯỚC mọi db call);
 *     - checks out-of-band: 3 câu (boolean từng câu — KHÔNG câu trả lời),
 *       labels tiếng Việt đủ MỌI check/status (PROVISIONAL — FD-3).
 *  2. Source contract action file `src/lib/actions/manual-account-recovery.ts`
 *     ("use server", chỉ async exports — Global Constraints):
 *     - CẢ BA action admin (request/decide/cancel) đều qua
 *       requireCapabilityWithStepUp("account.recover_manual") — super/ops
 *       only + step-up (A9: destructive account action); consume là PUBLIC
 *       (token trong cookie là credential — KHÔNG capability);
 *     - FORM FIELD NAMES: checkbox từng câu gửi `check_${check}` (check ∈
 *       MANUAL_RECOVERY_CHECKS) — action đọc ĐÚNG `checked(formData,
 *       "check_${check}")` cho MỌI check (lock bug form/action name mismatch)
 *       + attestation `attestedCall`;
 *     - rate limit per admin MỌI action admin; consume per IP + per token
 *       (bucket keyed bằng HMAC hash — limiter KHÔNG giữ token thô);
 *     - auditEventTx TRONG tx (sống chết cùng write) với action names
 *       account.manual_recovery_*; detail KHÔNG phone/token/answer thô;
 *     - token reset: randomBytes(32) base64url, DB lưu CHỈ HMAC
 *       (resetTokenHash), URL reset trả MỘT LẦN trong state (interpolate
 *       ${token} ĐÚNG MỘT nơi — không bao giờ db/audit/log);
 *     - approve: NEXT_PUBLIC_APP_URL check TRƯỚC tx (corrections #36),
 *       revokeAllUserSessionsTx TRONG cùng tx, CAS + re-read INSIDE tx +
 *       classify constraint violation NGOÀI tx (Global Constraints).
 *  3. Source contract UI: panel /admin/users?u=<id> render maskContact
 *     (KHÔNG giá trị đầy đủ), disable + lý do khi admin hiện tại là
 *     requester/subject; form client useActionState + dispatch thủ công
 *     (React 19 giữ input); typed error labels đủ MỌI code; public flow
 *     /recover/manual/[token] (route handler) + /recover/manual (page) +
 *     password form — token CHỈ trong cookie HttpOnly, KHÔNG trong form/URL.
 */
import { describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");

import {
  MANUAL_RECOVERY_ACTION_RATE,
  MANUAL_RECOVERY_CHECKS,
  MANUAL_RECOVERY_CHECK_LABELS,
  MANUAL_RECOVERY_CONSUME_RATE,
  MANUAL_RECOVERY_COOKIE,
  MANUAL_RECOVERY_COOKIE_MAX_AGE_SEC,
  MANUAL_RECOVERY_COOKIE_PATH,
  MANUAL_RECOVERY_LANDING_RATE,
  MANUAL_RECOVERY_REQUEST_TTL_HOURS,
  MANUAL_RECOVERY_RESET_TOKEN_TTL_MINUTES,
  MANUAL_RECOVERY_STATUSES,
  MANUAL_RECOVERY_STATUS_LABELS,
  MANUAL_RECOVERY_TOKEN_RE,
  accountRecoveryPhoneHash,
  accountRecoveryResetTokenHash,
} from "@/src/lib/manual-account-recovery";
import { hkdfKey } from "@/src/lib/hkdf";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const ACTIONS = "src/lib/actions/manual-account-recovery.ts";
const FORMS = "src/components/manual-account-recovery-forms.tsx";
const USERS_PAGE = "app/admin/users/page.tsx";
const ROUTE = "app/(auth)/recover/manual/[token]/route.ts";
const PUBLIC_PAGE = "app/(auth)/recover/manual/page.tsx";
const PASSWORD_FORM = "src/components/manual-recovery-password-form.tsx";

// ─── 1. Vocab module — hash + caps + labels ─────────────────────────────────

describe("accountRecoveryPhoneHash — HMAC keyed, KHÔNG bao giờ giá trị thô", () => {
  it("= HMAC-SHA256 hex 64 ký tự của hkdfKey(\"account-recovery-phone\") — label RIÊNG", () => {
    const value = "0901234567";
    const expected = createHmac("sha256", hkdfKey("account-recovery-phone"))
      .update(value)
      .digest("hex");
    const got = accountRecoveryPhoneHash(value);
    expect(got).toBe(expected);
    expect(got).toMatch(/^[0-9a-f]{64}$/); // hex 64 — cùng shape OtpCode.codeHash
  });

  it("label domain-separated — KHÔNG trùng label nào trước đây + KHÔNG trùng label token", () => {
    const value = "0912345678";
    for (const other of [
      "otp-hash",
      "beta-invite-hash",
      "ip-hash",
      "manual-contact-target",
      "account-recovery-reset-token",
    ]) {
      expect(accountRecoveryPhoneHash(value), `label ${other}`).not.toBe(
        createHmac("sha256", hkdfKey(other)).update(value).digest("hex"),
      );
    }
  });

  it("deterministic + KHÔNG chứa giá trị thô (hex output không reverses)", () => {
    expect(accountRecoveryPhoneHash("0901234567")).toBe(accountRecoveryPhoneHash("0901234567"));
    expect(accountRecoveryPhoneHash("0901234567")).not.toContain("0901234567");
    expect(accountRecoveryPhoneHash("0901234567")).not.toBe(accountRecoveryPhoneHash("0901234568"));
  });
});

describe("accountRecoveryResetTokenHash — HMAC keyed, token thô KHÔNG bao giờ lưu", () => {
  it("= HMAC-SHA256 hex 64 ký tự của hkdfKey(\"account-recovery-reset-token\") — label RIÊNG", () => {
    const token = randomBytes(32).toString("base64url");
    const expected = createHmac("sha256", hkdfKey("account-recovery-reset-token"))
      .update(token)
      .digest("hex");
    expect(accountRecoveryResetTokenHash(token)).toBe(expected);
    expect(accountRecoveryResetTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("label domain-separated khỏi account-recovery-phone + mọi label trước đây", () => {
    const token = randomBytes(32).toString("base64url");
    for (const other of [
      "otp-hash",
      "beta-invite-hash",
      "ip-hash",
      "manual-contact-target",
      "account-recovery-phone",
    ]) {
      expect(accountRecoveryResetTokenHash(token), `label ${other}`).not.toBe(
        createHmac("sha256", hkdfKey(other)).update(token).digest("hex"),
      );
    }
  });

  it("deterministic + KHÔNG chứa token thô", () => {
    const token = randomBytes(32).toString("base64url");
    expect(accountRecoveryResetTokenHash(token)).toBe(accountRecoveryResetTokenHash(token));
    expect(accountRecoveryResetTokenHash(token)).not.toContain(token);
  });
});

describe("caps + tunables (PROVISIONAL — Task E, FD-3)", () => {
  it("TTL request 24h (expired tính theo expiresAt — no cron); TTL reset token 30 phút", () => {
    expect(MANUAL_RECOVERY_REQUEST_TTL_HOURS).toBe(24);
    expect(MANUAL_RECOVERY_RESET_TOKEN_TTL_MINUTES).toBe(30);
  });

  it("rate limit tồn tại + HỮU HẠN cho MỌI surface (admin / landing / consume)", () => {
    for (const rule of [
      MANUAL_RECOVERY_ACTION_RATE,
      MANUAL_RECOVERY_LANDING_RATE,
      MANUAL_RECOVERY_CONSUME_RATE,
    ]) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowMs).toBeGreaterThan(0); // window trượt — KHÔNG khóa vĩnh viễn
    }
  });

  it("cookie HttpOnly path-scoped: tên riêng + path /recover/manual + TTL 15 phút", () => {
    expect(MANUAL_RECOVERY_COOKIE).toBe("sp_manual_recovery");
    expect(MANUAL_RECOVERY_COOKIE_PATH).toBe("/recover/manual");
    expect(MANUAL_RECOVERY_COOKIE_MAX_AGE_SEC).toBe(15 * 60);
  });
});

describe("MANUAL_RECOVERY_TOKEN_RE — 43-char base64url, reject TRƯỚC mọi db call", () => {
  it("match randomBytes(32).base64url (43 ký tự — CSPRNG của approve)", () => {
    for (let i = 0; i < 20; i++) {
      expect(MANUAL_RECOVERY_TOKEN_RE.test(randomBytes(32).toString("base64url"))).toBe(true);
    }
  });

  it("reject garbage: sai độ dài / padding / ký tự base64 thường / khoảng trắng", () => {
    expect(MANUAL_RECOVERY_TOKEN_RE.test("a".repeat(42))).toBe(false); // ngắn
    expect(MANUAL_RECOVERY_TOKEN_RE.test("a".repeat(44))).toBe(false); // dài
    expect(MANUAL_RECOVERY_TOKEN_RE.test(`${"a".repeat(42)}=`)).toBe(false); // padding
    expect(MANUAL_RECOVERY_TOKEN_RE.test(`${"a".repeat(41)}+/`)).toBe(false); // base64 thường
    expect(MANUAL_RECOVERY_TOKEN_RE.test("a b c d e f g h i j k l m n o p q r s t u v w x")).toBe(false); // space
    expect(MANUAL_RECOVERY_TOKEN_RE.test("")).toBe(false);
    expect(MANUAL_RECOVERY_TOKEN_RE.test("../../../etc/passwd")).toBe(false); // path traversal
  });
});

describe("checks out-of-band + statuses (founder FD-R3 — 2 trong 3 câu)", () => {
  it("ĐÚNG 3 câu hỏi — key là tên cột boolean, KHÔNG bao giờ câu trả lời", () => {
    expect([...MANUAL_RECOVERY_CHECKS]).toEqual(["listing_title", "province", "registration_month"]);
  });

  it("labels tiếng Việt đủ MỘT cho MỌI check (PROVISIONAL FD-3)", () => {
    for (const check of MANUAL_RECOVERY_CHECKS) {
      const label = MANUAL_RECOVERY_CHECK_LABELS[check];
      expect(label, `label ${check}`).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("statuses đủ 6 giá trị enum contract + label MỌI trạng thái", () => {
    expect([...MANUAL_RECOVERY_STATUSES].sort()).toEqual([
      "approved",
      "cancelled",
      "consumed",
      "expired",
      "rejected",
      "requested",
    ]);
    for (const status of MANUAL_RECOVERY_STATUSES) {
      const label = MANUAL_RECOVERY_STATUS_LABELS[status];
      expect(label, `label ${status}`).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── 2. Source contract — action file ───────────────────────────────────────

describe("source contract — src/lib/actions/manual-account-recovery.ts", () => {
  const src = () => read(ACTIONS);

  it("tồn tại + \"use server\" + CHỈ async exports (Global Constraints)", () => {
    expect(src()).toMatch(/^"use server";/);
    // mọi export đều async function — export const/type là lỗi "use server"
    for (const m of src().matchAll(/^export\s+(?!async function|type)\S.*$/gm)) {
      expect(m[0], `non-async export: ${m[0]}`).toMatch(/^export\s+type\s/);
    }
    expect(src()).toMatch(/export\s+type\s+ManualRecoveryFormState/);
  });

  it("CẢ BA action admin đều requireCapabilityWithStepUp(\"account.recover_manual\") — super/ops + step-up (A9)", () => {
    expect(src()).toMatch(/requireCapabilityWithStepUp\("account\.recover_manual"/g);
    const actionCount = (src().match(/export async function \w+Action/g) ?? []).length;
    expect(actionCount).toBe(4); // request + decide + cancel + consume
    const guardCount = (src().match(/requireCapabilityWithStepUp\("account\.recover_manual"/g) ?? []).length;
    expect(guardCount).toBe(3); // consume KHÔNG guard — public
  });

  it("FORM FIELD NAMES khớp — action đọc check_${check} cho MỌI check + attestedCall (lock bug name mismatch)", () => {
    const srcText = src();
    // form gửi `name={`check_${check}`}` (check ∈ MANUAL_RECOVERY_CHECKS) —
    // action phải đọc ĐÚNG tên đó cho MỘI check, không phải dạng camelCase khác.
    for (const check of MANUAL_RECOVERY_CHECKS) {
      expect(srcText, `action phải đọc checked(formData, "check_${check}")`).toContain(
        `checked(formData, "check_${check}")`,
      );
    }
    expect(srcText).toContain('checked(formData, "attestedCall")');
  });

  it("consume là PUBLIC — token từ cookie HttpOnly, KHÔNG từ formData, KHÔNG capability", () => {
    const consume = src().slice(src().indexOf("export async function consumeManualAccountRecoveryAction"));
    expect(consume).not.toMatch(/requireCapability/); // KHÔNG guard — token là credential
    expect(consume).toContain("(await cookies()).get(MANUAL_RECOVERY_COOKIE)");
    expect(consume).not.toMatch(/formData\.get\("(token|resetToken|resetUrl)"/); // token KHÔNG rides trong form
  });

  it("rate limit per admin MỌI action admin (checkRateLimit + MANUAL_RECOVERY_ACTION_RATE)", () => {
    expect(src()).toContain("checkRateLimit(");
    expect(src()).toContain("MANUAL_RECOVERY_ACTION_RATE");
    const rateCalls = (src().match(/checkRateLimit\(/g) ?? []).length;
    expect(rateCalls).toBeGreaterThanOrEqual(3); // request + decide + cancel
  });

  it("consume rate limit per IP + per token — bucket token keyed bằng HMAC (limiter KHÔNG giữ token thô)", () => {
    const consume = src().slice(src().indexOf("export async function consumeManualAccountRecoveryAction"));
    expect(consume).toContain("MANUAL_RECOVERY_CONSUME_RATE");
    expect(consume).toContain("accountRecoveryResetTokenHash(token)"); // bucket key = HMAC, không phải token
    expect(consume).toContain("clientIpFromHeaders(");
  });

  it("auditEventTx TRONG tx — sống chết cùng write (KHÔNG fire-after-commit)", () => {
    expect(src()).toContain("auditEventTx(");
    expect(src()).not.toMatch(/await\s+auditEvent\(/); // auditEvent (ngoài tx) không dùng ở file này
    for (const action of [
      "account.manual_recovery_requested",
      "account.manual_recovery_approved",
      "account.manual_recovery_rejected",
      "account.manual_recovery_cancelled",
      "account.manual_recovery_consumed",
    ]) {
      expect(src(), `audit action ${action}`).toContain(`"${action}"`);
    }
  });

  it("audit detail KHÔNG raw PII — KHÔNG phone/token/answer (§4.8)", () => {
    // detail audit chỉ chứa checks-count/decision — KHÔNG phone thô, KHÔNG token
    // thô, KHÔNG câu trả lời (booleans đã ở row, KHÔNG nhân bản vào audit)
    for (const m of src().matchAll(/detail:\s*(`[^`]*`|"[^"]*")/g)) {
      const detail = m[1]!;
      expect(detail, `audit detail chứa PII: ${detail}`).not.toMatch(
        /\$\{token|\$\{phone|\$\{email|\$\{normalizedPhone|\$\{currentPhone|\$\{subject\.phone/i,
      );
    }
  });

  it("CAS + re-read INSIDE tx + classify constraint violation NGOÀI tx (Batch 3/6/7)", () => {
    expect(src()).toContain("db.transaction(");
    expect(src()).toContain("SqlQueryError"); // classify theo sqlState + constraint prefix
    expect(src()).toMatch(/account_recovery_one_open/); // partial unique prefix (hash suffix)
    // CAS: updateAll where theo giá trị đọc — không update mù
    expect(src()).toMatch(/\.where\(\(r\) => r\.status\.eq\("requested"\)\)/);
    expect(src()).toMatch(/\.where\(\(r\) => r\.expiresAt\.gt\(/);
    // consume CAS: approved + chưa consume + còn hạn token
    expect(src()).toMatch(/\.where\(\(r\) => r\.consumedAt\.isNull\(\)\)/);
    expect(src()).toMatch(/\.where\(\(r\) => r\.resetTokenExpiresAt\.gt\(/);
  });

  it("two-person rule + guards: typed errors riêng từng vai (spec §5.4.2 hướng nghiêm nhất)", () => {
    const srcText = src();
    for (const code of [
      "SELF_RECOVERY_FORBIDDEN", // subject === chính mình (request + decide)
      "SAME_PERSON_FORBIDDEN", // B === requester (decide)
      "ADMIN_SUBJECT_FORBIDDEN", // subject là admin account — bootstrap runbook
      "PHONE_NOT_VERIFIED", // cuộc gọi PHẢI tới số ĐÃ XÁM MINH
      "CHECKS_INSUFFICIENT", // < 2/3 câu đúng — không mở request
      "ATTESTATION_REQUIRED", // phải xác nhận đã gọi đúng số đã xác minh
      "OPEN_REQUEST_EXISTS", // partial unique — duplicate request
      "CONTACT_CHANGED", // phone đổi giữa request/decide
      "EXPIRED", // expiresAt quá hạn (no cron)
      "ALREADY_DECIDED", // quyết định song song
      "NOT_REQUESTER", // chỉ người mở mới hủy được
      "APP_URL_UNCONFIGURED", // corrections #36 — check TRƯỚC tx
    ]) {
      expect(srcText, `typed error thiếu: ${code}`).toContain(`"${code}"`);
    }
  });

  it("request: checks đọc từ form (boolean từng câu) + checksPassed < 2 → CHECKS_INSUFFICIENT", () => {
    const request = src().slice(
      src().indexOf("export async function requestManualAccountRecoveryAction"),
      src().indexOf("export async function decideManualAccountRecoveryAction"),
    );
    expect(request).toMatch(/checksPassed < 2/);
    expect(request).toContain("accountRecoveryPhoneHash(normalizedPhone)"); // hash của phone DB, KHÔNG formData
    expect(request).toContain("phoneVerifiedAtSnapshot");
    // expired-on-read: request MỚI flip row quá hạn sang 'expired' trong tx của
    // mình — partial unique KHÔNG chặn vĩnh viễn user sau lần đầu hết hạn
    expect(request).toMatch(/status: "expired"/);
  });

  it("approve: token CSPRNG 256-bit base64url + DB lưu CHỈ HMAC + URL reset interpolate token ĐÚNG MỘT nơi", () => {
    const decide = src().slice(
      src().indexOf("export async function decideManualAccountRecoveryAction"),
      src().indexOf("export async function cancelManualAccountRecoveryAction"),
    );
    expect(decide).toContain('randomBytes(32).toString("base64url")');
    expect(decide).toContain("accountRecoveryResetTokenHash(token)");
    expect(decide).toContain("resetTokenHash");
    // token thô interpolate ĐÚNG MỘT lần — vào URL trả về (state), KHÔNG vào
    // db (chỉ resetTokenHash)/audit/telemetry/log
    const interpolations = [...decide.matchAll(/\$\{token\}/g)];
    expect(interpolations, "token thô chỉ được interpolate vào resetUrl MỘT lần").toHaveLength(1);
    expect(decide).toContain("resetUrl: `${appUrl}/recover/manual/${token}`");
    expect(decide).not.toMatch(/token:\s*token\b/); // KHÔNG bao giờ ghi cột token thô
  });

  it("approve: NEXT_PUBLIC_APP_URL check TRƯỚC tx (corrections #36) + revokeAllUserSessionsTx TRONG tx", () => {
    const decide = src().slice(
      src().indexOf("export async function decideManualAccountRecoveryAction"),
      src().indexOf("export async function cancelManualAccountRecoveryAction"),
    );
    const appUrlAt = decide.indexOf("process.env.NEXT_PUBLIC_APP_URL");
    const txAt = decide.indexOf("db.transaction(");
    expect(appUrlAt).toBeGreaterThanOrEqual(0);
    expect(txAt).toBeGreaterThan(appUrlAt); // check TRƯỚC khi đụng tx
    expect(decide).toContain('revokeAllUserSessionsTx(tx, fresh.userId, "manual_account_recovery")');
  });

  it("consume: hashPassword NGOÀI tx (bcrypt chậm — không giữ tx) + CAS + password CÙNG tx", () => {
    const consume = src().slice(src().indexOf("export async function consumeManualAccountRecoveryAction"));
    const hashAt = consume.indexOf("await hashPassword(");
    const txAt = consume.indexOf("db.transaction(");
    expect(hashAt).toBeGreaterThanOrEqual(0);
    expect(txAt).toBeGreaterThan(hashAt); // hash TRƯỚC tx — KHÔNG giữ tx cho bcrypt
    expect(consume).toMatch(/status: "consumed", consumedAt: nowIso/); // claim + password CÙNG tx
    expect(consume).toContain("passwordHash"); // ghi mật khẩu mới trong cùng tx với claim
  });

  it("consume: mọi lý do fail collapse về MỘT thông báo chung (enumeration-safe §7.7)", () => {
    const consume = src().slice(src().indexOf("export async function consumeManualAccountRecoveryAction"));
    expect(consume).toContain("RECOVERY_LINK_INVALID_MESSAGE");
    expect(consume).toMatch(/LINK_INVALID/); // sentinel CAS 0 row → cùng thông báo chung
  });

  it("consume: xóa cookie path-scoped (corrections #35 — delete Path=/ là MỘT cookie khác)", () => {
    const consume = src().slice(src().indexOf("export async function consumeManualAccountRecoveryAction"));
    expect(consume).toContain(
      "delete({ name: MANUAL_RECOVERY_COOKIE, path: MANUAL_RECOVERY_COOKIE_PATH })",
    );
  });
});

// ─── 3. Source contract — UI admin (panel + forms) ───────────────────────────

describe("source contract — src/components/manual-account-recovery-forms.tsx", () => {
  const src = () => read(FORMS);

  it("\"use client\" + useActionState + dispatch thủ công (React 19 giữ input qua error)", () => {
    expect(src()).toMatch(/^"use client";/);
    expect(src()).toContain("useActionState");
    expect(src()).toContain("startTransition"); // pattern founding-seller-forms (b6-review LOW-2)
    expect(src()).toContain("preventDefault"); // form KHÔNG gắn action prop — không requestFormReset
  });

  it("checkbox từng câu gửi check_${check} từ MANUAL_RECOVERY_CHECKS + attestation attestedCall", () => {
    const srcText = src();
    // form render checkbox từ CHÍNH vocab constant — tên field = `check_${check}`
    expect(srcText).toMatch(/name=\{`check_\$\{check\}`\}/);
    expect(srcText).toContain("MANUAL_RECOVERY_CHECKS.map");
    expect(srcText).toContain('name="attestedCall"');
  });

  it("typed error labels đủ MỌI code action trả (map code → tiếng Việt)", () => {
    const srcText = src();
    for (const code of [
      "STEP_UP_REQUIRED",
      "MFA_CODE_INVALID",
      "MFA_RATE_LIMITED",
      "RATE_LIMITED",
      "INVALID_INPUT",
      "USER_NOT_FOUND",
      "NOT_FOUND",
      "SELF_RECOVERY_FORBIDDEN",
      "SAME_PERSON_FORBIDDEN",
      "PHONE_NOT_VERIFIED",
      "ADMIN_SUBJECT_FORBIDDEN",
      "CHECKS_INSUFFICIENT",
      "ATTESTATION_REQUIRED",
      "OPEN_REQUEST_EXISTS",
      "CONTACT_CHANGED",
      "EXPIRED",
      "ALREADY_DECIDED",
      "NOT_REQUESTER",
      "APP_URL_UNCONFIGURED",
    ]) {
      expect(srcText, `label thiếu: ${code}`).toContain(`"${code}"`);
    }
  });

  it("disable + lý do rõ khi admin hiện tại là requester/subject (two-person rule UI)", () => {
    expect(src()).toContain("isRequester"); // admin hiện tại là người mở request
    expect(src()).toContain("isSubject"); // admin hiện tại là người được khôi phục
    expect(src()).toMatch(/disabled=\{/); // disable có điều kiện — không render mù
  });

  it("KHÔNG render giá trị liên hệ đầy đủ — chỉ qua maskContact prop (§7.6)", () => {
    // mask đến từ server (prop) — client KHÔNG nhận giá trị thô
    expect(src()).toContain("maskedPhone");
    expect(src()).not.toMatch(/\$\{u\.phone\}|\$\{subject\.phone\}|\$\{view\.phone\}/);
  });

  it("resetUrl hiển thị từ state MỘT lần — KHÔNG render lại từ DB/view (token thô không tồn tại nơi khác)", () => {
    expect(src()).toContain("state.resetUrl");
    // view KHÔNG mang token/url — chỉ resetTokenExpiresAt (thời điểm hết hạn)
    expect(src()).not.toMatch(/view\.resetUrl|openRequest\.resetUrl/);
  });
});

// ─── 4. Source contract — /admin/users page (panel ?u=) ──────────────────────

describe("source contract — app/admin/users/page.tsx (panel ?u=)", () => {
  const src = () => read(USERS_PAGE);

  it("panel \"Khôi phục tài khoản thủ công\" render cho user đang xem (?u=) — additive", () => {
    expect(src()).toContain("ManualAccountRecoveryPanel");
    expect(src()).toContain("ManualRecoveryView");
    expect(src()).toContain("maskContact"); // reuse founding-seller-vocab (§7.6) — masked server-side
    // additive — mọi cột/form Batch 2/3/7 + Task A còn nguyên
    expect(src()).toContain("setBetaMembershipAction");
    expect(src()).toContain("suspendUserAction");
    expect(src()).toContain("revokeAllUserSessionsAction");
    expect(src()).toContain("ManualContactVerificationPanel");
  });

  it("panel chỉ render khi viewer giữ account.recover_manual (convenience — action tự guard)", () => {
    expect(src()).toContain('includes("account.recover_manual")');
  });

  it("view build server-side: maskedPhone qua maskContact + subjectIsAdmin đọc adminRole (KHÔNG role display)", () => {
    expect(src()).toMatch(/maskContact\(\s*"phone"/);
    expect(src()).toContain("adminRole"); // subject là admin account → request disable
    expect(src()).toContain("subjectIsAdmin");
    expect(src()).toContain("isSubject"); // admin hiện tại là subject → MỌI form disable
  });

  it("KHÔNG email/phone trong URL mới (corrections #27 precedent)", () => {
    expect(src()).not.toMatch(/\/admin\/users\?u=\$\{u\.email\}/);
    expect(src()).not.toMatch(/\/admin\/users\?u=\$\{u\.phone\}/);
  });
});

// ─── 5. Source contract — public flow (route handler + page + password form) ──

describe("source contract — app/(auth)/recover/manual/[token]/route.ts (landing)", () => {
  const src = () => read(ROUTE);

  it("Route Handler (KHÔNG page — Server Component không set cookie được, corrections #7)", () => {
    expect(src()).toMatch(/export\s+async\s+function\s+GET\(/);
    expect(src()).toContain("res.cookies.set(");
  });

  it("rate limit TRƯỚC mọi db read (corrections #13) + shape check TRƯỚC lookup (corrections #12)", () => {
    const srcText = src();
    const rateAt = srcText.indexOf("rateLimitRequest(");
    const shapeAt = srcText.indexOf("MANUAL_RECOVERY_TOKEN_RE.test(token)");
    const lookupAt = srcText.indexOf("findValidManualRecoveryToken(token)");
    expect(rateAt).toBeGreaterThanOrEqual(0);
    expect(shapeAt).toBeGreaterThan(rateAt); // shape sau rate, TRƯỚC lookup
    expect(lookupAt).toBeGreaterThan(shapeAt); // garbage không tốn một query nào
  });

  it("KHÔNG side effect ngoài cookie (corrections #7 — bots unfurl GET link này)", () => {
    expect(src()).not.toMatch(/updateAll|\.create\(|auditEvent|revokeAllUserSessions/);
  });

  it("cookie HttpOnly path-scoped + TTL 15 phút + 303 redirect tokenless", () => {
    const srcText = src();
    expect(srcText).toContain("httpOnly: true");
    expect(srcText).toContain("path: MANUAL_RECOVERY_COOKIE_PATH");
    expect(srcText).toContain("maxAge: MANUAL_RECOVERY_COOKIE_MAX_AGE_SEC");
    expect(srcText).toContain('NextResponse.redirect(new URL("/recover/manual", request.url), 303)');
  });

  it("Referrer-Policy no-referrer + X-Robots-Tag noindex + no-store (corrections #8 — mirror invite)", () => {
    const srcText = src();
    expect(srcText).toContain('"Referrer-Policy", "no-referrer"');
    expect(srcText).toContain('"X-Robots-Tag", "noindex"');
    expect(srcText).toContain('"Cache-Control", "no-store"');
  });
});

describe("source contract — app/(auth)/recover/manual/page.tsx (tokenless)", () => {
  const src = () => read(PUBLIC_PAGE);

  it("token CHỈ từ cookie HttpOnly — KHÔNG next/query/form (corrections #35 precedent)", () => {
    expect(src()).toContain("(await cookies()).get(MANUAL_RECOVERY_COOKIE)");
    expect(src()).not.toMatch(/searchParams|next=|\?token/);
  });

  it("cookie thiếu/token không còn hợp lệ → thông báo CHUNG (enumeration-safe)", () => {
    expect(src()).toContain("Liên kết không còn hiệu lực");
  });

  it("noindex (URL reset không được index) + KHÔNG render PII/token", () => {
    expect(src()).toMatch(/robots.*index:\s*false|noindex/);
    expect(src()).not.toMatch(/\$\{token\}|phone|email/i);
  });
});

describe("source contract — src/components/manual-recovery-password-form.tsx (public)", () => {
  const src = () => read(PASSWORD_FORM);

  it("useActionState + consume action — KHÔNG token trong form (token sống trong cookie)", () => {
    expect(src()).toMatch(/^"use client";/);
    expect(src()).toContain("useActionState");
    expect(src()).toContain("consumeManualAccountRecoveryAction");
    expect(src()).not.toMatch(/name="(token|resetToken|resetUrl)"/); // token KHÔNG rides trong form
  });

  it("mật khẩu mới CÙNG chính sách self-service recovery (6..100 — recovery.ts)", () => {
    expect(src()).toContain('minLength={6}');
    expect(src()).toContain('maxLength={100}');
    expect(src()).toContain('autoComplete="new-password"');
  });
});
