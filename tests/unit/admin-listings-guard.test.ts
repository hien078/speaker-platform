/**
 * Admin listings page — server-side guard (review follow-up Batch 2 Task 4,
 * spec §4.5/§4.9 + Acceptance Gate "every admin page/action guarded
 * server-side").
 *
 * Trang moderation queue phải TỰ guard `listing.moderate` — requireAdminUser
 * ở layout chỉ là cổng vào /admin (mọi adminRole đều qua được), KHÔNG phải
 * quyền xem queue; action approve/reject đã guard riêng
 * (src/lib/actions/admin.ts — defense-in-depth: control vắng mặt ≠ quyền).
 *
 * Hợp đồng:
 *  1. support/analyst (chỉ admin.access) → FORBIDDEN — và guard chạy TRƯỚC
 *     mọi data read (db không bị chạm).
 *  2. moderator/operations_admin (có listing.moderate) → render queue.
 *  3. Chưa đăng nhập → FORBIDDEN.
 *
 * Cơ chế mock như admin-finance-readonly.test.ts: session seam điều khiển
 * được, guard thật chạy qua rbac thật; db fixture 1 listing pending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// Session seam — guard đọc qua getSessionFromCookie (rbac thật)
const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
}));

vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(async () => sessionState.current),
}));

// Page import action để gắn <form action> — stub là đủ; guard của action
// assert ở rbac.test.ts + financial-shutdown-actions.test.ts.
vi.mock("@/src/lib/actions/admin", () => ({
  approveListingAction: vi.fn(),
  rejectListingAction: vi.fn(),
}));

// db fixture — chainable query builder; đếm lần .all() để assert guard-before-read
const dbState = vi.hoisted(() => ({ allCalls: 0 }));

vi.mock("@/src/prisma/db.client", () => {
  const LISTING = {
    id: "listing-1",
    title: "Loa JBL Charge 5 cũ",
    price: 1_800_000,
    status: "pending",
    condition: "used",
    city: "Hà Nội",
    description: "Loa bluetooth cũ còn tốt",
    createdAt: "2026-10-06T08:00:00.000Z",
    images: [{ url: "/loa.jpg" }],
    seller: { name: "Trần Bán", email: "ban@loaviet.test", isVerifiedSeller: false },
    category: { name: "Loa bluetooth" },
    brand: null,
  };
  const chain = {
    where: () => chain,
    include: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    all: async () => {
      dbState.allCalls += 1;
      return [LISTING];
    },
  };
  return { db: { orm: { public: { Listing: chain } } } };
});

import * as listingsPage from "../../app/admin/listings/page";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION = {
  id: "sess-1",
  userId: "user-1",
  isAdmin: true,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-10-06T20:00:00.000Z",
  steppedUpAt: null,
  userAgent: null,
} as const;

/** SessionUser fixture — adminRole là nguồn quyền duy nhất (spec §8.5). */
const userWith = (adminRole: string | null) => ({
  id: "user-1",
  email: "u@loaviet.test",
  name: "U",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole,
  sessionId: "sess-1",
});

const login = (adminRole: string | null): void => {
  sessionState.current = { session: { ...SESSION }, user: userWith(adminRole) };
};

type PageFn = (props: { searchParams: Promise<{ tab?: string }> }) => Promise<unknown>;
const AdminListingsPage = listingsPage.default as unknown as PageFn;
const call = () => AdminListingsPage({ searchParams: Promise.resolve({}) });

// ─── React element tree helpers (async server component return value) ───────

type ElementLike = { type?: unknown; props?: { children?: unknown } | null };

/** Toàn bộ text trong tree — assert nội dung render ra cho role được phép. */
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

beforeEach(() => {
  sessionState.current = null;
  dbState.allCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Guard listing.moderate — deny sai role TRƯỚC khi đọc db (spec §4.5) ─────

describe("admin listings page — guard listing.moderate server-side (spec §4.5/§4.9)", () => {
  it("support (chỉ admin.access) → FORBIDDEN, db KHÔNG bị chạm", async () => {
    login("support");
    await expect(call()).rejects.toThrowError(/^FORBIDDEN$/);
    expect(dbState.allCalls).toBe(0);
  });

  it("analyst (admin.access + analytics.read) → FORBIDDEN, db KHÔNG bị chạm", async () => {
    login("analyst");
    await expect(call()).rejects.toThrowError(/^FORBIDDEN$/);
    expect(dbState.allCalls).toBe(0);
  });

  it("chưa đăng nhập → FORBIDDEN (fail closed)", async () => {
    await expect(call()).rejects.toThrowError(/^FORBIDDEN$/);
    expect(dbState.allCalls).toBe(0);
  });

  it("moderator (listing.moderate) → render queue", async () => {
    login("moderator");
    const tree = await call();
    expect(textOf(tree)).toContain("Loa JBL Charge 5 cũ");
    expect(dbState.allCalls).toBe(1);
  });

  it("operations_admin (listing.moderate) → render queue", async () => {
    login("operations_admin");
    const tree = await call();
    expect(textOf(tree)).toContain("Loa JBL Charge 5 cũ");
    expect(dbState.allCalls).toBe(1);
  });
});
