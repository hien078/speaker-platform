/**
 * Policy acceptance UI surfaces (zero-cost launch Task D — founder decision
 * 2026-10-12) — source-contract tests (pattern deal-ui.test.ts /
 * finance-public-surface.test.ts: repo KHÔNG có jsdom/E2E infra nên hợp đồng
 * là source text, không render test).
 *
 * Hợp đồng: mọi surface bị guard assertCurrentPoliciesAccepted chặn render
 * THÔNG BÁO TRUNG TÍNH + đường đồng ý (/account/policies) — KHÔNG 500, KHÔNG
 * code thô phản chiếu (action phân loại typed error sang surface riêng):
 *
 *  1. PolicyAcceptanceNotice (shared): plain component (KHÔNG "use client",
 *     KHÔNG hook) — render được ở cả server banner lẫn client form; copy
 *     mechanics-only (nguyên nhân + đường làm) + Link /account/policies.
 *  2. DealCreateForm / PortableListingForm / ListingForm: special-case
 *     state.error === "POLICY_ACCEPTANCE_REQUIRED" → <PolicyAcceptanceNotice />
 *     — code KHÔNG nằm trong text map (map fallback sẽ render code thô nếu
 *     bỏ special-case; deal map chốt điều này bằng absence assert).
 *  3. ChatWindow: 403 JSON {error: "POLICY_ACCEPTANCE_REQUIRED"} → banner +
 *     link (KHÔNG im lặng như 4xx khác); parse an toàn (body không JSON →
 *     giữ hành vi im lặng cũ — KHÔNG 500 từ res.json()).
 *  4. AuthForm (register): checkbox acceptPolicies required + links
 *     /policies/terms + /policies/privacy target="_blank" rel="noopener"
 *     (đọc policy KHÔNG mất form); KHÔNG render ở mode login.
 *  5. PolicyAcceptanceForm (/account/policies): useActionState
 *     acceptCurrentPoliciesAction + dispatch thủ công onSubmit +
 *     startTransition (React 19 form reset — pattern deal-create-form:
 *     checkbox KHÔNG bị requestFormReset wipe sau {error}) + required.
 *  6. Banner ?error= (app/sell/my + app/sell/[id]/edit): special-case code →
 *     Link /account/policies; text map (listing-error-text.ts) có copy trung
 *     tính tiếng Việt; allowlist SUBMIT_ERROR_PARAM_CODES (listings.ts) chứa
 *     code — không thì submitErrorParam co redirect về CONTENT_INVALID và
 *     banner không bao giờ thấy code này.
 *  7. app/account/policies/page.tsx: getCurrentUser + redirect /login khi
 *     chưa đăng nhập; đọc FRESH missingPolicyAcceptances; form chỉ mount khi
 *     còn thiếu (đủ → trạng thái "đã đồng ý", KHÔNG form).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(`${root}/${p}`, "utf8");

/**
 * Strip block comment + line comment — absence assert ("KHÔNG 'use client'",
 * "KHÔNG code thô") phải quét CODE, KHÔNG PHẢI docstring (docstring Task D
 * mô tả chính cơ chế đó; pattern promise-language scan của deal-ui.test.ts).
 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ─── 1. PolicyAcceptanceNotice — shared, plain component ─────────────────────

describe("PolicyAcceptanceNotice — shared notice (plain, mechanics-only)", () => {
  const src = () => read("src/components/policy-acceptance-notice.tsx");

  it("plain component — KHÔNG 'use client', KHÔNG hook (render được server + client)", () => {
    const code = codeOnly(src());
    expect(code).not.toContain('"use client"');
    expect(code).not.toContain("useActionState");
    expect(code).not.toContain("useState");
    expect(code).not.toContain("useTransition");
  });

  it("copy trung tính: nguyên nhân (chưa đồng ý) + đường làm (link /account/policies)", () => {
    expect(src()).toContain("Bạn cần đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư");
    expect(src()).toContain('href="/account/policies"');
    expect(src()).toContain("Xem và đồng ý tại trang tài khoản");
  });

  it("KHÔNG phản chiếu code thô POLICY_ACCEPTANCE_REQUIRED ra UI", () => {
    expect(codeOnly(src())).not.toContain("POLICY_ACCEPTANCE_REQUIRED");
  });
});

// ─── 2. Forms — special-case render notice thay vì text map ───────────────────

describe("DealCreateForm — POLICY_ACCEPTANCE_REQUIRED render notice (KHÔNG code thô)", () => {
  const src = () => read("src/components/deal-create-form.tsx");

  it("special-case state.error === 'POLICY_ACCEPTANCE_REQUIRED' → <PolicyAcceptanceNotice />", () => {
    expect(src()).toContain('state.error === "POLICY_ACCEPTANCE_REQUIRED"');
    expect(src()).toContain("<PolicyAcceptanceNotice />");
    expect(src()).toContain(
      'import { PolicyAcceptanceNotice } from "@/src/components/policy-acceptance-notice"',
    );
  });

  it("code KHÔNG nằm trong DEAL_CREATE_ERROR_TEXT — map fallback sẽ render code thô nếu bỏ special-case", () => {
    const srcText = src();
    // tách block map (giữa khai báo map và export form)
    const mapStart = srcText.indexOf("DEAL_CREATE_ERROR_TEXT: Record<string, string> = {");
    const mapEnd = srcText.indexOf("};", mapStart);
    const mapBlock = srcText.slice(mapStart, mapEnd);
    expect(mapBlock).not.toContain("POLICY_ACCEPTANCE_REQUIRED");
  });
});

describe.each([
  ["PortableListingForm", "src/components/portable-listing-form.tsx"],
  ["ListingForm", "src/components/listing-form.tsx"],
] as const)("%s — POLICY_ACCEPTANCE_REQUIRED render notice", (_name, path) => {
  const src = () => read(path);

  it("special-case state.error === 'POLICY_ACCEPTANCE_REQUIRED' → <PolicyAcceptanceNotice />", () => {
    expect(src()).toContain('state.error === "POLICY_ACCEPTANCE_REQUIRED"');
    expect(src()).toContain("<PolicyAcceptanceNotice />");
    expect(src()).toContain(
      'import { PolicyAcceptanceNotice } from "@/src/components/policy-acceptance-notice"',
    );
  });
});

// ─── 3. ChatWindow — 403 JSON → banner + link (KHÔNG im lặng, KHÔNG 500) ──────

describe("ChatWindow — 403 POLICY_ACCEPTANCE_REQUIRED → banner + link", () => {
  const src = () => read("src/components/chat-window.tsx");

  it("parse error code từ JSON response an toàn (body không JSON → KHÔNG 500)", () => {
    expect(src()).toContain('typeof json.error === "string"');
    expect(src()).toMatch(/catch \{\s*\n\s*\/\* body không phải JSON/);
  });

  it("code === 'POLICY_ACCEPTANCE_REQUIRED' → setPolicyNotice(true) (KHÔNG im lặng như 4xx khác)", () => {
    expect(src()).toContain('code === "POLICY_ACCEPTANCE_REQUIRED"');
    expect(src()).toContain("setPolicyNotice(true)");
  });

  it("gửi thất bại → trả lại nội dung vừa gõ (review fix: không mất tin nhắn khi bị chặn)", () => {
    expect(src()).toContain("setText((t) => t || body)");
  });

  it("banner: thông báo trung tính + Link /account/policies (KHÔNG code thô)", () => {
    expect(src()).toMatch(/\{policyNotice && \(/);
    expect(src()).toContain(
      "Bạn cần đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư của LoaViet",
    );
    expect(src()).toContain('href="/account/policies"');
    expect(src()).toContain("Xem và đồng ý tại trang tài khoản");
  });
});

// ─── 4. AuthForm — consent checkbox bắt buộc khi ĐĂNG KÝ ──────────────────────

describe("AuthForm — checkbox acceptPolicies (register only)", () => {
  const src = () => read("src/components/auth-form.tsx");

  it("checkbox name='acceptPolicies' required — CHỈ mode register (login KHÔNG)", () => {
    expect(src()).toContain('mode === "register" && (');
    expect(src()).toContain('name="acceptPolicies"');
    expect(src()).toMatch(/name="acceptPolicies"\s*\n\s*required/);
  });

  it("links /policies/terms + /policies/privacy mở tab mới (target=_blank + rel) — KHÔNG mất form", () => {
    expect(src()).toContain('href="/policies/terms"');
    expect(src()).toContain('href="/policies/privacy"');
    expect(src()).toContain('target="_blank"');
    expect(src()).toContain('rel="noopener"');
  });

  it("copy đồng ý tiếng Việt tường minh (Nghị định 13/2023 explicit consent)", () => {
    expect(src()).toContain("Tôi đã đọc và đồng ý với");
    expect(src()).toContain("Điều khoản sử dụng");
    expect(src()).toContain("Chính sách quyền riêng tư");
  });
});

// ─── 5. PolicyAcceptanceForm — /account/policies (React 19 form reset) ────────

describe("PolicyAcceptanceForm — acceptCurrentPoliciesAction + dispatch thủ công", () => {
  const src = () => read("src/components/policy-acceptance-form.tsx");

  it('"use client" + useActionState(acceptCurrentPoliciesAction) — enforcement ở ACTION', () => {
    expect(src()).toContain('"use client"');
    expect(src()).toContain("useActionState");
    expect(src()).toContain("acceptCurrentPoliciesAction");
  });

  it("KHÔNG action prop trên <form> — dispatch thủ công onSubmit + startTransition (checkbox sống qua {error})", () => {
    expect(src()).not.toMatch(/<form\s[^>]*action=\{formAction\}/);
    expect(src()).toContain("onSubmit={(e) => {");
    expect(src()).toContain("e.preventDefault()");
    expect(src()).toContain("startTransition(() => {");
    expect(src()).toContain("void formAction(fd)");
    expect(src()).toContain("new FormData(e.currentTarget)");
  });

  it("checkbox acceptPolicies required + links tab mới (đọc policy trước khi đồng ý)", () => {
    expect(src()).toContain('name="acceptPolicies"');
    expect(src()).toMatch(/name="acceptPolicies"\s*\n\s*required/);
    expect(src()).toContain('href="/policies/terms"');
    expect(src()).toContain('href="/policies/privacy"');
    expect(src()).toContain('target="_blank"');
  });
});

// ─── 6. Banner ?error= — /sell/my + /sell/[id]/edit + allowlist redirect ──────

describe("Banner ?error=POLICY_ACCEPTANCE_REQUIRED — /sell/my + /sell/[id]/edit", () => {
  it("app/sell/my: special-case code → Link /account/policies (text thường vẫn qua submitErrorText)", () => {
    const src = read("app/sell/my/page.tsx");
    expect(src).toContain('sp.error === "POLICY_ACCEPTANCE_REQUIRED"');
    expect(src).toContain('href="/account/policies"');
    expect(src).toContain("Xem và đồng ý tại trang tài khoản");
  });

  it("app/sell/[id]/edit: special-case code → Link /account/policies", () => {
    const src = read("app/sell/[id]/edit/page.tsx");
    expect(src).toContain('submitError === "POLICY_ACCEPTANCE_REQUIRED"');
    expect(src).toContain('href="/account/policies"');
    expect(src).toContain("Xem và đồng ý tại trang tài khoản");
  });

  it("listing-error-text: POLICY_ACCEPTANCE_REQUIRED → copy trung tính tiếng Việt (KHÔNG code thô)", () => {
    const src = read("src/lib/listing-error-text.ts");
    expect(src).toContain("POLICY_ACCEPTANCE_REQUIRED:");
    expect(src).toContain(
      "Bạn cần đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư của LoaViet trước khi đăng hoặc gửi duyệt tin",
    );
  });

  it("allowlist SUBMIT_ERROR_PARAM_CODES (listings.ts) chứa code — không thì redirect bị co về CONTENT_INVALID", () => {
    const src = read("src/lib/actions/listings.ts");
    expect(src).toMatch(/const SUBMIT_ERROR_PARAM_CODES[\s\S]*?"POLICY_ACCEPTANCE_REQUIRED",/);
  });
});

// ─── 7. /account/policies page — trạng thái + form theo missing FRESH ────────

describe("app/account/policies — trang đồng ý cho user đã đăng nhập", () => {
  const src = () => read("app/account/policies/page.tsx");

  it("chưa đăng nhập → redirect /login (KHÔNG render trạng thái người khác)", () => {
    expect(src()).toContain("getCurrentUser");
    expect(src()).toContain('redirect("/login")');
  });

  it("đọc FRESH missingPolicyAcceptances (dynamic) — form mount CHỈ khi còn thiếu", () => {
    expect(src()).toContain("missingPolicyAcceptances");
    expect(src()).toContain("missing.length > 0 ?");
    expect(src()).toContain("<PolicyAcceptanceForm />");
    expect(src()).toContain('export const dynamic = "force-dynamic"');
  });

  it("hiển thị version hiện hành + trạng thái DRAFT-NOT-REVIEWED trung tính (FD-3)", () => {
    expect(src()).toContain("Phiên bản {policy.version}");
    expect(src()).toContain("DRAFT-NOT-REVIEWED");
    expect(src()).toContain("bản dự thảo, chưa được duyệt");
  });
});
