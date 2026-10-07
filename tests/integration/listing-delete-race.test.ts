/**
 * Listing delete vs moderation takedown — REAL-DB race integration test
 * (review fix Task 6 item 1 — HIGH).
 *
 * Root cause (node_modules/@prisma/orm-family-sql/dist/orm-client.mjs
 * `#findFirstMatchingRowIdentityWhere` ~4794/~4892): terminal đơn-row
 * `.delete()` SELECT row khớp filter ĐẦU (không FOR UPDATE) rồi
 * `DELETE WHERE id = <id đó>` — điều kiện filter KHÔNG nằm trong statement
 * write. Vì vậy `Listing.where({ id, status }).delete()` KHÔNG phải
 * compare-and-set: takedown tx giữ row lock, select của delete thấy status
 * CŨ (MVCC), DELETE-by-id chờ lock, takedown COMMIT → DELETE vẫn xoá row
 * vừa bị takedown (cascade ảnh/cart/wishlist — nguồn moderation record bị
 * phá). `deleteAll()` compile TOÀN BỘ filter vào MỘT statement — Postgres
 * re-check WHERE sau khi lock thả → 0 rows → typed error, row SỐNG SÓT.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh) — KHÔNG chạy trong
 * `npm test`. Unit test (listing-lock.test.ts) pin logic qua db mock với
 * fidelity hai bước; ở đây chứng minh NGỮ ĐÓ against DB THẬT + ORM THẬT
 * với hai connection (takedown tx + action) và barrier row lock:
 *
 *  1. RACE: takedown tx giữ row lock (chưa commit) → deleteListingAction
 *     đọc approved (MVCC) → deleteAll chờ lock → takedown commit →
 *     deleteAll re-evaluate → 0 rows → LISTING_MODERATION_LOCKED →
 *     listing SỐNG SÓT với status `removed`, ảnh/cart NGUYÊN VẸN.
 *  2. HAPPY PATH: listing pending không có đơn → deleteAll xoá row →
 *     ảnh + cart được dọn (deleteAll dọn từng bảng — không phụ thuộc cascade).
 *
 * next/headers mock (cookie store điều khiển được — requireUser cần cookies()
 * ngoài request scope); next/cache mock (revalidatePath). Phần DB là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── Cookie store điều khiển được (next/headers) ─────────────────────────────

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
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { deleteListingAction } from "../../src/lib/actions/listings";

/** Action kết thúc bằng redirect() → throw NEXT_REDIRECT — coi là THÀNH CÔNG, trả URL. */
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

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const uid = (): string => `it-race-${Date.now()}-${seq++}`;

async function mkUser(over: Record<string, unknown> = {}): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "IT Race",
    role: "buyer",
    ...over,
  });
  return u.id;
}

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Đăng nhập user trên cookie store mock — session thật trong DB scratch. */
const login = async (userId: string): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId, { isAdmin: false });
};

const createdUsers: string[] = [];
const createdCategories: string[] = [];

/** Xoá AuditEvent (SetNull) trước, rồi user (cascade session/notification). */
async function cleanupUser(userId: string): Promise<void> {
  const events = await db.orm.public.AuditEvent.where({ actorId: userId }).all();
  await db.orm.public.User.where({ id: userId }).deleteAll();
  for (const e of events) {
    await db.orm.public.AuditEvent.where({ id: e.id }).deleteAll();
  }
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  for (const id of createdUsers) {
    await cleanupUser(id);
  }
  createdUsers.length = 0;
  for (const catId of createdCategories) {
    await db.orm.public.Category.where({ id: catId }).deleteAll();
  }
  createdCategories.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

/** Listing approved của seller + 1 ảnh + 1 cart item của buyer. */
async function seedListing(sellerId: string, buyerId: string): Promise<{
  listingId: string;
  imageId: string;
  cartItemId: string;
}> {
  const cat = await db.orm.public.Category.create({
    name: `Danh mục IT ${uid()}`,
    slug: `it-cat-${uid()}`,
  });
  createdCategories.push(cat.id);
  const listing = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.id,
    title: `Loa IT ${uid()}`,
    slug: `it-listing-${uid()}`,
    description: "Mô tả đủ dài cho integration test",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
  });
  const image = await db.orm.public.ListingImage.create({
    listingId: listing.id,
    url: `/uploads/it-${uid()}.jpg`,
    sortOrder: 0,
  });
  const cart = await db.orm.public.Cart.create({ userId: buyerId });
  const cartItem = await db.orm.public.CartItem.create({
    cartId: cart.id,
    listingId: listing.id,
    quantity: 1,
  });
  return { listingId: listing.id, imageId: image.id, cartItemId: cartItem.id };
}

// ─── 1. RACE — takedown tx giữ row lock, delete chạy song song ───────────────

d("deleteListingAction vs takedown — REAL-DB race (item 1 HIGH)", () => {
  it("takedown tx giữ row lock → delete đọc approved (MVCC) → deleteAll chờ lock → takedown commit → 0 rows → LISTING_MODERATION_LOCKED, listing SỐNG SÓT removed, ảnh/cart NGUYÊN VẸN", async () => {
    const sellerId = await mkUser({ role: "seller" });
    const buyerId = await mkUser();
    createdUsers.push(sellerId, buyerId);
    const { listingId, imageId, cartItemId } = await seedListing(sellerId, buyerId);
    await login(sellerId);

    // T2 = takedown tx (hiệu ứng DB: status → removed) — mở tx, UPDATE lấy
    // row lock, CHƯA commit → tx giữ lock park lại (barrier như
    // multi-row-writes.test.ts).
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    const t2 = db.transaction(async (tx) => {
      await tx.orm.public.Listing
        .where({ id: listingId })
        .where((l) => l.status.in(["approved", "hidden", "pending"]))
        .updateAll({ status: "removed" });
      signalLockTaken(); // lock đang giữ, tx vẫn mở
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    // Flow = deleteListingAction của seller: đọc listing (MVCC — T2 chưa
    // commit → thấy approved), qua guard, tới deleteAll
    // .where({ id, status: "approved" }) → BLOCK trên row lock của T2.
    const flow = deleteListingAction(fd({ listingId }));
    // cho flow kịp chạm write — nó KHÔNG THỂ qua được lock của T2, nên sau
    // sleep chắc chắn đang block (select của nó đã thấy approved).
    await sleep(500);
    // T2 commit TRƯỚC khi await flow — flow đang block TRÊN row lock của T2,
    // chỉ thả khi T2 commit; commit sau await flow = deadlock.
    commitT2();

    // deleteAll re-evaluate WHERE sau khi lock thả → status đã removed →
    // 0 rows → typed redirect (old .delete() sẽ DELETE WHERE id — row MẤT).
    // b4-holistic round-3: CAS 0-rows → redirect CONCURRENT_CHANGE (code trung
    // thực — row đổi tay giữa read và write), KHÔNG throw ra error boundary.
    const url = await expectRedirect(() => flow);
    expect(url).toBe("/sell/my?error=CONCURRENT_CHANGE");
    await t2;

    // Listing SỐNG SÓT với status removed — nguồn moderation record nguyên vẹn
    const listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing).not.toBeNull();
    expect(listing!.status).toBe("removed");
    // Ảnh + cart item KHÔNG bị cascade (row chưa bao giờ bị xoá)
    const image = await db.orm.public.ListingImage.first({ id: imageId });
    expect(image).not.toBeNull();
    const cartItem = await db.orm.public.CartItem.first({ id: cartItemId });
    expect(cartItem).not.toBeNull();
  });

  it("HAPPY PATH: listing pending không có đơn → deleteAll xoá row + dọn ảnh + cart (không phụ thuộc cascade)", async () => {
    const sellerId = await mkUser({ role: "seller" });
    const buyerId = await mkUser();
    createdUsers.push(sellerId, buyerId);
    const { listingId, imageId, cartItemId } = await seedListing(sellerId, buyerId);
    await db.orm.public.Listing
      .where({ id: listingId })
      .updateAll({ status: "pending" });
    await login(sellerId);

    await deleteListingAction(fd({ listingId }));

    const listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing).toBeNull(); // row gone
    const image = await db.orm.public.ListingImage.first({ id: imageId });
    expect(image).toBeNull(); // ảnh được dọn
    const cartItem = await db.orm.public.CartItem.first({ id: cartItemId });
    expect(cartItem).toBeNull(); // cart được dọn
  });
});
