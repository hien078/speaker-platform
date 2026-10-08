/**
 * Batch 5 migration integration tests — plan Task 1 (batch 5), spec §5.7
 * (search normalization column + alias mechanism), §5.8 (telemetry domain —
 * ProductEvent), §5.9 (location source), §8 (additive-first) + §9 Batch 5.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `batch5_search_telemetry` (Task 1):
 *  - ADDITIVE (S3): ProductEvent + SearchAlias nhận create + read + delete
 *    round-trip với đúng field contract; Listing nhận update locationSource
 *    (enum mới listing_location_source — đủ 3 giá trị §5.9) +
 *    searchTextNormalized (cột derived, full-text `simple` — S-1);
 *    provinceLevelCode/locationDisplayName là cột Batch 4 — round-trip từ
 *    create, Batch 5 KHÔNG thêm lại (S3/S4);
 *  - ProductEvent KHÔNG FK (append-only sống qua vòng đời listing — spec
 *    §5.8/§4.8): xóa listing, event vẫn đọc được;
 *  - UNIQUE: SearchAlias (alias, target) chặn duplicate (23505); cùng alias
 *    khác target vẫn sống (unique là cặp);
 *  - CHECK search_alias_target_ids (corrections item 5): target=brand với
 *    brandId NULL bị từ chối (23514); target=model với productModelId NULL
 *    bị từ chối; target=brand với CẢ HAI id set cũng bị từ chối (một alias row
 *    trỏ đúng MỘT catalog entity);
 *  - ops.json: mọi op additive — không drop/alter cột/bảng/index đang có
 *    (cặp Listing_status_check_* DROP+ADD được dung sai NẾU planner render —
 *    S2, additive in effect; Batch 5 không thêm giá trị listing_status nào
 *    nên KHÔNG render là đúng); không data transform (backfill là offline
 *    script, §8.6);
 *  - `npx prisma db verify` exit 0 sau migrate (marker + schema khớp);
 *  - bảng finance legacy (Order, Payment, Payout, WithdrawRequest,
 *    LedgerEntry, Dispute) vẫn đọc được + seeded Order+Payment đọc lại
 *    nguyên vẹn (spec §4.3/§8.1);
 *  - Batch 2/3/4 (UserSession, AuditEvent, BetaCohortMembership,
 *    SellerVerification, UserSuspension, ModerationCase, AbuseReport,
 *    ListingImageUpload) nhận create + delete round-trip (S-22 — migration
 *    Batch 5 không làm xáo trộn graph của batch trước).
 *  - [b5-review Task 1 L1 — đóng trong Task 11] row Listing tạo ở head
 *    PRE-Batch 5 sống sót qua migration Batch 5: database THỨ HAI trong cùng
 *    container scratch → migrate về head cũ (dir round4) → seed raw SQL →
 *    capture row_to_json → migrate --to production → row còn nguyên,
 *    locationSource/searchTextNormalized NULL, mọi cột khác byte-identical
 *    (approvedContentAt là backfill Batch 4 trên self-edge — có chủ đích).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { isUniqueConstraintViolation, SqlQueryError } from "@prisma/orm-family-sql/errors";
import postgres from "@prisma/orm-postgres/runtime";

import type { Contract } from "../../src/prisma/contract.d";
import contractJson from "../../src/prisma/contract.json" with { type: "json" };
import { db } from "../../src/prisma/db.client";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const execFileAsync = promisify(execFile);

let seq = 0;
const uid = () => `b5-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B5 ${role}`,
    role,
  });
  return u.id;
}

async function mkCategory(): Promise<string> {
  const c = await db.orm.public.Category.create({
    name: `B5 cat ${uid()}`,
    slug: `b5-cat-${uid()}`,
  });
  return c.id;
}

async function mkBrand(): Promise<string> {
  const b = await db.orm.public.Brand.create({
    name: `B5 brand ${uid()}`,
    slug: `b5-brand-${uid()}`,
  });
  return b.id;
}

async function mkModel(brandId: string, categoryId: string): Promise<string> {
  const m = await db.orm.public.ProductModel.create({
    brandId,
    categoryId,
    name: `B5 model ${uid()}`,
    slug: `b5-model-${uid()}`,
    status: "approved",
  });
  return m.id;
}

/** Listing tối thiểu — Batch 5 không thêm cột bắt buộc nào (S3: mọi cột mới nullable). */
async function mkListing(
  sellerId: string,
  categoryId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId,
    title: `Loa B5 ${uid()}`,
    slug: `loa-b5-${uid()}`,
    description: "integration test batch 5",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
    ...overrides,
  });
  return l.id;
}

/** Bắt unique violation (23505) — trả error để assert constraint name. */
async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<SqlQueryError> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(isUniqueConstraintViolation(err)).toBe(true); // SQLSTATE 23505 chuẩn
  expect(SqlQueryError.is(err)).toBe(true);
  return err as SqlQueryError;
}

/** Bắt check violation (23514) — target ⇒ id set (corrections item 5). */
async function expectCheckViolation(fn: () => Promise<unknown>): Promise<SqlQueryError> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(SqlQueryError.is(err)).toBe(true);
  const q = err as SqlQueryError;
  expect(q.sqlState).toBe("23514"); // check_violation
  return q;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK để không bị Restrict chặn.
const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  productModels: [] as string[],
  listings: [] as string[],
  searchAliases: [] as string[],
  productEvents: [] as string[],
  imageUploads: [] as string[],
  abuseReports: [] as string[],
  userSuspensions: [] as string[],
  moderationCases: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
  auditEvents: [] as string[],
  sessions: [] as string[],
  payments: [] as string[],
  orders: [] as string[],
};

afterEach(async () => {
  // ProductEvent — KHÔNG FK, append-only (spec §5.8) — test tự dọn row mình tạo
  for (const id of created.productEvents) {
    await db.orm.public.ProductEvent.where({ id }).delete();
  }
  for (const id of created.searchAliases) {
    await db.orm.public.SearchAlias.where({ id }).delete();
  }
  for (const id of created.imageUploads) {
    await db.orm.public.ListingImageUpload.where({ id }).delete();
  }
  for (const id of created.abuseReports) {
    await db.orm.public.AbuseReport.where({ id }).delete();
  }
  for (const id of created.userSuspensions) {
    await db.orm.public.UserSuspension.where({ id }).delete();
  }
  for (const id of created.moderationCases) {
    await db.orm.public.ModerationCase.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.productModels) {
    await db.orm.public.ProductModel.where({ id }).delete();
  }
  for (const id of created.brands) {
    await db.orm.public.Brand.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).delete();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).delete();
  }
  for (const id of created.auditEvents) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  for (const id of created.sessions) {
    await db.orm.public.UserSession.where({ id }).delete();
  }
  for (const id of created.payments) {
    await db.orm.public.Payment.where({ id }).delete();
  }
  for (const id of created.orders) {
    await db.orm.public.OrderStatusHistory.where({ orderId: id }).delete();
    await db.orm.public.Order.where({ id }).delete();
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

// ─── 1. Additive: ProductEvent + SearchAlias + 2 cột Listing mới (S3) ───

d("applies the batch 5 migration additively", () => {
  it("ProductEvent — create + read + delete round-trip với đủ field contract (spec §5.8)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const brandId = await mkBrand();
    created.brands.push(brandId);
    const modelId = await mkModel(brandId, categoryId);
    created.productModels.push(modelId);
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);

    const searchSessionId = randomUUID();
    const resultListingIds = [randomUUID(), randomUUID()];
    const ev = await db.orm.public.ProductEvent.create({
      name: "search_submitted",
      schemaVersion: "1",
      actorPseudonym: "a".repeat(64), // HMAC hex — KHÔNG bao giờ raw user id (S-10)
      sessionPseudonym: "b".repeat(64),
      searchSessionId,
      listingId, // KHÔNG FK — event append-only sống qua vòng đời listing
      productModelId: modelId,
      conversationId: null,
      provinceCode: "ha-noi", // coarse location (spec §4.8) — mã tỉnh canonical
      metadata: { resultCount: 2, resultListingIds },
    });
    created.productEvents.push(ev.id);

    const row = await db.orm.public.ProductEvent.first({ id: ev.id });
    expect(row!.name).toBe("search_submitted");
    expect(row!.schemaVersion).toBe("1");
    expect(row!.occurredAt).toBeTruthy();
    expect(row!.actorPseudonym).toBe("a".repeat(64));
    expect(row!.sessionPseudonym).toBe("b".repeat(64));
    expect(row!.pseudonymKeyVersion).toBe("1"); // default — phát hiện key rotation (S-11)
    expect(row!.isInternal).toBe(false); // default — exclusion flag tính lúc emit (S-12)
    expect(row!.searchSessionId).toBe(searchSessionId);
    expect(row!.listingId).toBe(listingId);
    expect(row!.productModelId).toBe(modelId);
    expect(row!.conversationId).toBeNull();
    expect(row!.provinceCode).toBe("ha-noi");
    expect(row!.metadata).toEqual({ resultCount: 2, resultListingIds }); // jsonb deep-equal

    await db.orm.public.ProductEvent.where({ id: ev.id }).delete();
    expect(await db.orm.public.ProductEvent.first({ id: ev.id })).toBeNull();
  });

  it("ProductEvent sống qua vòng đời listing — KHÔNG FK (append-only, spec §5.8)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    // listing VẪN track vào created — test xóa nó ngay trong thân để chứng
    // minh event sống sót; track giữ cleanup chạy đúng khi test fail giữa
    // chừng (orphan listing chặn Category delete → 23503 → cleanup abort →
    // user role="admin" sót lại bị predicate backfill của admin-bootstrap
    // test nâng super_admin — thứ tự file vitest không alphabet, đã gặp).
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);
    const ev = await db.orm.public.ProductEvent.create({
      name: "listing_viewed",
      schemaVersion: "1",
      listingId,
      metadata: { ownerView: false, fromSearch: true },
    });
    created.productEvents.push(ev.id);

    await db.orm.public.Listing.where({ id: listingId }).delete();
    expect(await db.orm.public.Listing.first({ id: listingId })).toBeNull();
    // event vẫn đọc được — nguồn đã chết, event sống (KHÔNG FK theo thiết kế)
    const row = await db.orm.public.ProductEvent.first({ id: ev.id });
    expect(row!.listingId).toBe(listingId);
  });

  it("SearchAlias — create + read + delete round-trip, brand + model target (spec §5.7)", async () => {
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const brandId = await mkBrand();
    created.brands.push(brandId);
    const modelId = await mkModel(brandId, categoryId);
    created.productModels.push(modelId);

    const aliasText = `soundlink-${uid()}`; // dạng CHUẨN HÓA (normalizeSearchText) — khóa tra cứu
    const brandAlias = await db.orm.public.SearchAlias.create({
      alias: aliasText,
      target: "brand",
      brandId,
      note: "founder-reviewed seed (A7)",
    });
    created.searchAliases.push(brandAlias.id);
    const row = await db.orm.public.SearchAlias.first({ id: brandAlias.id });
    expect(row!.alias).toBe(aliasText);
    expect(row!.target).toBe("brand");
    expect(row!.brandId).toBe(brandId);
    expect(row!.productModelId).toBeNull();
    expect(row!.note).toBe("founder-reviewed seed (A7)");
    expect(row!.createdAt).toBeTruthy();

    const modelAlias = await db.orm.public.SearchAlias.create({
      alias: aliasText, // cùng alias, KHÁC target — unique là cặp (alias, target)
      target: "model",
      productModelId: modelId,
    });
    created.searchAliases.push(modelAlias.id);
    const row2 = await db.orm.public.SearchAlias.first({ id: modelAlias.id });
    expect(row2!.target).toBe("model");
    expect(row2!.productModelId).toBe(modelId);
    expect(row2!.brandId).toBeNull();

    // back-relation (S3): Brand.searchAliases / ProductModel.searchAliases đọc được
    const brandRow = await db.orm.public.Brand.where({ id: brandId })
      .include("searchAliases", (sa) => sa.select("id"))
      .first();
    expect(brandRow!.searchAliases.map((sa) => sa.id)).toContain(brandAlias.id);
    const modelRow = await db.orm.public.ProductModel.where({ id: modelId })
      .include("searchAliases", (sa) => sa.select("id"))
      .first();
    expect(modelRow!.searchAliases.map((sa) => sa.id)).toContain(modelAlias.id);

    await db.orm.public.SearchAlias.where({ id: brandAlias.id }).delete();
    expect(await db.orm.public.SearchAlias.first({ id: brandAlias.id })).toBeNull();
    await db.orm.public.SearchAlias.where({ id: modelAlias.id }).delete();
    expect(await db.orm.public.SearchAlias.first({ id: modelAlias.id })).toBeNull();
  });

  it("Listing nhận update locationSource + searchTextNormalized; cột Batch 4 không bị thêm lại (S3/S4)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);

    // Listing tạo với cột structured Batch 4 — provinceLevelCode/locationDisplayName
    // là cột Batch 4 (S3): round-trip từ create chứng minh Batch 5 KHÔNG re-add.
    const listingId = await mkListing(sellerId, categoryId, {
      provinceLevelCode: "ha-noi",
      communeLevelCode: null,
      locationDisplayName: "Gần Cầu Giấy",
    });
    created.listings.push(listingId);

    // Batch 5 thêm ĐÚNG 2 cột (S3): locationSource + searchTextNormalized — qua update
    await db.orm.public.Listing.where({ id: listingId }).update({
      locationSource: "seller_declared",
      searchTextNormalized: "loa jbl charge 5 nhu moi",
    });
    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.locationSource).toBe("seller_declared");
    expect(row!.searchTextNormalized).toBe("loa jbl charge 5 nhu moi");
    // cột Batch 4 nguyên vẹn — không bị đụng
    expect(row!.provinceLevelCode).toBe("ha-noi");
    expect(row!.communeLevelCode).toBeNull();
    expect(row!.locationDisplayName).toBe("Gần Cầu Giấy");
    // legacy fields không bị đụng (additive-only)
    expect(row!.city).toBe("Hà Nội");
    expect(row!.title).toBeTruthy();
  });

  it("Listing.locationSource nhận đủ 3 giá trị listing_location_source (spec §5.9)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    for (const source of ["seller_declared", "legacy_mapped", "unresolved"] as const) {
      const listingId = await mkListing(sellerId, categoryId);
      created.listings.push(listingId);
      await db.orm.public.Listing.where({ id: listingId }).update({ locationSource: source });
      expect((await db.orm.public.Listing.first({ id: listingId }))!.locationSource).toBe(source);
    }
    // null = chưa backfill — cột nullable, KHÔNG default (S3)
    const freshId = await mkListing(sellerId, categoryId);
    created.listings.push(freshId);
    expect((await db.orm.public.Listing.first({ id: freshId }))!.locationSource).toBeNull();
  });

  it("searchTextNormalized full-text index khai báo language 'simple' (S-1)", async () => {
    // contract.json là nguồn chân thực của migration — expression của index
    // phải là to_tsvector('simple', …) (S-1: english stopword/stemmer làm hỏng
    // text tiếng Việt đã pre-normalize — "loa do" mất "do").
    const contractPath = fileURLToPath(new URL("../../src/prisma/contract.json", import.meta.url));
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      storage: {
        namespaces: {
          public: {
            entries: {
              table: Record<string, { indexes: Array<{ expression?: string }> }>;
            };
          };
        };
      };
    };
    const indexes = contract.storage.namespaces.public.entries.table.Listing!.indexes;
    const fts = indexes.find((i) => /searchTextNormalized/.test(i.expression ?? ""));
    expect(fts?.expression).toBe("to_tsvector('simple', \"searchTextNormalized\")");
  });

  it("migration ops: mọi op additive — không drop/alter cột/bảng đang có (S2/S3)", async () => {
    // đọc ops.json của package batch5 — nguồn chân thực planner render
    const migrationsAppDir = fileURLToPath(new URL("../../migrations/app/", import.meta.url));
    const dirName = readdirSync(migrationsAppDir).find((e) => /_batch5_search_telemetry$/.test(e));
    expect(dirName).toBeTruthy(); // package chưa render → fail (đúng ở Step 2 TDD)
    const ops = JSON.parse(
      readFileSync(join(migrationsAppDir, dirName!, "ops.json"), "utf8"),
    ) as Array<{ id: string; label: string; operationClass: string }>;

    // 2 bảng mới — toàn bộ op "table." là CREATE (không drop bảng nào)
    const tableOps = ops.filter((o) => o.id.startsWith("table."));
    expect(tableOps.map((o) => o.id)).toContain("table.ProductEvent");
    expect(tableOps.map((o) => o.id)).toContain("table.SearchAlias");
    expect(tableOps.filter((o) => /drop/i.test(o.label))).toEqual([]);

    // Batch 5 thêm ĐÚNG 2 cột vào bảng hiện có (S3) — không cột nào khác bị đụng
    const columnOps = ops.filter((o) => o.id.startsWith("column."));
    expect(columnOps.map((o) => o.id).sort()).toEqual(
      ["column.public.Listing.locationSource", "column.public.Listing.searchTextNormalized"].sort(),
    );

    // cặp DROP+ADD của Listing_status_check_* — dung sai NẾU planner render (S2):
    // pg/text enum value sống trong CHECK constraint. Batch 5 KHÔNG thêm giá trị
    // listing_status nào nên KHÔNG render là kết quả đúng; nếu render thì phải
    // là đúng 1 cặp DROP+ADD — additive in effect, classify và đi tiếp.
    const listingCheckRe = /^(drop)?checkconstraint\.listing\.listing_status_check_/i;
    const listingCheckOps = ops.filter((o) => listingCheckRe.test(o.id));
    expect(listingCheckOps.filter((o) => /drop/i.test(o.label))).toHaveLength(
      listingCheckOps.length / 2,
    );

    // mọi op "destructive" (drop/alter) đều phải là thành viên của cặp trên —
    // không drop/alter cột/bảng/index/constraint nào đang có khác
    for (const op of ops.filter((o) => o.operationClass === "destructive")) {
      expect(op.id).toMatch(listingCheckRe);
    }
    for (const op of ops.filter((o) => /drop|alter/i.test(o.label))) {
      expect(op.id).toMatch(listingCheckRe);
    }

    // không data transform — backfill location/search-text là offline script
    // (Task 2/4, spec §8.6), KHÔNG nằm trong migration
    expect(ops.filter((o) => o.operationClass === "data")).toEqual([]);

    // full-text index op tồn tại (S-1 — expression pin ở test bên trên)
    expect(
      ops.filter((o) => /^index\.listing\.listing_search_text_search_/i.test(o.id)),
    ).toHaveLength(1);

    // unique (alias, target) render như op riêng
    expect(
      ops.filter((o) => /^unique\.searchalias\.searchalias_alias_target_key$/i.test(o.id)),
    ).toHaveLength(1);

    // CHECK search_alias_target_ids (corrections item 5) render TRONG createTable
    // của SearchAlias (checkExpression trong constraints — KHÔNG phải op riêng):
    // assert presence trong migration.ts của package — runtime 23514 test bên dưới
    // chứng minh constraint sống trong DB.
    const migrationTs = readFileSync(join(migrationsAppDir, dirName!, "migration.ts"), "utf8");
    expect(migrationTs).toMatch(/checkExpression\(\s*'search_alias_target_ids_/);
    // rendered TS escape quote: \'brand\' — match cả dạng escape
    expect(migrationTs).toMatch(
      /target = \\'brand\\' AND "brandId" IS NOT NULL AND "productModelId" IS NULL/,
    );
    expect(migrationTs).toMatch(
      /target = \\'model\\' AND "productModelId" IS NOT NULL AND "brandId" IS NULL/,
    );
  });
});

// ─── 2. Unique + CHECK trên SearchAlias ───

d("search alias constraints hold", () => {
  it("SearchAlias trùng (alias, target) → 23505; cùng alias khác target vẫn sống", async () => {
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const brandId = await mkBrand();
    created.brands.push(brandId);
    const modelId = await mkModel(brandId, categoryId);
    created.productModels.push(modelId);

    const aliasText = `dup-${uid()}`;
    const first = await db.orm.public.SearchAlias.create({
      alias: aliasText,
      target: "brand",
      brandId,
    });
    created.searchAliases.push(first.id);

    // duplicate (alias, target) → 23505
    const err = await expectUniqueViolation(() =>
      db.orm.public.SearchAlias.create({ alias: aliasText, target: "brand", brandId }),
    );
    expect(err.constraint).toBe("SearchAlias_alias_target_key");

    // cùng alias, KHÁC target → được (unique là cặp (alias, target))
    const other = await db.orm.public.SearchAlias.create({
      alias: aliasText,
      target: "model",
      productModelId: modelId,
    });
    created.searchAliases.push(other.id);
    expect((await db.orm.public.SearchAlias.first({ id: other.id }))!.target).toBe("model");
  });

  it("target=brand với brandId NULL bị từ chối — CHECK search_alias_target_ids (corrections item 5)", async () => {
    const err = await expectCheckViolation(() =>
      db.orm.public.SearchAlias.create({ alias: `no-id-${uid()}`, target: "brand" }),
    );
    expect(err.constraint).toMatch(/^search_alias_target_ids_/);
    expect(err.table).toBe("SearchAlias");
  });

  it("target=model với productModelId NULL bị từ chối (target ⇒ id set)", async () => {
    const err = await expectCheckViolation(() =>
      db.orm.public.SearchAlias.create({ alias: `no-id-${uid()}`, target: "model" }),
    );
    expect(err.constraint).toMatch(/^search_alias_target_ids_/);
  });

  it("target=brand với CẢ HAI id set bị từ chối — một alias row trỏ đúng MỘT entity", async () => {
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const brandId = await mkBrand();
    created.brands.push(brandId);
    const modelId = await mkModel(brandId, categoryId);
    created.productModels.push(modelId);
    const err = await expectCheckViolation(() =>
      db.orm.public.SearchAlias.create({
        alias: `both-${uid()}`,
        target: "brand",
        brandId,
        productModelId: modelId,
      }),
    );
    expect(err.constraint).toMatch(/^search_alias_target_ids_/);
  });
});

// ─── 3. Marker + schema khớp contract sau migrate ───

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 4. Finance legacy giữ nguyên (spec §4.3 + §8.1) ───

d("preserves finance tables", () => {
  it("Order/Payment/Payout/WithdrawRequest/LedgerEntry/Dispute vẫn đọc được", async () => {
    // đọc từng bảng — bảng mất/thêm cột sẽ fail ngay ở đây
    expect(await db.orm.public.Order.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payment.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payout.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.WithdrawRequest.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.LedgerEntry.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Dispute.where({ id: "nope-0000" }).all()).toEqual([]);
  });

  it("Order + Payment seeded đọc lại nguyên vẹn", async () => {
    const buyerId = await mkUser("buyer");
    const sellerId = await mkUser("seller");
    created.users.push(buyerId, sellerId);
    const o = await db.orm.public.Order.create({
      code: `B5-${uid()}`,
      buyerId,
      sellerId,
      status: "awaiting_payment",
      totalAmount: 500_000,
      commissionRate: 5,
      commissionAmount: 25_000,
      sellerPayout: 475_000,
      paymentMethod: "escrow",
      shippingAddress: "123 Đường Test, TP Test",
      shippingPhone: "0901234567",
    });
    created.orders.push(o.id);
    const p = await db.orm.public.Payment.create({
      orderId: o.id,
      method: "escrow",
      status: "pending",
      amount: 500_000,
      provider: "momo",
    });
    created.payments.push(p.id);

    const order = await db.orm.public.Order.first({ id: o.id });
    expect(order!.code).toBe(o.code);
    expect(order!.status).toBe("awaiting_payment");
    expect(order!.totalAmount).toBe(500_000);
    expect(order!.commissionRate).toBe(5);
    expect(order!.commissionAmount).toBe(25_000);
    expect(order!.sellerPayout).toBe(475_000);
    expect(order!.paymentMethod).toBe("escrow");
    const payment = await db.orm.public.Payment.first({ id: p.id });
    expect(payment!.orderId).toBe(o.id);
    expect(payment!.method).toBe("escrow");
    expect(payment!.status).toBe("pending");
    expect(payment!.amount).toBe(500_000);
    expect(payment!.provider).toBe("momo");
  });
});

// ─── 5. Batch 2/3/4 tables nhận create + delete round-trip (S-22) ───

d("preserves batch 2/3/4 tables", () => {
  it("Batch 2: UserSession/AuditEvent/BetaCohortMembership/SellerVerification round-trip", async () => {
    const userId = await mkUser();
    created.users.push(userId);

    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: `hash-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.sessions.push(s.id);
    expect((await db.orm.public.UserSession.first({ id: s.id }))!.tokenHash).toBe(s.tokenHash);

    const ae = await db.orm.public.AuditEvent.create({
      actorId: userId,
      action: "session.revoked",
      reason: "typed_reason_code",
    });
    created.auditEvents.push(ae.id);
    expect((await db.orm.public.AuditEvent.first({ id: ae.id }))!.action).toBe("session.revoked");

    const bm = await db.orm.public.BetaCohortMembership.create({
      userId,
      cohort: "internal",
      status: "active",
    });
    created.betaMemberships.push(bm.id);
    const bmRow = await db.orm.public.BetaCohortMembership.first({ id: bm.id });
    expect(bmRow!.cohort).toBe("internal");
    expect(bmRow!.status).toBe("active");

    const sv = await db.orm.public.SellerVerification.create({
      userId,
      policyVersion: "v1",
    });
    created.sellerVerifications.push(sv.id);
    const svRow = await db.orm.public.SellerVerification.first({ id: sv.id });
    expect(svRow!.status).toBe("pending"); // default
    expect(svRow!.policyVersion).toBe("v1");

    // delete round-trip — migration Batch 5 không làm xáo trộn graph Batch 2
    await db.orm.public.UserSession.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSession.first({ id: s.id })).toBeNull();
    await db.orm.public.AuditEvent.where({ id: ae.id }).delete();
    expect(await db.orm.public.AuditEvent.first({ id: ae.id })).toBeNull();
    await db.orm.public.BetaCohortMembership.where({ id: bm.id }).delete();
    expect(await db.orm.public.BetaCohortMembership.first({ id: bm.id })).toBeNull();
    await db.orm.public.SellerVerification.where({ id: sv.id }).delete();
    expect(await db.orm.public.SellerVerification.first({ id: sv.id })).toBeNull();
  });

  it("Batch 3: UserSuspension/ModerationCase/AbuseReport round-trip", async () => {
    const userId = await mkUser("seller");
    const actorId = await mkUser("admin");
    created.users.push(userId, actorId);

    const sus = await db.orm.public.UserSuspension.create({
      userId,
      reasonCode: "confirmed_abuse",
      suspendedById: actorId,
    });
    created.userSuspensions.push(sus.id);
    const susRow = await db.orm.public.UserSuspension.first({ id: sus.id });
    expect(susRow!.status).toBe("active"); // default
    expect(susRow!.reasonCode).toBe("confirmed_abuse");

    const mc = await db.orm.public.ModerationCase.create({
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCategory: "suspected_scam",
    });
    created.moderationCases.push(mc.id);
    const mcRow = await db.orm.public.ModerationCase.first({ id: mc.id });
    expect(mcRow!.state).toBe("open"); // default
    expect(mcRow!.reasonCategory).toBe("suspected_scam");

    const ar = await db.orm.public.AbuseReport.create({
      reporterId: userId,
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCode: "suspected_scam",
      caseId: mc.id,
    });
    created.abuseReports.push(ar.id);
    expect((await db.orm.public.AbuseReport.first({ id: ar.id }))!.reasonCode).toBe(
      "suspected_scam",
    );

    // delete round-trip (thứ tự ngược FK: report → case → suspension)
    await db.orm.public.AbuseReport.where({ id: ar.id }).delete();
    expect(await db.orm.public.AbuseReport.first({ id: ar.id })).toBeNull();
    await db.orm.public.ModerationCase.where({ id: mc.id }).delete();
    expect(await db.orm.public.ModerationCase.first({ id: mc.id })).toBeNull();
    await db.orm.public.UserSuspension.where({ id: sus.id }).delete();
    expect(await db.orm.public.UserSuspension.first({ id: sus.id })).toBeNull();
  });

  it("Batch 4: ListingImageUpload round-trip", async () => {
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
    expect(row!.bytes).toBe(204_800);
    await db.orm.public.ListingImageUpload.where({ id: up.id }).delete();
    expect(await db.orm.public.ListingImageUpload.first({ id: up.id })).toBeNull();
  });
});

// ─── 6. Row pre-Batch-5 sống sót qua migration Batch 5 (b5-review Task 1 L1) ───

/**
 * [b5-review Task 1 L1 — đóng trong Task 11] Migration Batch 5 là additive:
 * một Listing row tạo ở head PRE-Batch 5 phải sống sót nguyên vẹn qua nó.
 *
 * Flow (database THỨ HAI `speaker_b5_l1` trong cùng container scratch — user
 * `speaker` là superuser của container do test-integration.sh tạo, nên
 * CREATE DATABASE được phép; suite chỉ chạy qua scripts/test-integration.sh):
 *  1. CREATE DATABASE speaker_b5_l1 (qua raw lane của pool client chính);
 *  2. `prisma db migrate --db <l1> --to <dir round4>` — head PRE-Batch-5
 *     (dir-name target: requiredInvariants rỗng → self-edge backfill KHÔNG
 *     chạy ở bước này — marker 66d2193a…, invariants []);
 *  3. seed 2 Listing (approved + draft) bằng RAW SQL — contract của ORM là
 *     hình batch-5 (có cột chưa tồn tại ở head cũ) nên ORM lane không dùng
 *     được; raw SQL chỉ chạm cột tồn tại ở head cũ;
 *  4. capture row_to_json (toàn bộ cột) — BEFORE;
 *  5. `prisma db migrate --db <l1> --to production` — path walk từ marker
 *     66d2193a… tới ref production BẮT BUỘC đi qua self-edge round4 (ref
 *     khai báo invariant `backfill-listing-approved-content-at` mà marker
 *     chưa có) → backfill approvedContentAt CHẠY + batch5 áp — đây cũng là
 *     bằng chứng end-to-end cho L2 (path từ @empty tới production gồm
 *     self-edge);
 *  6. capture AFTER + marker → assert.
 *
 * Kỳ vọng: locationSource/searchTextNormalized NULL (cột mới, nullable —
 * S3); MỌI cột khác byte-identical; NGOẠI LỆ DUY NHẤT approvedContentAt trên
 * row approved = updatedAt của row (backfill Batch 4 — data op có chủ đích
 * trên self-edge, KHÔNG phải hiệu ứng Batch 5; row draft không bị chạm vì
 * backfill chỉ đếm status='approved').
 */
d("pre-Batch-5 row survives the batch 5 migration (b5-review T1 L1)", () => {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  const PRE_B5_HEAD_DIR = "20261007T2007_batch4_round4_approved_content_backfill";
  const BATCH5_DIR = "20261007T2208_batch5_search_telemetry";
  // Batch 6 Task 1 — corrections item 3: ref production đã advance qua batch6,
  // path walk từ marker 66d2193a… giờ đi thêm batch6 sau batch5 (append —
  // không assertion nào bị yếu đi; :910 end == production hash giữ nguyên).
  const BATCH6_DIR = "20261008T0237_batch6_chat_deal";
  const INVARIANT = "backfill-listing-approved-content-at";

  type Row = Record<string, unknown>;

  /** Client thứ hai (raw lane only) trỏ vào database L1 — cùng pattern db.client.ts. */
  function mkL1Client(url: string) {
    return postgres<Contract>({ contractJson, url });
  }
  type L1Client = ReturnType<typeof mkL1Client>;

  /** Chạy `npx prisma …` từ repo root, trả envelope result của dòng result cuối. */
  async function prismaCli(
    args: string[],
  ): Promise<{ migrationsApplied: number; markerHash: string; applied: Array<{ dirName: string }> }> {
    const { stdout } = await execFileAsync("npx", ["prisma", ...args], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = stdout
      .split("\n")
      .filter((l) => l.startsWith("{") && l.includes('"kind":"result"'))
      .at(-1);
    expect(line, "prisma CLI result line").toBeTruthy();
    return JSON.parse(line!).envelope.result;
  }

  /** SELECT row_to_json(l) cho 1 Listing id — toàn bộ cột, so sánh byte. */
  async function readListingRow(client: L1Client, id: string): Promise<Row> {
    const rows = await client
      .runtime()
      .query(
        client.raw.sql`SELECT row_to_json(l) AS row FROM "public"."Listing" l WHERE "id" = ${id}`
          .returnsRow({ row: "pg/json@1" })
          .build(),
      )
      .toArray();
    expect(rows, `Listing ${id}`).toHaveLength(1);
    return rows[0]!.row as Row;
  }

  it(
    "row tạo ở head pre-Batch-5: locationSource/searchTextNormalized NULL, mọi cột khác nguyên vẹn",
    { timeout: 180_000 },
    async () => {
      const mainUrl = process.env.DATABASE_URL!;
      const l1Url = mainUrl.replace(/\/[^/]+$/, "/speaker_b5_l1");
      // hash kỳ vọng đọc từ artefact (nguồn chân thực của graph — không hardcode)
      const preB5To = (
        JSON.parse(
          readFileSync(join(ROOT, "migrations/app", PRE_B5_HEAD_DIR, "migration.json"), "utf8"),
        ) as { to: string }
      ).to;
      const productionRef = JSON.parse(
        readFileSync(join(ROOT, "migrations/app/refs/production.json"), "utf8"),
      ) as { hash: string; invariants: string[] };

      let l1: L1Client | null = null;
      try {
        // 1. database thứ hai trong cùng container scratch (tên là hằng số —
        //    identifier SQL không parameterize được; DROP IF EXISTS chống đọng)
        await db
          .runtime()
          .execute(db.raw.sql`DROP DATABASE IF EXISTS speaker_b5_l1 WITH (FORCE)`.affectedCount().build());
        await db.runtime().execute(db.raw.sql`CREATE DATABASE speaker_b5_l1`.affectedCount().build());

        // 2. migrate L1 về head PRE-Batch-5 (dir-name target: requiredInvariants
        //    rỗng → self-edge backfill KHÔNG chạy ở bước này)
        const pre = await prismaCli(["db", "migrate", "--db", l1Url, "--to", PRE_B5_HEAD_DIR]);
        expect(pre.migrationsApplied).toBe(5); // baseline → b2 → b3 → b4 → holistic
        expect(pre.markerHash).toBe(preB5To); // head cũ — CHƯA có batch5

        // 3. seed raw SQL (ORM lane không dùng được: contract hiện tại là hình
        //    batch-5 — cột chưa tồn tại ở head cũ; raw SQL chỉ chạm cột head cũ)
        l1 = mkL1Client(l1Url);
        const suffix = `${Date.now()}`;
        const sellerId = `l1-seller-${suffix}`;
        const catId = `l1-cat-${suffix}`;
        const approvedId = `l1-listing-approved-${suffix}`;
        const draftId = `l1-listing-draft-${suffix}`;
        await l1.runtime().execute(
          l1.raw.sql`INSERT INTO "public"."User" ("id","email","passwordHash","name","role","createdAt","updatedAt")
            VALUES (${sellerId}, ${`l1-${suffix}@integration.test`}, ${"x"}, ${"L1 Seller"}, ${"seller"}, now(), now())`.affectedCount().build(),
        );
        await l1.runtime().execute(
          l1.raw.sql`INSERT INTO "public"."Category" ("id","name","slug","createdAt")
            VALUES (${catId}, ${`L1 Cat ${suffix}`}, ${`l1-cat-${suffix}`}, now())`.affectedCount().build(),
        );
        await l1.runtime().execute(
          l1.raw.sql`INSERT INTO "public"."Listing"
            ("id","sellerId","categoryId","title","slug","description","condition","price","status","city","viewCount","createdAt","updatedAt")
            VALUES (${approvedId}, ${sellerId}, ${catId}, ${"Loa L1 approved"}, ${`loa-l1-approved-${suffix}`}, ${"mô tả L1"}, ${"good"}, ${1000000}, ${"approved"}, ${"Hà Nội"}, ${0}, now(), now())`.affectedCount().build(),
        );
        await l1.runtime().execute(
          l1.raw.sql`INSERT INTO "public"."Listing"
            ("id","sellerId","categoryId","title","slug","description","condition","price","status","city","viewCount","createdAt","updatedAt")
            VALUES (${draftId}, ${sellerId}, ${catId}, ${"Loa L1 draft"}, ${`loa-l1-draft-${suffix}`}, ${"mô tả L1"}, ${"good"}, ${1000000}, ${"draft"}, ${"Hà Nội"}, ${0}, now(), now())`.affectedCount().build(),
        );

        // 4. BEFORE — toàn bộ cột ở head cũ
        const approvedBefore = await readListingRow(l1, approvedId);
        const draftBefore = await readListingRow(l1, draftId);
        expect(approvedBefore.status).toBe("approved");
        expect(approvedBefore.approvedContentAt).toBeNull(); // backfill chưa chạy
        await l1.close();
        l1 = null;

        // 5. migrate tới production — path walk từ marker 66d2193a… tới ref
        //    production BẮT BUỘC đi qua self-edge round4 (ref khai báo
        //    invariant mà marker chưa có) → backfill CHẠY + batch5 áp
        const post = await prismaCli(["db", "migrate", "--db", l1Url, "--to", "production"]);
        expect(post.applied.map((m) => m.dirName)).toEqual([PRE_B5_HEAD_DIR, BATCH5_DIR, BATCH6_DIR]);
        expect(post.markerHash).toBe(productionRef.hash);

        // 6. AFTER + marker
        l1 = mkL1Client(l1Url);
        const approvedAfter = await readListingRow(l1, approvedId);
        const draftAfter = await readListingRow(l1, draftId);
        const markerRows = await l1
          .runtime()
          .query(
            l1.raw.sql`SELECT "core_hash" AS hash, to_jsonb("invariants") AS invariants FROM "prisma_contract"."marker"`
              .returnsRow({ hash: "pg/text@1", invariants: "pg/json@1" })
              .build(),
          )
          .toArray();
        expect(markerRows).toHaveLength(1);
        expect(markerRows[0]!.hash).toBe(productionRef.hash);
        expect(markerRows[0]!.invariants as string[]).toContain(INVARIANT); // marker ghi invariant → idempotent

        // 7. assert — 2 cột mới NULL (S3), mọi cột khác byte-identical
        for (const [before, after, label] of [
          [approvedBefore, approvedAfter, "approved"],
          [draftBefore, draftAfter, "draft"],
        ] as const) {
          expect(after.locationSource, `${label}.locationSource`).toBeNull();
          expect(after.searchTextNormalized, `${label}.searchTextNormalized`).toBeNull();
          // đúng 2 key mới xuất hiện — không cột nào khác bị thêm/bớt
          expect(Object.keys(after).sort()).toEqual(
            [...Object.keys(before), "locationSource", "searchTextNormalized"].sort(),
          );
          for (const [k, v] of Object.entries(before)) {
            // approvedContentAt: duy nhất được phép đổi (backfill Batch 4 trên
            // self-edge — có chủ đích, KHÔNG phải hiệu ứng Batch 5) — assert riêng bên dưới
            if (k === "approvedContentAt") continue;
            expect(after[k], `${label}.${k} unchanged`).toEqual(v);
          }
        }
        // row approved: backfill Batch 4 đã chạy trên self-edge (L2 end-to-end)
        expect(approvedAfter.approvedContentAt).toBe(approvedBefore.updatedAt);
        // row draft: backfill KHÔNG chạm (WHERE status='approved') — toàn vẹn
        expect(draftAfter.approvedContentAt).toBeNull();
      } finally {
        // dọn: đóng client L1 rồi drop database (DROP cần không còn connection)
        await l1?.close();
        await db
          .runtime()
          .execute(db.raw.sql`DROP DATABASE IF EXISTS speaker_b5_l1 WITH (FORCE)`.affectedCount().build())
          .catch(() => undefined); // container scratch dọn ở trap EXIT — không che failure thật
      }
    },
  );
});
