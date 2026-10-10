/**
 * Deal UI — hợp đồng source + drift labels (Batch 6 plan Task 6 —
 * spec §6.4/§5.2/§4.2/§6.1; source-contract style của finance-public-surface.test.ts,
 * không jsdom).
 *
 * Scope 6a (parallelism map Wave 2 — corrections 2026-10-08):
 *
 *  1. SafetyGuidance (src/components/safety-guidance.tsx): render đủ 6 điểm
 *     §6.4 + dòng §5.2 ("The UI must state") + dòng trung tính Batch 1 —
 *     byte-identical với plan Task 6 (corrections #18: copy-safety
 *     SAFETY_64_POINTS/SAFETY_52_LINE trên local/b8-early-integration).
 *  2. §4.2/§6.4: KHÔNG có ngôn ngữ hứa hẹn (đảm bảo / bảo đảm / bảo hiểm /
 *     bảo vệ thanh toán / bảo vệ giao dịch / giữ tiền hộ / escrow /
 *     guarantee / insurance) NGOÀI dòng negation trung tính duy nhất
 *     "LoaViet không giữ tiền và không bảo đảm giao dịch." (Review Focus 5 —
 *     scan cả comment, không chỉ text render: copy-safety chỉ strip whole-line
 *     comment, trailing comment VẪN bị quét).
 *  3. B2 hygiene: plain component — KHÔNG "use client", KHÔNG import
 *     db/server; KHÔNG dangerouslySetInnerHTML (stored-XSS contract).
 *  4. src/lib/constants.ts (additive, Task 6a): DEAL_STATUS_LABELS /
 *     DEAL_OUTCOME_LABELS drift hai chiều với vocabulary src/lib/deal-vocab.ts
 *     (mọi giá trị có nhãn, mọi nhãn là giá trị hợp lệ — plan Task 6 drift);
 *     KHÔNG có DEAL_FULFILLMENT_METHOD_LABELS — fulfillment Deal reuse
 *     FULFILLMENT_METHOD_LABELS của Batch 4 (corrections #20).
 *
 * Scope 6b (Wave 4 — file này là bản mở rộng của Task 6b; source-contract cho
 * panel/forms/page mounts theo plan Task 6 Step 1 + corrections #15/#16/#31):
 *
 *  5. DealPanel (src/components/deal-panel.tsx): server component (props in,
 *     React out — KHÔNG đọc db); §5.2 line + DEAL_STATUS_LABELS + formatVND;
 *     DealCreateForm cho buyer+approved khi deal null HOẶC terminal (S11/D4);
 *     DealOutcomeForm chỉ khi open + viewer chưa mark; KHÔNG tự mount
 *     SafetyGuidance (trang mount MỘT LẦN); cancellationReason render React
 *     text (KHÔNG dangerouslySetInnerHTML).
 *  6. DealCreateForm / DealOutcomeForm ("use client" + useActionState):
 *     import CHỈ deal-vocab + constants + actions/deals (B2 hygiene —
 *     exact-module match cho @/src/lib/deal, substring scan false-positive
 *     trên deal-vocab); mọi control có <label htmlFor> (§10 accessibility);
 *     markSold checkbox CHỈ seller + success, default off (D6/FD-3);
 *     cancellationReason textarea chỉ cancelled + maxLength bound (D3).
 *  7. app/chat/[id]/page.tsx: deal tra THEO conversationId (S11 — không theo
 *     (listingId, buyerId)); DealPanel + SafetyGuidance (MỘT LẦN, sau panel);
 *     giữ select redaction + block banner/report dialog Batch 3 (Q4 additive).
 *  8. app/listings/[slug]/page.tsx (D12/§6.1): eligibility qua
 *     assertListingSellerInteractable — CHỈ typed SELLER_* codes map thành
 *     copy trung tính, lỗi khác rethrow (KHÔNG catch-all); anonymous vẫn thấy
 *     "Nhắn người bán" (KHÔNG thêm && user — corrections #16); compact
 *     DealCreateForm chỉ cho buyer đã có hội thoại (corrections #31); giữ
 *     disclaimer Batch 1 (pins finance-public-surface).
 *  9. (§4b — b6-review LOW-1/LOW-2) React 19 form reset: hai form KHÔNG gắn
 *     action prop — dispatch thủ công onSubmit + preventDefault +
 *     startTransition (pattern b4-holistic round-1 PortableListingForm) để
 *     outcome/markSold/cancellationReason/agreedPrice/fulfillmentMethod
 *     KHÔNG bị form.reset() wipe sau action trả {error}.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEAL_STATUS_LABELS,
  DEAL_OUTCOME_LABELS,
  FULFILLMENT_METHOD_LABELS,
} from "@/src/lib/constants";
import {
  DEAL_STATUSES,
  DEAL_OUTCOMES,
  DEAL_FULFILLMENT_METHODS,
} from "@/src/lib/deal-vocab";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── Copy §6.4/§5.2 — byte-identical plan Task 6 (corrections #18) ────────────

/** Sáu điểm §6.4 — bản dịch tiếng Việt (copy-safety SAFETY_64_POINTS). */
const SAFETY_64_POINTS = [
  "Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.",
  "Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.",
  "Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.",
  "Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.",
  "Cẩn trọng với các đường link thanh toán đáng ngờ.",
  "Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.",
] as const;

/** Dòng §5.2 — bắt buộc trong UI (copy-safety SAFETY_52_LINE). */
const SAFETY_52_LINE = "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.";

/** Dòng trung tính Batch 1 — negation duy nhất được allowlist (copy-safety). */
const NEUTRAL_LINE = "LoaViet không giữ tiền và không bảo đảm giao dịch.";

/**
 * §4.2/§6.4 — ngôn ngữ hứa hẹn cấm: copy-safety PROMISE_PATTERNS
 * (corrections #18) + "giữ tiền hộ" (plan Task 6 scan). Match ở CẢ comment
 * lẫn text render — chỉ dòng negation trung tính được phép chứa "bảo đảm".
 */
const PROMISE_RE =
  /đảm bảo|bảo đảm|bảo hiểm|bảo vệ thanh toán|bảo vệ giao dịch|giữ tiền hộ|escrow|guarantee|insurance/i;

// ─── 1. SafetyGuidance — source contract (§6.4 + §5.2 + §4.2) ────────────────

describe("SafetyGuidance — §6.4 six points + §5.2 line (source contract)", () => {
  const src = () => read("src/components/safety-guidance.tsx");

  it("render đủ 6 điểm §6.4 — byte-identical plan Task 6 / copy-safety", () => {
    for (const point of SAFETY_64_POINTS) {
      expect(src()).toContain(point);
    }
  });

  it("render dòng §5.2 (bắt buộc trong UI) + dòng trung tính Batch 1", () => {
    expect(src()).toContain(SAFETY_52_LINE);
    expect(src()).toContain(NEUTRAL_LINE);
  });

  it("§4.2: KHÔNG ngôn ngữ hứa hẹn nào NGOÀI dòng negation trung tính", () => {
    // Bỏ dòng chứa negation ("bảo đảm" bên trong "không bảo đảm" — không
    // phải affirmative promise); mọi occurrence pattern còn lại (kể cả trong
    // comment) = vi phạm §4.2/§6.4 "Avoid giving the impression that safety
    // guidance equals transaction insurance".
    const withoutNegation = src()
      .split("\n")
      .filter((line) => !line.includes(NEUTRAL_LINE))
      .join("\n");
    expect(withoutNegation).not.toMatch(PROMISE_RE);
  });

  it("plain component — KHÔNG 'use client', KHÔNG import server/db (B2 hygiene)", () => {
    expect(src()).toContain("export function SafetyGuidance");
    expect(src()).not.toContain('"use client"');
    expect(src()).not.toContain('"use server"');
    expect(src()).not.toContain("db.client");
    expect(src()).not.toContain("server-only");
    expect(src()).not.toContain("next/headers");
    expect(src()).not.toContain("next/cache");
  });

  it("KHÔNG dangerouslySetInnerHTML (stored-XSS contract)", () => {
    expect(src()).not.toContain("dangerouslySetInnerHTML");
  });
});

// ─── 2. constants — deal labels drift (plan Task 6 + corrections #20) ────────

describe("constants — deal status/outcome labels drift", () => {
  const constantsSrc = () => read("src/lib/constants.ts");

  it("DEAL_STATUS_LABELS: keys === DEAL_STATUSES hai chiều (mọi giá trị có nhãn, mọi nhãn hợp lệ)", () => {
    expect(Object.keys(DEAL_STATUS_LABELS).sort()).toEqual([...DEAL_STATUSES].sort());
    // giá trị pin theo plan Task 6 (product copy — PROVISIONAL A9/FD-3,
    // Batch 8 duyệt; đổi label = sửa test một cách có chủ đích)
    expect(DEAL_STATUS_LABELS).toEqual({
      open: "Đang mở",
      completed: "Hoàn tất",
      cancelled: "Đã hủy",
      no_deal: "Không đạt",
    });
  });

  it("DEAL_OUTCOME_LABELS: keys === DEAL_OUTCOMES hai chiều (D3 — marking per party)", () => {
    expect(Object.keys(DEAL_OUTCOME_LABELS).sort()).toEqual([...DEAL_OUTCOMES].sort());
    expect(DEAL_OUTCOME_LABELS).toEqual({
      success: "Thỏa thuận thành công",
      no_deal: "Không đạt thỏa thuận",
      cancelled: "Đã hủy thỏa thuận",
    });
  });

  it("mọi nhãn là chuỗi không rỗng (không bao giờ render key thô)", () => {
    for (const labels of [DEAL_STATUS_LABELS, DEAL_OUTCOME_LABELS]) {
      for (const value of Object.values(labels)) {
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("corrections #20: KHÔNG có DEAL_FULFILLMENT_METHOD_LABELS — Deal reuse FULFILLMENT_METHOD_LABELS của Batch 4", () => {
    expect(constantsSrc()).not.toContain("DEAL_FULFILLMENT_METHOD_LABELS");
    // Map Batch 4 phủ đủ 4 phương thức §5.2 — deal panel dùng lại, không map riêng.
    for (const method of DEAL_FULFILLMENT_METHODS) {
      expect(FULFILLMENT_METHOD_LABELS).toHaveProperty(method);
    }
  });
});

// ─── 3. DealPanel — source contract (Task 6b — spec §5.2/S11/D4/D12) ──────────

describe("DealPanel — panel thỏa thuận trên trang hội thoại (source contract)", () => {
  const src = () => read("src/components/deal-panel.tsx");

  it("server component — props in, React out (KHÔNG 'use client', KHÔNG db)", () => {
    expect(src()).toContain("export function DealPanel");
    expect(src()).not.toContain('"use client"');
    expect(src()).not.toContain('"use server"');
    expect(src()).not.toContain("db.client");
    expect(src()).not.toContain("server-only");
  });

  it("render §5.2 line + DEAL_STATUS_LABELS + formatVND agreedPrice + fulfillment label", () => {
    expect(src()).toContain(SAFETY_52_LINE);
    expect(src()).toContain("DEAL_STATUS_LABELS");
    expect(src()).toContain("formatVND");
    expect(src()).toContain("FULFILLMENT_METHOD_LABELS");
  });

  it("DealCreateForm cho buyer + listing approved khi deal null HOẶC terminal (S11/D4)", () => {
    expect(src()).toContain("DealCreateForm");
    expect(src()).toContain('variant="full"');
    expect(src()).toContain("isTerminalDealStatus");
    expect(src()).toMatch(/viewerRole === "buyer"/);
    expect(src()).toMatch(/listing\?\.status === "approved"/);
  });

  it("DealOutcomeForm CHỈ khi deal open + viewer chưa mark (D3 — đã mark thì chờ)", () => {
    expect(src()).toContain("DealOutcomeForm");
    expect(src()).toMatch(/deal\.status === "open"/);
    expect(src()).toMatch(/viewerOutcomeAt === null/);
    expect(src()).toContain("Bạn đã đánh dấu kết quả");
  });

  it("KHÔNG tự mount SafetyGuidance (trang mount MỘT LẦN — tránh render đôi)", () => {
    expect(src()).not.toContain("SafetyGuidance");
  });

  it("KHÔNG dangerouslySetInnerHTML — cancellationReason render React text (stored-XSS)", () => {
    expect(src()).not.toContain("dangerouslySetInnerHTML");
    expect(src()).toContain("deal.cancellationReason");
  });

  it("§4.2: KHÔNG promise language (scan cả comment — chỉ dòng negation được phép)", () => {
    const withoutNegation = src()
      .split("\n")
      .filter((line) => !line.includes(NEUTRAL_LINE))
      .join("\n");
    expect(withoutNegation).not.toMatch(PROMISE_RE);
  });
});

// ─── 4. Client forms — B2 hygiene + D6 markSold (Task 6b) ──────────────────────

/** B2 hygiene — client form Deal import CHỈ từ deal-vocab + constants + actions. */
const assertClientFormHygiene = (path: string): void => {
  const src = read(path);
  expect(src, `${path}: "use client"`).toContain('"use client"');
  expect(src, `${path}: useActionState`).toContain("useActionState");
  // KHÔNG import db / server-only / module domain server
  expect(src, `${path}: db`).not.toContain("db.client");
  expect(src, `${path}: server-only`).not.toContain("server-only");
  // exact-module match — substring scan false-positive trên deal-vocab
  expect(src, `${path}: @/src/lib/deal`).not.toMatch(/from "@\/src\/lib\/deal"/);
  // import TỪ deal-vocab + constants + actions (plan Task 6 — chỉ ba nguồn này)
  expect(src, `${path}: deal-vocab`).toContain("@/src/lib/deal-vocab");
  expect(src, `${path}: constants`).toContain("@/src/lib/constants");
  expect(src, `${path}: actions/deals`).toContain("@/src/lib/actions/deals");
  // stored-XSS contract
  expect(src, `${path}: dangerouslySetInnerHTML`).not.toContain("dangerouslySetInnerHTML");
  // §4.2 — KHÔNG promise language (scan cả comment, negation được allowlist)
  const withoutNegation = src
    .split("\n")
    .filter((line) => !line.includes(NEUTRAL_LINE))
    .join("\n");
  expect(withoutNegation, `${path}: promise language`).not.toMatch(PROMISE_RE);
};

describe("DealCreateForm — useActionState(createDealAction) + variant (source contract)", () => {
  const src = () => read("src/components/deal-create-form.tsx");

  it('B2 hygiene: "use client" + import CHỈ deal-vocab + constants + actions', () => {
    assertClientFormHygiene("src/components/deal-create-form.tsx");
    expect(src()).toContain("createDealAction");
  });

  it("compact (trang listing §6.1) render CHỈ nút submit — hai trường chỉ full variant", () => {
    expect(src()).toMatch(/variant === "compact"/);
    // hai trường giá/phương thức gate trên !compact — compact không gửi gì thêm
    expect(src()).toMatch(/\{!compact && \(/);
    expect(src()).toContain("Tạo thỏa thuận");
  });

  it("full variant: agreedPrice (bound D5) + fulfillmentMethod select (labels Batch 4)", () => {
    expect(src()).toContain("DEAL_AGREED_PRICE_MIN");
    expect(src()).toContain("DEAL_AGREED_PRICE_MAX");
    expect(src()).toContain("DEAL_FULFILLMENT_METHODS");
    expect(src()).toContain("FULFILLMENT_METHOD_LABELS");
  });

  it("mọi control có <label htmlFor> (spec §10 accessibility)", () => {
    expect(src()).toMatch(/htmlFor=/);
  });

  it("lỗi typed hiển thị tiếng Việt, KHÔNG phản chiếu input (DEAL_CONVERSATION_REQUIRED)", () => {
    expect(src()).toContain("DEAL_CONVERSATION_REQUIRED");
    expect(src()).toContain("Hãy nhắn người bán trước khi tạo thỏa thuận");
  });
});

describe("DealOutcomeForm — useActionState(markDealOutcomeAction) + D6 markSold (source contract)", () => {
  const src = () => read("src/components/deal-outcome-form.tsx");

  it('B2 hygiene: "use client" + import CHỈ deal-vocab + constants + actions', () => {
    assertClientFormHygiene("src/components/deal-outcome-form.tsx");
    expect(src()).toContain("markDealOutcomeAction");
  });

  it("markSold checkbox CHỈ seller + chọn success, default OFF (D6/FD-3 — buyer không thấy)", () => {
    expect(src()).toContain("markSold");
    expect(src()).toMatch(/viewerRole === "seller"/);
    expect(src()).toMatch(/outcome === "success"/);
    // default off — KHÔNG defaultChecked/checked mặc định
    expect(src()).not.toContain("defaultChecked");
    expect(src()).toContain("Đánh dấu tin đã bán");
  });

  it("cancellationReason textarea CHỈ khi chọn cancelled + maxLength bound (D3)", () => {
    expect(src()).toMatch(/outcome === "cancelled"/);
    expect(src()).toContain("DEAL_CANCELLATION_REASON_MAX");
    expect(src()).toContain("cancellationReason");
  });

  it("ba lựa chọn từ DEAL_OUTCOMES + label DEAL_OUTCOME_LABELS (không tự chế giá trị)", () => {
    expect(src()).toContain("DEAL_OUTCOMES");
    expect(src()).toContain("DEAL_OUTCOME_LABELS");
  });

  it("mọi control có <label htmlFor> (spec §10 accessibility)", () => {
    expect(src()).toMatch(/htmlFor=/);
  });
});

// ─── 4b. b6-review LOW-1/LOW-2 — React 19 form reset: inputs sống qua error ───

/**
 * b6-review LOW-1/LOW-2 (2-skeptic verification Tasks 6a/6b): React 19 gọi
 * requestFormReset trên MỌI form action KHÔNG throw — kể cả action trả
 * {error} — nên form.reset() wipe DOM: radio outcome bỏ chọn + markSold bỏ
 * tick + cancellationReason/agreedPrice/fulfillmentMethod rỗng, TRONG KHI
 * useState VẪN giữ outcome cũ → retry đọc FormData từ DOM ĐÃ RESET (outcome
 * rỗng → DEAL_OUTCOME_INVALID, markSold mất). Hợp đồng fix = pattern
 * b4-holistic round-1 của PortableListingForm
 * (tests/unit/portable-listing-form.test.ts:159-179): KHÔNG action prop —
 * dispatch thủ công onSubmit + preventDefault + startTransition(formAction(fd))
 * → KHÔNG requestFormReset → mọi control giữ nguyên giá trị qua error
 * response (pending của useActionState vẫn track đúng khi gọi trong
 * transition — React docs). Repo không có jsdom/E2E infra (ghi nhận từ Batch
 * 2) nên hợp đồng là source-contract như Batch 4, không render test.
 */
describe("DealOutcomeForm — outcome/markSold/reason sống qua action error (React 19 form reset)", () => {
  const src = () => read("src/components/deal-outcome-form.tsx");

  it("KHÔNG action prop trên <form> — dispatch thủ công onSubmit + startTransition (KHÔNG requestFormReset)", () => {
    expect(src()).not.toMatch(/<form\s[^>]*action=\{formAction\}/);
    expect(src()).toContain("onSubmit={(e) => {");
    expect(src()).toContain("e.preventDefault()");
    expect(src()).toContain("startTransition(() => {");
    expect(src()).toContain("void formAction(fd)");
  });

  it("FormData build từ form tại submit — radio controlled, textarea/checkbox KHÔNG defaultValue", () => {
    // FormData đọc DOM TRỰC TIẾP tại submit — radio vẫn controlled (checked
    // từ useState) nên lựa chọn sống qua re-render error; KHÔNG có
    // defaultValue nào bị form.reset() wipe (dù reset path đã bị bỏ ở test trên).
    expect(src()).toContain("new FormData(e.currentTarget)");
    expect(src()).toMatch(/checked=\{outcome === o\}/);
    expect(src()).toMatch(/onChange=\{\(\) => setOutcome\(o\)\}/);
    expect(src()).not.toContain("defaultValue");
  });
});

describe("DealCreateForm — agreedPrice/fulfillmentMethod sống qua action error (React 19 form reset)", () => {
  const src = () => read("src/components/deal-create-form.tsx");

  it("KHÔNG action prop trên <form> — dispatch thủ công onSubmit + startTransition (KHÔNG requestFormReset)", () => {
    // full variant: agreedPrice/fulfillmentMethod là uncontrolled DOM input —
    // KHÔNG action prop thì KHÔNG có requestFormReset nào wipe chúng sau
    // {error}; compact variant chỉ nút nên không mất gì thêm.
    expect(src()).not.toMatch(/<form\s[^>]*action=\{formAction\}/);
    expect(src()).toContain("onSubmit={(e) => {");
    expect(src()).toContain("e.preventDefault()");
    expect(src()).toContain("startTransition(() => {");
    expect(src()).toContain("void formAction(fd)");
    expect(src()).toContain("new FormData(e.currentTarget)");
  });
});

// ─── 5. app/chat/[id] — DealPanel + SafetyGuidance mounts (Task 6b) ───────────

describe("app/chat/[id] — deal panel mount (S11) + safety guidance (§6.4)", () => {
  const src = () => read("app/chat/[id]/page.tsx");

  it("deal tra THEO conversationId (S11 — KHÔNG theo (listingId, buyerId))", () => {
    expect(src()).toMatch(/Deal\s*\.where\(\{ conversationId: convo\.id \}\)/);
    expect(src()).toContain(".orderBy((d) => d.createdAt.desc())");
    // panel không tra theo cặp (listing, buyer) — deal sống qua listing deletion
    expect(src()).not.toMatch(/Deal\s*\.where\(\{ listingId:/);
  });

  it("DealPanel mount với listing redaction (corrections #15) + viewerRole từ convo", () => {
    expect(src()).toContain("<DealPanel");
    // listingVisible ? {...} : null — viewer không được thấy content đã gỡ
    expect(src()).toMatch(/listing && listingVisible/);
    expect(src()).toMatch(/\{ id: listing\.id, title: listing\.title, status: listing\.status \}/);
    expect(src()).toContain('user.id === convo.buyerId ? "buyer" : "seller"');
  });

  it("SafetyGuidance mount ĐÚNG MỘT LẦN, SAU DealPanel (§6.4 near chat/deal flows)", () => {
    const guidanceCount = (src().match(/<SafetyGuidance/g) ?? []).length;
    expect(guidanceCount).toBe(1);
    expect(src()).toContain("<DealPanel");
    expect(src().indexOf("<SafetyGuidance")).toBeGreaterThan(src().indexOf("<DealPanel"));
  });

  it("giữ nguyên select redaction pin (chat-pages.test.ts) + block banner + report dialog Batch 3 (Q4)", () => {
    // select pin — KHÔNG đổi (corrections #15)
    expect(src()).toMatch(/l\.select\("id", "title", "slug", "price", "status", "acceptExchange"\)/);
    // Batch 3 mounts giữ nguyên (file-conflict rules Q4 — additive mount)
    expect(src()).toContain("getBlockState");
    expect(src()).toContain("isUserSuspended");
    expect(src()).toContain("ReportDialog");
    expect(src()).toContain("unblockUserAction");
    expect(src()).toContain("ChatWindow");
  });
});

// ─── 6. app/listings/[slug] — D12 CTA gating + §6.1 secondary CTA (Task 6b) ──

describe("app/listings/[slug] — D12 eligibility gating + §6.1 secondary CTA (source contract)", () => {
  const src = () => read("app/listings/[slug]/page.tsx");

  it("eligibility qua assertListingSellerInteractable — CHỈ typed SELLER_* codes, lỗi khác RETHROW", () => {
    expect(src()).toContain("assertListingSellerInteractable");
    expect(src()).toContain("SELLER_INELIGIBLE_CODES");
    expect(src()).toContain("SELLER_SUSPENDED");
    expect(src()).toContain("SELLER_NOT_VERIFIED");
    expect(src()).toContain("SELLER_MEMBERSHIP_INACTIVE");
    // KHÔNG catch-all: nhánh else rethrow lỗi infra/db (§4.5 — action enforce)
    expect(src()).toMatch(/else\s*\{\s*throw e;\s*\}/);
  });

  it("eligible → 'Nhắn người bán' + DealCreateForm compact (§6.1); ineligible → copy trung tính (D12)", () => {
    expect(src()).toContain("Nhắn người bán");
    expect(src()).toContain('<DealCreateForm listingId={listing.id} variant="compact" />');
    expect(src()).toContain("Người bán hiện không nhận tin nhắn mới");
  });

  it("anonymous vẫn thấy CTA — KHÔNG thêm && user (corrections #16)", () => {
    // nhánh CTA giữ nguyên điều kiện cũ (approved + !isOwner) — khách chưa đăng
    // nhập thấy "Nhắn người bán"; compact form mới mới gate trên user.
    expect(src()).toMatch(/listing\.status === "approved" && !isOwner \?/);
    expect(src()).not.toMatch(/listing\.status === "approved" && !isOwner && user/);
  });

  it("compact form CHỈ cho buyer đã có hội thoại (corrections #31 — DEAL_CONVERSATION_REQUIRED vô dụng)", () => {
    expect(src()).toContain(".where({ listingId: listing.id, buyerId: user.id })");
    expect(src()).toMatch(/\{user && buyerConvo !== null && \(/);
  });

  it("giữ disclaimer Batch 1 + hint an toàn (pins finance-public-surface + copy-safety)", () => {
    expect(src()).toContain("ngoài LoaViet");
    expect(src()).toContain("không giữ tiền");
    expect(src()).toContain("không bảo đảm giao dịch");
    expect(src()).toContain("startConversationAction");
    // Batch 3 report dialog + Batch 5 emission call sites giữ nguyên (Q4)
    expect(src()).toContain("ReportDialog");
    expect(src()).toContain("recordListingView");
    expect(src()).toContain("recordSearchResultClick");
  });

  it("§4.2: KHÔNG promise language NGOÀI dòng negation (scan cả comment)", () => {
    const withoutNegation = src()
      .split("\n")
      .filter((line) => !line.includes(NEUTRAL_LINE))
      .join("\n");
    expect(withoutNegation).not.toMatch(PROMISE_RE);
  });
});
