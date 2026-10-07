/**
 * b4-holistic round-4 (LOW deploy-risk) — backfill Listing.approvedContentAt
 * cho row approved HIỆN CÓ: integration trên scratch DB
 * (scripts/test-integration.sh: container riêng + migrate + dọn). KHÔNG chạy
 * trong `npm test`.
 *
 * Finding: cột approvedContentAt (b4-holistic-2) chỉ SET bởi
 * approveListingAction — mọi row approved TRƯỚC deploy (Batch ≤3 / seed) giữ
 * NULL → hide→show coi content CHƯA duyệt → pending chờ duyệt lại content đã
 * duyệt. Fix: data-only migration backfill (self-edge + invariant routing —
 * pin artefact ở tests/unit/approved-content-backfill-migration.test.ts;
 * đã verify trên scratch DB marker pre-deploy → migrate chạy backfill).
 *
 * Test này chạy VERBATIM các step SQL của ops.json (precheck EXISTS →
 * execute UPDATE → postcheck NOT EXISTS — cùng câu lệnh + params db migrate
 * chạy) qua raw lane, rồi assert hành vi sau backfill:
 *  1. row approved NULL → approvedContentAt = updatedAt;
 *  2. row hidden/pending NULL → GIỮ NULL (fail-closed — không biết content
 *     đã duyệt chưa);
 *  3. sau backfill: hide → show → APPROVED (fast path — KHÔNG vào review),
 *     KHÔNG audit listing.submitted;
 *  4. row approved NULL KHÔNG backfill (chưa chạy) → hide → show → PENDING
 *     (hành vi fail-closed giữ nguyên cho row thật sự chưa duyệt).
 *
 * Mock recipe như tests/integration/listing-visibility-review.test.ts: cookie
 * store điều khiển được (next/headers), session THẬT trên DB scratch, action
 * THẬT toàn bộ (gate + audit + CAS thật).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── Cookie store điều khiển được (next/headers) ──────────────────────────────

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
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { toggleListingVisibilityAction } from "../../src/lib/actions/listings";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = () => `b4r4-${Date.now()}-${seq++}`;

async function mkVerifiedSeller(): Promise<string> {
  const now = new Date().toISOString();
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4R4 Seller",
    role: "seller",
    emailVerifiedAt: now,
    phoneVerifiedAt: now,
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
  });
  await db.orm.public.PolicyAcceptance.create({
    userId: u.id,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: now,
  });
  await db.orm.public.BetaCohortMembership.create({
    userId: u.id,
    cohort: "founding_seller",
    status: "active",
  });
  await db.orm.public.SellerVerification.create({
    userId: u.id,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
    reasonCode: "requirements_met",
    submittedAt: now,
    reviewedAt: now,
  });
  return u.id;
}

/** Category create-if-absent THEO SLUG — chỉ track row MÌNH tạo. */
async function mkCategory(slug: string, name: string): Promise<string> {
  const existing = await db.orm.public.Category.first({ slug });
  if (existing) return existing.id;
  const c = await db.orm.public.Category.create({
    name,
    slug,
    commissionRate: 5,
    sortOrder: 0,
    isActive: true,
  });
  created.categories.push(c.id);
  return c.id;
}

/**
 * Listing approved/hidden/pending legacy shape TRƯỚC backfill:
 * approvedContentAt NULL (row Batch ≤3 / seed pre-round-4) — seed TRỰC TIẾP
 * (KHÔNG qua action) để mô phỏng dữ liệu production lúc deploy.
 */
async function seedListing(input: {
  sellerId: string;
  categoryId: string;
  status: "approved" | "hidden" | "pending";
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.categoryId,
    brandId: null,
    title: "Loa thùng PA JBL Eon715 sự kiện",
    slug: `loa-thung-pa-jbl-eon715-${uid()}`,
    description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    condition: "good",
    price: 11_200_000,
    negotiable: true,
    acceptExchange: false,
    status: input.status,
    rejectionReason: null,
    city: "Hà Nội",
    viewCount: 0,
    approvedContentAt: null, // pre-deploy shape — backfill phải xử
  });
  await db.orm.public.ListingImage.create({
    listingId: l.id,
    url: "/img/listings/it-a.svg",
    sortOrder: 0,
  });
  return l.id;
}

// ─── Ops.json của migration backfill — chạy VERBATIM như db migrate ─────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION_DIR = "migrations/app/20261007T2007_batch4_round4_approved_content_backfill";

type OpsStep = { description: string; sql: string; params?: unknown[] };
type OpsOp = { id: string; operationClass: string; precheck?: OpsStep[]; execute?: OpsStep[]; postcheck?: OpsStep[] };

const dataOp = (
  JSON.parse(readFileSync(`${root}/${MIGRATION_DIR}/ops.json`, "utf8")) as OpsOp[]
).find((o) => o.operationClass === "data")!;

/** Template tag gọi trực tiếp: placeholder $n của step → interpolation đúng vị trí. */
function opsStepToRawTag(step: OpsStep): ReturnType<typeof db.raw.sql> {
  const params = step.params ?? [];
  const literals = step.sql.split(/\$\d+/);
  if (literals.length !== params.length + 1) {
    throw new Error(`ops.json step placeholder/params lệch nhau: ${step.sql}`);
  }
  // Template tag là hàm thường (strings, ...values) — gọi trực tiếp với params
  // JSON thuần của ops.json (string/number/bool — primitive được raw lane chấp
  // nhận lúc runtime; cast unknown[] cho gọn, KHÔNG build plan từ dữ liệu lạ).
  const rawTag = db.raw.sql as unknown as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => ReturnType<typeof db.raw.sql>;
  return rawTag(literals as unknown as TemplateStringsArray, ...params);
}

/** Chạy VERBATIM precheck/execute/postcheck của op data — cùng SQL + params runner chạy. */
async function runBackfillOp(): Promise<void> {
  // precheck: EXISTS → true (còn việc — KHÔNG fail MIGRATION.PRECHECK_FAILED)
  const pre = await db
    .runtime()
    .query<{ ok: boolean }>(opsStepToRawTag(dataOp.precheck![0]!).returnsRow({ ok: "pg/bool@1" }).build());
  expect(pre[0]!.ok).toBe(true);
  // execute: UPDATE approvedContentAt = updatedAt WHERE approved AND NULL
  await db.runtime().execute(opsStepToRawTag(dataOp.execute![0]!).affectedCount().build());
  // postcheck: NOT EXISTS → true (việc đã xong)
  const post = await db
    .runtime()
    .query<{ ok: boolean }>(opsStepToRawTag(dataOp.postcheck![0]!).returnsRow({ ok: "pg/bool@1" }).build());
  expect(post[0]!.ok).toBe(true);
}

// ─── Form helpers ─────────────────────────────────────────────────────────────

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = async (userId: string): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId);
};

/** Action kết thúc bằng redirect() → throw NEXT_REDIRECT — coi là THÀNH CÔNG/redirect. */
const expectRedirect = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("NEXT_REDIRECT:")) return msg.slice("NEXT_REDIRECT:".length);
    throw e;
  }
  return "";
};

// ─── Dọn dẹp — FK-safe ────────────────────────────────────────────────────────

const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.Listing.where({ sellerId: id }).deleteAll();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.SellerVerification.where({ userId: id }).deleteAll();
    await db.orm.public.User.where({ id }).deleteAll();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  created.users.length = 0;
  created.categories.length = 0;
  created.listings.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── Backfill + hành vi hide→show sau backfill ─────────────────────────────

d("backfill approvedContentAt (b4-holistic round-4 LOW deploy-risk)", () => {
  it("row approved NULL → backfill VERBATIM ops.json → approvedContentAt = updatedAt; hidden/pending GIỮ NULL", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const approvedId = await seedListing({ sellerId, categoryId: cat, status: "approved" });
    const hiddenId = await seedListing({ sellerId, categoryId: cat, status: "hidden" });
    const pendingId = await seedListing({ sellerId, categoryId: cat, status: "pending" });
    created.listings.push(approvedId, hiddenId, pendingId);

    await runBackfillOp();

    const approved = await db.orm.public.Listing.first({ id: approvedId });
    expect(approved!.approvedContentAt).not.toBeNull();
    expect(approved!.approvedContentAt).toBe(approved!.updatedAt); // = updatedAt (tín hiệu ĐÃ-DUYỆT)
    // hidden/pending KHÔNG backfill — fail-closed (không biết content đã duyệt chưa)
    expect((await db.orm.public.Listing.first({ id: hiddenId }))!.approvedContentAt).toBeNull();
    expect((await db.orm.public.Listing.first({ id: pendingId }))!.approvedContentAt).toBeNull();

    // idempotent: chạy lại toàn bộ op (precheck giờ false → runner SKIP op —
    // ở đây chạy lại execute là no-op vì predicate NULL không còn khớp).
    await db.runtime().execute(opsStepToRawTag(dataOp.execute![0]!).affectedCount().build());
    expect((await db.orm.public.Listing.first({ id: approvedId }))!.approvedContentAt).toBe(
      approved!.approvedContentAt,
    );
  });

  it("SAU backfill: approved → hide → show → APPROVED (fast path — KHÔNG vào review)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedListing({ sellerId, categoryId: cat, status: "approved" });
    created.listings.push(listingId);

    await runBackfillOp();
    await login(sellerId);

    // hide (approved → hidden — approvedContentAt GIỮ NGUYÊN) — path thành công
    // redirect /sell/my URL sạch (b4-holistic round-4) → bọc expectRedirect.
    await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId })));
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("hidden");

    // show lại → APPROVED fast path (content đã duyệt — KHÔNG pending chờ duyệt lại)
    await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId })));
    const reshowed = await db.orm.public.Listing.first({ id: listingId });
    expect(reshowed!.status).toBe("approved");
    expect(reshowed!.approvedContentAt).not.toBeNull();
    // KHÔNG audit submit nào — vòng hide/show không đổi content không vào review
    const submits = await db.orm.public.AuditEvent
      .where({ action: "listing.submitted", resourceId: listingId })
      .all();
    expect(submits).toHaveLength(0);
  });

  it("KHÔNG backfill (row approved NULL chưa được xử) → hide → show → PENDING (fail-closed giữ nguyên)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedListing({ sellerId, categoryId: cat, status: "approved" });
    created.listings.push(listingId);

    // KHÔNG chạy backfill — row vẫn NULL như pre-deploy chưa migrate
    await login(sellerId);
    // hide thành công → redirect /sell/my (round-4) → bọc expectRedirect
    await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId }))); // hide
    const url = await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId })));

    // hiện lại → PENDING + audit listing.submitted (via=show_again) — hành vi
    // fail-closed cho row THẬT SỰ chưa duyệt (chưa qua backfill).
    expect(url).toBe("/sell/my?submitted=1");
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("pending");
  });
});
