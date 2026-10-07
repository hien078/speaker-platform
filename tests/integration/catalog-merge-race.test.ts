/**
 * mergeModelAction — concurrent OPPOSITE merges (A→B đồng thời B→A) —
 * REAL-DB race integration test (b4-holistic round-4 LOW partial).
 *
 * Finding: guard merge chéo hiện tại chỉ chặn tuần tự (stale page) — hai
 * request ĐỒNG THỜI dưới READ COMMITTED: tx1 đọc target B approved (MVCC),
 * claim source A; tx2 đọc target A approved, claim source B — hai claim
 * lock HAI row khác nhau, Listing/PriceHistory moves đụng row disjoint
 * (productModelId=A của tx1 vs =B của tx2) → CẢ HAI commit → A merged vào B
 * VÀ B merged vào A — mọi listing trỏ model merged, MODEL_INVALID chặn
 * approve/submit/toggle vĩnh viễn (đúng failure finding 464).
 *
 * Fix (verified): lock TARGET row bằng CAS UPDATE (row lock) TRƯỚC khi claim
 * source — merge ngược rồi hoặc BLOCK (re-evaluate predicate sau commit bên
 * kia: thấy 'merged' → 0 rows → sentinel MODEL_TARGET_INVALID) hoặc Postgres
 * deadlock-abort MỘT bên (rethrow → fail closed). Cả hai: TỐI ĐA MỘT merge
 * commit.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh) — KHÔNG chạy trong
 * `npm test`. Mock recipe như listing-delete-race.test.ts: cookie store
 * điều khiển được, session THẬT, action THẬT, hai connection đồng thời.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { mergeModelAction } from "../../src/lib/actions/catalog";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = () => `it-merge-${Date.now()}-${seq++}`;

async function mkAdmin(): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "IT Merge Race",
    role: "admin",
    adminRole: "operations_admin", // listing.moderate — cùng mapping admin/catalog
  });
  return u.id;
}

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = async (userId: string): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId, { isAdmin: true });
};

/** Cặp model approved CÙNG category + CÙNG brand (điều kiện merge hợp lệ). */
async function mkModelPair(categoryId: string, brandId: string): Promise<{ a: string; b: string }> {
  const mk = async (name: string) => {
    const m = await db.orm.public.ProductModel.create({
      brandId,
      categoryId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${uid()}`,
      status: "approved",
    });
    return m.id;
  };
  return { a: await mk("JBL Charge 5"), b: await mk("JBL Charge 6") };
}

const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  models: [] as string[],
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
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
  }
  for (const id of created.models) {
    await db.orm.public.PriceHistory.where({ modelId: id }).deleteAll();
    await db.orm.public.ProductModel.where({ id }).deleteAll();
  }
  for (const id of created.brands) {
    await db.orm.public.Brand.where({ id }).deleteAll();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.SellerVerification.where({ userId: id }).deleteAll();
    await db.orm.public.User.where({ id }).deleteAll();
  }
  created.users.length = 0;
  created.categories.length = 0;
  created.brands.length = 0;
  created.models.length = 0;
  created.listings.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── RACE: hai merge ngược ĐỒNG THỜI ─────────────────────────────────────────

d("mergeModelAction — concurrent opposite merges (b4-holistic round-4 LOW partial)", () => {
  /**
   * Vòng lặp N cặp model MỚI (mỗi vòng 2 model approved + 1 listing trên A) —
   * hai action ĐỒNG THỜI qua Promise.allSettled (2 connection pool thật).
   * Trước fix: CẢ HAI tx đọc target approved (MVCC) → claim source khác row →
   * moves disjoint → CẢ HAI commit → A.merged=B VÀ B.merged=A. Sau fix
   * (target CAS lock): tối đa MỘT commit mỗi vòng — vòng nào cũng.
   */
  const ROUNDS = 3;

  it("A→B đồng thời B→A: TỐI ĐA MỘT merge commit — model còn lại approved, listing trỏ model SỐNG", async () => {
    const adminId = await mkAdmin();
    created.users.push(adminId);
    const cat = await db.orm.public.Category.create({
      name: `Loa IT ${uid()}`,
      slug: `it-merge-${uid()}`,
      commissionRate: 5,
      sortOrder: 0,
      isActive: true,
    });
    created.categories.push(cat.id);
    const brand = await db.orm.public.Brand.create({ name: `JBL ${uid()}`, slug: `jbl-${uid()}` });
    created.brands.push(brand.id);
    const seller = await db.orm.public.User.create({
      email: `${uid()}@integration.test`,
      passwordHash: PASSWORD_HASH,
      name: "IT Merge Seller",
      role: "seller",
    });
    created.users.push(seller.id);
    await login(adminId);

    for (let round = 0; round < ROUNDS; round++) {
      const pair = await mkModelPair(cat.id, brand.id);
      created.models.push(pair.a, pair.b);
      // listing trỏ model A — nếu A merge vào B, listing chuyển sang B (model
      // SỐNG approved); nếu B merge vào A, listing giữ A (vẫn sống).
      const listing = await db.orm.public.Listing.create({
        sellerId: seller.id,
        categoryId: cat.id,
        brandId: brand.id,
        productModelId: pair.a,
        title: `Tin model A vòng ${round}`,
        slug: `tin-model-a-${uid()}`,
        description: "Tin trỏ model A",
        condition: "good",
        price: 1_000_000,
        status: "approved",
        city: "Hà Nội",
      });
      created.listings.push(listing.id);

      // HAI merge ngược ĐỒNG THỜI — allSettled: một bên có thể reject
      // (deadlock abort — fail closed) hoặc resolve no-op (sentinel stale).
      const results = await Promise.allSettled([
        mergeModelAction(fd({ modelId: pair.a, targetId: pair.b })), // A → B
        mergeModelAction(fd({ modelId: pair.b, targetId: pair.a })), // B → A
      ]);

      const a = await db.orm.public.ProductModel.first({ id: pair.a });
      const b = await db.orm.public.ProductModel.first({ id: pair.b });
      const mergedCount = [a!.status, b!.status].filter((s) => s === "merged").length;

      // Trước fix: 2 (CẢ HAI merged — failure finding 464). Sau fix: đúng 1.
      // KHÔNG bao giờ 2 — model approved canonical còn lại để listing trỏ.
      expect(
        mergedCount,
        `vòng ${round}: tối đa MỘT model được merged (A=${a!.status}, B=${b!.status})`,
      ).toBeLessThanOrEqual(1);
      // một merge THẬT SỰ thành công mỗi vòng (một bên commit) — model còn lại
      // approved và KHÔNG trỏ vào model merged (mergedIntoId của approved = null)
      expect(mergedCount, `vòng ${round}: một merge commit`).toBe(1);
      const merged = a!.status === "merged" ? a! : b!;
      const survivor = a!.status === "merged" ? b! : a!;
      expect(survivor.status).toBe("approved");
      expect(survivor.mergedIntoId).toBeNull(); // survivor KHÔNG bị merge ngược lại
      expect(merged.mergedIntoId).toBe(survivor.id);

      // listing trỏ model SỐNG (approved) — KHÔNG bao giờ trỏ model merged
      // (MODEL_INVALID chặn approve/submit/toggle vĩnh viễn nếu có).
      const listingRow = await db.orm.public.Listing.first({ id: listing.id });
      expect(listingRow!.productModelId).toBe(survivor.id);

      // audit model.merged: đúng MỘT event cho merge thắng cuộc
      const mergedEvents = await db.orm.public.AuditEvent
        .where({ action: "model.merged", resourceId: merged.id })
        .all();
      expect(mergedEvents).toHaveLength(1);

      // dọn listing vòng này để vòng sau sạch (FK productModelId)
      await db.orm.public.Listing.where({ id: listing.id }).deleteAll();
      void results;
    }
  });

  it("một merge HOÀN TẤT trước, merge ngược SAU ĐÓ (tuần tự) → sentinel no-op (giữ hợp đồng stale-page)", async () => {
    const adminId = await mkAdmin();
    created.users.push(adminId);
    const cat = await db.orm.public.Category.create({
      name: `Loa IT ${uid()}`,
      slug: `it-merge-seq-${uid()}`,
      commissionRate: 5,
      sortOrder: 0,
      isActive: true,
    });
    created.categories.push(cat.id);
    const brand = await db.orm.public.Brand.create({ name: `Marshall ${uid()}`, slug: `marshall-${uid()}` });
    created.brands.push(brand.id);
    const pair = await mkModelPair(cat.id, brand.id);
    created.models.push(pair.a, pair.b);
    await login(adminId);

    // A → B thành công
    await mergeModelAction(fd({ modelId: pair.a, targetId: pair.b }));
    // B → A SAU ĐÓ: target A đã merged → sentinel no-op (KHÔNG resurrect)
    await mergeModelAction(fd({ modelId: pair.b, targetId: pair.a }));

    const a = await db.orm.public.ProductModel.first({ id: pair.a });
    const b = await db.orm.public.ProductModel.first({ id: pair.b });
    expect(a!.status).toBe("merged");
    expect(a!.mergedIntoId).toBe(pair.b);
    expect(b!.status).toBe("approved"); // KHÔNG bị merge ngược
    expect(b!.mergedIntoId).toBeNull();
  });
});
