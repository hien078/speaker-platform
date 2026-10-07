/**
 * Beta catalog seed (Batch 4 Task 7 — spec §5.6.1 category gate, §1 focus
 * brands, §12.1 core model coverage; A3/A11) — integration tests trên scratch
 * DB (scripts/test-integration.sh: container riêng + migrate + dọn).
 * KHÔNG chạy trong `npm test` (vitest.config.ts chỉ gồm tests/unit).
 *
 * Chứng minh scripts/seed-beta-catalog.ts (offline maintenance command —
 * Batch 2 backfill-script posture: dry-run mặc định, --apply để mutate,
 * idempotent, KHÔNG expose HTTP/admin UI):
 *
 *  1. Fail closed: thiếu DATABASE_URL trong env THẬT → từ chối;
 *     NODE_ENV=production → từ chối trừ khi --allow-production tường minh.
 *  2. Dry-run báo cáo plan (counts) và KHÔNG mutate gì (0 row, không audit).
 *  3. --apply tạo Category "Loa Bluetooth di động" slug NGUYÊN VĂN
 *     "portable_bluetooth_speaker" (allowlist slug — KHÔNG qua slugify,
 *     underscore intact) + đủ 5 brand focus spec §1 (JBL, Marshall, Sony,
 *     Bose, Soundcore — Soundcore MỚI); listingRegimeForCategorySlug
 *     === "beta"; model APPROVED (fixture CỦA TEST) trong category beta
 *     round-trip productModelId qua Listing (canonical-model-selection gate).
 *  4. --models <founder.json> (fixture DO TEST cung — A3: KHÔNG phụ thuộc
 *     danh sách founder thật): upsert create-if-absent theo slug, status
 *     "pending" (founder duyệt qua /admin/catalog — KHÔNG model nào tự
 *     approved); model ĐÃ TỒN TẠI (sony-srs-xp500 approved trong
 *     loa-bluetooth — trạng thái src/prisma/seed-models.ts tái tạo) KHÔNG
 *     bị reassign category/brand/status.
 *  5. AuditEvent ghi TRỰC TIẾP qua db.orm (actor null — system/offline,
 *     action "beta_catalog.seeded", detail = counts — KHÔNG PII); script
 *     KHÔNG import helper audit server-only (source-contract — 0 hit kể cả
 *     comment, theo Task 9 scan convention).
 *  6. Idempotent: --apply lần hai (cùng founder file) no-op — 0 row mới,
 *     không nhân bản.
 *  7. Rollback: xoá ProductModel theo slug list + brand chưa dùng +
 *     category — khôi phục trạng thái trước (category biến mất).
 *
 * CÁC CASE CHẠY THEO THỨ TỰ trong một describe — state tích lũy có chủ đích
 * (dry-run trên DB sạch → apply → --models → audit → idempotent → rollback
 * dọn sạch); afterAll là lưới an toàn khi case trước fail giữa chừng.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { db } from "../../src/prisma/db.client";
import { listingRegimeForCategorySlug } from "../../src/lib/beta-categories";
import { seedBetaCatalog } from "../../scripts/seed-beta-catalog";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Spec §5.6.1 verbatim — allowlist slug, KHÔNG qua slugify (A11). */
const BETA_SLUG = "portable_bluetooth_speaker";
/** 5 brand focus spec §1 — slug = slugify(name) theo convention seed.ts. */
const SEED_BRAND_SLUGS = ["jbl", "marshall", "sony", "bose", "soundcore"] as const;
/** Source-contract: đọc source script theo vị trí file, không phụ thuộc CWD. */
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/seed-beta-catalog.ts", import.meta.url));

let seq = 0;
const uid = () => `bcs-${Date.now()}-${seq++}`;

async function mkUser(): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: "BCS seller",
    role: "seller",
  });
  return u.id;
}

/**
 * Founder file DO TEST cung (A3 — implementer KHÔNG tự viết danh sách model
 * từ training data; đây là fixture để đi qua đường --models, dọn sạch ở
 * rollback case). "Sony SRS-XP500" trùng slug model đã tồn tại → phải skip;
 * "Yamaha Stagepas 600I" dùng brand NGOÀI 5 brand seed nhưng đã có trong DB
 * (fixture) → phải dùng row đó, KHÔNG tự chế brand mới.
 */
function writeFounderFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "beta-catalog-seed-"));
  const file = join(dir, "founder.json");
  writeFileSync(
    file,
    JSON.stringify([
      { brand: "JBL", name: "Charge 5", releaseYear: 2021 },
      { brand: "Sony", name: "SRS-XP500" },
      { brand: "Soundcore", name: "Motion 300" },
      { brand: "Yamaha", name: "Stagepas 600I" },
    ]),
    "utf8",
  );
  return { dir, file };
}

// ─── Teardown (thứ tự ngược FK — Restrict mặc định: listing → model →
// category/brand → user; audit không FK chặn) ────────────────────────────────

const created = {
  users: [] as string[],
  listings: [] as string[],
  models: [] as string[], // fixture model theo id
  brands: [] as string[], // fixture brand theo id (ngoài 5 brand seed)
  categories: [] as string[], // fixture category theo id
};
let founder: { dir: string; file: string } | null = null;

/** Model seed theo slug (founder file của test + fixture trùng slug seed-models.ts). */
const SEED_MODEL_SLUGS = ["jbl-charge-5", "soundcore-motion-300", "yamaha-stagepas-600i", "sony-srs-xp500"];

/** Dọn theo slug/id — no-op khi rollback case đã dọn (best-effort lưới an toàn). */
async function teardown(): Promise<void> {
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
  }
  for (const id of created.models) {
    await db.orm.public.ProductModel.where({ id }).deleteAll();
  }
  // model seed theo slug list (kể cả fixture sony-srs-xp500 cùng slug)
  await db.orm.public.ProductModel.where((m) => m.slug.in(SEED_MODEL_SLUGS)).deleteAll();
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  await db.orm.public.Category.where({ slug: BETA_SLUG }).deleteAll();
  await db.orm.public.Brand.where((b) => b.slug.in([...SEED_BRAND_SLUGS])).deleteAll();
  for (const id of created.brands) {
    await db.orm.public.Brand.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).deleteAll();
  }
  await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).deleteAll();
}

afterEach(() => {
  vi.unstubAllEnvs(); // stubEnv của case fail-closed không rò sang case khác
});

afterAll(async () => {
  await teardown();
  if (founder) rmSync(founder.dir, { recursive: true, force: true });
  await db.close();
});

// ─── 1. Fail closed (env thật trước khi db.client nạp) ──────────────────────

d("beta catalog seed — scripts/seed-beta-catalog.ts (plan Task 7)", () => {
  it("fail closed: thiếu DATABASE_URL trong env thật → từ chối; NODE_ENV=production → từ chối trừ khi --allow-production", async () => {
    // DATABASE_URL phải nằm trong env THẬT (process.env) TRƯỚC db.client nạp
    // (L3 — backfill precedent): thiếu → typed refusal, KHÔNG chạm DB.
    vi.stubEnv("DATABASE_URL", "");
    await expect(seedBetaCatalog(false)).rejects.toThrowError(/DATABASE_URL/);
    vi.unstubAllEnvs();

    // NODE_ENV=production: seed catalog vào DB thật phải là hành động có chủ
    // đích — từ chối trừ khi allowProduction tường minh (dry-run KHÔNG mutate
    // nên an toàn để đi qua).
    vi.stubEnv("NODE_ENV", "production");
    await expect(seedBetaCatalog(false)).rejects.toThrowError(/SEED_REFUSED_PRODUCTION/);
    const allowed = await seedBetaCatalog(false, undefined, { allowProduction: true });
    expect(allowed.mode).toBe("dry-run");
    vi.unstubAllEnvs();
  });

  // ─── 2. Dry-run: báo cáo plan, KHÔNG mutate ───────────────────────────────

  it("dry-run báo cáo plan (counts) và KHÔNG mutate gì (0 row, không audit)", async () => {
    const report = await seedBetaCatalog(false);
    expect(report.mode).toBe("dry-run");
    expect(report.category).toBe(1); // SẼ tạo category beta (DB sạch)
    expect(report.brands).toBe(5); // SẼ tạo đủ 5 brand focus spec §1
    expect(report.models).toBe(0); // không có --models
    expect(report.detail.categorySlug).toBe(BETA_SLUG);

    // KHÔNG mutate: 0 row, không audit
    expect(await db.orm.public.Category.first({ slug: BETA_SLUG })).toBeNull();
    for (const slug of SEED_BRAND_SLUGS) {
      expect(await db.orm.public.Brand.first({ slug })).toBeNull();
    }
    expect(await db.orm.public.AuditEvent.first({ action: "beta_catalog.seeded" })).toBeNull();
  });

  // ─── 3. --apply: category allowlist slug + 5 brand + model round-trip ────

  it("--apply tạo category slug allowlist (underscore NGUYÊN VĂN — KHÔNG slugify) + brand Soundcore; regime beta; model approved round-trip productModelId", async () => {
    const report = await seedBetaCatalog(true);
    expect(report.mode).toBe("apply");
    expect(report.category).toBe(1);
    expect(report.brands).toBe(5);
    expect(report.models).toBe(0);

    const category = await db.orm.public.Category.first({ slug: BETA_SLUG });
    expect(category).not.toBeNull();
    // underscore intact — slugify() sẽ cho "portable-bluetooth-speaker" và
    // làm hỏng khóa allowlist (A11 — KHÔNG slugify slug này)
    expect(category!.slug).toBe("portable_bluetooth_speaker");
    expect(category!.name).toBe("Loa Bluetooth di động");
    expect(category!.isActive).toBe(true);
    expect(listingRegimeForCategorySlug(category!.slug)).toBe("beta");

    // đủ 5 brand focus (spec §1) — Soundcore MỚI (seed hiện chưa có)
    for (const slug of SEED_BRAND_SLUGS) {
      expect(await db.orm.public.Brand.first({ slug })).not.toBeNull();
    }
    expect((await db.orm.public.Brand.first({ slug: "soundcore" }))!.name).toBe("Soundcore");

    // canonical-model-selection gate: model APPROVED (fixture CỦA TEST) trong
    // category beta → Listing tạo chống nó round-trip productModelId
    const jbl = (await db.orm.public.Brand.first({ slug: "jbl" }))!;
    const model = await db.orm.public.ProductModel.create({
      brandId: jbl.id,
      categoryId: category!.id,
      name: `Fixture Model ${uid()}`,
      slug: `fixture-model-${uid()}`,
      status: "approved",
    });
    created.models.push(model.id);
    const sellerId = await mkUser();
    created.users.push(sellerId);
    const listing = await db.orm.public.Listing.create({
      sellerId,
      categoryId: category!.id,
      brandId: jbl.id,
      productModelId: model.id,
      title: `Loa fixture ${uid()}`,
      slug: `loa-fixture-${uid()}`,
      description: "integration test beta catalog seed",
      condition: "good",
      price: 1_000_000,
      status: "approved",
      city: "Hà Nội",
    });
    created.listings.push(listing.id);
    const row = await db.orm.public.Listing.first({ id: listing.id });
    expect(row!.productModelId).toBe(model.id);
  });

  // ─── 4. --models: upsert PENDING, KHÔNG reassign model cũ ────────────────

  it("--models <founder.json> upsert model PENDING (create-if-absent); model đã tồn tại KHÔNG bị reassign category/brand/status", async () => {
    // fixture tái tạo trạng thái src/prisma/seed-models.ts: sony-srs-xp500
    // APPROVED trong category legacy loa-bluetooth (A11: seed KHÔNG đụng)
    const legacyCategory = await db.orm.public.Category.create({
      name: "Loa Bluetooth",
      slug: "loa-bluetooth",
    });
    created.categories.push(legacyCategory.id);
    const sony = (await db.orm.public.Brand.first({ slug: "sony" }))!; // brand do seed tạo ở case trước
    const existingModel = await db.orm.public.ProductModel.create({
      brandId: sony.id,
      categoryId: legacyCategory.id,
      name: "SRS-XP500",
      slug: "sony-srs-xp500",
      status: "approved",
    });
    created.models.push(existingModel.id);

    founder = writeFounderFile();
    // brand NGOÀI 5 brand seed nhưng đã có trong DB (fixture) — seed phải dùng
    // row này cho model founder, KHÔNG tự chế brand mới ngoài danh sách
    const yamaha = await db.orm.public.Brand.create({ name: "Yamaha", slug: "yamaha" });
    created.brands.push(yamaha.id);
    const report = await seedBetaCatalog(true, founder.file);
    expect(report.mode).toBe("apply");
    expect(report.category).toBe(0); // đã có — create-if-absent
    expect(report.brands).toBe(0);
    expect(report.models).toBe(3); // Charge 5 + Motion 300 + Stagepas 600I; SRS-XP500 đã tồn tại → skip

    const betaCategoryId = (await db.orm.public.Category.first({ slug: BETA_SLUG }))!.id;

    // model MỚI: PENDING trong category beta, đúng brand — founder duyệt qua
    // /admin/catalog (A3) — KHÔNG model nào tự động approved
    const charge5 = await db.orm.public.ProductModel.first({ slug: "jbl-charge-5" });
    expect(charge5).not.toBeNull();
    expect(charge5!.status).toBe("pending");
    expect(charge5!.categoryId).toBe(betaCategoryId);
    expect(charge5!.brandId).toBe((await db.orm.public.Brand.first({ slug: "jbl" }))!.id);
    expect(charge5!.releaseYear).toBe(2021);

    const motion = await db.orm.public.ProductModel.first({ slug: "soundcore-motion-300" });
    expect(motion).not.toBeNull();
    expect(motion!.status).toBe("pending");
    expect(motion!.categoryId).toBe(betaCategoryId);

    // brand ngoài 5 nhưng đã có trong DB: model vẫn seed PENDING dưới brand đó
    const stagepas = await db.orm.public.ProductModel.first({ slug: "yamaha-stagepas-600i" });
    expect(stagepas).not.toBeNull();
    expect(stagepas!.status).toBe("pending");
    expect(stagepas!.categoryId).toBe(betaCategoryId);
    expect(stagepas!.brandId).toBe(yamaha.id); // dùng row DB có sẵn — KHÔNG tạo brand mới

    // model ĐÃ TỒN TẠI: KHÔNG reassign — vẫn approved trong loa-bluetooth + brand sony
    const untouched = await db.orm.public.ProductModel.first({ slug: "sony-srs-xp500" });
    expect(untouched!.id).toBe(existingModel.id);
    expect(untouched!.status).toBe("approved");
    expect(untouched!.categoryId).toBe(legacyCategory.id);
    expect(untouched!.brandId).toBe(sony.id);
  });

  // ─── 5. Audit trực tiếp qua db.orm + source-contract ──────────────────────

  it("AuditEvent ghi TRỰC TIẾP qua db.orm — actor null, action beta_catalog.seeded, detail = counts; script KHÔNG import helper audit server-only (source-contract)", async () => {
    const events = await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).all();
    expect(events.length).toBeGreaterThanOrEqual(2); // 2 lần apply ở case 3 + 4
    for (const evt of events) {
      expect(evt.actorId).toBeNull(); // system/offline — KHÔNG reviewer người
      expect(evt.detail).toMatch(/^category=\d+ brands=\d+ models=\d+$/); // counts — KHÔNG PII
    }

    // source-contract: script import CHỈ plain module — helper audit của app
    // là server-only (throw dưới tsx) nên KHÔNG BAO GIỜ được import. 0 hit kể
    // cả comment (Task 9 scan convention).
    const src = readFileSync(SCRIPT_PATH, "utf8");
    expect(src).not.toContain("audit-event");
    expect(src).not.toMatch(/import\s+["']server-only["']/);
  });

  // ─── 6. Idempotent ────────────────────────────────────────────────────────

  it("idempotent: --apply lần HAI (cùng founder file) no-op — 0 row mới, không nhân bản", async () => {
    const report = await seedBetaCatalog(true, founder!.file);
    expect(report.mode).toBe("apply");
    expect(report.category).toBe(0);
    expect(report.brands).toBe(0);
    expect(report.models).toBe(0); // cả 4 model founder đều đã có (SRS-XP500 skip từ case 4)

    // KHÔNG nhân bản: đúng 1 category beta, đúng 5 brand, đúng 1 model/slug
    expect(await db.orm.public.Category.where({ slug: BETA_SLUG }).all()).toHaveLength(1);
    expect(
      await db.orm.public.Brand.where((b) => b.slug.in([...SEED_BRAND_SLUGS])).all(),
    ).toHaveLength(5);
    for (const slug of ["jbl-charge-5", "soundcore-motion-300", "yamaha-stagepas-600i", "sony-srs-xp500"]) {
      expect(await db.orm.public.ProductModel.where({ slug }).all()).toHaveLength(1);
    }
  });

  // ─── 7. Rollback (procedure chứng minh trên scratch DB) ──────────────────

  it("rollback: xoá ProductModel theo slug list + brand chưa dùng + category — khôi phục trạng thái trước (category biến mất)", async () => {
    // 0. fixture phụ thuộc FK trước (listing Restrict sang category/brand/model)
    for (const id of created.listings) {
      await db.orm.public.Listing.where({ id }).deleteAll();
    }
    // 1. ProductModel: fixture theo id + seed theo slug list (3 model seed tạo ở case 4/6)
    for (const id of created.models) {
      await db.orm.public.ProductModel.where({ id }).deleteAll();
    }
    await db.orm.public.ProductModel
      .where((m) => m.slug.in(["jbl-charge-5", "soundcore-motion-300", "yamaha-stagepas-600i"]))
      .deleteAll();
    // 2. category fixture (loa-bluetooth) — model của nó đã xoá ở bước 1
    for (const id of created.categories) {
      await db.orm.public.Category.where({ id }).deleteAll();
    }
    // 3. brand chưa dùng (đủ 5 slug seed — model đã xoá ở bước 1)
    await db.orm.public.Brand.where((b) => b.slug.in([...SEED_BRAND_SLUGS])).deleteAll();
    // 4. category beta — bước cuối của rollback procedure
    await db.orm.public.Category.where({ slug: BETA_SLUG }).deleteAll();

    // trạng thái TRƯỚC seed được khôi phục
    expect(await db.orm.public.Category.first({ slug: BETA_SLUG })).toBeNull();
    for (const slug of SEED_BRAND_SLUGS) {
      expect(await db.orm.public.Brand.first({ slug })).toBeNull();
    }
    expect(await db.orm.public.ProductModel.first({ slug: "jbl-charge-5" })).toBeNull();
    // brand CÓ TRƯỚC seed (fixture Yamaha — ngoài 5 brand seed) sống qua rollback:
    // procedure chỉ xoá những gì seed ĐÃ THÊM, không xoá trạng thái có sẵn
    expect(await db.orm.public.Brand.first({ slug: "yamaha" })).not.toBeNull();

    // user fixture dọn sau (listing đã xoá — Cascade không còn gì treo)
    for (const id of created.users) {
      await db.orm.public.User.where({ id }).deleteAll();
    }
  });
});
