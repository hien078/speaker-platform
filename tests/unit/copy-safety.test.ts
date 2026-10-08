/**
 * Copy-safety scan THƯỜ TRỰC (Batch 8 Task 2) — hợp nhất các rg scan copy
 * từng batch (Batch 1 plan §8, Batch 4 plan Task 9, Batch 6 plan Task 8) thành
 * MỘT gate rerunnable — source-scan pattern tests/unit/finance-public-surface.test.ts.
 *
 * Spec: §4.2 (No Misleading Promise — copy công khai không được claim LoaViet
 * giữ tiền / bảo vệ thanh toán / bảo đảm người bán-sản phẩm-giao dịch-meetup),
 * §4.7 (Location Neutrality — không location-safety claim), §6.2 (Seller
 * Verification Copy — câu trung tính, tránh các câu "bảo đảm"), §5.2/§6.4
 * (Independent Transaction Safety Guidance — sáu điểm + dòng "thanh toán và
 * giao nhận hàng diễn ra độc lập ngoài LoaViet").
 *
 * Phạm vi nguồn copy công khai (plan Task 2 Interfaces — đọc file như text):
 * mọi file .tsx dưới app/ (đệ quy) + mọi file .tsx dưới src/components/
 * (đệ quy) + mọi file .ts dưới src/content/ (đệ quy).
 * (app/manifest.ts + các route dưới app/api là .ts — ngoài glob; manifest
 * pin bởi tests/unit/finance-public-surface.test.ts, api route không phải copy.)
 *
 * Phân loại hit — kỷ luật "classify carefully" (Batch 6 plan Task 8: scan là
 * cho wording KHẲNG ĐỊNH — negation chứa "bảo đảm" bên trong "không bảo đảm"):
 *  - Scan §4.2 chạy trên copy SỐNG: bỏ comment (comment không phải copy render),
 *    chuẩn hoá whitespace (JSX ngắt câu giữa dòng), và MỌI hit pattern phải nằm
 *    trong một câu NEGATION allowlisted exact — hit ngoài negation = vi phạm
 *    §4.2 (defect của file sở hữu — fix ở đó, KHÔNG weaken scan).
 *  - Scan NEGATIVE (§4.7 + §6.2 avoid) quét TOÀN BỘ glob, comments kể cả,
 *    không loại trừ: không file nào được phép chứa location-safety claim hay
 *    câu avoid §6.2.
 *  - Loại trừ khỏi scan §4.2 (không phải copy công khai) — MỖI file có PIN để
 *    loại trừ không tự silently hợp lệ: trang finance retire (404 trước render,
 *    Batch 1 — guard phải còn), flow finance guard-throw
 *    (assertFinancialFeaturesEnabled), component finance dormant (không file
 *    sống nào import), app/admin/** (console operator sau auth — readout
 *    finance lịch sử chỉ đọc, Batch 1 Task 5; spec §4.2 là copy CÔNG KHAI).
 *    Pin biến mất → test FAIL để soi lại phân loại.
 *
 * Merge fix (Wave 0 — commit "fix(ops): reconcile early batch 8 work with
 * batches 5-7"): Task 2 được thực thi sớm trên cây chỉ có Batch 0–2; các nhánh
 * "EARLY EXECUTION" (re-verify after Batch N) đã HUYỀN TRỰC HOÁ trên cây merge
 * Batch 5–7 (grep-verified):
 *  - src/components/safety-guidance.tsx (Batch 6 Task 6 — §6.4 render gần
 *    chat/deal) CÓ trong tree, được app/chat/[id]/page.tsx import + render —
 *    describe BẤT ĐIỀU KIỆN (component bị xoá → test FAIL, không skip
 *    silently), kèm pin import/render trên chat page.
 *  - Copy §6.4 gần chat flow: chat page mount SafetyGuidance (Batch 6 Task 6b)
 *    + listing detail (Batch 1) + nội dung policy safety_guidance (Task 1).
 *  - app/admin/seller-verification/page.tsx KHÔNG chứa câu §6.2 trung tính
 *    (code Batch 2: hàng đợi ops review — badge "Đã xác minh" là trạng thái
 *    email/phone, không phải claim người bán) — theo code, ghi nhận lệch plan.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { POLICY_KEYS, policyContent } from "../../src/lib/policy-registry";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── Walk phạm vi glob (mặc định quét mọi file MỚI — gate thường trực) ────────

/** Liệt kê đệ quy mọi file dưới <dir> khớp hậu tố (repo-relative, sort). */
function walk(dir: string, suffix: ".tsx" | ".ts"): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(`${root}/${current}`)) {
      const p = `${current}/${entry}`;
      if (statSync(`${root}/${p}`).isDirectory()) stack.push(p);
      else if (p.endsWith(suffix)) out.push(p);
    }
  }
  return out.sort();
}

/** Nguồn copy công khai (plan Task 2 Interfaces). */
const GLOB_FILES: string[] = [
  ...walk("app", ".tsx"),
  ...walk("src/components", ".tsx"),
  ...walk("src/content", ".ts"),
];

// ─── Phân loại: loại trừ khỏi scan §4.2 (không phải copy công khai) ──────────

/**
 * Trang finance retire (Batch 1 Task 4) — notFound() TRƯỚC mọi read khi
 * FINANCIAL_FEATURES_ENABLED=false; copy dormant bên dưới guard không render
 * công khai. Pin: mỗi file phải còn guard (financialFeaturesEnabled +
 * notFound()) — guard biến mất thì loại trừ không còn hợp lệ → test FAIL.
 * Danh sách trùng RETIRED_FINANCE_PAGES của tests/unit/finance-public-surface.test.ts.
 */
const RETIRED_FINANCE_PAGES: readonly string[] = [
  "app/cart/page.tsx",
  "app/checkout/page.tsx",
  "app/orders/page.tsx",
  "app/orders/[id]/page.tsx",
  "app/orders/sales/page.tsx",
  "app/wallet/page.tsx",
  "app/offers/page.tsx",
  "app/exchange/page.tsx",
  "app/listings/[slug]/exchange/page.tsx",
];

/**
 * Flow finance guard-throw (Batch 1 Task 3) — assertFinancialFeaturesEnabled
 * đứng trước mọi verify-then-mutate; không render copy khi finance tắt.
 */
const DORMANT_FINANCE_FLOW_PAGES: readonly string[] = [
  "app/payments/momo/return/page.tsx",
];

/**
 * Component finance dormant — chỉ import bởi trang đã retire / admin (đọc
 * lịch sử); không reachable từ copy công khai sống. Pin: không file sống nào
 * được import (case riêng) — reachable thì loại trừ không còn hợp lệ.
 */
const DORMANT_FINANCE_COMPONENTS: readonly string[] = [
  "src/components/checkout-form.tsx",
  "src/components/escrow-pay-modal.tsx",
  "src/components/offer-card.tsx",
  "src/components/offer-form.tsx",
  "src/components/exchange-offer-form.tsx",
  "src/components/exchange-topup-button.tsx",
  "src/components/confirm-receipt-button.tsx",
  "src/components/withdraw-form.tsx",
];

/**
 * Console operator (app/admin/**) — sau auth (requireCapability/
 * requireAdminUser từng trang — tests/unit/admin-page-guards.test.ts), readout
 * finance lịch sử chỉ đọc (Batch 1 Task 5). Spec §4.2 là copy CÔNG KHAI —
 * admin không thuộc phạm vi; scan NEGATIVE (§4.7/§6.2) vẫn quét admin.
 */
const ADMIN_PREFIX = "app/admin/";

const EXCLUDED_FROM_PROMISE_SCAN = new Set<string>([
  ...RETIRED_FINANCE_PAGES,
  ...DORMANT_FINANCE_FLOW_PAGES,
  ...DORMANT_FINANCE_COMPONENTS,
]);

const isExcludedFromPromiseScan = (p: string) =>
  EXCLUDED_FROM_PROMISE_SCAN.has(p) || p.startsWith(ADMIN_PREFIX);

/** Copy công khai SỐNG — mọi file mới trong glob được quét mặc định. */
const LIVE_FILES = GLOB_FILES.filter((p) => !isExcludedFromPromiseScan(p));

// ─── Chuẩn hoá text ───────────────────────────────────────────────────────────

/**
 * Bỏ comment — comment nguồn không phải copy render (spec §4.2 governs copy):
 * (a) block comment JSX `{/* … *\/}` thay bằng dấu cách; (b) dòng thuần comment
 * (docblock ` * …`, `// …`, `/* …`, `<!-- …`) bỏ cả dòng. Dòng code + JSX text
 * giữ nguyên — comment cuối dòng KHÔNG bị bỏ (hit trong đó vẫn bị soi).
 */
const stripComments = (text: string) =>
  text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*|<!--)/.test(line))
    .join("\n");

/** Chuẩn hoá whitespace — JSX ngắt câu giữa dòng (footer / seller profile). */
const normalize = (text: string) => text.replace(/\s+/g, " ");

/** Text scan §4.2 của một file: bỏ comment + chuẩn hoá. */
const scanText = (p: string) => normalize(stripComments(read(p)));

// ─── §4.2 pattern + negation allowlist ────────────────────────────────────────

/** Pattern ngôn ngữ promise (plan Task 2 — case-insensitive). */
const PROMISE_PATTERNS: ReadonlyArray<RegExp> = [
  /đảm bảo/gi,
  /bảo đảm/gi,
  /bảo hiểm/gi,
  /bảo vệ (thanh toán|giao dịch)/gi,
  /giữ tiền hộ/gi,
  /escrow/gi,
  /guarantee/gi,
  /insurance/gi,
];

/**
 * Negation allowlisted — hit pattern CHỈ hợp lệ khi nằm trong một câu
 * negation exact này (precedent Batch 6 plan Task 8). Mở rộng allowlist =
 * quyết định CÓ ghi nhận (report + review), không phải cách weaken scan:
 * entry mới phải là negation render thật, kèm nơi render.
 */
const ALLOWED_NEGATIONS: ReadonlyArray<{ re: RegExp; where: string }> = [
  {
    // Batch 1 — footer ×2, home, layout metadata, listing disclaimer, seller profile.
    re: /LoaViet không giữ tiền và không bảo đảm giao dịch/gi,
    where: "footer + listing disclaimer (plan) — còn home/layout/seller profile",
  },
  {
    // Batch 2 §6.2 explainer (seller-verification-form): xác minh là kiểm soát
    // truy cập — "không phải bảo đảm sản phẩm hay chứng nhận giao dịch" là
    // NEGATION render, không phải promise. Ghi nhận lệch plan: plan liệt kê 2
    // negation (footer + §5.2); câu negation §6.2 của Batch 2 có sẵn trong
    // tree — classify theo code, KHÔNG flag (sửa file Batch 2 bị cấm bởi
    // early-execution constraint; xem report).
    re: /không<\/b> phải bảo đảm sản phẩm hay chứng nhận giao dịch/gi,
    where: "src/components/seller-verification-form.tsx — §6.2 explainer negation",
  },
];

type Hit = { file: string; pattern: string; context: string };

/** Quét text đã chuẩn hoá: hit pattern ngoài mọi negation allowlisted = vi phạm. */
function findPromiseViolations(file: string, text: string): Hit[] {
  const allowed: Array<[number, number]> = [];
  for (const { re } of ALLOWED_NEGATIONS) {
    for (const m of text.matchAll(re)) {
      allowed.push([m.index!, m.index! + m[0].length]);
    }
  }
  const violations: Hit[] = [];
  for (const re of PROMISE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      const insideNegation = allowed.some(([a, b]) => start >= a && start < b);
      if (!insideNegation) {
        violations.push({
          file,
          pattern: m[0],
          context: text.slice(Math.max(0, start - 60), Math.min(text.length, end + 60)),
        });
      }
    }
  }
  return violations;
}

// ─── 1. §4.2 — không promise language trong copy công khai ───────────────────

describe("§4.2 — không có ngôn ngữ guarantee/escrow/protection/payment-promise trong copy công khai", () => {
  const violations = LIVE_FILES.flatMap((f) => findPromiseViolations(f, scanText(f)));

  it("mọi hit pattern nằm trong negation allowlisted — không còn hit nào khác", () => {
    expect(
      violations.map((v) => `${v.file}: "${v.pattern}" … ${v.context}`),
      `scope: ${LIVE_FILES.length} file sống / ${GLOB_FILES.length} file glob`,
    ).toEqual([]);
  });

  it("negation allowlisted phải CÒN — footer + listing disclaimer (plan Task 2)", () => {
    expect(scanText("src/components/footer.tsx")).toContain(
      "LoaViet không giữ tiền và không bảo đảm giao dịch",
    );
    expect(scanText("app/listings/[slug]/page.tsx")).toContain(
      "LoaViet không giữ tiền và không bảo đảm giao dịch",
    );
    expect(scanText("src/components/seller-verification-form.tsx")).toContain(
      "không</b> phải bảo đảm sản phẩm hay chứng nhận giao dịch",
    );
  });
});

// ─── 2. §4.7 — không location-safety claim ───────────────────────────────────

/** Pattern location-safety (plan Task 2) — 0 hit, không allowlist. */
const LOCATION_SAFETY_PATTERNS: ReadonlyArray<RegExp> = [
  /khu vực an toàn/gi,
  /an toàn khu vực/gi,
  /chứng nhận an toàn/gi,
  /khu vực được bảo đảm/gi,
  /verified market/gi,
];

describe("§4.7 — không có location-safety claim (toàn bộ phạm vi glob, comments kể cả)", () => {
  it("0 hit — nhãn vận hành cho phép là 'Khu vực beta trọng điểm' (không match pattern)", () => {
    const hits: string[] = [];
    for (const f of GLOB_FILES) {
      for (const re of LOCATION_SAFETY_PATTERNS) {
        for (const m of read(f).matchAll(re)) hits.push(`${f}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// ─── 3. §6.2 — wording seller-verification trung tính ─────────────────────────

/** Câu trung tính cho phép (spec §6.2). */
const SELLER_VERIFICATION_NEUTRAL =
  "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet";

/** Ba câu avoid (spec §6.2) — 0 hit toàn phạm vi, không allowlist. */
const SELLER_VERIFICATION_AVOID_PATTERNS: ReadonlyArray<RegExp> = [
  /Người bán được LoaViet bảo đảm/gi,
  /Sản phẩm được LoaViet đảm bảo an toàn/gi,
  /Giao dịch được bảo vệ bởi LoaViet/gi,
];

describe("§6.2 — wording seller-verification là dạng trung tính", () => {
  it("các surface xác minh chứa câu trung tính (theo code — seller profile là badge công khai)", () => {
    for (const f of [
      "app/sell/verification/page.tsx",
      "src/components/seller-verification-form.tsx",
      "app/seller/[id]/page.tsx",
    ]) {
      expect(normalize(read(f)), f).toContain(SELLER_VERIFICATION_NEUTRAL);
    }
  });

  it("KHÔNG BAO GIỜ câu avoid §6.2 — 0 hit toàn phạm vi glob (comments kể cả)", () => {
    const hits: string[] = [];
    for (const f of GLOB_FILES) {
      for (const re of SELLER_VERIFICATION_AVOID_PATTERNS) {
        for (const m of read(f).matchAll(re)) hits.push(`${f}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("app/admin/seller-verification: hàng đợi ops review — không render claim §6.2 (lệch plan, theo code — xem report)", () => {
    // Plan Task 2 mong page admin chứa câu trung tính; code Batch 2 thực tế là
    // hàng đợi review ops (badge "Đã xác minh" = trạng thái email/phone, không
    // phải claim người bán). Theo code (hard rule "follow the code"); ghi nhận
    // trong report + re-verify sau Batch 7. Đảm bảo tối thiểu: không câu avoid.
    const text = read("app/admin/seller-verification/page.tsx");
    for (const re of SELLER_VERIFICATION_AVOID_PATTERNS) {
      expect(text.match(re)).toBeNull();
    }
  });
});

// ─── 4. §5.2/§6.4 — safety guidance render gần chat/deal flows ────────────────

/** Sáu điểm §6.4 (bản dịch tiếng Việt — khớp tests/unit/policy-registry.test.ts). */
const SAFETY_64_POINTS = [
  "Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.",
  "Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.",
  "Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.",
  "Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.",
  "Cẩn trọng với các đường link thanh toán đáng ngờ.",
  "Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.",
] as const;

/** Dòng §5.2 (spec "The UI must state" — bản dịch Batch 6). */
const SAFETY_52_LINE = "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.";

describe("§5.2/§6.4 — các dòng safety guidance còn + render gần chat/deal flows", () => {
  it("sáu điểm §6.4 + dòng §5.2 còn trong nội dung policy safety_guidance (Batch 8 Task 1)", () => {
    const body = policyContent("safety_guidance");
    for (const point of SAFETY_64_POINTS) {
      expect(body).toContain(point);
    }
    expect(body).toContain(SAFETY_52_LINE);
  });

  it("listing detail (surface deal-adjacent Batch 1) render hướng dẫn §6.4-adjacent", () => {
    // Surface deal-adjacent Batch 1 (CTA "Nhắn người bán" + hộp hướng dẫn +
    // disclaimer §5.2). Batch 6 Task 6b đã thêm SafetyGuidance trên chat page —
    // describe dưới pin riêng (merge fix Wave 0: bỏ nhánh early-execution).
    const text = normalize(read("app/listings/[slug]/page.tsx"));
    expect(text).toContain("Hẹn ở nơi công cộng");
    expect(text).toContain("kiểm tra và test loa kỹ trước khi trả tiền");
    expect(text).toContain("không chia sẻ OTP/mật khẩu");
    expect(text).toContain("cẩn trọng với link thanh toán lạ");
    expect(text).toContain("diễn ra độc lập ngoài LoaViet");
  });
});

/** Batch 6 Task 6 — component render §6.4 gần chat/deal (merge fix Wave 0: BẤT ĐIỀU KIỆN). */
const SAFETY_GUIDANCE_COMPONENT = "src/components/safety-guidance.tsx";
const CHAT_PAGE = "app/chat/[id]/page.tsx";

// Merge fix Wave 0: describe BẤT ĐIỀU KIỆN — component bị xoá thì read throw →
// test FAIL, KHÔNG skip silently. Component nằm trong scope walk (LIVE_FILES)
// tự động. Drift pin với src/content/policies/safety-guidance.ts: cả hai mang
// đúng SAFETY_64_POINTS / SAFETY_52_LINE (assert song song ở describe §4 và §5).
describe("Batch 6 safety-guidance component — §6.4 render gần chat/deal (merge fix: unconditional)", () => {
  it("chứa đủ sáu điểm §6.4 + dòng §5.2 (không promise language — scope walk tự quét)", () => {
    const text = normalize(read(SAFETY_GUIDANCE_COMPONENT));
    for (const point of SAFETY_64_POINTS) {
      expect(text).toContain(point);
    }
    expect(text).toContain(SAFETY_52_LINE);
  });

  it("app/chat/[id]/page.tsx import + render <SafetyGuidance> (Batch 6 Task 6b — mount gần chat)", () => {
    const page = read(CHAT_PAGE);
    expect(page).toContain('import { SafetyGuidance } from "@/src/components/safety-guidance"');
    expect(page).toContain("<SafetyGuidance");
  });
});

// ─── 5. Nội dung policy — không promise language ─────────────────────────────

describe("nội dung policy (src/content/policies) — không có promise language", () => {
  it("mọi POLICY_TEXT sạch pattern §4.2 (placeholder neutral — founder text phải sạch hoặc allowlist mở rộng có ghi nhận)", () => {
    const hits: string[] = [];
    for (const key of POLICY_KEYS) {
      const body = policyContent(key);
      for (const re of PROMISE_PATTERNS) {
        for (const m of body.matchAll(re)) hits.push(`policy ${key}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// ─── 6. Pin phân loại — loại trừ chỉ hợp lệ khi surface còn retire/dormant ───

describe("pin phân loại — loại trừ khỏi scan §4.2 phải còn hợp lệ", () => {
  it("mọi trang finance retire còn guard (financialFeaturesEnabled + notFound) — Batch 1", () => {
    for (const f of RETIRED_FINANCE_PAGES) {
      const src = read(f);
      expect(src, f).toContain("financialFeaturesEnabled");
      expect(src, f).toContain("notFound()");
    }
  });

  it("flow finance guard-throw còn assertFinancialFeaturesEnabled", () => {
    for (const f of DORMANT_FINANCE_FLOW_PAGES) {
      expect(read(f), f).toContain("assertFinancialFeaturesEnabled");
    }
  });

  it("component finance dormant KHÔNG được import từ bất kỳ file sống nào", () => {
    for (const c of DORMANT_FINANCE_COMPONENTS) {
      const specifier = `@/src/components/${c.replace(/^src\/components\//, "").replace(/\.tsx$/, "")}`;
      for (const f of LIVE_FILES) {
        expect(read(f), `${f} import ${specifier}`).not.toContain(specifier);
      }
    }
  });

  it("danh sách loại trừ không stale — mọi entry còn tồn tại trong glob", () => {
    for (const f of EXCLUDED_FROM_PROMISE_SCAN) {
      expect(GLOB_FILES, f).toContain(f);
    }
  });
});
