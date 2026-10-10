/**
 * Suspended-membership enforcement proof across every gated surface — unit
 * tests (Batch 7 plan Task 7 — spec §9 Batch 7 Gate "suspended membership
 * enforcement" + "seller cohort + verification publication requirement";
 * Review Focus 3; corrections 2026-10-08 item 30: NĂM publication transitions,
 * không phải bốn — createListingAction/updateListingAction/
 * toggleListingVisibilityAction/submitListingAction/approveListingAction —
 * và saveListingDraftAction CỐ Ý KHÔNG bị gate (§4.4), assert tường minh).
 *
 * Task 7 là TESTS ONLY — KHÔNG product code mới (plan Task 7 "Produces: no
 * new product code"). Mọi case dưới đây gọi CỔNG THẬT của batch sở hữu:
 *  - Batch 2 `checkSellerPublicationRequirements`/`assertSellerPublicationAllowed`
 *    (seller-verification-policy.ts — 8 yêu cầu incl.
 *    founding_seller_membership_active) — re-pinned, KHÔNG re-implement.
 *  - Batch 4 `assertListingPublishable`/`checkListingPublication`
 *    (listing-publication.ts — wrapper kế thừa gate Batch 2, seller TRƯỚC
 *    content) — order pin.
 *  - Batch 2/4/5 năm transition surfaces (listings.ts + admin.ts — approve
 *    cần `version` form field = updatedAt đã review, corrections #30).
 *  - Batch 6 `assertListingSellerInteractable` (deal.ts D2 — seller-side
 *    chat/Deal) — gọi guard THẬT, KHÔNG viết lại.
 *  - Task 6 `assertBuyerBetaChatAccess`/`isActiveBetaParticipant`
 *    (beta-access.ts — buyer-side §2.1).
 *
 * Hợp đồng (plan Task 7 Step 1 — fixture Batch 6 verified-seller shape:
 * emailVerifiedAt/phoneVerifiedAt/sellerType/sellerOperatingProvinceCode/
 * PolicyAcceptance(seller_rules,v1)/SellerVerification(verified)/
 * BetaCohortMembership(founding_seller, active) + listing approved; flip
 * CHỈ membership sang suspended):
 *
 *  A. Publication gates (Batch 2/4) — suspended founding_seller membership:
 *   1. checkSellerPublicationRequirements → missing CHỈ
 *      founding_seller_membership_active (7 yêu cầu khác vẫn thỏa — flip-only).
 *   2. assertListingPublishable → SELLER_PUBLICATION_BLOCKED TRƯỚC mọi
 *      content check (content CỐ Ý invalid — ảnh URL ngoài; nếu content
 *      chạy trước sẽ là IMAGE_URL_INVALID).
 *   3. createListingAction → typed error, KHÔNG Listing.create.
 *   4. updateListingAction content-change → pending blocked; status + nội
 *      dung giữ nguyên.
 *   5. toggleListingVisibilityAction hidden→approved blocked → redirect
 *      /sell/verification (b4-holistic-2 — KHÔNG còn silent return; ruling
 *      recorded: code thắng plan text), status unchanged.
 *   6. submitListingAction draft→pending blocked (transition thứ 5 —
 *      corrections #30) → redirect /sell/verification + audit
 *      listing.submit_blocked reason SELLER_PUBLICATION_BLOCKED:….
 *   7. approveListingAction (admin) → KHÔNG approve + audit
 *      listing.approve_blocked (defense-in-depth — kể cả admin duyệt).
 *   8. saveListingDraftAction → VẪN lưu nháp (§4.4 draft TRƯỚC verification —
 *      corrections #30 assert tường minh gate KHÔNG over-block).
 *   9. CẢ NĂM transition pass khi membership active (no over-block).
 *  B. Batch 6 D2 seller-side guard (gọi guard THẬT): suspended →
 *     SELLER_MEMBERSHIP_INACTIVE; active → pass.
 *  C. Chat surface: buyer (member) trên live listing của suspended-membership
 *     seller → SELLER_MEMBERSHIP_INACTIVE, KHÔNG Conversation, KHÔNG emit;
 *     suspended-membership member làm BUYER → BETA_MEMBERSHIP_REQUIRED
 *     (Task 6); active seller + member buyer → tạo hội thoại (no over-block).
 *  D. Deal surface: cả hai chân — suspended-membership seller →
 *     SELLER_MEMBERSHIP_INACTIVE; suspended-membership buyer →
 *     BETA_MEMBERSHIP_REQUIRED; eligible pair → Deal tạo (no over-block).
 *  E. isActiveBetaParticipant (Task 6 read): suspended → false; active →
 *     true; hết hạn → false (corrections #16).
 *  F. Live listings stay live (Batch 3 A2 precedent): isListingSearchable
 *     unchanged, row untouched sau các lần từ chối; listing-page CTA render
 *     D12 neutral copy (source-contract — Task 6 đã wire buyerBetaEligible).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * + next/navigation (redirect throw) + next/headers (cookie store điều khiển
 * được) + db.client in-memory (đủ model cho năm transition surface + chat +
 * Deal). session/rbac/auth/moderation/rate-limit/policy/wrapper/beta-access/
 * deal/audit/telemetry GIỮ BẢN THẬT — đăng nhập qua UserSession row thật
 * (publication-gate.test.ts pattern; corrections #21: KHÔNG mock rbac cho
 * admin case — requireCapability đọc session.isAdmin thật). Emit core THẬT
 * (PRODUCT_EVENT_PSEUDONYM_KEY stubbed) ghi row ProductEvent vào mock —
 * assert ROW, KHÔNG chỉ spy. AUTH_SECRET stub (hkdfKey ip-hash của audit).
 * resetRateLimits() mỗi test.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const headerState = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerState.headers),
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

// ─── db.client mock — in-memory đủ model cho năm transition surface + chat + Deal ──

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  sessions: [] as Row[],
  listings: [] as Row[],
  images: [] as Row[],
  categories: [] as Row[],
  brands: [] as Row[],
  models: [] as Row[],
  uploads: [] as Row[],
  priceHistory: [] as Row[],
  verifications: [] as Row[],
  acceptances: [] as Row[],
  memberships: [] as Row[],
  suspensions: [] as Row[],
  blocks: [] as Row[],
  audits: [] as Row[],
  adminAudits: [] as Row[],
  notifications: [] as Row[],
  conversations: [] as Row[],
  deals: [] as Row[],
  dealHistory: [] as Row[],
  events: [] as Row[], // ProductEvent — emit core THẬT ghi vào đây
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
          lt: (v: unknown) => (row[field] as number) < (v as number),
          lte: (v: unknown) => (row[field] as number) <= (v as number),
          gt: (v: unknown) => (row[field] as number) > (v as number),
          gte: (v: unknown) => (row[field] as number) >= (v as number),
          isNull: () => row[field] === null || row[field] === undefined,
          isNotNull: () => row[field] !== null && row[field] !== undefined,
          asc: () => ({ field, dir: "asc" as const }),
          desc: () => ({ field, dir: "desc" as const }),
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[], defaults?: () => Row, attach?: (row: Row) => void) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      orderBy: (_cb: (ops: unknown) => unknown) => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        if (includeRel === "user" && attach) attach(copy);
        return copy;
      },
      all: async () =>
        rows
          .filter((r) => preds.every((p) => matches(r, p)))
          .map((r) => {
            const copy = { ...r };
            if (includeRel === "user" && attach) attach(copy);
            return copy;
          }),
      update: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        Object.assign(hit[0]!, data);
        return { ...hit[0]! };
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      deleteAll: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      include: (rel: string) => query([], rel),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const models = {
    User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    UserSession: makeModel(
      dbState.sessions,
      () => ({
        id: `sess-${dbState.sessions.length + 1}`,
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        revokedAt: null,
        revokedReason: null,
        steppedUpAt: null,
        isAdmin: false,
        userAgent: null,
      }),
      (row) => {
        row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
      },
    ),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      viewCount: 0,
      negotiable: false,
      acceptExchange: false,
      rejectionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    ListingImage: makeModel(dbState.images, () => ({
      id: `img-${dbState.images.length + 1}`,
      sortOrder: 0,
      checklistSlot: null,
    })),
    Category: makeModel(dbState.categories, () => ({
      id: `cat-${dbState.categories.length + 1}`,
      commissionRate: 5,
      sortOrder: 0,
      isActive: true,
      createdAt: new Date().toISOString(),
    })),
    Brand: makeModel(dbState.brands, () => ({
      id: `brand-${dbState.brands.length + 1}`,
      logoUrl: null,
      createdAt: new Date().toISOString(),
    })),
    ProductModel: makeModel(dbState.models, () => ({
      id: `model-${dbState.models.length + 1}`,
      releaseYear: null,
      description: null,
      specs: null,
      image: null,
      status: "approved",
      mergedIntoId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    ListingImageUpload: makeModel(dbState.uploads, () => ({
      id: `up-${dbState.uploads.length + 1}`,
      bytes: 1024,
      width: 800,
      height: 600,
      createdAt: new Date().toISOString(),
    })),
    PriceHistory: makeModel(dbState.priceHistory, () => ({
      id: `ph-${dbState.priceHistory.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    SellerVerification: makeModel(dbState.verifications, () => ({
      id: `sv-${dbState.verifications.length + 1}`,
      method: "operations_review",
      submittedAt: null,
      reviewedAt: null,
      reviewerId: null,
      reasonCode: null,
      note: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    PolicyAcceptance: makeModel(dbState.acceptances, () => ({
      id: `pa-${dbState.acceptances.length + 1}`,
      acceptedAt: new Date().toISOString(),
    })),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      id: `bcm-${dbState.memberships.length + 1}`,
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    UserSuspension: makeModel(dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
      note: null,
      suspendedById: null,
      suspendedAt: new Date().toISOString(),
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    })),
    UserBlock: makeModel(dbState.blocks, () => ({
      id: `blk-${dbState.blocks.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    AuditEvent: makeModel(dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    AdminAuditLog: makeModel(dbState.adminAudits, () => ({
      id: `aal-${dbState.adminAudits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      readAt: null,
      createdAt: new Date().toISOString(),
    })),
    Conversation: makeModel(dbState.conversations, () => ({
      id: `convo-${dbState.conversations.length + 1}`,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    })),
    // Deal id PHẢI là uuid thật — deal_created metadata schema z.uuid()
    // (product-events.ts:189) reject id fixture dạng "deal-<n>".
    Deal: makeModel(dbState.deals, () => ({
      id: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    DealStatusHistory: makeModel(dbState.dealHistory, () => ({
      id: `dsh-${dbState.dealHistory.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    ProductEvent: makeModel(dbState.events, () => ({
      id: `pe-${dbState.events.length + 1}`,
      occurredAt: new Date().toISOString(),
    })),
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import { checkSellerPublicationRequirements } from "@/src/lib/seller-verification-policy";
import { assertListingPublishable } from "@/src/lib/listing-publication";
import { listingPublicationInputFromRow } from "@/src/lib/actions/helpers";
import { assertListingSellerInteractable } from "@/src/lib/deal";
import { isActiveBetaParticipant } from "@/src/lib/beta-access";
import { isListingSearchable } from "@/src/lib/search-query";
import {
  createListingAction,
  updateListingAction,
  toggleListingVisibilityAction,
  submitListingAction,
  saveListingDraftAction,
} from "@/src/lib/actions/listings";
import { approveListingAction } from "@/src/lib/actions/admin";
import { startConversationAction } from "@/src/lib/actions/chat";
import { createDealAction } from "@/src/lib/actions/deals";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(`${root}/${p}`, "utf8");

const mkUser = (over: Partial<Row>): Row & { id: string } => ({
  id: "user-x",
  email: "x@loaviet.test",
  passwordHash: "bcrypt-x",
  name: "X",
  role: "buyer",
  avatarUrl: null,
  phone: null,
  city: null,
  bio: null,
  isVerifiedSeller: false,
  adminRole: null,
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  sellerType: null,
  sellerOperatingProvinceCode: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

/** Admin operations (listing.moderate + beta_cohort.manage — KHÔNG cần step-up). */
const ADMIN_OPS = mkUser({
  id: "admin-ops",
  email: "ops@loaviet.test",
  name: "Ops",
  role: "admin",
  adminRole: "operations_admin",
});

/** Seller ĐỦ 8 yêu cầu policy v1 (Batch 6 verified-seller shape) — case flip CHỈ membership. */
const mkVerifiedSeller = (id: string, email: string): Row & { id: string } =>
  mkUser({
    id,
    email,
    name: `Seller ${id}`,
    role: "seller",
    emailVerifiedAt: "2026-10-01T00:00:00.000Z",
    phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
  });

const SELLER = mkVerifiedSeller("seller-1", "seller@loaviet.test");
/** Seller thứ hai — ELIGIBLE (đủ §7.8) cho chân buyer của các case chat/Deal. */
const SELLER2 = mkVerifiedSeller("seller-2", "seller2@loaviet.test");
/** Buyer — active private_beta_buyer member (§2.1 participant). */
const BUYER = mkUser({
  id: "buyer-1",
  email: "mua@loaviet.test",
  name: "Người Mua",
  role: "buyer",
});

/** Nạp seller + 3 row policy (acceptance/membership active/verification verified). */
const seedPolicyRows = (
  sellerId: string,
  over?: { membershipStatus?: string },
): void => {
  dbState.acceptances.push({
    id: `pa-${dbState.acceptances.length + 1}`,
    userId: sellerId,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: new Date().toISOString(),
  });
  dbState.memberships.push({
    id: `bcm-${dbState.memberships.length + 1}`,
    userId: sellerId,
    cohort: "founding_seller",
    status: over?.membershipStatus ?? "active",
    invitedBy: null,
    invitedAt: null,
    acceptedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  dbState.verifications.push({
    id: `sv-${dbState.verifications.length + 1}`,
    userId: sellerId,
    status: "verified",
    method: "operations_review",
    submittedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewerId: "admin-ops",
    reasonCode: "requirements_met",
    note: null,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

/** Membership private_beta_buyer active của BUYER (§2.1 participant). */
const seedBuyerMembership = (over: Row = {}): void => {
  dbState.memberships.push({
    id: `bcm-buyer-${dbState.memberships.length + 1}`,
    userId: BUYER.id,
    cohort: "private_beta_buyer",
    status: "active",
    invitedBy: null,
    invitedAt: null,
    acceptedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });
};

/** Flip CHỈ membership (founding_seller) của seller sang status — không đụng gì khác. */
const setSellerMembershipStatus = (sellerId: string, status: string): void => {
  const m = dbState.memberships.find((r) => r["userId"] === sellerId && r["cohort"] === "founding_seller");
  if (m === undefined) throw new Error(`no founding_seller membership for ${sellerId} (fixture)`);
  m["status"] = status;
};

// ─── Batch 4 fixtures (beta catalog + ảnh owned — publication-gate pattern) ──

const UUID_IMG = "00000000-0000-4000-8000-0000000000dd";
const IMG_URL = `/uploads/${UUID_IMG}.webp`;

const CATEGORY = {
  id: "cat-1",
  name: "Loa Bluetooth di động",
  slug: "portable_bluetooth_speaker",
  commissionRate: 5,
  sortOrder: 0,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const BRAND = { id: "brand-1", name: "JBL", slug: "jbl", logoUrl: null, createdAt: "2026-09-01T00:00:00.000Z" };
const MODEL = {
  id: "model-1",
  brandId: "brand-1",
  categoryId: CATEGORY.id,
  name: "Charge 5",
  slug: "jbl-charge-5",
  releaseYear: null,
  description: null,
  specs: null,
  image: null,
  status: "approved",
  mergedIntoId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

/** Ảnh upload MỚI thuộc seller — rule (1) ownership pass. */
const seedUpload = (ownerUserId: string): void => {
  dbState.uploads.push({
    id: `up-${dbState.uploads.length + 1}`,
    ownerUserId,
    storageKey: `${UUID_IMG}.webp`,
    bytes: 1024,
    width: 800,
    height: 600,
    createdAt: new Date().toISOString(),
  });
};

/** Ảnh ĐÃ GẮN vào listing (toggle/submit/approve input từ DB row). */
const seedImage = (listingId: string, url: string, checklistSlot: string | null, sortOrder = 0): void => {
  dbState.images.push({
    id: `img-${dbState.images.length + 1}`,
    listingId,
    url,
    sortOrder,
    checklistSlot,
  });
};

/** Listing fixture của seller — structured beta đầy đủ + 1 ảnh gắn (slot front). */
const seedListing = (sellerId: string, status: string, over?: Partial<Row>): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `listing-${dbState.listings.length + 1}`,
    sellerId,
    categoryId: CATEGORY.id,
    brandId: BRAND.id,
    title: "Loa JBL Charge 5 chính hãng",
    slug: `loa-jbl-charge-5-chinh-hang-${dbState.listings.length + 1}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status,
    rejectionReason: null,
    city: "Hà Nội",
    viewCount: 0,
    productModelId: MODEL.id,
    inventoryContext: "used",
    includedAccessories: null,
    knownDefects: null,
    repairHistory: null,
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: "ha-noi",
    communeLevelCode: null,
    locationDisplayName: "Khu vực Cầu Giấy",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  dbState.listings.push(row);
  seedImage(row.id, IMG_URL, "front");
  return row;
};

// ─── Session thật (publication-gate pattern — corrections #21: KHÔNG mock rbac) ─

const login = (user: Row, opts?: { isAdmin?: boolean }): string => {
  const id = `sess-${user.id}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: sha256Hex(token),
    isAdmin: opts?.isAdmin ?? false,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: null,
    userAgent: "unit-test-agent/1.0",
  });
  cookieState.store.set(SESSION_COOKIE, token);
  return id;
};

const fd = (entries: Record<string, string | string[]>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const item of v) form.append(k, item);
    else form.set(k, v);
  }
  return form;
};

/** Approve formData — post ĐÚNG `version` (updatedAt) mà review card đã render. */
const approveFd = (listing: Row, over?: Record<string, string>): FormData =>
  fd({ listingId: String(listing.id), version: String(listing.updatedAt), ...(over ?? {}) });

/** Form beta đầy đủ (structured + ảnh owned + slot) — các case block chỉ flip membership. */
const listingForm = (over?: Record<string, string | string[]>): FormData => {
  const form = fd({
    title: "Loa JBL Charge 5 chính hãng",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    categoryId: CATEGORY.id,
    brandId: BRAND.id,
    productModelId: MODEL.id,
    condition: "good",
    price: "1800000",
    city: "Hà Nội",
    inventoryContext: "used",
    provinceLevelCode: "ha-noi",
    locationDisplayName: "Khu vực Cầu Giấy",
    fulfillmentMethods: ["meetup"],
    images: [IMG_URL],
    imageSlots: ["front"],
  });
  if (over) {
    for (const [k, v] of Object.entries(over)) {
      if (Array.isArray(v)) {
        form.delete(k);
        for (const item of v) form.append(k, item);
      } else form.set(k, v);
    }
  }
  return form;
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

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const resetStores = (): void => {
  for (const store of Object.values(dbState)) (store as unknown[]).length = 0;
};

const seedBase = (): void => {
  dbState.users.push({ ...ADMIN_OPS }, { ...SELLER }, { ...SELLER2 }, { ...BUYER });
  dbState.categories.push({ ...CATEGORY });
  dbState.brands.push({ ...BRAND });
  dbState.models.push({ ...MODEL });
  // Cả hai seller đủ 8 yêu cầu (membership ACTIVE mặc định — case suspend tự flip).
  seedPolicyRows(SELLER.id);
  seedPolicyRows(SELLER2.id);
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  resetStores();
  seedBase();
  cookieState.store.clear();
  headerState.headers = new Headers();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── A. Publication gates (Batch 2/4) — suspended founding_seller membership ──

describe("A. publication gates — suspended founding_seller membership (flip CHỈ membership)", () => {
  beforeEach(() => {
    setSellerMembershipStatus(SELLER.id, "suspended");
  });

  it("A1. checkSellerPublicationRequirements → missing CHỈ founding_seller_membership_active (Batch 2 gate re-pinned)", async () => {
    const check = await checkSellerPublicationRequirements(SELLER.id);
    // 7 yêu cầu khác vẫn thỏa (flip-only pin) — suspension membership KHÔNG phải
    // account suspension (Batch 3) nên account_not_suspended cũng KHÔNG thiếu.
    expect(check).toEqual({ ok: false, missing: ["founding_seller_membership_active"] });
  });

  it("A2. assertListingPublishable → SELLER_PUBLICATION_BLOCKED TRƯỚC mọi content check (Batch 4 wrapper order pin)", async () => {
    const listing = seedListing(SELLER.id, "approved");
    seedUpload(SELLER.id); // ảnh owned — content stage SẴ pass nếu chạy tới
    // Fixture row là Record<string, unknown> — cast sang ListingPublicationRow
    // (mock trả đủ trường; type chỉ cần cho biên dịch).
    const input = await listingPublicationInputFromRow(
      listing as unknown as Parameters<typeof listingPublicationInputFromRow>[0],
      SELLER.id,
    );
    // Cố ý làm content SAI (ảnh URL ngoài — rule 3 IMAGE_URL_INVALID): nếu
    // content check chạy TRƯỚC seller gate, lỗi sẽ là IMAGE_URL_INVALID.
    input.imageUrls = ["https://evil.example/x.png"];

    await expect(assertListingPublishable(input)).rejects.toThrow(
      "SELLER_PUBLICATION_BLOCKED:founding_seller_membership_active",
    );
  });

  it("A3. createListingAction → typed error, KHÔNG Listing.create (spec §4.4/§4.9)", async () => {
    seedUpload(SELLER.id);
    login(SELLER);

    const state = await createListingAction({}, listingForm());

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("thành viên founding_seller còn hoạt động");
    expect(dbState.listings).toHaveLength(0); // KHÔNG transition vào review
    expect(dbState.images).toHaveLength(0);
  });

  it("A4. updateListingAction: content-change → pending blocked; status + nội dung giữ nguyên", async () => {
    seedUpload(SELLER.id);
    const listing = seedListing(SELLER.id, "approved");
    login(SELLER);

    const state = await updateListingAction(
      {},
      listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: listing.id }),
    );

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("thành viên founding_seller còn hoạt động");
    // KHÔNG transition, KHÔNG ghi đè nội dung
    expect(listing.status).toBe("approved");
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng");
  });

  it("A5. toggleListingVisibilityAction: hidden → approved blocked → redirect /sell/verification, status unchanged (b4-holistic-2)", async () => {
    seedUpload(SELLER.id);
    const listing = seedListing(SELLER.id, "hidden", { approvedContentAt: "2026-10-01T00:00:00.000Z" });
    login(SELLER);

    // b4-holistic-2: block HIỂN THỊ qua redirect typed (KHÔNG còn silent return —
    // ruling recorded: code thắng plan text "silent return").
    const url = await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId: listing.id })));

    expect(url).toBe("/sell/verification");
    expect(listing.status).toBe("hidden");
  });

  it("A6. submitListingAction: draft → pending blocked (transition thứ 5 — corrections #30) → redirect /sell/verification + audit submit_blocked", async () => {
    seedUpload(SELLER.id);
    const listing = seedListing(SELLER.id, "draft");
    login(SELLER);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: listing.id })));

    expect(url).toBe("/sell/verification");
    expect(listing.status).toBe("draft"); // KHÔNG transition vào review
    const evt = dbState.audits.find((r) => r.action === "listing.submit_blocked");
    expect(evt).toMatchObject({
      actorId: SELLER.id,
      resourceType: "Listing",
      resourceId: listing.id,
      reason: "SELLER_PUBLICATION_BLOCKED:founding_seller_membership_active",
    });
  });

  it("A7. approveListingAction (admin): KHÔNG approve + audit 'listing.approve_blocked' (defense-in-depth — Review Focus 3)", async () => {
    seedUpload(SELLER.id);
    const listing = seedListing(SELLER.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending"); // KHÔNG approve — kể cả admin duyệt
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: SELLER.id,
      resourceType: "Listing",
      resourceId: listing.id,
      reason: "publication_requirements_unmet",
    });
    expect(evt!.detail).toContain("founding_seller_membership_active");
    // KHÔNG có event approved cho lần này
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0); // legacy audit cũng KHÔNG ghi
  });

  it("A8. saveListingDraftAction: VẪN lưu nháp (§4.4 — draft TRƯỚC verification, gate KHÔNG áp; corrections #30)", async () => {
    seedUpload(SELLER.id);
    login(SELLER);

    const url = await expectRedirect(() => saveListingDraftAction({}, listingForm()));

    expect(url).toMatch(/^\/sell\/([^/]+)\/edit\?saved=draft$/);
    expect(dbState.listings).toHaveLength(1);
    expect(dbState.listings[0]).toMatchObject({ sellerId: SELLER.id, status: "draft" });
  });
});

// ─── A9. No over-block — CẢ NĂM transition pass khi membership active ─────────

describe("A9. publication gates — membership ACTIVE: cả năm transition pass (no over-block)", () => {
  it("create → pending; update content-change → pending; toggle hidden → approved; submit draft → pending; approve pending → approved", async () => {
    seedUpload(SELLER.id);
    login(SELLER);

    // 1. create → pending
    const createdUrl = await expectRedirect(() => createListingAction({}, listingForm()));
    expect(createdUrl).toContain("/sell/my?created=1");
    const created = dbState.listings.find((r) => r["status"] === "pending");
    expect(created).toMatchObject({ sellerId: SELLER.id });

    // 2. update content-change (approved → pending)
    const approvedRow = seedListing(SELLER.id, "approved");
    const updateUrl = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: approvedRow.id }),
      ),
    );
    expect(updateUrl).toContain("/sell/my?updated=1");
    expect(approvedRow.status).toBe("pending");

    // 3. toggle hidden → approved (approvedContentAt ĐÃ SET — content đã được duyệt)
    const hiddenRow = seedListing(SELLER.id, "hidden", { approvedContentAt: "2026-10-01T00:00:00.000Z" });
    await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId: hiddenRow.id })));
    expect(hiddenRow.status).toBe("approved");

    // 4. submit draft → pending
    const draftRow = seedListing(SELLER.id, "draft");
    const submitUrl = await expectRedirect(() => submitListingAction(fd({ listingId: draftRow.id })));
    expect(submitUrl).toBe("/sell/my?submitted=1");
    expect(draftRow.status).toBe("pending");

    // 5. approve pending → approved (admin) + audit listing.approved
    login(ADMIN_OPS, { isAdmin: true });
    const pendingRow = seedListing(SELLER.id, "pending");
    await approveListingAction(approveFd(pendingRow));
    expect(pendingRow.status).toBe("approved");
    expect(dbState.audits.some((r) => r.action === "listing.approved" && r.resourceId === pendingRow.id)).toBe(true);
  });
});

// ─── B. Batch 6 D2 — seller-side guard (gọi guard THẬT, KHÔNG re-implement) ───

describe("B. assertListingSellerInteractable (Batch 6 D2) — suspended membership", () => {
  it("B1. suspended-membership seller → SELLER_MEMBERSHIP_INACTIVE (guard THẬT)", async () => {
    setSellerMembershipStatus(SELLER.id, "suspended");
    await expect(assertListingSellerInteractable(SELLER.id)).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
  });

  it("B2. active seller → pass (no over-block)", async () => {
    await expect(assertListingSellerInteractable(SELLER.id)).resolves.toBeUndefined();
  });
});

// ─── C. Chat surface — startConversationAction ───────────────────────────────

describe("C. startConversationAction — suspended membership trên cả hai chân", () => {
  it("C1. member buyer trên live listing của suspended-membership seller → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2), KHÔNG Conversation, KHÔNG emit", async () => {
    setSellerMembershipStatus(SELLER.id, "suspended");
    const listing = seedListing(SELLER.id, "approved");
    seedBuyerMembership();
    login(BUYER);

    await expect(startConversationAction(fd({ listingId: listing.id }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    expect(dbState.conversations).toHaveLength(0);
    expect(dbState.events.filter((e) => e["name"] === "conversation_started")).toHaveLength(0);
  });

  it("C2. suspended-membership member làm BUYER (listing của seller eligible khác) → BETA_MEMBERSHIP_REQUIRED (Task 6)", async () => {
    // SELLER (founding_seller suspended) đóng vai trò buyer trên listing SELLER2.
    const listing = seedListing(SELLER2.id, "approved");
    setSellerMembershipStatus(SELLER.id, "suspended");
    login(SELLER);

    await expect(startConversationAction(fd({ listingId: listing.id }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(dbState.conversations).toHaveLength(0);
  });

  it("C3. active seller + member buyer → tạo hội thoại (no over-block) + conversation_started emitted", async () => {
    const listing = seedListing(SELLER.id, "approved");
    seedBuyerMembership();
    login(BUYER);

    await expect(startConversationAction(fd({ listingId: listing.id }))).rejects.toThrow(
      "NEXT_REDIRECT", // tạo thành công → redirect /chat/<id>
    );
    expect(dbState.conversations).toHaveLength(1);
    expect(dbState.conversations[0]).toMatchObject({
      listingId: listing.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
    });
    // ProductEvent row THẬT trong db mock (key stubbed — KHÔNG chỉ spy)
    expect(dbState.events.filter((e) => e["name"] === "conversation_started")).toHaveLength(1);
  });
});

// ─── D. Deal surface — createDealAction (C2 — actor LÀ buyer, Batch 6 D11) ────

describe("D. createDealAction — suspended membership trên cả hai chân của Deal surface", () => {
  it("D1. member buyer tạo Deal trên listing của suspended-membership seller → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2), KHÔNG Deal", async () => {
    setSellerMembershipStatus(SELLER.id, "suspended");
    const listing = seedListing(SELLER.id, "approved");
    seedBuyerMembership();
    login(BUYER);

    const state = await createDealAction({}, fd({ listingId: listing.id, agreedPrice: "1500000" }));

    expect(state).toEqual({ error: "SELLER_MEMBERSHIP_INACTIVE" });
    expect(dbState.deals).toHaveLength(0);
    expect(dbState.dealHistory).toHaveLength(0);
    expect(dbState.events.filter((e) => e["name"] === "deal_created")).toHaveLength(0);
  });

  it("D2. suspended-membership buyer → BETA_MEMBERSHIP_REQUIRED (Task 6 — seller vẫn eligible), KHÔNG Deal", async () => {
    const listing = seedListing(SELLER2.id, "approved");
    setSellerMembershipStatus(SELLER.id, "suspended");
    login(SELLER); // SELLER (membership suspended) đóng vai trò buyer

    const state = await createDealAction({}, fd({ listingId: listing.id, agreedPrice: "1500000" }));

    expect(state).toEqual({ error: "BETA_MEMBERSHIP_REQUIRED" });
    expect(dbState.deals).toHaveLength(0);
  });

  it("D3. eligible pair (active seller + member buyer + hội thoại) → Deal open tạo (no over-block)", async () => {
    const listing = seedListing(SELLER.id, "approved");
    seedBuyerMembership();
    dbState.conversations.push({
      id: "convo-1",
      listingId: listing.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    });
    login(BUYER);

    const state = await createDealAction({}, fd({ listingId: listing.id, agreedPrice: "1500000" }));

    expect(state).toEqual({ success: "Đã tạo thỏa thuận." });
    expect(dbState.deals).toHaveLength(1);
    expect(dbState.deals[0]).toMatchObject({
      listingId: listing.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
      status: "open",
      agreedPrice: 1_500_000,
    });
    expect(dbState.events.filter((e) => e["name"] === "deal_created")).toHaveLength(1);
  });
});

// ─── E. Task 6 read — isActiveBetaParticipant ─────────────────────────────────

describe("E. isActiveBetaParticipant (Task 6 read) — suspended/hết hạn membership", () => {
  it("E1. suspended membership → false; active → true (no over-block); hết hạn → false (corrections #16)", async () => {
    seedBuyerMembership();
    expect(await isActiveBetaParticipant(BUYER.id)).toBe(true);

    const buyerMembership = dbState.memberships.find(
      (r) => r["userId"] === BUYER.id && r["cohort"] === "private_beta_buyer",
    );
    buyerMembership!["status"] = "suspended";
    expect(await isActiveBetaParticipant(BUYER.id)).toBe(false);

    buyerMembership!["status"] = "active";
    buyerMembership!["expiresAt"] = "2020-01-01T00:00:00.000Z";
    expect(await isActiveBetaParticipant(BUYER.id)).toBe(false);
  });

  it("E2. suspended founding_seller membership → false (cùng read phục vụ chân seller-as-buyer)", async () => {
    setSellerMembershipStatus(SELLER.id, "suspended");
    expect(await isActiveBetaParticipant(SELLER.id)).toBe(false);
    setSellerMembershipStatus(SELLER.id, "active");
    expect(await isActiveBetaParticipant(SELLER.id)).toBe(true);
  });
});

// ─── F. Live listings stay live (Batch 3 A2 precedent) ───────────────────────

describe("F. live listings stay live and readable while suspended (Batch 3 A2 precedent)", () => {
  it("F1. isListingSearchable('approved') unchanged + listing row untouched sau các lần từ chối chat/Deal mới", async () => {
    setSellerMembershipStatus(SELLER.id, "suspended");
    const listing = seedListing(SELLER.id, "approved");
    const before = JSON.stringify(listing);
    seedBuyerMembership();
    login(BUYER);

    // Suspension blocks NEW publication/interactions — KHÔNG phải existing inventory:
    // search seam vẫn nhận "approved" (isListingSearchable — S6 seam unchanged).
    expect(isListingSearchable("approved")).toBe(true);
    expect(isListingSearchable("hidden")).toBe(false);

    // New conversation/Deal trên listing live BỊ TỪ CHỐI (Batch 6 D2)…
    await expect(startConversationAction(fd({ listingId: listing.id }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    const dealState = await createDealAction({}, fd({ listingId: listing.id }));
    expect(dealState).toEqual({ error: "SELLER_MEMBERSHIP_INACTIVE" });

    // …nhưng row listing NGUYÊN VẸN (không auto-unpublish/ẩn/xóa — removal là
    // moderator decision qua Batch 3 takedown, KHÔNG tự động).
    expect(JSON.stringify(listing)).toBe(before);
    expect(listing.status).toBe("approved");
    expect(dbState.listings).toHaveLength(1);
  });

  it("F2. listing-page CTA render D12 neutral copy cho non-member buyer (source-contract — Task 6 wiring)", () => {
    const src = read("app/listings/[slug]/page.tsx");
    // Task 6 (corrections #18): trang consults isActiveBetaParticipant cho buyer
    // logged-in non-owner — KHÔNG render form chết cho non-member.
    expect(src).toContain("isActiveBetaParticipant");
    // D12 neutral copy (PROVISIONAL) thay form nhắn tin.
    expect(src).toContain("Tính năng nhắn tin đang giới hạn cho thành viên beta");
  });
});
