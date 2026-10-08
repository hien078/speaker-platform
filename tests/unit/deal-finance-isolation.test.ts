/**
 * Deal finance isolation — §9 Batch 6 Gate proof (Batch 6 plan Task 7; spec
 * §4.1 No Money Path, §4.10 No Finance Escape Hatch, §9 Gate "No Deal action
 * creates Payment / Payout / Wallet / Ledger / Escrow transaction"; Q7).
 *
 * Source-contract style của finance-public-surface.test.ts / deal-ui.test.ts:
 * đọc source như TEXT — không import module app nào, không db mock, không
 * jsdom. Contract test: plan Task 7 Step 1 cho phép pass ngay khi các surface
 * đã sạch (pass/fail per case được record trong verification doc Task 8);
 * violation là defect của file sở hữu, KHÔNG phải lý do đổi test.
 *
 * Hợp đồng (plan Task 7 Step 1 + corrections 2026-10-08 items 24/28 + note
 * parallelism Task 7 ∥ Task 6b — file này là owner duy nhất của Task 7):
 *
 *  1. SOURCE SCAN — mọi deal/chat surface của Batch 6: ZERO word-boundary
 *     occurrence của finance model/helper (Order/OrderItem/Payment/Payout/
 *     WithdrawRequest/LedgerEntry/Dispute/Cart/CartItem/Offer/ExchangeOffer/
 *     recordLedgerTx/escrowIn/escrowRelease/escrowRefund/computeCommission/
 *     generateOrderCode/assertFinancialFeaturesEnabled/
 *     assertMockPaymentsAllowed — KHÔNG có token Wallet vì Wallet không
 *     phải model (wallet.ts là helper trên LedgerEntry/WithdrawRequest —
 *     phủ qua import-graph denylist); \b chống FP-1/FP-2: orderBy/sortOrder/
 *     border/offers KHÔNG match. Scan cả comment (Task 8 rg scan cùng posture).
 *  2. RAW-SQL FORBID (S5) — cùng surface list: zero db.raw/db.sql/tx.sql/
 *     tx.execute/executeRaw/queryRaw/$queryRaw. Deal surface KHÔNG được dùng
 *     raw SQL chút nào — mạnh hơn scan table-name case-insensitive (raw SQL
 *     có thể chạm finance table dưới casing mà model-scan bỏ sót).
 *  3. IMPORT GRAPH — BFS từ mọi entry point deal/chat: KHÔNG node reachable
 *     nào là finance module (denylist 13 module Q7 — helpers.ts deny vì
 *     import financial-features + recordLedgerTx; utils.ts KHÔNG deny —
 *     computeCommission là pure function, formatVND/timeAgo/slugify được
 *     import hợp pháp; source scan vẫn cấm CALL REFERENCE computeCommission/
 *     generateOrderCode trong file Batch 6). Walker theo MỌI import form repo
 *     dùng (S5, corrections #28): static/type `from "…"`, dynamic
 *     `await import("…")` (route.ts notify), side-effect `import "…"`,
 *     re-export `export * from "…"` / `export {…} from "…"` (bare re-export
 *     chain có thể giấu finance module sau intermediary); resolve `@/` → repo
 *     root (tsconfig "@/*" → "./*"), relative → dirname, thử suffix
 *     .ts/.tsx//index.ts; bare specifier (next/*, server-only, react,
 *     lucide-react, zod, @prisma/*, node:*) = external — skip. Re-export +
 *     dynamic-import following được pin riêng (walker hỏng không được im
 *     lặng pass): observability-core.ts trong closure deals.ts CHỈ reachable
 *     qua re-export của observability.ts; notify.ts trong closure route.ts
 *     CHỈ reachable qua dynamic import.
 *  4. KHÔNG direct ProductEvent write (Q6) — emission chỉ qua emitProductEvent
 *     (Batch 5 core — fail-open, ghi qua db NGOÀI tx của action).
 *  5. KHÔNG AuditEvent write từ Deal action (Q6/D7) — DealStatusHistory là
 *     user-action record; audit log bảo mật là privileged-actor domain (§4.6).
 *  6. Dormant finance conversation-creator (Batch 1 boundary — corrections
 *     #28): đúng HAI site Conversation.create trong src/ + app/ (chat.ts +
 *     exchange.ts), CẢ HAI giữ guard — exchange.ts finance-guarded TRƯỚC
 *     create, chat.ts giữ Batch 3 actor guard + D1 approved-only + D2
 *     seller-side eligibility TRƯỚC create.
 *
 * Surface Task 6b (parallelism note): src/components/deal-*.tsx chưa có ở
 * tree này — scan qua GLOB /^deal-.+\.tsx$/ tự pick up khi 6b merge; hai trang
 * app/chat/[id]/page.tsx + app/listings/[slug]/page.tsx (6b mount panel/forms
 * + CTA) đã tồn tại và được scan cả source lẫn import graph từ nay.
 *
 * (corrections #24 — scan append-only DealStatusHistory — sống ở
 * tests/unit/deal-domain.test.ts §8; file này KHÔNG duplicate.)
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const abs = (p: string) => join(root, p);
const rel = (f: string) => relative(root, f);
const read = (p: string) => readFileSync(abs(p), "utf8");

// ─── Surface list — mọi deal/chat surface của Batch 6 ────────────────────────

/** Fixed surfaces — PHẢI tồn tại (thiếu = proof quét hụt surface thật). */
const FIXED_SURFACES = [
  "src/lib/actions/deals.ts",
  "src/lib/deal.ts",
  "src/lib/deal-vocab.ts",
  "src/lib/actions/chat.ts",
  "src/lib/actions/wishlist.ts",
  "app/api/chat/[id]/route.ts",
  "src/components/safety-guidance.tsx",
  // Task 6b surfaces (corrections #28 — BFS verified từ các file này):
  "app/chat/[id]/page.tsx",
  "app/listings/[slug]/page.tsx",
] as const;

/**
 * Glob Task 6b — deal-panel/deal-create-form/deal-outcome-form
 * (src/components/deal-*.tsx). Tree này chưa merge 6b → list rỗng là OK;
 * scan tự pick up khi 6b merge (Task 7 ∥ Task 6b, file-disjoint).
 */
const dealComponentFiles = (): string[] =>
  readdirSync(abs("src/components"), { withFileTypes: true })
    .filter((e) => e.isFile() && /^deal-.+\.tsx$/.test(e.name))
    .map((e) => `src/components/${e.name}`);

/** Mọi surface cần source-scan (fixed + glob 6b). */
const surfaces = (): string[] => [...FIXED_SURFACES, ...dealComponentFiles()];

// ─── Finance vocabulary (Q7) — word boundary, FP-1/FP-2 lesson ───────────────

/**
 * Finance model + helper — word boundary (\b) để orderBy/sortOrder/border/
 * offers KHÔNG false-positive (Batch 0 inventory FP-1/FP-2). Token list =
 * plan Task 7 verbatim (19 token) — Wallet KHÔNG có token vì không phải
 * model (phủ qua import-graph denylist src/lib/wallet.ts).
 */
const FINANCE_TOKENS =
  /\b(?:Order|OrderItem|Payment|Payout|WithdrawRequest|LedgerEntry|Dispute|Cart|CartItem|Offer|ExchangeOffer|recordLedgerTx|escrowIn|escrowRelease|escrowRefund|computeCommission|generateOrderCode|assertFinancialFeaturesEnabled|assertMockPaymentsAllowed)\b/g;

/** Raw SQL (S5) — deal surface KHÔNG được dùng raw SQL chút nào. */
const RAW_SQL_TOKENS = /db\.raw|db\.sql|tx\.sql|tx\.execute|executeRaw|queryRaw|\$queryRaw/g;

/** Mọi match của re trong src (matchAll — không đụng lastIndex của regex dùng chung). */
const scanAll = (src: string, re: RegExp): string[] =>
  [...src.matchAll(re)].map((m) => m[0] as string);

// ─── Import graph walker (S5/corrections #28 — mọi import form repo dùng) ─────

/**
 * Strip comment trước khi extract import — comment nhắc ĐƯỜNG DẪN finance
 * module (admin-mfa.ts nhắc helpers.ts, verification-delivery.ts nhắc
 * financial-features.ts) không được tạo edge giả. Thuật toán comment-strip
 * của audit-append.test.ts §6 / deal-domain.test.ts §8.
 */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, " ");

/**
 * Mọi import specifier của một file: static/type import + re-export
 * (`from "…"` — gồm `export * from` / `export {…} from`), side-effect
 * (`import "…"`), dynamic (`await import("…")` / `import("…")`).
 * Guard `(?:^|[^\w$.])` — chặn property access `.from(` và identifier suffix.
 */
const importSpecifiersOf = (text: string): string[] => {
  const src = stripComments(text);
  const specs: string[] = [];
  for (const m of src.matchAll(/(?:^|[^\w$.])from\s*["']([^"']+)["']/g)) specs.push(m[1] as string);
  for (const m of src.matchAll(/(?:^|[^\w$.])import\s*["']([^"']+)["']/g)) specs.push(m[1] as string);
  for (const m of src.matchAll(/(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g))
    specs.push(m[1] as string);
  return specs;
};

/**
 * Resolve specifier → file tuyệt đối; null = external KHÔNG follow (bare
 * specifier: next/*, server-only, react, lucide-react, zod, @prisma/*,
 * node:* — finance module trong repo luôn import qua `@/src/…` hoặc relative
 * nên skip bare là đủ và không sót denylist).
 */
const resolveSpecifier = (spec: string, fromFile: string): string | null => {
  if (!spec.startsWith("@/") && !spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = spec.startsWith("@/")
    ? join(root, spec.slice(2)) // tsconfig paths: "@/*" → "./*"
    : resolvePath(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

const ENTRY_SENTINEL = "<entry>";

type ImportWalk = {
  visited: Set<string>;
  parent: Map<string, string>;
};

/** BFS import graph từ các entry (repo-relative) — visited set chống vòng. */
const walkImports = (entries: string[]): ImportWalk => {
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const e of entries) {
    const a = abs(e);
    if (visited.has(a)) continue;
    visited.add(a);
    parent.set(a, ENTRY_SENTINEL);
    queue.push(a);
  }
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of importSpecifiersOf(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved === null || visited.has(resolved)) continue;
      visited.add(resolved);
      parent.set(resolved, file);
      queue.push(resolved);
    }
  }
  return { visited, parent };
};

/** Chuỗi import dẫn tới file (thông điệp fail: entry → … → finance module). */
const chainOf = (file: string, parent: Map<string, string>): string => {
  const links: string[] = [];
  let cur: string | undefined = file;
  while (cur !== undefined && cur !== ENTRY_SENTINEL) {
    links.unshift(rel(cur));
    cur = parent.get(cur);
  }
  return links.join(" → ");
};

// ─── Finance denylist (Q7) + entry points của import graph ───────────────────

/**
 * Finance module denylist — plan Task 7 verbatim (13 module). helpers.ts bị
 * deny vì import financial-features + recordLedgerTx; utils.ts KHÔNG bị deny
 * (computeCommission pure function, formatVND/timeAgo/slugify import hợp pháp
 * — source scan vẫn cấm CALL REFERENCE trong file Batch 6).
 */
const FINANCE_MODULES = [
  "src/lib/escrow.ts",
  "src/lib/ledger.ts",
  "src/lib/wallet.ts",
  "src/lib/momo.ts",
  "src/lib/mock-payment.ts",
  "src/lib/financial-features.ts",
  "src/lib/actions/orders.ts",
  "src/lib/actions/offers.ts",
  "src/lib/actions/exchange.ts",
  "src/lib/actions/cart.ts",
  "src/lib/actions/withdraw.ts",
  "src/lib/actions/helpers.ts",
  "src/lib/actions/reviews.ts",
] as const;

/**
 * Entry points của import graph (plan Task 7: deals/chat/wishlist/route + bốn
 * component — safety-guidance fixed, deal-* qua glob; + hai trang Task 6b,
 * corrections #28). 6b merge → glob thêm panel/forms; trang hội thoại cũng
 * import chúng nên được phủ kép.
 */
const importEntries = (): string[] => [
  "src/lib/actions/deals.ts",
  "src/lib/actions/chat.ts",
  "src/lib/actions/wishlist.ts",
  "app/api/chat/[id]/route.ts",
  "src/components/safety-guidance.tsx",
  "app/chat/[id]/page.tsx",
  "app/listings/[slug]/page.tsx",
  ...dealComponentFiles(),
];

// ─── Source enumeration (src/ + app/ — thuật toán audit-append.test.ts §6) ────

/** Mọi file .ts/.tsx dưới src/ + app/ (đệ quy). */
const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) out.push(p);
    }
  };
  walk(join(root, "src"));
  walk(join(root, "app"));
  return out;
};

/** Slice thân hàm từ tên (đến `export async function` kế tiếp) — assert guard TRONG đúng hàm. */
const functionSlice = (src: string, fnName: string): string => {
  const start = src.indexOf(fnName);
  expect(start, `phải tìm thấy ${fnName} trong source`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("export async function", start + fnName.length);
  return src.slice(start, next === -1 ? undefined : next);
};

// ─── 1. Source scan — finance vocabulary + raw SQL ────────────────────────────

describe("(Task 7) source scan — finance vocabulary + raw SQL trên mọi deal/chat surface", () => {
  it("mọi fixed surface TỒN TẠI (glob deal-* có thể rỗng trước khi 6b merge)", () => {
    for (const p of FIXED_SURFACES) {
      expect(existsSync(abs(p)), `surface phải tồn tại: ${p}`).toBe(true);
    }
  });

  it("ZERO word-boundary finance model/helper (Q7 — FP-1/FP-2: \\b chống orderBy/sortOrder/border FP)", () => {
    const offenders: string[] = [];
    for (const p of surfaces()) {
      for (const m of scanAll(read(p), FINANCE_TOKENS)) {
        offenders.push(`${p} :: ${m}`);
      }
    }
    expect(
      offenders,
      "§9 Batch 6 Gate — surface deal/chat KHÔNG được nhắc finance model/helper (kể cả comment)",
    ).toEqual([]);
  });

  it("ZERO raw SQL (S5) — db.raw/db.sql/tx.sql/tx.execute/executeRaw/queryRaw/$queryRaw", () => {
    const offenders: string[] = [];
    for (const p of surfaces()) {
      for (const m of scanAll(read(p), RAW_SQL_TOKENS)) {
        offenders.push(`${p} :: ${m}`);
      }
    }
    expect(offenders, "deal surface KHÔNG được dùng raw SQL chút nào (S5)").toEqual([]);
  });
});

// ─── 2. Import graph — BFS từ mọi entry point deal/chat (Q7) ──────────────────

describe("(Task 7) import graph — BFS từ mọi entry point deal/chat (Q7)", () => {
  it("denylist finance module TỒN TẠI (rename finance module → denylist phải được cập nhật)", () => {
    for (const p of FINANCE_MODULES) {
      expect(existsSync(abs(p)), `denylist trỏ file không tồn tại: ${p}`).toBe(true);
    }
  });

  it("walker sanity — resolve được import THẬT (walk hỏng không được im lặng pass)", () => {
    const walk = walkImports(importEntries());
    expect(walk.visited.size, "phải enumerate được node import").toBeGreaterThan(10);
    expect(walk.visited.has(abs("src/prisma/db.client.ts"))).toBe(true);
    expect(walk.visited.has(abs("src/lib/moderation.ts"))).toBe(true);
    expect(walk.visited.has(abs("src/lib/auth.ts"))).toBe(true);
  });

  it("re-export following — observability-core.ts trong closure deals.ts CHỈ reachable qua `export {…} from` của observability.ts", () => {
    // deals.ts import observability (KHÔNG import observability-core trực tiếp);
    // trong closure deals.ts, rbac/admin-mfa KHÔNG reachable (admin-mfa là
    // importer trực tiếp duy nhất còn lại) → node này chỉ đến được qua re-export
    // — bare re-export chain không thể giấu finance module sau intermediary.
    const walk = walkImports(["src/lib/actions/deals.ts"]);
    expect(walk.visited.has(abs("src/lib/observability-core.ts"))).toBe(true);
  });

  it("dynamic-import following — notify.ts trong closure route.ts CHỈ reachable qua `await import(…)` (corrections #28)", () => {
    // route.ts KHÔNG import notify tĩnh — chỉ `const { notify } = await
    // import("@/src/lib/notify")` (route.ts:224); walker phải parse dynamic
    // import nếu không notify bị bỏ sót khỏi graph.
    const walk = walkImports(["app/api/chat/[id]/route.ts"]);
    expect(walk.visited.has(abs("src/lib/notify.ts"))).toBe(true);
  });

  it("KHÔNG finance module nào reachable từ bất kỳ entry (§9 Gate — import graph)", () => {
    const walk = walkImports(importEntries());
    const financeAbs = new Set(FINANCE_MODULES.map((p) => abs(p)));
    const hits: string[] = [];
    for (const f of walk.visited) {
      if (financeAbs.has(f)) hits.push(chainOf(f, walk.parent));
    }
    expect(hits, "finance module reachable qua import graph từ surface deal/chat").toEqual([]);
  });
});

// ─── 3. Q6 — emission chỉ qua emitProductEvent; Deal action KHÔNG ghi AuditEvent ──

describe("(Task 7) Q6 — emission chỉ qua emitProductEvent; Deal action KHÔNG ghi AuditEvent", () => {
  it("ZERO direct ProductEvent write (ProductEvent.create/update/delete/updateAll/deleteAll)", () => {
    const offenders: string[] = [];
    for (const p of surfaces()) {
      for (const m of scanAll(read(p), /ProductEvent\.(?:create|update|delete|updateAll|deleteAll)/g)) {
        offenders.push(`${p} :: ${m}`);
      }
    }
    expect(
      offenders,
      "emission chỉ qua emitProductEvent (Batch 5 core — fail-open, ghi qua db NGOÀI tx của action)",
    ).toEqual([]);
  });

  it("ZERO auditEvent/AuditEvent reference trong src/lib/actions/deals.ts (D7 — DealStatusHistory là user-action record)", () => {
    const src = read("src/lib/actions/deals.ts");
    expect(scanAll(src, /auditEvent|AuditEvent/g)).toEqual([]);
  });
});

// ─── 4. Conversation.create — đúng HAI site, cả hai giữ guard (S5 + Batch 1) ───

describe("(Task 7) Conversation.create — đúng HAI site, cả hai giữ guard (S5 + Batch 1 boundary)", () => {
  it("đúng HAI site Conversation.create trong src/ + app/ (strip comment): chat.ts + exchange.ts", () => {
    const files = sourceFiles();
    // sanity: enumeration hỏng không được im lặng pass (audit-append pattern)
    expect(files.length, "phải enumerate được source files").toBeGreaterThan(100);
    const sites: string[] = [];
    for (const f of files) {
      // strip comment — chat.ts:79 + telemetry-recorders.ts:161 là comment, không phải site
      if (stripComments(readFileSync(f, "utf8")).includes("Conversation.create")) {
        sites.push(rel(f));
      }
    }
    expect(sites.sort(), "site tạo Conversation thứ ba = đường chat mới chưa review guard").toEqual([
      "src/lib/actions/chat.ts",
      "src/lib/actions/exchange.ts",
    ]);
  });

  it("chat.ts — startConversationAction giữ Batch 3 actor guard + D1 approved-only + D2 seller-side TRƯỚC Conversation.create", () => {
    const fn = functionSlice(read("src/lib/actions/chat.ts"), "startConversationAction");
    const createIdx = fn.indexOf("Conversation.create");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    const b3ActorGuard = fn.indexOf("assertCanStartConversation(");
    const d1ApprovedOnly = fn.indexOf('listing.status !== "approved"');
    const d2SellerSide = fn.indexOf("assertListingSellerInteractable(");
    expect(b3ActorGuard, "Batch 3 actor guard (block hai hướng + suspension) phải có").toBeGreaterThanOrEqual(0);
    expect(d1ApprovedOnly, "D1 approved-only gate phải có").toBeGreaterThanOrEqual(0);
    expect(d2SellerSide, "D2 seller-side eligibility (§7.8) phải có").toBeGreaterThanOrEqual(0);
    expect(b3ActorGuard).toBeLessThan(createIdx);
    expect(d1ApprovedOnly).toBeLessThan(createIdx);
    expect(d2SellerSide).toBeLessThan(createIdx);
  });

  // B7 Task 6 (corrections #31 — additive): buyer-side guard §2.1 ngồi GIỮA
  // D2 seller-side và Conversation.create (T4/C1 order), KHÔNG đụng emission
  // (recordConversationStarted SAU create) hay redirect branch.
  it("chat.ts — B7 buyer-side guard (assertBuyerBetaChatAccess) SAU D2, TRƯỚC Conversation.create + emission", () => {
    const fn = functionSlice(read("src/lib/actions/chat.ts"), "startConversationAction");
    const createIdx = fn.indexOf("Conversation.create");
    const d2SellerSide = fn.indexOf("assertListingSellerInteractable(");
    const b7BuyerSide = fn.indexOf("assertBuyerBetaChatAccess(");
    const emitIdx = fn.indexOf("recordConversationStarted(");
    expect(b7BuyerSide, "B7 buyer-side guard (§2.1) phải có").toBeGreaterThanOrEqual(0);
    expect(d2SellerSide).toBeLessThan(b7BuyerSide); // Batch 6 D2 TRƯỚC Batch 7
    expect(b7BuyerSide).toBeLessThan(createIdx); // TRƯỚC create — KHÔNG tạo row
    expect(createIdx).toBeLessThan(emitIdx); // emission SAU create thành công
  });

  it("exchange.ts — createExchangeOfferAction vẫn finance-guarded TRƯỚC Conversation.create (dormant, Batch 1 boundary)", () => {
    const fn = functionSlice(read("src/lib/actions/exchange.ts"), "createExchangeOfferAction");
    const createIdx = fn.indexOf("Conversation.create");
    const guardIdx = fn.indexOf("assertFinancialFeaturesEnabled()");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx, "guard finance của Batch 1 phải còn (KHÔNG bị Batch 6 gỡ)").toBeGreaterThanOrEqual(0);
    // guard TRƯỚC create VÀ TRƯỚC mọi read (requireUser/session — Batch 1 posture)
    expect(guardIdx).toBeLessThan(createIdx);
    expect(guardIdx).toBeLessThan(fn.indexOf("await requireUser()"));
  });
});
