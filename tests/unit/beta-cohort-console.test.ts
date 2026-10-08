/**
 * Founding seller console (Batch 7 plan Task 5 — spec §5.10/§5.10.1/§12.1/§12.3,
 * §4.5/§4.8/§4.9/§4.11/§7.6; corrections 2026-10-08 items 19/27/28/29/33/37 + P2).
 *
 * Hợp đồng (plan Task 5 Step 1 — source-contract style của
 * finance-public-surface.test.ts + pure-logic trên view-model helpers):
 *
 *  1. Page /admin/beta-cohort: requireCapability("beta_cohort.manage") TRƯỚC
 *     db read đầu tiên (super/ops — ma trận §5.4.1; moderator/support/analyst
 *     fail closed ở ACTION level, pin bởi test Task 4); force-dynamic;
 *     server component (KHÔNG "use client").
 *  2. S5 — KHÔNG write trong render: page KHÔNG gọi syncFoundingSellerFunnel,
 *     KHÔNG .update(/.updateAll(/.create(/.delete( — mọi mutation là action
 *     Task 3/4 posted bởi form; page render STORED status BÊSIDE live reads.
 *  3. §5.10 display list: total candidates / invited / registered (summary),
 *     verification state (checkSellerPublicationRequirements.missing +
 *     SellerVerification.status), first-listing state (firstListingAt +
 *     approvedListingCountOf), quality listing count (stored field — A3),
 *     last seller activity (lastContactAt + latest listing updatedAt),
 *     needs-assistance (candidateNeedsAssistance — D2), assigned operator,
 *     onboarding notes — mỗi mục có mặt trong source page/console.
 *  4. PII minimization (§4.8/§7.6 — Review Focus 4): contactReference render
 *     MASKED qua maskContact — behavioral: element tree chứa mask, KHÔNG
 *     chứa raw; KHÔNG có reveal/unmask/pii.view_sensitive (A2 fail closed).
 *  5. Token secrecy (Review Focus 1): console KHÔNG render inviteUrl/token;
 *     inviteUrl chỉ xuất hiện trong response state MỘT LẦN của form mời
 *     (founding-seller-forms.tsx); form KHÔNG mang token (S1).
 *  6. Supply readiness (§12.1): targets "20–50"/"100–300" là DISPLAY STRING
 *     (helper thuần), KHÔNG có code path chặn theo count (source: no
 *     `if (count >= 20)`); quality count render kèm caveat pending-definition
 *     (A3) — "tin đã duyệt" (factual) ≠ "tin chất lượng (ops sample)" (ops-set).
 *  7. Concierge (§5.10.1): copy trách nhiệm — operations hỗ trợ được gì,
 *     KHÔNG tự ý tạo thông tin thay người bán (corrections #33), người bán
 *     chịu trách nhiệm gì; KHÔNG copy hứa hẹn/incentive (§4.2/§4.11).
 *  8. Membership read-only: console render BetaCohortMembership status của
 *     linked user + link /admin/users?u=<id> (corrections #27 — KHÔNG ?q=);
 *     KHÔNG import setBetaMembershipAction (không có surface mutation thứ hai
 *     — Batch 2 sở hữu; corrections #19 chỉ thêm form buyer vào CHÍNH trang
 *     users của Batch 2).
 *  9. Nav (corrections #28): href "/admin/beta-cohort" + capability
 *     "beta_cohort.manage" trong NAV; filter vẫn caps.includes(item.capability).
 * 10. Users page (corrections #19/#27 + P2): ?u= exact filter (where({ id }) —
 *     KHÔNG ilike); cột + form grant/suspend private_beta_buyer reuse
 *     setBetaMembershipAction (gate canManageCohort); link Beta cohort per
 *     user → /admin/beta-cohort?userId=<id>; MỌI column/form hiện có còn
 *     nguyên (additive); KHÔNG email/phone trong URL mới.
 * 11. Audit filter (corrections #29): ACTION_PREFIXES + founding_seller +
 *     beta_cohort (additive — prefix cũ còn nguyên).
 * 12. B2 hygiene: forms "use client" + useActionState + dispatch thủ công
 *     (React 19 form reset — giữ input qua error); console server component;
 *     KHÔNG dangerouslySetInnerHTML (notes là ops free text — React text only).
 * 13. Copy-safety (corrections #33 — copy-safety.test.ts arrives with early
 *     Batch 8): console + forms KHÔNG chứa đảm bảo/bảo đảm/bảo hiểm/bảo vệ
 *     (thanh toán|giao dịch)/giữ tiền hộ/escrow/guarantee/insurance/thưởng/
 *     incentive — KỂ CẢ trailing comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Source-contract helpers (readFileSync — không mock) ──────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const PAGE = "app/admin/beta-cohort/page.tsx";
const CONSOLE = "src/components/founding-seller-console.tsx";
const FORMS = "src/components/founding-seller-forms.tsx";
const LAYOUT = "app/admin/layout.tsx";
const USERS_PAGE = "app/admin/users/page.tsx";
const AUDIT_PAGE = "app/admin/audit/page.tsx";
const ACTIONS = "src/lib/actions/founding-sellers.ts";

/**
 * Regex copy-safety (corrections #33 + plan Task 5 "no guarantee/incentive
 * language") — quét cả trailing comment (copy-safety chỉ strip whole-line
 * comment nên mọi occurrence đều phải sạch).
 */
const FORBIDDEN_COPY_RE =
  /đảm bảo|bảo đảm|bảo hiểm|bảo vệ thanh toán|bảo vệ giao dịch|giữ tiền hộ|escrow|guarantee|insurance|thưởng|incentive/i;

// ─── Canonical stubbing recipe (cho phần import — Batch 3/6) ───────────────────

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

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
    has: () => false,
    getAll: () => [],
  })),
}));

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

type Row = Record<string, unknown>;
type Pred = ((proxy: unknown) => unknown) | Row;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  sessions: [] as Row[],
  candidates: [] as Row[],
  tokens: [] as Row[],
  memberships: [] as Row[],
  verifications: [] as Row[],
  listings: [] as Row[],
  audits: [] as Row[],
}));

vi.mock("@/src/prisma/db.client", () => {
  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          gt: (v: unknown) => (row[field] as number) > (v as number),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[]) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      include: () => query(preds),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        return rows.find((r) => all.every((p) => matches(r, p))) ?? null;
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { id: `row-${rows.length + 1}`, ...data };
        rows.push(row);
        return { ...row };
      },
      aggregate: async (fn: (a: { count: () => number }) => Row) =>
        fn({ count: () => rows.filter((r) => preds.every((p) => matches(r, p))).length }),
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
      aggregate: (fn: (a: { count: () => number }) => Row) => query([]).aggregate(fn),
    };
  };

  const models = {
    User: makeModel(dbState.users),
    UserSession: makeModel(dbState.sessions),
    FoundingSellerCandidate: makeModel(dbState.candidates),
    BetaInviteToken: makeModel(dbState.tokens),
    BetaCohortMembership: makeModel(dbState.memberships),
    SellerVerification: makeModel(dbState.verifications),
    Listing: makeModel(dbState.listings),
    AuditEvent: makeModel(dbState.audits),
  };
  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import {
  FoundingSellerConsole,
  buildSupplyReadinessView,
  summarizeCandidates,
  type CandidateRowView,
  type OperatorOption,
} from "@/src/components/founding-seller-console";
import { InviteIssueForm } from "@/src/components/founding-seller-forms";
import {
  assignCandidateOperatorAction,
  recordCandidateContactAction,
  revokeInviteAction,
  syncCandidateFunnelAction,
  updateQualityListingCountAction,
  updateCandidateStatusAction,
} from "@/src/lib/actions/founding-sellers";

// ─── React element-tree helpers (wishlist-page/sell-pages pattern) ─────────────

type ElementLike = { type?: unknown; props?: Record<string, unknown> | null };

/** Toàn bộ text host-level trong tree (component KHÔNG gọi — chỉ text inline). */
function textOf(node: unknown): string {
  const parts: string[] = [];
  const collect = (n: unknown): void => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (typeof n === "object" && n !== null) {
      collect((n as ElementLike).props?.["children"]);
    }
  };
  collect(node);
  return parts.join(" ");
}

/** Props của MỌI element có type === component cho trước. */
function elementsOf(node: unknown, type: unknown): Row[] {
  const out: Row[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const el = n as ElementLike;
    if (el.type === type) out.push((el.props ?? {}) as Row);
    walk(el.props?.["children"]);
  };
  walk(node);
  return out;
}

/** Mọi <form> host element trong tree (action prop = server action reference). */
function formsOf(node: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const el = n as ElementLike;
    if (el.type === "form") out.push((el.props ?? {}) as Record<string, unknown>);
    walk(el.props?.["children"]);
  };
  walk(node);
  return out;
}

// ─── Fixtures console (view model — page tính từ live reads, đây là shape) ────

const NOW = "2026-10-08T00:00:00.000Z";

const ROW_LINKED: CandidateRowView = {
  id: "cand-1",
  contactChannel: "email",
  contactReference: "lienhe@example.com",
  source: "giới thiệu bởi cộng đồng loa",
  targetCommunity: "ha-noi",
  status: "registered",
  invitedAt: NOW,
  registeredAt: NOW,
  verifiedAt: null,
  firstListingAt: null,
  qualityListingCount: 0,
  lastContactAt: null, // chưa từng liên hệ → needsAssistance true (D2)
  notes: "Ghi chú ops mẫu — React text only",
  assignedOperatorId: null,
  assignedOperatorName: null,
  userId: "user-9",
  linkedUserName: "Seller Mới",
  membershipStatus: "active",
  verificationStatus: "pending",
  publicationMissing: ["xác minh số điện thoại", "được operations review xác minh"],
  approvedListingCount: 0,
  lastListingUpdatedAt: null,
  needsAssistance: true,
  activeTokenId: null,
};

const ROW_PROSPECT: CandidateRowView = {
  id: "cand-2",
  contactChannel: "phone",
  contactReference: "0901234567",
  source: "tuyển qua nhóm cộng đồng",
  targetCommunity: "ho-chi-minh",
  status: "prospect",
  invitedAt: null,
  registeredAt: null,
  verifiedAt: null,
  firstListingAt: null,
  qualityListingCount: 0,
  lastContactAt: null,
  notes: null,
  assignedOperatorId: "admin-ops",
  assignedOperatorName: "Ops",
  userId: null,
  linkedUserName: null,
  membershipStatus: null,
  verificationStatus: null,
  publicationMissing: [],
  approvedListingCount: 0,
  lastListingUpdatedAt: null,
  needsAssistance: false,
  activeTokenId: "token-9",
};

const OPERATORS: readonly OperatorOption[] = [{ id: "admin-ops", name: "Ops" }];

// ══════════════════════════════════════════════════════════════════════════════
// 1. Source contract — app/admin/beta-cohort/page.tsx
// ══════════════════════════════════════════════════════════════════════════════

describe("source contract — app/admin/beta-cohort/page.tsx (guard + S5 + §5.10 reads)", () => {
  it("requireCapability(beta_cohort.manage) TRƯỚC db read đầu tiên (spec §4.5/§4.9)", () => {
    const src = read(PAGE);
    const guardIdx = src.indexOf('await requireCapability("beta_cohort.manage")');
    const firstDbIdx = src.indexOf("db.orm.");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(firstDbIdx, "page phải đọc db (console live reads)").toBeGreaterThanOrEqual(0);
    expect(firstDbIdx).toBeGreaterThan(guardIdx);
  });

  it("force-dynamic + server component (KHÔNG use client)", () => {
    const src = read(PAGE);
    expect(src).toContain('export const dynamic = "force-dynamic"');
    expect(src).not.toContain('"use client"');
  });

  it("S5 — KHÔNG write trong render: không sync, không update/create/delete", () => {
    const src = read(PAGE);
    // funnel sync CHỈ qua syncCandidateFunnelAction (posted form — Task 4)
    expect(src).not.toContain("syncFoundingSellerFunnel");
    // page chỉ đọc — mọi mutation là action Task 3/4 posted bởi form
    expect(src).not.toMatch(/\.(update|updateAll|create|delete|deleteAll)\(/);
  });

  it("searchParams.userId filter — link target từ /admin/users (plan Task 5)", () => {
    const src = read(PAGE);
    expect(src).toContain("searchParams");
    expect(src).toMatch(/userId\?: string/);
    expect(src).toContain("where({ userId: userIdFilter })");
  });

  it("live reads §5.10 — publication requirements + approved count + assistance + relations", () => {
    const src = read(PAGE);
    // verification state (per-candidate) — Batch 2 policy, live
    expect(src).toContain("checkSellerPublicationRequirements(");
    // first-listing state + factual count (KHÔNG quality — A3)
    expect(src).toContain("approvedListingCountOf(");
    // needs-assistance flag (D2 heuristic — Task 2)
    expect(src).toContain("candidateNeedsAssistance(");
    // verification status + linked membership (read-only) + active token (revoke form)
    expect(src).toContain("SellerVerification");
    expect(src).toContain("BetaCohortMembership");
    expect(src).toContain("BetaInviteToken");
    // last seller activity — latest listing updatedAt
    expect(src).toContain("Listing");
    expect(src).toContain("updatedAt");
  });

  it("render summary + supply readiness + concierge + forms (§5.10/§12.1/§5.10.1)", () => {
    const src = read(PAGE);
    expect(src).toContain("summarizeCandidates(");
    expect(src).toContain("buildSupplyReadinessView(");
    expect(src).toContain("FoundingSellerConsole");
    expect(src).toContain("CandidateCreateForm");
    // activation metrics ở /admin/analytics (Batch 5) — link, KHÔNG duplicate
    expect(src).toContain('"/admin/analytics"');
    // supply targets render từ helper (display strings)
    expect(src).toContain("targetInvited");
    expect(src).toContain("targetListings");
  });

  it("concierge card §5.10.1 — trách nhiệm split, KHÔNG tự ý tạo thông tin (corrections #33)", () => {
    const src = read(PAGE);
    expect(src).toContain("tự ý tạo thông tin thay người bán");
    // operations assist: model selection/structured fields/photo checklist/formatting/migration
    expect(src).toContain("chọn model");
    expect(src).toContain("checklist ảnh");
    // seller retains: price/condition/defects/repair history/ownership/product claims/publication consent
    expect(src).toContain("giá hỏi");
    expect(src).toContain("tình trạng");
    expect(src).toContain("đồng ý đăng tin");
  });

  it("copy-safety — KHÔNG promise/incentive language (§4.2/§4.11, corrections #33)", () => {
    expect(read(PAGE)).not.toMatch(FORBIDDEN_COPY_RE);
  });

  it("KHÔNG dangerouslySetInnerHTML + KHÔNG import setBetaMembershipAction + KHÔNG inviteUrl", () => {
    const src = read(PAGE);
    expect(src).not.toContain("dangerouslySetInnerHTML");
    // membership mutation là của Batch 2 trên /admin/users — console chỉ read + link
    expect(src).not.toContain("setBetaMembershipAction");
    // token/URL mời KHÔNG render ở page (Review Focus 1)
    expect(src).not.toContain("inviteUrl");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Source contract — src/components/founding-seller-console.tsx
// ══════════════════════════════════════════════════════════════════════════════

describe("source contract — src/components/founding-seller-console.tsx (table + plain forms)", () => {
  it("server component — KHÔNG use client (plain form action posts)", () => {
    const src = read(CONSOLE);
    expect(src).not.toContain('"use client"');
  });

  it("gọi maskContact cho contact (§4.8/§7.6) — KHÔNG render thô", () => {
    const src = read(CONSOLE);
    expect(src).toContain("maskContact(");
  });

  it("render §5.10 row: status badge + milestones + verification + listing + activity + operator + notes", () => {
    const src = read(CONSOLE);
    // status từ STORED field + badge (Task 4 constants) + labels (Task 2 vocab)
    expect(src).toContain("FOUNDING_SELLER_STATUS_LABELS");
    expect(src).toContain("FOUNDING_SELLER_STATUS_BADGE");
    // milestones §5.10
    expect(src).toContain("invitedAt");
    expect(src).toContain("registeredAt");
    expect(src).toContain("verifiedAt");
    expect(src).toContain("firstListingAt");
    // verification state + linked membership (read-only)
    expect(src).toContain("verificationStatus");
    expect(src).toContain("membershipStatus");
    expect(src).toContain("publicationMissing");
    // listing counts — factual ≠ ops sample (A3)
    expect(src).toContain("approvedListingCount");
    expect(src).toContain("qualityListingCount");
    expect(src).toContain("tin đã duyệt");
    expect(src).toContain("ops sample");
    // last seller activity
    expect(src).toContain("lastContactAt");
    expect(src).toContain("lastListingUpdatedAt");
    // needs-assistance (D2) + assigned operator + notes (React text)
    expect(src).toContain("needsAssistance");
    expect(src).toContain("Cần hỗ trợ");
    expect(src).toContain("assignedOperatorName");
    expect(src).toContain("notes");
    // community display qua PROVINCE_CODES (FD-1 — Batch 2 registry)
    expect(src).toContain("PROVINCE_CODES");
  });

  it("mọi form action Task 3/4 có mặt (revoke/sync/transition/assign/contact/quality)", () => {
    const src = read(CONSOLE);
    expect(src).toContain("revokeInviteAction");
    expect(src).toContain("syncCandidateFunnelAction");
    expect(src).toContain("updateCandidateStatusAction");
    expect(src).toContain("assignCandidateOperatorAction");
    expect(src).toContain("recordCandidateContactAction");
    expect(src).toContain("updateQualityListingCountAction");
    // manual transition: reason select từ vocabulary + toStatus select từ MANUALLY_SETTABLE
    expect(src).toContain("FOUNDING_SELLER_TRANSITION_REASONS");
    expect(src).toContain("MANUALLY_SETTABLE_STATUSES");
    // client forms (useActionState) — invite + notes
    expect(src).toContain("InviteIssueForm");
    expect(src).toContain("CandidateNotesForm");
  });

  it("link /admin/users?u=<id> cho grant/suspend (corrections #27 — KHÔNG ?q=)", () => {
    const src = read(CONSOLE);
    expect(src).toMatch(/\/admin\/users\?u=/);
    expect(src).not.toMatch(/\/admin\/users\?q=/);
  });

  it("KHÔNG setBetaMembershipAction + KHÔNG inviteUrl + KHÔNG dangerouslySetInnerHTML", () => {
    const src = read(CONSOLE);
    expect(src).not.toContain("setBetaMembershipAction");
    expect(src).not.toContain("inviteUrl");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("copy-safety — KHÔNG promise/incentive (§4.2/§4.11, corrections #33 — kể cả comment)", () => {
    expect(read(CONSOLE)).not.toMatch(FORBIDDEN_COPY_RE);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Source contract — src/components/founding-seller-forms.tsx (B2 hygiene)
// ══════════════════════════════════════════════════════════════════════════════

describe("source contract — src/components/founding-seller-forms.tsx (use client + useActionState)", () => {
  it('"use client" + useActionState + dispatch thủ công (React 19 form reset)', () => {
    const src = read(FORMS);
    expect(src).toContain('"use client"');
    expect(src).toContain("useActionState");
    // b6-review LOW-2 pattern — giữ input qua action error
    expect(src).toContain("onSubmit");
    expect(src).toContain("preventDefault");
    expect(src).toContain("startTransition");
  });

  it("ba form: createCandidateAction + inviteCandidateAction + updateCandidateNotesAction", () => {
    const src = read(FORMS);
    expect(src).toContain("createCandidateAction");
    expect(src).toContain("inviteCandidateAction");
    expect(src).toContain("updateCandidateNotesAction");
  });

  it("inviteUrl render MỘT LẦN từ response state — KHÔNG hidden token (S1, Review Focus 1)", () => {
    const src = read(FORMS);
    // URL tuyệt đối trả về trong FoundingSellerFormState.inviteUrl — render từ state
    expect(src).toContain("state.inviteUrl");
    // form mời KHÔNG bao giờ mang token (action đọc cookie; token trong form bị ignore)
    expect(src).not.toContain('name="token"');
  });

  it("import client-safe ONLY — KHÔNG db/server-only (B2 hygiene)", () => {
    const src = read(FORMS);
    expect(src).not.toContain("@/src/prisma");
    expect(src).not.toContain('"server-only"');
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("copy-safety — KHÔNG promise/incentive (§4.2/§4.11, corrections #33 — kể cả comment)", () => {
    expect(read(FORMS)).not.toMatch(FORBIDDEN_COPY_RE);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Source contract — nav (corrections #28) + audit filter (corrections #29)
// ══════════════════════════════════════════════════════════════════════════════

describe("source contract — app/admin/layout.tsx nav (corrections #28)", () => {
  it('nav entry /admin/beta-cohort gated beta_cohort.manage (convenience — spec §4.5)', () => {
    const src = read(LAYOUT);
    expect(src).toContain('href: "/admin/beta-cohort"');
    expect(src).toContain('label: "Beta cohort"');
    expect(src).toContain('capability: "beta_cohort.manage"');
    // Batch 2 Task 9 filtering giữ nguyên — nav là CONVENIENCE, guard trang là control
    expect(src).toContain("caps.includes(item.capability)");
  });
});

describe("source contract — app/admin/audit/page.tsx ACTION_PREFIXES (corrections #29)", () => {
  it("prefix filter MỞ RỘNG additive: founding_seller + beta_cohort", () => {
    const src = read(AUDIT_PAGE);
    expect(src).toContain('{ value: "founding_seller", label: "Founding seller" }');
    expect(src).toContain('{ value: "beta_cohort", label: "Beta cohort" }');
  });

  it("prefix cũ còn nguyên (additive — pin audit-append.test.ts không suy yếu)", () => {
    const src = read(AUDIT_PAGE);
    for (const p of ["moderation", "seller_verification", "session", "admin", "user"]) {
      expect(src, `prefix "${p}" phải còn`).toContain(`"${p}"`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Source contract — app/admin/users/page.tsx (corrections #19/#27 + additive)
// ══════════════════════════════════════════════════════════════════════════════

describe("source contract — app/admin/users/page.tsx (?u= + private_beta_buyer + additive)", () => {
  it("?u= exact filter (where({ id }) — KHÔNG ilike; corrections #27)", () => {
    const src = read(USERS_PAGE);
    expect(src).toMatch(/u\?: string/);
    expect(src).toContain("where({ id: uid })");
  });

  it("cột + form grant/suspend private_beta_buyer reuse setBetaMembershipAction (corrections #19/P2)", () => {
    const src = read(USERS_PAGE);
    // read membership buyer (read-only display)
    expect(src).toContain('cohort: "private_beta_buyer"');
    expect(src).toContain("buyerStatus");
    // grant/suspend forms — hidden cohort=private_beta_buyer, gated canManageCohort
    expect(src).toContain('value="private_beta_buyer"');
    expect(src).toContain("canManageCohort");
  });

  it("link Beta cohort per user → /admin/beta-cohort?userId=<id> (plan Task 5)", () => {
    const src = read(USERS_PAGE);
    expect(src).toMatch(/\/admin\/beta-cohort\?userId=\$\{u\.id\}/);
  });

  it("additive — MỌI column/form hiện có còn nguyên (Batch 2 Task 10 + Batch 3 Task 5)", () => {
    const src = read(USERS_PAGE);
    expect(src).toContain("setBetaMembershipAction"); // founding forms (Batch 2)
    expect(src).toContain('value="founding_seller"');
    expect(src).toContain("suspendUserAction");
    expect(src).toContain("liftSuspensionAction");
    expect(src).toContain("revokeAllUserSessionsAction");
    expect(src).toContain("/admin/seller-verification?q=");
    expect(src).toContain("foundingStatus");
    expect(src).toContain("activeSuspension");
    expect(src).toContain("isVerifiedSeller");
  });

  it("KHÔNG email/phone trong URL mới (corrections #27)", () => {
    const src = read(USERS_PAGE);
    expect(src).not.toMatch(/\/admin\/beta-cohort\?userId=\$\{u\.email\}/);
    expect(src).not.toMatch(/\/admin\/users\?u=\$\{u\.email\}/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. No reveal-PII action (A2 fail closed — Review Focus 4)
// ══════════════════════════════════════════════════════════════════════════════

describe("source contract — KHÔNG reveal-PII path (A2 fail closed, spec §5.4.1/§7.6)", () => {
  it("app/admin/beta-cohort + console + forms + actions: không reveal/unmask/pii.view_sensitive", () => {
    const files = [PAGE, CONSOLE, FORMS, ACTIONS];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} không được có reveal path`).not.toMatch(/reveal|unmask|pii\.view_sensitive/i);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Pure-logic — view-model helpers (plan Task 5 "pure-logic tests")
// ══════════════════════════════════════════════════════════════════════════════

describe("buildSupplyReadinessView — targets là DISPLAY STRING, counts từ live data (§12.1)", () => {
  it("trả đúng shape: counts + targetInvited 20–50 + targetListings 100–300", () => {
    const view = buildSupplyReadinessView(
      [
        { invitedAt: NOW, verifiedAt: NOW },
        { invitedAt: null, verifiedAt: null }, // prospect — chưa mời
        { invitedAt: NOW, verifiedAt: null },
      ],
      42,
    );
    expect(view).toEqual({
      invitedFoundingSellers: 2, // ever-invited (invitedAt set)
      verifiedFoundingSellers: 1, // ever-verified (verifiedAt set)
      approvedListingsByFoundingSellers: 42,
      targetInvited: "20–50",
      targetListings: "100–300",
    });
  });

  it("KHÔNG gate theo count — helper thuần, không throw/không chặn (§12.1 founder approval)", () => {
    // count 0 hoặc 10.000 — helper vẫn trả view (targets là tham chiếu, không phải chặn)
    expect(buildSupplyReadinessView([], 0).targetInvited).toBe("20–50");
    expect(buildSupplyReadinessView([{ invitedAt: NOW, verifiedAt: NOW }], 100_000).targetListings).toBe("100–300");
  });
});

describe("summarizeCandidates — §5.10 summary counts theo STORED status", () => {
  it("total/invited/registered đếm theo status hiện tại", () => {
    const summary = summarizeCandidates([
      { status: "prospect" },
      { status: "invited" },
      { status: "invited" },
      { status: "registered" },
      { status: "active_founding_seller" },
      { status: "exited" },
    ]);
    expect(summary).toEqual({
      totalCandidates: 6,
      invited: 2,
      registered: 1,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Behavioral render — masked contact + §5.10 row + forms (element tree)
// ══════════════════════════════════════════════════════════════════════════════

describe("FoundingSellerConsole render — PII mask + §5.10 row + forms (Review Focus 1/4)", () => {
  const render = () =>
    FoundingSellerConsole({ rows: [ROW_LINKED, ROW_PROSPECT], operators: OPERATORS });

  it("contactReference render MASKED — raw KHÔNG BAO GIỜ xuất hiện (§4.8/§7.6)", () => {
    const text = textOf(render());
    // maskContact (Task 2 — fixed-width): "lienhe@example.com" → "l***@example.com"
    expect(text).toContain("l***@example.com");
    // "0901234567" → "09*****67" (fixed-width 9 — corrections #34)
    expect(text).toContain("09*****67");
    // raw KHÔNG render — bất kỳ đâu trong tree
    expect(text).not.toContain("lienhe@example.com");
    expect(text).not.toContain("0901234567");
  });

  it("§5.10 row: status label + needs-assistance badge + notes React text + operator", () => {
    const text = textOf(render());
    expect(text).toContain("Đã tham gia"); // FOUNDING_SELLER_STATUS_LABELS.registered
    expect(text).toContain("Tiềm năng"); // .prospect
    expect(text).toContain("Cần hỗ trợ"); // needsAssistance badge (D2)
    expect(text).toContain("Ghi chú ops mẫu — React text only"); // notes — React text
    expect(text).toContain("Ops"); // assignedOperatorName
    expect(text).toContain("Seller Mới"); // linkedUserName
    expect(text).toContain("active"); // membershipStatus read-only
    expect(text).toContain("pending"); // verificationStatus
    expect(text).toContain("Hà Nội"); // PROVINCE_CODES["ha-noi"] (FD-1)
    expect(text).toContain("TP. Hồ Chí Minh"); // PROVINCE_CODES["ho-chi-minh"]
  });

  it("các plain form action Task 3/4 có mặt với đúng action reference", () => {
    const forms = formsOf(render());
    const actions = forms.map((f) => f["action"]);
    expect(actions).toContain(revokeInviteAction); // ROW_PROSPECT có activeTokenId
    expect(actions).toContain(syncCandidateFunnelAction); // ROW_LINKED có userId
    expect(actions).toContain(updateCandidateStatusAction);
    expect(actions).toContain(assignCandidateOperatorAction);
    expect(actions).toContain(recordCandidateContactAction);
    expect(actions).toContain(updateQualityListingCountAction);
  });

  it("InviteIssueForm CHỈ render cho prospect/invited (invite là pre-registration — S9)", () => {
    const invites = elementsOf(render(), InviteIssueForm);
    expect(invites).toHaveLength(1);
    expect(invites[0]!["candidateId"]).toBe("cand-2"); // prospect — KHÔNG phải registered
  });

  it("revoke form CHỈ render khi có token active (id — KHÔNG phải raw token)", () => {
    const forms = formsOf(render());
    const revoke = forms.find((f) => f["action"] === revokeInviteAction);
    expect(revoke).toBeDefined();
    expect(JSON.stringify(revoke)).toContain("token-9"); // tokenId hidden input — row id
    expect(JSON.stringify(revoke)).not.toContain("raw-token");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. admin-page-guards regression — trang mới tự rơi vào lưới (spec §4.5)
// ══════════════════════════════════════════════════════════════════════════════

describe("regression — admin page guard net (tests/unit/admin-page-guards.test.ts enumerate)", () => {
  it("page mới gọi requireCapability( — lưới guard bắt được", () => {
    const src = read(PAGE);
    expect(src).toMatch(/requireCapability\(|requireAdminUser\(/);
  });
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
});

afterEach(() => {
  vi.unstubAllEnvs();
});