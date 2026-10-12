/**
 * Manual contact verification — zero-cost launch Task A (founder 2026-10-12).
 *
 * Unit contract (không DB — action behavior thuộc integration suite
 * tests/integration/manual-contact-verification.test.ts trên scratch DB):
 *
 *  1. Vocab module `src/lib/manual-contact-verification.ts` (plain module —
 *     import được từ client component + test, KHÔNG server-only):
 *     - manualContactTargetHash = HMAC-SHA256 hex 64 ký tự của giá trị CHUẨN
 *       HÓA qua hkdfKey("manual-contact-target") — label RIÊNG (không dùng
 *       "otp-hash"/"beta-invite-hash"), KHÔNG BAO GIỜ lưu/trả giá trị thô;
 *     - caps: note ≤ 1000, TTL request 24h, rate limit per admin;
 *     - labels tiếng Việt đủ MỌI method/channel (PROVISIONAL — FD-3).
 *  2. Source contract action file `src/lib/actions/manual-contact-verification.ts`
 *     ("use server", chỉ async exports — Global Constraints):
 *     - CẢ BA action (request/decide/cancel) đều qua
 *       requireCapabilityWithStepUp("contact.verify_manual") — super/ops only
 *       + step-up (A5: quyết định verification thủ công);
 *     - rate limit per admin (checkRateLimit) MỌI action;
 *     - auditEventTx TRONG tx (sống chết cùng write — KHÔNG fire-after-commit)
 *       với action names contact.manual_verify_*;
 *     - note qua redactDetail TẠI WRITE TIME; audit detail KHÔNG chứa raw
 *       email/phone/note (chỉ ids/channel/method — spec §4.8);
 *     - CAS (updateAll where theo giá trị đọc) + re-read INSIDE tx + classify
 *       constraint violation NGOÀI tx (Global Constraints Batch 3/6/7).
 *  3. Source contract UI: panel trên /admin/users?u=<id> render maskContact
 *     (KHÔNG giá trị đầy đủ), disable + lý do rõ khi admin hiện tại là
 *     requester/subject; form client dùng useActionState + dispatch thủ công
 *     (React 19 giữ input qua action error — pattern founding-seller-forms);
 *     typed error labels đủ MỌI code; KHÔNG email/phone trong URL.
 */
import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");

import {
  MANUAL_CONTACT_CHANNELS,
  MANUAL_CONTACT_CHANNEL_LABELS,
  MANUAL_CONTACT_METHODS,
  MANUAL_CONTACT_METHOD_LABELS,
  MANUAL_CONTACT_NOTE_MAX_LENGTH,
  MANUAL_CONTACT_REQUEST_TTL_HOURS,
  MANUAL_CONTACT_ACTION_RATE,
  manualContactTargetHash,
} from "@/src/lib/manual-contact-verification";
import { hkdfKey } from "@/src/lib/hkdf";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const ACTIONS = "src/lib/actions/manual-contact-verification.ts";
const FORMS = "src/components/manual-contact-verification-forms.tsx";
const USERS_PAGE = "app/admin/users/page.tsx";

// ─── 1. Vocab module — hash + caps + labels ─────────────────────────────────

describe("manualContactTargetHash — HMAC keyed, KHÔNG bao giờ giá trị thô", () => {
  it("= HMAC-SHA256 hex 64 ký tự của hkdfKey(\"manual-contact-target\") — label RIÊNG", () => {
    const value = "0901234567";
    const expected = createHmac("sha256", hkdfKey("manual-contact-target"))
      .update(value)
      .digest("hex");
    const got = manualContactTargetHash(value);
    expect(got).toBe(expected);
    expect(got).toMatch(/^[0-9a-f]{64}$/); // hex 64 — cùng shape OtpCode.codeHash
  });

  it("label domain-separated — KHÔNG trùng otp-hash / beta-invite-hash / ip-hash", () => {
    const value = "lienhe@example.com";
    for (const other of ["otp-hash", "beta-invite-hash", "ip-hash"]) {
      expect(manualContactTargetHash(value)).not.toBe(
        createHmac("sha256", hkdfKey(other)).update(value).digest("hex"),
      );
    }
  });

  it("deterministic + KHÔNG chứa giá trị thô (hex output không reverses)", () => {
    expect(manualContactTargetHash("0901234567")).toBe(manualContactTargetHash("0901234567"));
    expect(manualContactTargetHash("0901234567")).not.toContain("0901234567");
    expect(manualContactTargetHash("0901234567")).not.toBe(manualContactTargetHash("0901234568"));
  });
});

describe("caps + tunables (PROVISIONAL — zero-cost launch Task A)", () => {
  it("note ≤ 1000 ký tự; TTL request 24h (expired tính theo expiresAt — no cron)", () => {
    expect(MANUAL_CONTACT_NOTE_MAX_LENGTH).toBe(1_000);
    expect(MANUAL_CONTACT_REQUEST_TTL_HOURS).toBe(24);
  });

  it("rate limit per admin tồn tại (hữu hạn — KHÔNG khóa vĩnh viễn)", () => {
    expect(MANUAL_CONTACT_ACTION_RATE.limit).toBeGreaterThan(0);
    expect(MANUAL_CONTACT_ACTION_RATE.windowMs).toBeGreaterThan(0);
  });

  it("channels đủ email + phone; methods đủ 4 giá trị contract", () => {
    expect([...MANUAL_CONTACT_CHANNELS].sort()).toEqual(["email", "phone"]);
    expect([...MANUAL_CONTACT_METHODS].sort()).toEqual([
      "in_person",
      "other",
      "phone_call",
      "video_call",
    ]);
  });

  it("labels tiếng Việt đủ MỘT cho MỌI channel/method (PROVISIONAL FD-3)", () => {
    for (const channel of MANUAL_CONTACT_CHANNELS) {
      const label = MANUAL_CONTACT_CHANNEL_LABELS[channel];
      expect(label, `label ${channel}`).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    }
    for (const method of MANUAL_CONTACT_METHODS) {
      const label = MANUAL_CONTACT_METHOD_LABELS[method];
      expect(label, `label ${method}`).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── 2. Source contract — action file ───────────────────────────────────────

describe("source contract — src/lib/actions/manual-contact-verification.ts", () => {
  const src = () => read(ACTIONS);

  it("tồn tại + \"use server\" + CHỈ async exports (Global Constraints)", () => {
    expect(src()).toMatch(/^"use server";/);
    // mọi export đều async function — export const/type là lỗi "use server"
    for (const m of src().matchAll(/^export\s+(?!async function|type)\S.*$/gm)) {
      expect(m[0], `non-async export: ${m[0]}`).toMatch(/^export\s+type\s/);
    }
    expect(src()).toMatch(/export\s+type\s+ManualContactFormState/);
  });

  it("CẢ BA action đều requireCapabilityWithStepUp(\"contact.verify_manual\") — super/ops + step-up", () => {
    expect(src()).toMatch(
      /requireCapabilityWithStepUp\("contact\.verify_manual"/g,
    );
    const actionCount = (src().match(/export async function \w+Action/g) ?? []).length;
    expect(actionCount).toBe(3); // request + decide + cancel
    const guardCount = (src().match(/requireCapabilityWithStepUp\("contact\.verify_manual"/g) ?? []).length;
    expect(guardCount).toBe(actionCount);
  });

  it("rate limit per admin MỌI action (checkRateLimit + MANUAL_CONTACT_ACTION_RATE)", () => {
    expect(src()).toContain("checkRateLimit(");
    expect(src()).toContain("MANUAL_CONTACT_ACTION_RATE");
    const rateCalls = (src().match(/checkRateLimit\(/g) ?? []).length;
    expect(rateCalls).toBeGreaterThanOrEqual(3);
  });

  it("auditEventTx TRONG tx — sống chết cùng write (KHÔNG fire-after-commit)", () => {
    expect(src()).toContain("auditEventTx(");
    expect(src()).not.toMatch(/await\s+auditEvent\(/); // auditEvent (ngoài tx) không dùng ở file này
    for (const action of [
      "contact.manual_verify_requested",
      "contact.manual_verify_approved",
      "contact.manual_verify_rejected",
      "contact.manual_verify_cancelled",
    ]) {
      expect(src(), `audit action ${action}`).toContain(`"${action}"`);
    }
  });

  it("note qua redactDetail TẠI WRITE TIME; audit detail KHÔNG raw email/phone/note (§4.8)", () => {
    expect(src()).toContain("redactDetail(");
    // detail audit chỉ chứa ids/channel/method/decision — KHÔNG note/email/phone
    for (const m of src().matchAll(/detail:\s*(`[^`]*`|"[^"]*")/g)) {
      const detail = m[1]!;
      expect(detail, `audit detail chứa PII: ${detail}`).not.toMatch(
        /\$\{note|\$\{email|\$\{phone|\$\{target|\$\{value/i,
      );
    }
  });

  it("CAS + re-read INSIDE tx + classify constraint violation NGOÀI tx (Batch 3/6/7)", () => {
    expect(src()).toContain("db.transaction(");
    expect(src()).toContain("SqlQueryError"); // classify theo sqlState + constraint prefix
    expect(src()).toMatch(/manual_contact_one_requested/); // partial unique prefix (hash suffix)
    // CAS: updateAll where theo giá trị đọc — không update mù
    expect(src()).toMatch(/\.where\(\(v\) => v\.status\.eq\("requested"\)\)/);
    expect(src()).toMatch(/\.where\(\(v\) => v\.expiresAt\.gt\(/);
  });

  it("verifiedAt set CHỈ khi còn null (conditional updateAll — không đè timestamp cũ)", () => {
    // cùng pattern verification.ts: updateAll where verifiedAt isNull
    expect(src()).toMatch(/emailVerifiedAt\.isNull\(\)|phoneVerifiedAt\.isNull\(\)/);
  });

  it("approve phone branch: CAS trên RAW value đọc trong tx + GHI dạng CHUẨN HÓA (fix review #1 — uniqueness không bypass bởi dạng thô)", () => {
    // updateAll match CHỈ khi row vẫn giữ đúng raw value vừa hash-check —
    // phone ĐÃ VERIFIED được GHI thành currentTarget (chuẩn hóa) để owner
    // lookup where({ phone }) của lần approve/OTP-confirm sau không bị lỡ
    // bởi dạng thô ("+84912345678" / "0912 345 678") còn sót từ signup.
    expect(src()).toMatch(/\.where\(\{ id: subject\.id, phone: subject\.phone \}\)/);
    expect(src()).toMatch(/updateAll\(\{ phone: currentTarget, phoneVerifiedAt: nowIso \}\)/);
  });

  it("approve email branch: CAS trên email đọc trong tx (fix review #2 — email đổi giữa read/write không bị verify)", () => {
    expect(src()).toMatch(/\.where\(\{ id: subject\.id, email: subject\.email \}\)/);
    expect(src()).toMatch(/updateAll\(\{ emailVerifiedAt: nowIso \}\)/);
  });

  it("CAS 0 row → re-read INSIDE tx → idempotent no-op (verified cùng giá trị) HOẶC CONTACT_CHANGED (fix review #2)", () => {
    // 0 row = giá trị đổi giữa read/write (CONTACT_CHANGED — tx abort, claim +
    // audit rollback) HOẶC ai đó đã verify CÙNG giá trị chuẩn hóa (idempotent
    // no-op — KHÔNG đè timestamp).
    expect(src()).toMatch(/claimedPhone\.length === 0/);
    expect(src()).toMatch(/claimedEmail\.length === 0/);
    expect(src()).toMatch(
      /recheck\.phoneVerifiedAt === null \|\| recheck\.phone !== currentTarget/,
    );
    expect(src()).toMatch(
      /recheck\.emailVerifiedAt === null \|\| recheck\.email !== subject\.email/,
    );
  });

  it("two-person rule: quyết định ≠ requester ≠ subject — typed errors riêng từng vai", () => {
    expect(src()).toContain("SAME_PERSON_FORBIDDEN"); // B === requester (decide)
    expect(src()).toContain("SELF_VERIFICATION_FORBIDDEN"); // subject === self (request)
    expect(src()).toContain("CONTACT_CHANGED"); // hash đổi giữa request/decide
    expect(src()).toContain("EXPIRED"); // expiresAt quá hạn
    expect(src()).toContain("OPEN_REQUEST_EXISTS"); // partial unique — duplicate request
  });
});

// ─── 3. Source contract — UI (panel + forms) ────────────────────────────────

describe("source contract — src/components/manual-contact-verification-forms.tsx", () => {
  const src = () => read(FORMS);

  it("\"use client\" + useActionState + dispatch thủ công (React 19 giữ input qua error)", () => {
    expect(src()).toMatch(/^"use client";/);
    expect(src()).toContain("useActionState");
    expect(src()).toContain("startTransition"); // pattern founding-seller-forms (b6-review LOW-2)
    expect(src()).toContain("preventDefault"); // form KHÔNG gắn action prop — không requestFormReset
  });

  it("typed error labels đủ MỌI code action trả (map code → tiếng Việt)", () => {
    const srcText = src();
    for (const code of [
      "STEP_UP_REQUIRED",
      "MFA_CODE_INVALID",
      "MFA_RATE_LIMITED",
      "RATE_LIMITED",
      "INVALID_INPUT",
      "NOTE_TOO_LONG",
      "USER_NOT_FOUND",
      "SELF_VERIFICATION_FORBIDDEN",
      "SAME_PERSON_FORBIDDEN",
      "PHONE_NOT_ON_FILE",
      "ALREADY_VERIFIED",
      "OPEN_REQUEST_EXISTS",
      "CONTACT_CHANGED",
      "EXPIRED",
      "ALREADY_DECIDED",
      "NOT_REQUESTER",
      "PHONE_ALREADY_VERIFIED",
    ]) {
      expect(srcText, `label thiếu: ${code}`).toContain(`"${code}"`);
    }
  });

  it("disable + lý do rõ khi admin hiện tại là requester/subject (two-person rule UI)", () => {
    expect(src()).toContain("isRequester"); // admin hiện tại là người mở request
    expect(src()).toContain("isSubject"); // admin hiện tại là người được xác minh
    expect(src()).toMatch(/disabled=\{/); // disable có điều kiện — không render mù
  });

  it("KHÔNG render giá trị liên hệ đầy đủ — chỉ qua maskContact prop (§7.6)", () => {
    // mask đến từ server (prop) — client KHÔNG nhận giá trị thô
    expect(src()).toContain("maskedValue");
    expect(src()).not.toMatch(/email\s*[:=]\s*\$\{|\$\{u\.email\}|\$\{subject\.email\}/);
    expect(src()).not.toMatch(/\$\{u\.phone\}|\$\{subject\.phone\}/);
  });
});

describe("source contract — app/admin/users/page.tsx (panel ?u=)", () => {
  const src = () => read(USERS_PAGE);

  it("panel \"Xác minh liên hệ thủ công\" render cho user đang xem (?u=) — additive", () => {
    expect(src()).toContain("Xác minh liên hệ thủ công");
    expect(src()).toContain("ManualContactVerificationPanel");
    expect(src()).toContain("maskContact"); // reuse founding-seller-vocab (§7.6)
    // additive — mọi cột/form Batch 2/3/7 còn nguyên (pin beta-cohort-console)
    expect(src()).toContain("setBetaMembershipAction");
    expect(src()).toContain("suspendUserAction");
    expect(src()).toContain("revokeAllUserSessionsAction");
  });

  it("panel chỉ render khi viewer giữ contact.verify_manual (convenience — action tự guard)", () => {
    expect(src()).toContain('includes("contact.verify_manual")');
  });

  it("KHÔNG email/phone trong URL mới (corrections #27 precedent)", () => {
    expect(src()).not.toMatch(/\/admin\/users\?u=\$\{u\.email\}/);
    expect(src()).not.toMatch(/\/admin\/users\?u=\$\{u\.phone\}/);
  });
});
