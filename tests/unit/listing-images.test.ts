/**
 * Listing image ownership (Batch 4 Task 2 — spec §5.6.4 "ownership
 * authorization") — unit tests. Review Focus 4.
 *
 * Per-URL rules THEO THỨ TỰ (B1):
 *  (1) url khớp LISTING_IMAGE_URL_PATTERN (/uploads/<uuid>.<ext>) → tra
 *      ListingImageUpload theo storageKey = basename; row tồn tại →
 *      ownerUserId PHẢI = sellerId (sai → IMAGE_NOT_OWNED — kể cả khi url đã
 *      gắn vào listing này); url phải BẰNG /uploads/<storageKey> chính xác —
 *      tra theo basename mà KHÔNG khớp pattern (scheme URL chứa uuid của chính
 *      seller) KHÔNG BAO GIỜ vào rule (1) → IMAGE_URL_INVALID (chống bypass).
 *  (2) row-less + đã gắn vào listing này → CHỈ chấp nhận khi khớp
 *      ATTACHED_IMAGE_PATH_PATTERN (/img|/uploads) và KHÔNG chứa ".." — ảnh seed
 *      /img/… và ảnh /uploads/ pre-Batch-4 ĐÃ GẮN được giữ nguyên (B1 compat).
 *  (3) còn lại → IMAGE_URL_INVALID — kể cả URL có scheme đã gắn (không bao giờ
 *      tin URL ngoài, kể cả tại approve).
 *
 * Thêm: url trùng lặp → IMAGE_DUPLICATE; imageSlots lệch độ dài →
 * IMAGE_SLOT_MISMATCH; mọi url resolve xong mới trả về — KHÓA db write nào
 * chạy trước khi hàm resolve (hàm chỉ READ — action gọi trước mọi ListingImage
 * write).
 *
 * db.client mock in-memory (ListingImageUpload + ListingImage) — pattern
 * publication-gate.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── db.client mock — in-memory ListingImageUpload + ListingImage + Listing ──

const dbState = vi.hoisted(() => ({
  uploads: [] as Array<Record<string, unknown>>,
  images: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  writes: [] as string[], // mọi lệnh write (create/update/updateAll/delete) — spy
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[], writeLabel: string, defaults?: () => Row) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        return rows.find((r) => all.every((p) => matches(r, p))) ?? null;
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      update: async (data: Row) => {
        dbState.writes.push(`${writeLabel}.update`);
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        Object.assign(hit[0]!, data);
        return { ...hit[0]! };
      },
      updateAll: async (data: Row) => {
        dbState.writes.push(`${writeLabel}.updateAll`);
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      delete: async () => {
        dbState.writes.push(`${writeLabel}.delete`);
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      deleteAll: async () => {
        dbState.writes.push(`${writeLabel}.deleteAll`);
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        dbState.writes.push(`${writeLabel}.create`);
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const models = {
    ListingImageUpload: makeModel(dbState.uploads, "ListingImageUpload", () => ({
      id: `up-${dbState.uploads.length + 1}`,
      bytes: 1024,
      width: 800,
      height: 600,
      createdAt: new Date().toISOString(),
    })),
    ListingImage: makeModel(dbState.images, "ListingImage", () => ({
      id: `img-${dbState.images.length + 1}`,
      sortOrder: 0,
      checklistSlot: null,
    })),
    // Review fix (LOW): attached-set read scope theo sellerId — cần Listing row
    Listing: makeModel(dbState.listings, "Listing", () => ({
      id: `listing-${dbState.listings.length + 1}`,
      sellerId: "seller-unknown",
      status: "draft",
    })),
  };
  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

import {
  ATTACHED_IMAGE_PATH_PATTERN,
  LISTING_IMAGE_URL_PATTERN,
  assertListingImagesOwned,
} from "@/src/lib/listing-images";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const UUID_OWN = "00000000-0000-4000-8000-0000000000aa";
const UUID_OTHER = "00000000-0000-4000-8000-0000000000bb";
const UUID_PRE_B4 = "00000000-0000-4000-8000-0000000000cc";
const URL_OWN = `/uploads/${UUID_OWN}.webp`;
const URL_OTHER = `/uploads/${UUID_OTHER}.webp`;
const URL_PRE_B4 = `/uploads/${UUID_PRE_B4}.jpg`;

const SELLER = "seller-1";
const OTHER_SELLER = "seller-2";
const LISTING = "listing-1";
const OTHER_LISTING = "listing-2";

const seedUpload = (ownerUserId: string, storageKey: string): void => {
  dbState.uploads.push({
    id: `up-${dbState.uploads.length + 1}`,
    ownerUserId,
    storageKey,
    bytes: 1024,
    width: 800,
    height: 600,
    createdAt: new Date().toISOString(),
  });
};

/** Listing row — attached-set read scope theo (id, sellerId) sau review fix. */
const seedListing = (id: string, sellerId: string): void => {
  dbState.listings.push({
    id,
    sellerId,
    status: "approved",
    title: `listing ${id}`,
  });
};

const seedAttached = (listingId: string, url: string): void => {
  dbState.images.push({
    id: `img-${dbState.images.length + 1}`,
    listingId,
    url,
    sortOrder: 0,
    checklistSlot: null,
  });
};

const expectImageError = (
  input: Parameters<typeof assertListingImagesOwned>[0],
  code: string,
): Promise<void> => {
  const promise = assertListingImagesOwned(input);
  return expect(promise).rejects.toThrowError(code);
};

beforeEach(() => {
  dbState.uploads.length = 0;
  dbState.images.length = 0;
  dbState.listings.length = 0;
  dbState.writes.length = 0;
  // LISTING thuộc SELLER — rule (2) compat đọc attached-set THEO listing này
  seedListing(LISTING, SELLER);
});

afterEach(() => {
  expect(dbState.writes).toEqual([]); // hàm chỉ READ — không write nào chạy
});

// ─── 1. Pattern pins ──────────────────────────────────────────────────────────

describe("URL patterns", () => {
  it("LISTING_IMAGE_URL_PATTERN — /uploads/<uuid>.<ext> hex chuẩn", () => {
    expect(LISTING_IMAGE_URL_PATTERN.test(URL_OWN)).toBe(true);
    expect(LISTING_IMAGE_URL_PATTERN.test(`/uploads/${UUID_OWN}.jpg`)).toBe(true);
    expect(LISTING_IMAGE_URL_PATTERN.test(`/uploads/${UUID_OWN.toUpperCase()}.webp`)).toBe(false);
    expect(LISTING_IMAGE_URL_PATTERN.test(`https://evil.example/x/${UUID_OWN}.webp`)).toBe(false);
    expect(LISTING_IMAGE_URL_PATTERN.test(`/uploads/${UUID_OWN}.svg`)).toBe(false);
    expect(LISTING_IMAGE_URL_PATTERN.test(`/uploads/../${UUID_OWN}.webp`)).toBe(false);
  });

  it("ATTACHED_IMAGE_PATH_PATTERN — /img|/uploads path sạch, không scheme, không ..", () => {
    expect(ATTACHED_IMAGE_PATH_PATTERN.test("/img/listings/x.svg")).toBe(true);
    expect(ATTACHED_IMAGE_PATH_PATTERN.test("/uploads/anything.jpg")).toBe(true);
    expect(ATTACHED_IMAGE_PATH_PATTERN.test("https://x.example/a.jpg")).toBe(false);
    expect(ATTACHED_IMAGE_PATH_PATTERN.test("/../../etc/passwd")).toBe(false);
    expect(ATTACHED_IMAGE_PATH_PATTERN.test("javascript:alert(1)")).toBe(false);
  });
});

// ─── 2. Rule (1) — upload ownership ───────────────────────────────────────────

describe("assertListingImagesOwned — rule (1) upload row", () => {
  it("/uploads/<uuid>.webp owned by the seller → passes", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    await expect(
      assertListingImagesOwned({ sellerId: SELLER, imageUrls: [URL_OWN] }),
    ).resolves.toBeUndefined();
  });

  it("/uploads/<uuid>.webp owned by ANOTHER user → IMAGE_NOT_OWNED — kể cả khi đã gắn vào listing này (cross-account theft)", async () => {
    seedUpload(OTHER_SELLER, `${UUID_OTHER}.webp`);
    seedAttached(LISTING, URL_OTHER); // đã gắn vào listing của seller-1
    await expectImageError(
      { sellerId: SELLER, listingId: LISTING, imageUrls: [URL_OTHER] },
      "IMAGE_NOT_OWNED",
    );
  });

  it("upload row KHÔNG tồn tại + KHÔNG gắn vào listing → IMAGE_NOT_OWNED (claim upload không có ownership row — pre-Batch-4 detached)", async () => {
    // không seed upload, không seed attached
    await expectImageError(
      { sellerId: SELLER, imageUrls: [URL_PRE_B4] },
      "IMAGE_NOT_OWNED",
    );
  });

  it("upload row không tồn tại + gắn vào listing KHÁC → IMAGE_NOT_OWNED (re-attach sang listing khác bị chặn)", async () => {
    seedAttached(OTHER_LISTING, URL_PRE_B4);
    await expectImageError(
      { sellerId: SELLER, listingId: LISTING, imageUrls: [URL_PRE_B4] },
      "IMAGE_NOT_OWNED",
    );
  });

  it("scheme URL có basename LÀ upload của chính seller → IMAGE_URL_INVALID (rule-1 basename bypass — Review Focus 4)", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    await expectImageError(
      { sellerId: SELLER, imageUrls: [`https://evil.example/x/${UUID_OWN}.webp`] },
      "IMAGE_URL_INVALID",
    );
    // kể cả khi scheme URL đã gắn vào listing — vẫn IMAGE_URL_INVALID
    seedAttached(LISTING, `https://evil.example/x/${UUID_OWN}.webp`);
    await expectImageError(
      { sellerId: SELLER, listingId: LISTING, imageUrls: [`https://evil.example/x/${UUID_OWN}.webp`] },
      "IMAGE_URL_INVALID",
    );
  });
});

// ─── 3. Rule (2) — attached compat (B1) ───────────────────────────────────────

describe("assertListingImagesOwned — rule (2) attached compat", () => {
  it("attached pre-Batch-4 /uploads/<uuid>.jpg KHÔNG có upload row → passes on edit (B1 compat pin)", async () => {
    seedAttached(LISTING, URL_PRE_B4);
    await expect(
      assertListingImagesOwned({
        sellerId: SELLER,
        listingId: LISTING,
        imageUrls: [URL_PRE_B4],
      }),
    ).resolves.toBeUndefined();
  });

  it("seed /img/listings/x.svg đã gắn vào listing → passes", async () => {
    seedAttached(LISTING, "/img/listings/x.svg");
    await expect(
      assertListingImagesOwned({
        sellerId: SELLER,
        listingId: LISTING,
        imageUrls: ["/img/listings/x.svg"],
      }),
    ).resolves.toBeUndefined();
  });

  it("cùng URL /img/… trên listing KHÁC → IMAGE_URL_INVALID (chỉ listing này mới giữ)", async () => {
    seedAttached(OTHER_LISTING, "/img/listings/x.svg");
    await expectImageError(
      { sellerId: SELLER, listingId: LISTING, imageUrls: ["/img/listings/x.svg"] },
      "IMAGE_URL_INVALID",
    );
  });

  it("review fix (LOW): listingId của seller KHÁC → attached-set KHÔNG được dùng (read scope theo sellerId)", async () => {
    // OTHER_LISTING thuộc seller-2, ảnh /img/… gắn vào ĐÚNG listing đó — nếu
    // read theo listingId thuần, rule (2) sẽ honour ảnh của listing người khác.
    seedListing(OTHER_LISTING, OTHER_SELLER);
    seedAttached(OTHER_LISTING, "/img/listings/x.svg");
    await expectImageError(
      { sellerId: SELLER, listingId: OTHER_LISTING, imageUrls: ["/img/listings/x.svg"] },
      "IMAGE_URL_INVALID",
    );
    // row-less /uploads/<uuid>.jpg gắn vào listing người khác cũng KHÔNG passes
    seedAttached(OTHER_LISTING, URL_PRE_B4);
    await expectImageError(
      { sellerId: SELLER, listingId: OTHER_LISTING, imageUrls: [URL_PRE_B4] },
      "IMAGE_NOT_OWNED",
    );
  });

  it("listingId KHÔNG tồn tại → attached-set rỗng (fail closed — rule 2 không có gì để giữ)", async () => {
    seedAttached("listing-khong-ton-tai", "/img/listings/x.svg");
    await expectImageError(
      { sellerId: SELLER, listingId: "listing-khong-ton-tai", imageUrls: ["/img/listings/x.svg"] },
      "IMAGE_URL_INVALID",
    );
  });

  it("attached URL có scheme → IMAGE_URL_INVALID (rule 3 — scheme KHÔNG BAO GIỜ tin, kể cả đã gắn)", async () => {
    seedAttached(LISTING, "https://x.example/a.jpg");
    await expectImageError(
      { sellerId: SELLER, listingId: LISTING, imageUrls: ["https://x.example/a.jpg"] },
      "IMAGE_URL_INVALID",
    );
  });

  it("attached URL chứa .. → IMAGE_URL_INVALID (traversal đã gắn cũng bị chặn)", async () => {
    seedAttached(LISTING, "/uploads/../../etc/passwd");
    await expectImageError(
      { sellerId: SELLER, listingId: LISTING, imageUrls: ["/uploads/../../etc/passwd"] },
      "IMAGE_URL_INVALID",
    );
  });
});

// ─── 4. Rule (3) — everything else ────────────────────────────────────────────

describe("assertListingImagesOwned — rule (3) foreign/traversal URLs", () => {
  it.each([
    ["https://evil.example/uploads/x.webp"],
    ["javascript:alert(1)"],
    ["/../../etc/passwd"],
    [""],
    ["data:image/png;base64,AAAA"],
  ])("%s → IMAGE_URL_INVALID", async (url) => {
    await expectImageError({ sellerId: SELLER, imageUrls: [url] }, "IMAGE_URL_INVALID");
  });

  it("url /uploads/<uuid>.webp của user khác LẪN trong list tốt → vẫn chặn (fail trước)", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    seedUpload(OTHER_SELLER, `${UUID_OTHER}.webp`);
    await expectImageError(
      { sellerId: SELLER, imageUrls: [URL_OWN, URL_OTHER] },
      "IMAGE_NOT_OWNED",
    );
  });
});

// ─── 5. Duplicate + slot mismatch ─────────────────────────────────────────────

describe("assertListingImagesOwned — duplicate + slot mismatch", () => {
  it("url trùng lặp trong input → IMAGE_DUPLICATE", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    await expectImageError(
      { sellerId: SELLER, imageUrls: [URL_OWN, URL_OWN] },
      "IMAGE_DUPLICATE",
    );
  });

  it("imageSlots lệch độ dài imageUrls → IMAGE_SLOT_MISMATCH", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    await expectImageError(
      { sellerId: SELLER, imageUrls: [URL_OWN], imageSlots: ["front", "back"] },
      "IMAGE_SLOT_MISMATCH",
    );
  });

  it("imageSlots cùng độ dài → passes (slot value do schema validate)", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    await expect(
      assertListingImagesOwned({
        sellerId: SELLER,
        imageUrls: [URL_OWN],
        imageSlots: ["front"],
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── 6. Read-only contract ────────────────────────────────────────────────────

describe("assertListingImagesOwned — read-only (không write nào trước khi resolve)", () => {
  it("case THÀNH CÔNG cũng không phát sinh db write nào", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    seedAttached(LISTING, "/img/listings/x.svg");
    await assertListingImagesOwned({
      sellerId: SELLER,
      listingId: LISTING,
      imageUrls: [URL_OWN, "/img/listings/x.svg"],
    });
    expect(dbState.writes).toEqual([]);
  });

  it("case THẤT BẠI ở url thứ hai → không write nào chạy (fail trước mọi ListingImage write)", async () => {
    seedUpload(SELLER, `${UUID_OWN}.webp`);
    await expectImageError(
      { sellerId: SELLER, imageUrls: [URL_OWN, "https://evil.example/x.webp"] },
      "IMAGE_URL_INVALID",
    );
    expect(dbState.writes).toEqual([]);
  });
});
