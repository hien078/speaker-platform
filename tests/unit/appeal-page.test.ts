/**
 * Appeal page (/appeal/[caseId]) + form — unit tests (Task 7 review L1/L2,
 * spec §9 Batch 3 "appeal foundation" + §7.3 IDOR + §7.4 stored XSS).
 *
 * Hợp đồng (Task 7 review L1):
 *  1. notFound() cho case KHÔNG tồn tại VÀ non-subject — CÙNG hiển thị
 *     (không existence oracle cho case của người khác — Review Focus 3).
 *  2. Trang render CHO SUBJECT DUY NHẤT: KHÔNG reporter identities/notes/
 *     evidence/target — fixture CÓ report + evidence (nếu page query/render
 *     thì test fail ngay).
 *  3. KHÔNG dangerouslySetInnerHTML (source scan — moderation-pages.test.ts
 *     cover appeal page; ở đây pin thêm source appeal-form).
 *
 * Hợp đồng (Task 7 review L2 — state gating):
 *  4. Form/status CHỈ hiển thị cho case actioned/appealed/closed —
 *     open/triaged/investigating/dismissed → notFound() (subject không được
 *     "báo trước" rằng mình đang bị điều tra).
 *
 * Cơ chế mock như appeal-actions.test.ts: @/src/lib/auth fixture (requireUser
 * trả SessionUser) + db in-memory; getCaseSubjectUserId (moderation) THẬT
 * chạy trên db mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    set: () => undefined,
    delete: () => undefined,
    has: () => false,
    getAll: () => [],
  })),
}));

// ─── Fixtures — vi.hoisted để mock factory dùng được ─────────────────────────

const fixtures = vi.hoisted(() => ({
  SUBJECT_ID: "22222222-2222-4222-8222-222222222222", // seller — subject của case
  OTHER_ID: "44444444-4444-4444-8444-444444444444", // non-subject
}));

type FixtureUser = {
  id: string;
  name: string;
  role: "buyer" | "seller" | "admin";
  adminRole: string | null;
  sessionId: string;
};

const authState = vi.hoisted(() => ({ user: null as FixtureUser | null }));

vi.mock("@/src/lib/auth", () => ({
  requireUser: vi.fn(async () => {
    if (authState.user === null) {
      const { redirect } = await import("next/navigation");
      redirect("/login");
    }
    return authState.user!;
  }),
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── db.client mock — in-memory (case/evidence/appeal/action/user/listing) ────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  messages: [] as Row[],
  cases: [] as Row[],
  evidence: [] as Row[],
  appeals: [] as Row[],
  actions: [] as Row[],
}));

vi.mock("@/src/prisma/db.client", () => {
  type Pred = ((proxy: unknown) => unknown) | Row;

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          in: (arr: readonly unknown[]) => (arr as readonly unknown[]).includes(row[field]),
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
      select: (..._fields: string[]) => query(preds),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit === undefined ? null : { ...hit };
      },
      all: async () =>
        rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      create: async (data: Row) => {
        const row = { id: `row-${rows.length + 1}`, createdAt: "2026-10-01T00:00:00.000Z", ...data };
        rows.push(row);
        return { ...row };
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
    };
  };

  const models = {
    User: makeModel(dbState.users),
    Listing: makeModel(dbState.listings),
    Message: makeModel(dbState.messages),
    ModerationCase: makeModel(dbState.cases),
    ModerationEvidence: makeModel(dbState.evidence),
    Appeal: makeModel(dbState.appeals),
    ModerationAction: makeModel(dbState.actions),
  };

  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: models } }),
    },
  };
});

import * as appealPage from "../../app/appeal/[caseId]/page";
import { AppealForm } from "../../src/components/appeal-form";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SUBJECT: FixtureUser = {
  id: fixtures.SUBJECT_ID,
  name: "Người Bị Báo Cáo",
  role: "seller",
  adminRole: null,
  sessionId: "sess-1",
};

const OTHER: FixtureUser = {
  id: fixtures.OTHER_ID,
  name: "Người Dùng Khác",
  role: "buyer",
  adminRole: null,
  sessionId: "sess-2",
};

const CASE_ID = "case-appeal-1";
const LISTING_ID = "listing-appeal-1";
const REPORTER_ID = "reporter-777"; // người đã báo cáo — KHÔNG được hiện cho subject

/** Case actioned về listing của SUBJECT + evidence + report của reporter. */
const seedCase = (state: string): void => {
  dbState.cases.push({
    id: CASE_ID,
    targetType: "listing",
    targetId: LISTING_ID,
    state,
    priority: "normal",
    assignedModeratorId: null,
    reasonCategory: "suspected_scam",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  dbState.evidence.push({
    id: "ev-1",
    caseId: CASE_ID,
    sourceResourceType: "listing",
    sourceResourceId: LISTING_ID,
    capturedAt: "2026-10-01T00:00:00.000Z",
    relevantSnapshot: { kind: "listing", title: "Loa Bị Báo Cáo Bởi Người Khác", description: "Nội dung evidence" },
    subjectUserId: fixtures.SUBJECT_ID,
    reporterUserId: REPORTER_ID,
    classification: "suspected_scam",
  });
  // Report của reporter — page KHÔNG bao giờ query AbuseReport; row này ở đây
  // để pin: nếu ai thêm query/render reporter thì text fail ngay.
  dbState.users.push({ id: REPORTER_ID, name: "Tên Người Báo Cáo", role: "buyer" });
  dbState.listings.push({
    id: LISTING_ID,
    sellerId: fixtures.SUBJECT_ID,
    title: "Loa Bị Báo Cáo Bởi Người Khác",
    slug: "loa-bi-bao-cao",
    status: "removed",
  });
  // Sanction đã áp dụng (takedown) — page hiển thị label biện pháp.
  dbState.actions.push({
    id: "act-1",
    caseId: CASE_ID,
    actorId: "admin-ops",
    actionType: "listing.taken_down",
    targetType: "listing",
    targetId: LISTING_ID,
    reasonCode: "policy_violation_confirmed",
    note: null,
    createdAt: "2026-10-02T00:00:00.000Z",
  });
};

const seedAppeal = (state: string): void => {
  dbState.appeals.push({
    id: "appeal-1",
    caseId: CASE_ID,
    appellantId: fixtures.SUBJECT_ID,
    statement: "Lời trình bày của tôi",
    state,
    createdAt: "2026-10-03T00:00:00.000Z",
    closedAt: state === "closed" ? "2026-10-04T00:00:00.000Z" : null,
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
};

type PageFn = (props: { params: Promise<{ caseId: string }> }) => Promise<unknown>;
const AppealPage = appealPage.default as unknown as PageFn;
const call = (caseId: string) => AppealPage({ params: Promise.resolve({ caseId }) });

// ─── React element tree helpers ─────────────────────────────────────────────

type ElementLike = { type?: unknown; props?: { children?: unknown } | null };

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
      collect((n as ElementLike).props?.children);
    }
  };
  collect(node);
  return parts.join(" ");
}

/** Element có type === component cho trước có trong tree không (client component KHÔNG render — chỉ so type reference). */
function hasElement(node: unknown, type: unknown): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === type) {
        found = true;
        return;
      }
      walk(el.props?.children);
    }
  };
  walk(node);
  return found;
}

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;

beforeEach(() => {
  dbState.users.length = 0;
  dbState.listings.length = 0;
  dbState.messages.length = 0;
  dbState.cases.length = 0;
  dbState.evidence.length = 0;
  dbState.appeals.length = 0;
  dbState.actions.length = 0;
  authState.user = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 1. IDOR — notFound cho missing case VÀ non-subject (CÙNG hiển thị) ───────

describe("appeal page — IDOR (Review Focus 3): notFound cho missing case VÀ non-subject", () => {
  it("case KHÔNG tồn tại → notFound", async () => {
    authState.user = SUBJECT;
    await expect(call("case-khong-ton-tai")).rejects.toThrowError(NOT_FOUND);
  });

  it("non-subject → notFound — CÙNG error như case không tồn tại (không existence oracle)", async () => {
    seedCase("actioned");
    authState.user = OTHER;

    let errOther: unknown;
    try {
      await call(CASE_ID);
    } catch (e) {
      errOther = e;
    }
    expect((errOther as Error).message).toBe("NEXT_HTTP_ERROR_FALLBACK;404");

    // missing case — CÙNG message (so sánh trực tiếp, không oracle)
    let errMissing: unknown;
    try {
      await call("case-khong-ton-tai");
    } catch (e) {
      errMissing = e;
    }
    expect((errMissing as Error).message).toBe((errOther as Error).message);
  });

  it("chưa đăng nhập → redirect /login (requireUser)", async () => {
    seedCase("actioned");
    authState.user = null;
    await expect(call(CASE_ID)).rejects.toThrowError(/NEXT_REDIRECT:\/login/);
  });
});

// ─── 2. Subject-only render — KHÔNG reporter identities/notes/evidence/target ─

describe("appeal page — render CHO SUBJECT DUY NHẤT (L1: không reporter identities/evidence/target)", () => {
  it("subject + case actioned → render form kháng cáo; KHÔNG render tên/id/note reporter, KHÔNG render evidence, KHÔNG render target", async () => {
    seedCase("actioned");
    authState.user = SUBJECT;

    const tree = await call(CASE_ID);
    const text = textOf(tree);

    // form hiển thị cho subject của case đã actioned (client component —
    // assert qua type reference, nội dung form là hợp đồng appeal-form)
    expect(hasElement(tree, AppealForm)).toBe(true);
    expect(text).toContain("Gửi kháng cáo");

    // KHÔNG reporter identities/notes (fixture CÓ — nếu render là fail)
    expect(text).not.toContain("Tên Người Báo Cáo");
    expect(text).not.toContain(REPORTER_ID);
    // KHÔNG evidence (snapshot chỉ dùng resolve subject — không render)
    expect(text).not.toContain("Nội dung evidence");
    // KHÔNG target id (subject không cần biết đích internal)
    expect(text).not.toContain(LISTING_ID);
  });

  it("subject + đã có appeal (case appealed) → render TRẠNG THÁI kháng cáo, KHÔNG form gửi mới", async () => {
    seedCase("appealed");
    seedAppeal("submitted");
    authState.user = SUBJECT;

    const tree = await call(CASE_ID);
    const text = textOf(tree);

    expect(text).toContain("Kháng cáo của bạn");
    expect(text).toContain("Lời trình bày của tôi"); // statement của chính subject
    expect(hasElement(tree, AppealForm)).toBe(false); // form không còn
    expect(text).not.toContain("Bạn có thể gửi lời trình bày"); // copy form không render
  });

  it("subject + case closed (appeal đã đóng) → vẫn xem được trạng thái kháng cáo đã đóng", async () => {
    seedCase("closed");
    seedAppeal("closed");
    authState.user = SUBJECT;

    const tree = await call(CASE_ID);
    const text = textOf(tree);

    expect(text).toContain("Kháng cáo của bạn");
    expect(text).toContain("Đã đóng");
  });
});

// ─── 3. State gating (L2) — chỉ actioned/appealed/closed; còn lại notFound ───

describe("appeal page — state gating (L2): không báo trước điều tra đang diễn ra", () => {
  it.each(["open", "triaged", "investigating", "dismissed"])(
    "case state %s → notFound — subject KHÔNG được biết mình đang bị điều tra",
    async (state) => {
      seedCase(state);
      authState.user = SUBJECT;

      await expect(call(CASE_ID)).rejects.toThrowError(NOT_FOUND);
    },
  );

  it("case actioned (chưa appeal) → render (link /appeal/<caseId> từ notify trỏ đúng trạng thái appeal được)", async () => {
    seedCase("actioned");
    authState.user = SUBJECT;

    const tree = await call(CASE_ID);
    expect(textOf(tree)).toContain("Gửi kháng cáo");
  });
});

// ─── 4. Source contract — appeal form KHÔNG dangerouslySetInnerHTML ──────────

describe("appeal form — source contract (L1: stored XSS)", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));

  it("src/components/appeal-form.tsx KHÔNG dangerouslySetInnerHTML (statement untrusted — React text)", () => {
    const src = readFileSync(`${root}/src/components/appeal-form.tsx`, "utf8");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});
