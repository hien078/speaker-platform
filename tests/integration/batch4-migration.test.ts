/**
 * Batch 4 migration integration tests — plan Task 1 (batch 4), spec §8
 * (migration strategy: additive-first) + §5.6 (listing domain) + §5.6.2
 * (lifecycle `archived` — reserved) + §5.6.4 (upload ownership) + §9 Batch 4.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `batch4_listing_quality` (Task 1):
 *  - ADDITIVE: Listing nhận create + read round-trip với MỌI cột structured
 *    mới (inventoryContext, includedAccessories, knownDefects, repairHistory,
 *    fulfillmentMethods Json, provinceLevelCode, communeLevelCode,
 *    locationDisplayName) — đủ 3 giá trị inventory_context §5.6 — và read
 *    back NULL khi không set (legacy "not captured", spec §8.3);
 *  - ListingImage nhận checklistSlot ("front" §5.6.3 + null);
 *  - ListingImageUpload (mới — spec §5.6.4 "ownership authorization") nhận
 *    create + delete round-trip với ownerUserId/storageKey/bytes/width/height;
 *  - R2: Listing.status nhận "archived" (giá trị Batch 4 thêm — §5.6.2
 *    lifecycle, reserved) VÀ "removed" (đã có từ migration Batch 3 —
 *    assert, KHÔNG thêm lại);
 *  - `npx prisma db verify` exit 0 sau migrate (marker + schema khớp contract);
 *  - bảng finance legacy (Order, Payment, Payout, WithdrawRequest,
 *    LedgerEntry, Dispute) vẫn đọc được (spec §4.3/§8.1); Listing tạo chỉ
 *    bằng legacy fields đọc lại inventoryContext: null…; Listing.city vẫn
 *    non-null + populated (cột legacy không bị đụng).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { db } from "../../src/prisma/db.client";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const execFileAsync = promisify(execFile);

let seq = 0;
const uid = () => `b4-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B4 ${role}`,
    role,
  });
  return u.id;
}

async function mkCategory(): Promise<string> {
  const c = await db.orm.public.Category.create({
    name: `B4 cat ${uid()}`,
    slug: `b4-cat-${uid()}`,
  });
  return c.id;
}

/** Listing tối thiểu dạng legacy — KHÔNG cột structured nào (spec §8.3). */
async function mkLegacyListing(sellerId: string, categoryId: string): Promise<{ id: string; title: string; slug: string }> {
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId,
    title: `Loa B4 ${uid()}`,
    slug: `loa-b4-${uid()}`,
    description: "integration test batch 4",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
  });
  return { id: l.id, title: l.title, slug: l.slug };
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK để không bị Restrict chặn (Listing.category mặc định Restrict).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  listingImages: [] as string[],
  imageUploads: [] as string[],
};

afterEach(async () => {
  for (const id of created.imageUploads) {
    await db.orm.public.ListingImageUpload.where({ id }).delete();
  }
  for (const id of created.listingImages) {
    await db.orm.public.ListingImage.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  (Object.keys(created) as (keyof typeof created)[]).forEach((k) => {
    created[k].length = 0;
  });
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Additive: cột structured mới + checklistSlot + ListingImageUpload ───

d("applies the batch 4 migration additively", () => {
  it("Listing create + read round-trip với MỌI cột structured mới (spec §5.6)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);

    const l = await db.orm.public.Listing.create({
      sellerId,
      categoryId,
      title: `Loa B4 ${uid()}`,
      slug: `loa-b4-${uid()}`,
      description: "JBL Charge 5 còn mới, đủ phụ kiện",
      condition: "good",
      price: 1_500_000,
      status: "pending",
      city: "Hà Nội",
      // ─── Batch 4 — structured portable-speaker listing ───
      inventoryContext: "used",
      includedAccessories: "Sạc USB-C, túi đựng",
      knownDefects: "Khô viền cao su bên trái",
      repairHistory: "Chưa từng sửa",
      fulfillmentMethods: ["meetup", "seller_delivery"],
      provinceLevelCode: "ha-noi",
      communeLevelCode: null,
      locationDisplayName: "Gần Cầu Giấy",
    });
    created.listings.push(l.id);

    const row = await db.orm.public.Listing.first({ id: l.id });
    expect(row!.inventoryContext).toBe("used");
    expect(row!.includedAccessories).toBe("Sạc USB-C, túi đựng");
    expect(row!.knownDefects).toBe("Khô viền cao su bên trái");
    expect(row!.repairHistory).toBe("Chưa từng sửa");
    expect(row!.fulfillmentMethods).toEqual(["meetup", "seller_delivery"]); // jsonb deep-equal
    expect(row!.provinceLevelCode).toBe("ha-noi");
    expect(row!.communeLevelCode).toBeNull();
    expect(row!.locationDisplayName).toBe("Gần Cầu Giấy");
    // legacy fields không bị đụng (additive-only)
    expect(row!.title).toBe(l.title);
    expect(row!.city).toBe("Hà Nội");
    expect(row!.condition).toBe("good");
    expect(row!.price).toBe(1_500_000);
  });

  it("Listing đọc lại NULL cho mọi cột structured khi không set (legacy §8.3)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = (await mkLegacyListing(sellerId, categoryId)).id;
    created.listings.push(listingId);

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.inventoryContext).toBeNull();
    expect(row!.includedAccessories).toBeNull();
    expect(row!.knownDefects).toBeNull();
    expect(row!.repairHistory).toBeNull();
    expect(row!.fulfillmentMethods).toBeNull();
    expect(row!.provinceLevelCode).toBeNull();
    expect(row!.communeLevelCode).toBeNull();
    expect(row!.locationDisplayName).toBeNull();
  });

  it("Listing nhận đủ 3 giá trị inventory_context §5.6 (new/open_box/used)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    for (const ctx of ["new", "open_box", "used"] as const) {
      const l = await db.orm.public.Listing.create({
        sellerId,
        categoryId,
        title: `Loa B4 ${uid()}`,
        slug: `loa-b4-${uid()}`,
        description: "integration test batch 4",
        condition: "good",
        price: 1_000_000,
        status: "pending",
        city: "Hà Nội",
        inventoryContext: ctx,
      });
      created.listings.push(l.id);
      const row = await db.orm.public.Listing.first({ id: l.id });
      expect(row!.inventoryContext).toBe(ctx);
    }
  });

  it("ListingImage nhận checklistSlot 'front' (§5.6.3) và null", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = (await mkLegacyListing(sellerId, categoryId)).id;
    created.listings.push(listingId);

    const withSlot = await db.orm.public.ListingImage.create({
      listingId,
      url: "/uploads/00000000-0000-4000-8000-00000000000a.webp",
      sortOrder: 0,
      checklistSlot: "front",
    });
    created.listingImages.push(withSlot.id);
    const row = await db.orm.public.ListingImage.first({ id: withSlot.id });
    expect(row!.checklistSlot).toBe("front");

    const withoutSlot = await db.orm.public.ListingImage.create({
      listingId,
      url: "/uploads/00000000-0000-4000-8000-00000000000b.webp",
      sortOrder: 1,
      // checklistSlot bỏ trống → NULL (legacy/không gán slot)
    });
    created.listingImages.push(withoutSlot.id);
    const row2 = await db.orm.public.ListingImage.first({ id: withoutSlot.id });
    expect(row2!.checklistSlot).toBeNull();
  });

  it("ListingImageUpload — create + delete round-trip (spec §5.6.4 ownership)", async () => {
    const ownerUserId = await mkUser("seller");
    created.users.push(ownerUserId);
    const up = await db.orm.public.ListingImageUpload.create({
      ownerUserId,
      storageKey: `${uid()}.webp`,
      bytes: 204_800,
      width: 2560,
      height: 1440,
    });
    created.imageUploads.push(up.id);
    const row = await db.orm.public.ListingImageUpload.first({ id: up.id });
    expect(row!.ownerUserId).toBe(ownerUserId);
    expect(row!.storageKey).toBe(up.storageKey);
    expect(row!.bytes).toBe(204_800);
    expect(row!.width).toBe(2560);
    expect(row!.height).toBe(1440);
    expect(row!.createdAt).toBeTruthy();
    await db.orm.public.ListingImageUpload.where({ id: up.id }).delete();
    expect(await db.orm.public.ListingImageUpload.first({ id: up.id })).toBeNull();
  });

  it("Listing.status nhận 'archived' (Batch 4) VÀ 'removed' (Batch 3 — R2)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);

    // archived — giá trị Batch 4 thêm (§5.6.2 lifecycle, reserved — không
    // transition nào trong P0 ghi nó; chỉ chứng minh enum nhận được)
    const archived = await db.orm.public.Listing.create({
      sellerId,
      categoryId,
      title: `Loa B4 ${uid()}`,
      slug: `loa-b4-${uid()}`,
      description: "integration test batch 4",
      condition: "good",
      price: 1_000_000,
      status: "archived",
      city: "Hà Nội",
    });
    created.listings.push(archived.id);
    expect((await db.orm.public.Listing.first({ id: archived.id }))!.status).toBe("archived");

    // removed — ĐÃ CÓ từ migration Batch 3 (R2: Batch 3 là first writer;
    // Batch 4 KHÔNG thêm lại — chỉ assert giá trị vẫn sống sau migration mới)
    const removed = await db.orm.public.Listing.create({
      sellerId,
      categoryId,
      title: `Loa B4 ${uid()}`,
      slug: `loa-b4-${uid()}`,
      description: "integration test batch 4",
      condition: "good",
      price: 1_000_000,
      status: "removed",
      city: "Hà Nội",
    });
    created.listings.push(removed.id);
    expect((await db.orm.public.Listing.first({ id: removed.id }))!.status).toBe("removed");
  });
});

// ─── 2. Marker + schema khớp contract sau migrate ───

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 3. Finance legacy + legacy listing shape giữ nguyên (spec §4.3/§8.1/§8.3) ───

d("preserves finance tables and legacy listing shape", () => {
  it("Order/Payment/Payout/WithdrawRequest/LedgerEntry/Dispute vẫn đọc được", async () => {
    // đọc từng bảng — bảng mất/thêm cột sẽ fail ngay ở đây
    expect(await db.orm.public.Order.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payment.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payout.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.WithdrawRequest.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.LedgerEntry.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Dispute.where({ id: "nope-0000" }).all()).toEqual([]);
  });

  it("Listing legacy fields đọc lại nguyên vẹn — city vẫn required + populated", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const legacy = await mkLegacyListing(sellerId, categoryId);
    created.listings.push(legacy.id);

    const row = await db.orm.public.Listing.first({ id: legacy.id });
    expect(row!.title).toBe(legacy.title);
    expect(row!.slug).toBe(legacy.slug);
    expect(row!.description).toBe("integration test batch 4");
    expect(row!.condition).toBe("good");
    expect(row!.price).toBe(1_000_000);
    expect(row!.status).toBe("approved");
    expect(row!.city).toBe("Hà Nội"); // non-null, populated — cột legacy không bị đụng

    // city vẫn REQUIRED — create thiếu city phải throw (cột non-null không default).
    // Type hệ thống đã chặn qua CreateInput (tsc chứng minh) — ép qua unknown
    // để chứng minh DB (NOT NULL, không default) cũng chặn ở runtime.
    const withoutCity = {
      sellerId,
      categoryId,
      title: `Loa B4 ${uid()}`,
      slug: `loa-b4-${uid()}`,
      description: "integration test batch 4",
      condition: "good",
      price: 1_000_000,
      status: "pending",
      // city: bỏ trống — cột non-null không default
    } as unknown as Parameters<typeof db.orm.public.Listing.create>[0];
    let err: unknown;
    try {
      await db.orm.public.Listing.create(withoutCity);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
  });
});
