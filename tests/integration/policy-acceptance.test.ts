/**
 * Policy acceptance (terms + privacy) — integration tests (zero-cost launch
 * Task D — founder decision 2026-10-12) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + `prisma db migrate --to
 * production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/policy-acceptance.test.ts, register-policy-consent
 * .test.ts, policy-acceptance-action.test.ts) chứng minh logic với db mock;
 * ở đây chứng minh CÙNG hợp đồng against DB THẬT với module THẬT (unique
 * index PolicyAcceptance_userId_policyKey_policyVersion, tx Postgres,
 * session/auth, moderation guards, rate limit):
 *
 *  1. Registration tx (Nghị định 13/2023/NĐ-CP explicit consent): đăng ký với
 *     acceptPolicies=on → MỘT tx ghi User + Cart + HAI PolicyAcceptance
 *     (terms + privacy) ở version HIỆN HÀNH của registry — KHÔNG user mồ côi
 *     (lỗi giữa tx → rollback toàn bộ).
 *  2. Thiếu consent → typed POLICY_CONSENT_REQUIRED, KHÔNG User row.
 *  3. Guard trên DB thật — user HIỆN CÓ (tạo trực tiếp, mô phỏng user đăng ký
 *     TRƯỚC cơ chế — KHÔNG backfill): startConversationAction → redirect
 *     /account/policies (KHÔNG 500), KHÔNG Conversation; createDealAction →
 *     form error POLICY_ACCEPTANCE_REQUIRED, KHÔNG Deal.
 *  4. acceptCurrentPoliciesAction (đường /account/policies): thiếu checkbox →
 *     POLICY_CONSENT_REQUIRED KHÔNG row; đủ checkbox → success + ĐÚNG 2 row;
 *     sau đó guard pass (hội thoại + Deal tạo được — founder decision: chấp
 *     nhận trên hành động tiếp theo, KHÔNG consent backfill).
 *  5. Idempotent theo @@unique(userId, policyKey, policyVersion): accept lần
 *     hai → success, KHÔNG row mới (cơ chế Batch 2 — KHÔNG cơ chế thứ hai).
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/auth/guards/rate-limit/policy-registry là thật toàn bộ.
 * AUTH_SECRET + PRODUCT_EVENT_PSEUDONYM_KEY stub trong beforeAll (emission
 * path của startConversationAction/createDealAction chạy được).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// ─── Cookie store điều khiển được (next/headers) — session THẬT ──────────────

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
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
}));

import { db } from "../../src/prisma/db.client";
import { SESSION_COOKIE, createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { POLICIES } from "../../src/lib/policy-registry";
import { registerAction } from "../../src/lib/actions/auth";
import { startConversationAction } from "../../src/lib/actions/chat";
import { createDealAction } from "../../src/lib/actions/deals";
import { acceptCurrentPoliciesAction } from "../../src/lib/actions/policy-acceptance";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Key test hợp lệ — base64 của đúng 32 byte (product-events.test.ts pattern). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let seq = 0;
const uid = () => `zc-d-${Date.now()}-${seq++}`;

/** User tạo TRỰC TIẾP (KHÔNG qua registerAction) — mô phỏng user hiện có pre-Task-D. */
async function mkUser(role: "buyer" | "seller"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `ZC D ${role} ${seq}`,
    role,
  });
  created.users.push(u.id);
  return u.id;
}

/** Seller đủ §7.8 (D2 — Batch 6 verified-seller shape): verified + founding_seller active. */
async function seedSellerEligibility(sellerId: string): Promise<void> {
  const sv = await db.orm.public.SellerVerification.create({
    userId: sellerId,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
  });
  created.sellerVerifications.push(sv.id);
  const mem = await db.orm.public.BetaCohortMembership.create({
    userId: sellerId,
    cohort: "founding_seller",
    status: "active",
  });
  created.betaMemberships.push(mem.id);
}

/** Buyer là active beta participant (§2.1) — guard Task D chạy SAU gate này. */
async function seedBuyerMembership(buyerId: string): Promise<void> {
  const mem = await db.orm.public.BetaCohortMembership.create({
    userId: buyerId,
    cohort: "private_beta_buyer",
    status: "active",
  });
  created.betaMemberships.push(mem.id);
}

async function mkListing(sellerId: string): Promise<string> {
  const cat = await db.orm.public.Category.create({
    name: `Danh mục ${uid()}`,
    slug: `cat-${uid()}`,
  });
  created.categories.push(cat.id);
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.id,
    title: `Loa ${uid()}`,
    slug: `loa-${uid()}`,
    description: "integration test zero-cost task d",
    condition: "good",
    price: 1_800_000,
    status: "approved",
    city: "Hà Nội",
  });
  created.listings.push(l.id);
  return l.id;
}

async function mkConversation(listingId: string, buyerId: string, sellerId: string): Promise<string> {
  const c = await db.orm.public.Conversation.create({ listingId, buyerId, sellerId });
  created.conversations.push(c.id);
  return c.id;
}

/** Session THẬT cho user — trả token cookie để switch giữa các user. */
async function loginAs(userId: string): Promise<string> {
  await createSession(userId);
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

const setSession = (token: string): void => {
  cookieState.store.set(SESSION_COOKIE, token);
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Số row chấp nhận của user ở version hiện hành (terms + privacy). */
async function acceptanceCount(userId: string): Promise<number> {
  const rows = await db.orm.public.PolicyAcceptance.where({ userId }).all();
  return rows.filter(
    (r) =>
      (r.policyKey === "terms" || r.policyKey === "privacy") &&
      r.policyVersion ===
        (r.policyKey === "terms" ? POLICIES.terms.version : POLICIES.privacy.version),
  ).length;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: ProductEvent (no FK) → Deal (DealStatusHistory Cascade) →
// Conversation → Listing → Category → SellerVerification → BetaCohortMembership
// → AuditEvent (SetNull theo actor/subject) → User (Cart/PolicyAcceptance/
// Notification/UserSession Cascade theo user).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  conversations: [] as string[],
  deals: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
};

afterEach(async () => {
  // ProductEvent do emit core THẬT ghi — mọi event của fixture này mang listingId
  for (const listingId of created.listings) {
    await db.orm.public.ProductEvent.where({ listingId }).deleteAll();
  }
  for (const id of created.deals) {
    await db.orm.public.Deal.where({ id }).deleteAll();
  }
  for (const id of created.conversations) {
    await db.orm.public.Conversation.where({ id }).deleteAll();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).deleteAll();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
  // User CUỐI cùng — Cart + PolicyAcceptance + Notification + UserSession
  // cascade theo user (contract.prisma onDelete: Cascade).
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).deleteAll();
  }
  created.users.length = 0;
  created.categories.length = 0;
  created.listings.length = 0;
  created.conversations.length = 0;
  created.deals.length = 0;
  created.sellerVerifications.length = 0;
  created.betaMemberships.length = 0;
  cookieState.store.clear();
});

beforeAll(() => {
  // Emission path (conversation_started/deal_created) + audit ipHash cần key.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

beforeEach(() => {
  resetRateLimits();
});

// ─── 1/2. Registration tx — User + Cart + 2 PolicyAcceptance cùng nhau ───────

d("registerAction — consent terms + privacy trong tx đăng ký (DB thật)", () => {
  it("acceptPolicies=on → MỘT tx: User + Cart + HAI PolicyAcceptance ở version registry", async () => {
    const email = `${uid()}@register.test`;
    cookieState.store.clear();

    // redirect("/") throw NEXT_REDIRECT — đăng ký thành công KHÔNG return state
    await expect(
      registerAction(
        {},
        fd({
          name: "Người Dùng Task D",
          email,
          password: "mat-khau-manh-123",
          role: "buyer",
          acceptPolicies: "on",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/");

    const user = await db.orm.public.User.where({ email }).first();
    expect(user).not.toBeNull();
    created.users.push(user!.id); // dọn sau test

    // Cart cùng tx (không user mồ côi giỏ)
    const cart = await db.orm.public.Cart.first({ userId: user!.id });
    expect(cart).not.toBeNull();

    // HAI row chấp nhận ở version HIỆN HÀNH của registry (terms + privacy)
    expect(await acceptanceCount(user!.id)).toBe(2);
    const terms = await db.orm.public.PolicyAcceptance.first({
      userId: user!.id,
      policyKey: "terms",
      policyVersion: POLICIES.terms.version,
    });
    const privacy = await db.orm.public.PolicyAcceptance.first({
      userId: user!.id,
      policyKey: "privacy",
      policyVersion: POLICIES.privacy.version,
    });
    expect(terms).not.toBeNull();
    expect(privacy).not.toBeNull();
    expect(terms!.acceptedAt).not.toBeNull();
  });

  it("thiếu acceptPolicies → typed POLICY_CONSENT_REQUIRED, KHÔNG User row", async () => {
    const email = `${uid()}@noconsent.test`;
    cookieState.store.clear();

    const state = await registerAction(
      {},
      fd({ name: "Không Đồng Ý", email, password: "mat-khau-manh-123", role: "buyer" }),
    );

    expect(state).toEqual({
      error: "Bạn phải đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản.",
      code: "POLICY_CONSENT_REQUIRED",
    });
    expect(await db.orm.public.User.where({ email }).first()).toBeNull();
  });
});

// ─── 3/4/5. Guard + accept action trên DB thật (user hiện có — KHÔNG backfill) ─

d("guard assertCurrentPoliciesAccepted + acceptCurrentPoliciesAction (DB thật)", () => {
  /** Fixture đầy đủ: seller eligible + HAI listing approved (một cái có hội
   *  thoại cho Deal, một cái KHÔNG có — startConversationAction có branch
   *  existing redirect TRƯỚC guard Task D, nên assert guard phải dùng listing
   *  chưa có hội thoại để đi vào create branch) + buyer member. */
  async function seedPair() {
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller);
    const listing = await mkListing(seller); // có hội thoại (cho createDealAction)
    const listingFresh = await mkListing(seller); // KHÔNG hội thoại (create branch)
    const buyer = await mkUser("buyer");
    await seedBuyerMembership(buyer);
    const convo = await mkConversation(listing, buyer, seller);
    return { seller, listing, listingFresh, buyer, convo };
  }

  it("user hiện có (KHÔNG row chấp nhận) → startConversation redirect /account/policies, createDeal form error — KHÔNG row nào", async () => {
    const { listing, listingFresh, buyer } = await seedPair();
    const tok = await loginAs(buyer);
    setSession(tok);

    // Void action KHÔNG có error surface → typed redirect (KHÔNG 500).
    // listingFresh KHÔNG có hội thoại → create branch → guard Task D chặn.
    await expect(startConversationAction(fd({ listingId: listingFresh }))).rejects.toThrow(
      "NEXT_REDIRECT:/account/policies",
    );
    // KHÔNG Conversation row mới trên listingFresh (guard chặn TRƯỚC create)
    expect(
      await db.orm.public.Conversation.where({ listingId: listingFresh, buyerId: buyer }).all(),
    ).toHaveLength(0);

    // Form action → typed form error (KHÔNG throw 500). Guard chạy TRƯỚC
    // requireDealConversation nên listing (đã có hội thoại) cũng bị chặn.
    const dealState = await createDealAction({}, fd({ listingId: listing }));
    expect(dealState).toEqual({ error: "POLICY_ACCEPTANCE_REQUIRED" });
    expect(await db.orm.public.Deal.where({ buyerId: buyer }).all()).toHaveLength(0);
    expect(await acceptanceCount(buyer)).toBe(0);
  });

  it("acceptCurrentPoliciesAction: thiếu checkbox → POLICY_CONSENT_REQUIRED KHÔNG row; đủ → ĐÚNG 2 row; guard pass sau đó", async () => {
    const { listing, listingFresh, buyer } = await seedPair();
    const tok = await loginAs(buyer);
    setSession(tok);

    // Thiếu consent checkbox — server-side reject (form required chỉ là UX)
    const noConsent = await acceptCurrentPoliciesAction({}, fd({}));
    expect(noConsent).toEqual({
      error: "Hãy đánh dấu đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư trước khi gửi.",
      code: "POLICY_CONSENT_REQUIRED",
    });
    expect(await acceptanceCount(buyer)).toBe(0);

    // Đủ checkbox → success + ĐÚNG 2 row (terms + privacy ở version registry)
    const accepted = await acceptCurrentPoliciesAction({}, fd({ acceptPolicies: "on" }));
    expect(accepted.success).toContain("Đã ghi nhận đồng ý");
    expect(await acceptanceCount(buyer)).toBe(2);

    // Guard pass lại — hành động tạo nội dung chạy được (founder decision:
    // chấp nhận trên hành động tiếp theo, KHÔNG consent backfill).
    // listingFresh → create branch THẬT (không phải existing redirect).
    await expect(startConversationAction(fd({ listingId: listingFresh }))).rejects.toThrow(
      /NEXT_REDIRECT:\/chat\//,
    );
    const newConvo = await db.orm.public.Conversation
      .where({ listingId: listingFresh, buyerId: buyer })
      .first();
    expect(newConvo).not.toBeNull();
    created.conversations.push(newConvo!.id); // dọn sau test

    const dealState = await createDealAction({}, fd({ listingId: listing }));
    expect(dealState).toEqual({ success: "Đã tạo thỏa thuận." });
    const deal = await db.orm.public.Deal.where({ buyerId: buyer }).first();
    expect(deal).not.toBeNull();
    created.deals.push(deal!.id);
  });

  it("idempotent theo @@unique(userId, policyKey, policyVersion): accept lần hai → success, KHÔNG row mới", async () => {
    const { buyer } = await seedPair();
    const tok = await loginAs(buyer);
    setSession(tok);

    await acceptCurrentPoliciesAction({}, fd({ acceptPolicies: "on" }));
    expect(await acceptanceCount(buyer)).toBe(2);

    // Lần hai — đã đủ → no-op thành công (KHÔNG row mới, KHÔNG tx)
    const again = await acceptCurrentPoliciesAction({}, fd({ acceptPolicies: "on" }));
    expect(again.success).toContain("Bạn đã đồng ý");
    expect(await acceptanceCount(buyer)).toBe(2);
  });
});
