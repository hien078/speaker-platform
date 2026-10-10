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
 *     NODE_ENV=production → từ chối --apply trừ khi --allow-production
 *     tường minh (b4-holistic round-4: guard thu hẹp CHỈ --apply — dry-run
 *     chỉ đọc được PHÉP, compose migrate set NODE_ENV=production), 0 row +
 *     không audit.
 *  2. Dry-run báo cáo plan (counts) và KHÔNG mutate gì (0 row, không audit).
 *  3. Input founder file SAI SHAPE (review fix H2) → typed error, KHÔNG
 *     write gì (0 Category/Brand/ProductModel row, không audit) — CẢ
 *     dry-run lẫn --apply: JSON hỏng, gốc không phải mảng, sai kiểu,
 *     releaseYear thập phân/ngoài khoảng (H1), brand ngoài danh sách
 *     (SEED_MODEL_BRAND_MISSING), duplicate slug trong file (M4), khoá lạ
 *     (M5), caps file ≤ 1MB / ≤ 500 mục / brand,name ≤ 100 ký tự (M5).
 *  4. CLI (M6): --models thiếu đường dẫn (hoặc theo sau cờ khác) → usage
 *     error (exit 1); --models <file> parse đúng.
 *  5. --apply tạo Category "Loa Bluetooth di động" slug NGUYÊN VĂN
 *     "portable_bluetooth_speaker" (allowlist slug — KHÔNG qua slugify,
 *     underscore intact) + đủ 5 brand focus spec §1 (JBL, Marshall, Sony,
 *     Bose, Soundcore — Soundcore MỚI); listingRegimeForCategorySlug
 *     === "beta"; model APPROVED (fixture CỦA TEST) trong category beta
 *     round-trip productModelId qua Listing (canonical-model-selection gate).
 *  6. --models <founder.json> (fixture DO TEST cung — A3: KHÔNG phụ thuộc
 *     danh sách founder thật): upsert create-if-absent theo slug, status
 *     "pending" (founder duyệt qua /admin/catalog — KHÔNG model nào tự
 *     approved); model ĐÃ TỒN TẠI (sony-srs-xp500 approved trong
 *     loa-bluetooth — trạng thái src/prisma/seed-models.ts tái tạo) KHÔNG
 *     bị reassign category/brand/status.
 *  7. AuditEvent ghi TRỰC TIẾP qua db.orm (actor null — system/offline,
 *     action "beta_catalog.seeded", detail = counts — KHÔNG PII); script
 *     KHÔNG import helper audit server-only (source-contract — 0 hit kể cả
 *     comment, theo Task 9 scan convention). Source-contract M3: MỘT
 *     db.transaction bao toàn bộ creates + audit, audit qua tx.orm.
 *  8. Idempotent: --apply lần hai (cùng founder file) no-op — 0 row mới,
 *     không nhân bản.
 *  9. Rollback: xoá ProductModel theo slug list + brand + category — khôi
 *     phục trạng thái trước (category biến mất).
 * 10. Atomic (review fix M3): lỗi GIỮA apply (brand bị tx khác xoá giữa
 *     chừng → FK 23503) → TOÀN BỘ seed rollback — 0 row, không audit
 *     (KHÔNG bao giờ partial write).
 * 11. Race 23505 (review fix M3/L9): tx khác commit category giữa read và
 *     create → seed rollback + CHẠY LẠI toàn bộ đúng 1 lần (idempotent);
 *     model raced đang có khác category kỳ vọng → cảnh báo counts/slugs.
 * 12. Dry-run (review fix L8): category đang có INACTIVE → report in rõ
 *     isActive=false + cảnh báo; seed KHÔNG tự kích hoạt lại.
 *
 * CÁC CASE CHẠY THEO THỨ TỰ trong một describe — state tích lũy có chủ đích
 * (dry-run trên DB sạch → apply → --models → audit → idempotent → rollback
 * dọn sạch → L8 → atomic → race); afterAll là lưới an toàn khi case trước
 * fail giữa chừng.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { SqlQueryError } from "@prisma/orm-family-sql/errors";

import { db } from "../../src/prisma/db.client";
import { listingRegimeForCategorySlug } from "../../src/lib/beta-categories";
import { parseSeedCliArgs, seedBetaCatalog } from "../../scripts/seed-beta-catalog";

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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** Viết file founder tuỳ ý (case invalid input — dọn trong finally). */
function writeTempFounderFile(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "beta-catalog-seed-case-"));
  const file = join(dir, "founder.json");
  writeFileSync(file, content, "utf8");
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
  it("fail closed: thiếu DATABASE_URL trong env thật → từ chối; NODE_ENV=production → từ chối --apply trừ khi --allow-production (dry-run được phép — b4-holistic round-4)", async () => {
    // DATABASE_URL phải nằm trong env THẬT (process.env) TRƯỚC db.client nạp
    // (L3 — backfill precedent): thiếu → typed refusal, KHÔNG chạm DB.
    vi.stubEnv("DATABASE_URL", "");
    await expect(seedBetaCatalog(false)).rejects.toThrowError(/DATABASE_URL/);
    vi.unstubAllEnvs();

    // b4-holistic round-4: guard NODE_ENV thu hẹp CHỈ --apply — dry-run (chỉ
    // đọc + in plan) ĐƯỢC PHÉP dưới NODE_ENV=production (compose service
    // migrate set production — dry-run là bước BẮT BUỘC trong docs/deployment.md
    // §2 bước 5; trước fix guard cũ chặn cả dry-run → bước doc không chạy được).
    vi.stubEnv("NODE_ENV", "production");
    const dryRun = await seedBetaCatalog(false);
    expect(dryRun.mode).toBe("dry-run"); // đọc plan được — KHÔNG bị guard chặn
    vi.unstubAllEnvs();

    // --apply (isApply=true) vẫn từ chối khi NODE_ENV=production thiếu cờ —
    // refusal chặn TRƯỚC khi chạm DB → 0 row, không audit (fail closed).
    // (--allow-production pass-through pin ở unit seed-beta-catalog-guard;
    // --apply THẬT pin ở case 4 dưới — không mutate ở đây để giữ DB sạch
    // cho các case sau.)
    vi.stubEnv("NODE_ENV", "production");
    await expect(seedBetaCatalog(true)).rejects.toThrowError(/SEED_REFUSED_PRODUCTION/);
    vi.unstubAllEnvs();
    expect(await db.orm.public.Category.first({ slug: BETA_SLUG })).toBeNull();
    expect(await db.orm.public.AuditEvent.first({ action: "beta_catalog.seeded" })).toBeNull();
  });

  // ─── 2. Dry-run: báo cáo plan, KHÔNG mutate ───────────────────────────────

  it("dry-run báo cáo plan (counts) và KHÔNG mutate gì (0 row, không audit)", async () => {
    const report = await seedBetaCatalog(false);
    expect(report.mode).toBe("dry-run");
    expect(report.category).toBe(1); // SẼ tạo category beta (DB sạch)
    expect(report.brands).toBe(5); // SẼ tạo đủ 5 brand focus spec §1
    expect(report.models).toBe(0); // không có --models
    expect(report.detail.categorySlug).toBe(BETA_SLUG);
    expect(report.detail.categoryExists).toBe(false);
    expect(report.detail.categoryIsActive).toBeNull(); // chưa có → null (L8)

    // KHÔNG mutate: 0 row, không audit
    expect(await db.orm.public.Category.first({ slug: BETA_SLUG })).toBeNull();
    for (const slug of SEED_BRAND_SLUGS) {
      expect(await db.orm.public.Brand.first({ slug })).toBeNull();
    }
    expect(await db.orm.public.AuditEvent.first({ action: "beta_catalog.seeded" })).toBeNull();
  });

  // ─── 3. Input sai shape → typed error, KHÔNG write (review fix H2) ────────

  /** Chạy seed với file founder SAI — cả dry-run lẫn --apply phải reject + 0 write. */
  async function expectInvalidFounderFile(content: string, expected: RegExp, modelSlugs: string[]): Promise<void> {
    const { dir, file } = writeTempFounderFile(content);
    try {
      await expect(seedBetaCatalog(false, file)).rejects.toThrowError(expected);
      await expect(seedBetaCatalog(true, file)).rejects.toThrowError(expected);
      // KHÔNG write gì cả: 0 row category/brand/model, không audit
      expect(await db.orm.public.Category.first({ slug: BETA_SLUG })).toBeNull();
      for (const slug of SEED_BRAND_SLUGS) {
        expect(await db.orm.public.Brand.first({ slug })).toBeNull();
      }
      for (const slug of modelSlugs) {
        expect(await db.orm.public.ProductModel.first({ slug })).toBeNull();
      }
      expect(await db.orm.public.AuditEvent.first({ action: "beta_catalog.seeded" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const INVALID_FOUNDER_CASES: Array<{ name: string; content: string; expected: RegExp; modelSlugs: string[] }> = [
    {
      name: "JSON hỏng",
      content: `{"brand":"JBL",[`,
      expected: /SEED_MODELS_FILE_INVALID:json_invalid/,
      modelSlugs: [],
    },
    {
      name: "gốc không phải mảng",
      content: `{"brand":"JBL","name":"Charge 5"}`,
      expected: /SEED_MODELS_FILE_INVALID:root_not_array/,
      modelSlugs: [],
    },
    {
      name: "mục không phải object",
      content: JSON.stringify(["JBL Charge 5"]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:not_object/,
      modelSlugs: [],
    },
    {
      name: "brand sai kiểu (số — kèm index mục)",
      content: JSON.stringify([{ brand: 123, name: "Charge 5" }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:brand_/,
      modelSlugs: [],
    },
    {
      name: "thiếu name",
      content: JSON.stringify([{ brand: "JBL" }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:name_/,
      modelSlugs: [],
    },
    {
      name: "releaseYear thập phân (2024.5 — H1)",
      content: JSON.stringify([{ brand: "JBL", name: "Charge 5", releaseYear: 2024.5 }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:release_year_not_integer/,
      modelSlugs: ["jbl-charge-5"],
    },
    {
      name: "releaseYear âm (-5 — H1)",
      content: JSON.stringify([{ brand: "JBL", name: "Charge 5", releaseYear: -5 }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:release_year_out_of_range/,
      modelSlugs: ["jbl-charge-5"],
    },
    {
      name: "releaseYear tràn int (1e12 — H1)",
      content: JSON.stringify([{ brand: "JBL", name: "Charge 5", releaseYear: 1e12 }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:release_year_out_of_range/,
      modelSlugs: ["jbl-charge-5"],
    },
    {
      name: "releaseYear ngoài khoảng tương lai gần (3000 — H1)",
      content: JSON.stringify([{ brand: "JBL", name: "Charge 5", releaseYear: 3000 }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:release_year_out_of_range/,
      modelSlugs: ["jbl-charge-5"],
    },
    {
      name: "brand ngoài 5 brand seed + không có trong DB",
      content: JSON.stringify([{ brand: "Kawasaki", name: "Thing" }]),
      expected: /SEED_MODEL_BRAND_MISSING:kawasaki/,
      modelSlugs: ["kawasaki-thing"],
    },
    {
      name: "duplicate slug trong file (M4 — nêu cả 2 index mục)",
      content: JSON.stringify([
        { brand: "JBL", name: "Charge 5" },
        { brand: "jbl", name: "charge 5" },
      ]),
      expected: /SEED_MODELS_FILE_INVALID:duplicate_slug:jbl-charge-5:items\[0,1\]/,
      modelSlugs: ["jbl-charge-5"],
    },
    {
      name: "khoá lạ (M5 — chỉ brand/name/releaseYear được phép)",
      content: JSON.stringify([{ brand: "JBL", name: "Charge 5", color: "red" }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:unknown_key:color/,
      modelSlugs: ["jbl-charge-5"],
    },
    {
      name: "file > 1MB (M5)",
      content: "x".repeat(1_000_001),
      expected: /SEED_MODELS_FILE_INVALID:file_too_large/,
      modelSlugs: [],
    },
    {
      name: "> 500 mục (M5)",
      content: JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ brand: "JBL", name: `M ${i}` }))),
      expected: /SEED_MODELS_FILE_INVALID:too_many_items/,
      modelSlugs: [],
    },
    {
      name: "brand > 100 ký tự (M5)",
      content: JSON.stringify([{ brand: "B".repeat(101), name: "X" }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:brand_too_long/,
      modelSlugs: [],
    },
    {
      name: "name > 100 ký tự (M5)",
      content: JSON.stringify([{ brand: "JBL", name: "N".repeat(101) }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:name_too_long/,
      modelSlugs: [],
    },
    {
      name: "brand+name cho slug rỗng",
      content: JSON.stringify([{ brand: "!!!", name: "???" }]),
      expected: /SEED_MODELS_FILE_INVALID:item\[0\]:slug_empty/,
      modelSlugs: [],
    },
  ];

  for (const c of INVALID_FOUNDER_CASES) {
    it(`input sai shape → typed error + 0 write (dry-run VÀ --apply): ${c.name}`, async () => {
      await expectInvalidFounderFile(c.content, c.expected, c.modelSlugs);
    });
  }

  // ─── 4. CLI: --models thiếu path → usage error (review fix M6) ────────────

  it("CLI --models thiếu đường dẫn (hoặc đứng trước cờ khác) → usage error (exit 1); --models <file> parse đúng", () => {
    // thiếu path hoàn toàn
    expect(parseSeedCliArgs(["tsx", "seed-beta-catalog.ts", "--models"]).usageError).toMatch(/--models/);
    // theo sau là cờ khác — KHÔNG âm thầm bỏ qua --models
    expect(parseSeedCliArgs(["tsx", "seed-beta-catalog.ts", "--models", "--apply"]).usageError).toMatch(/--models/);
    expect(parseSeedCliArgs(["tsx", "seed-beta-catalog.ts", "--models", "--allow-production"]).usageError).toMatch(
      /--models/,
    );
    // dạng --models=<path> cũng KHÔNG âm thầm bỏ qua
    expect(parseSeedCliArgs(["tsx", "seed-beta-catalog.ts", "--models=founder.json"]).usageError).toMatch(/--models/);
    // không có --models → không lỗi
    expect(parseSeedCliArgs(["tsx", "seed-beta-catalog.ts", "--apply"]).usageError).toBeUndefined();
    // đầy đủ → parse đúng
    const ok = parseSeedCliArgs([
      "tsx",
      "seed-beta-catalog.ts",
      "--apply",
      "--models",
      "founder.json",
      "--allow-production",
    ]);
    expect(ok.isApply).toBe(true);
    expect(ok.allowProduction).toBe(true);
    expect(ok.modelsFile).toBe("founder.json");
    expect(ok.usageError).toBeUndefined();
  });

  // ─── 5. --apply: category allowlist slug + 5 brand + model round-trip ────

  it("--apply tạo category slug allowlist (underscore NGUYÊN VĂN — KHÔNG slugify) + brand Soundcore; regime beta; model approved round-trip productModelId", async () => {
    const report = await seedBetaCatalog(true);
    expect(report.mode).toBe("apply");
    expect(report.category).toBe(1);
    expect(report.brands).toBe(5);
    expect(report.models).toBe(0);
    // L7 — rollback list: CHỈ những slug run này TẠO
    expect(report.created.categorySlug).toBe(BETA_SLUG);
    expect(report.created.brandSlugs).toEqual([...SEED_BRAND_SLUGS]);
    expect(report.created.modelSlugs).toEqual([]);

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

  // ─── 6. --models: upsert PENDING, KHÔNG reassign model cũ ────────────────

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
    expect(report.created.categorySlug).toBeNull(); // L7 — run này không tạo category
    expect(report.created.modelSlugs).toEqual(["jbl-charge-5", "soundcore-motion-300", "yamaha-stagepas-600i"]);

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

  // ─── 7. Audit trực tiếp qua db.orm + source-contract ──────────────────────

  it("AuditEvent ghi TRỰC TIẾP qua db.orm — actor null, action beta_catalog.seeded, detail = counts; script KHÔNG import helper audit server-only (source-contract); MỘT db.transaction bao creates + audit (M3)", async () => {
    const events = await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).all();
    expect(events.length).toBeGreaterThanOrEqual(2); // 2 lần apply ở case 5 + 6
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
    // source-contract M3: MỘT db.transaction bao toàn bộ creates + audit;
    // audit ghi QUA tx.orm (cùng tx — sống chết với creates), KHÔNG bao giờ
    // db.orm trong callback.
    expect(src).toMatch(/db\.transaction\(async \(tx\) =>/);
    expect(src).toContain("tx.orm.public.AuditEvent.create");
  });

  // ─── 8. Idempotent ────────────────────────────────────────────────────────

  it("idempotent: --apply lần HAI (cùng founder file) no-op — 0 row mới, không nhân bản", async () => {
    const report = await seedBetaCatalog(true, founder!.file);
    expect(report.mode).toBe("apply");
    expect(report.category).toBe(0);
    expect(report.brands).toBe(0);
    expect(report.models).toBe(0); // cả 4 model founder đều đã có (SRS-XP500 skip từ case 6)
    // L7 — run này không tạo gì → rollback list rỗng
    expect(report.created.categorySlug).toBeNull();
    expect(report.created.brandSlugs).toEqual([]);
    expect(report.created.modelSlugs).toEqual([]);

    // KHÔNG nhân bản: đúng 1 category beta, đúng 5 brand, đúng 1 model/slug
    expect(await db.orm.public.Category.where({ slug: BETA_SLUG }).all()).toHaveLength(1);
    expect(
      await db.orm.public.Brand.where((b) => b.slug.in([...SEED_BRAND_SLUGS])).all(),
    ).toHaveLength(5);
    for (const slug of ["jbl-charge-5", "soundcore-motion-300", "yamaha-stagepas-600i", "sony-srs-xp500"]) {
      expect(await db.orm.public.ProductModel.where({ slug }).all()).toHaveLength(1);
    }
  });

  // ─── 9. Rollback (procedure chứng minh trên scratch DB) ──────────────────

  it("rollback: xoá ProductModel theo slug list + brand + category — khôi phục trạng thái trước (category biến mất)", async () => {
    // 0. fixture phụ thuộc FK trước (listing Restrict sang category/brand/model)
    for (const id of created.listings) {
      await db.orm.public.Listing.where({ id }).deleteAll();
    }
    // 1. ProductModel: fixture theo id + seed theo slug list (3 model seed tạo ở case 6/8)
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
    // 3. brand theo slug list (đủ 5 slug seed — model đã xoá ở bước 1)
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

  // ─── 10. Dry-run + category đang có INACTIVE (review fix L8) ─────────────

  it("dry-run (L8): category đang có INACTIVE → report in rõ isActive=false + cảnh báo; seed KHÔNG tự kích hoạt lại", async () => {
    const cat = await db.orm.public.Category.create({
      name: "Loa Bluetooth di động",
      slug: BETA_SLUG,
      isActive: false,
    });
    created.categories.push(cat.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const report = await seedBetaCatalog(false);
      expect(report.mode).toBe("dry-run");
      expect(report.detail.categoryExists).toBe(true);
      expect(report.detail.categoryIsActive).toBe(false); // L8 — in rõ isActive
      expect(report.category).toBe(0); // đã có — KHÔNG tạo
      // cảnh báo khi inactive (founder quyết — seed KHÔNG tự kích hoạt)
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("isActive=false");
    } finally {
      warnSpy.mockRestore();
    }
    // KHÔNG mutate: vẫn inactive — create-if-absent KHÔNG bao giờ update row cũ
    const after = await db.orm.public.Category.first({ slug: BETA_SLUG });
    expect(after!.isActive).toBe(false);
    await db.orm.public.Category.where({ id: cat.id }).deleteAll();
  });

  // ─── 11. Atomic (review fix M3): lỗi giữa apply → rollback toàn bộ ────────

  it("atomic (M3): lỗi GIỮA apply (brand bị tx khác xoá → FK 23503) → TOÀN BỘ seed rollback — 0 row, không audit (KHÔNG partial write)", async () => {
    // fixture: brand Yamaha (ngoài 5 brand seed — brand CÓ TRƯỚC seed, case
    // rollback giữ lại) + founder file model Yamaha — pre-flight thấy brand
    // (MVCC), INSERT model mới đụng FK brandId.
    let yamaha = await db.orm.public.Brand.first({ slug: "yamaha" });
    if (!yamaha) {
      yamaha = await db.orm.public.Brand.create({ name: "Yamaha", slug: "yamaha" });
      created.brands.push(yamaha.id);
    }
    const { dir, file } = writeTempFounderFile(JSON.stringify([{ brand: "Yamaha", name: "Stagepas 600I" }]));
    const auditBefore = (await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).all()).length;

    // T2: xoá brand Yamaha — GIỮ row lock, CHƯA commit → INSERT model của seed
    // (FK brandId → RI trigger SELECT FOR KEY SHARE) block trên lock
    // (pattern multi-row-writes.test.ts / listing-delete-race.test.ts).
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    const t2 = db.transaction(async (tx) => {
      await tx.orm.public.Brand.where({ id: yamaha.id }).deleteAll();
      signalLockTaken(); // lock đang giữ, tx vẫn mở
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    // Flow: seed --apply --models — tx của seed: đọc (MVCC thấy Yamaha) →
    // tạo category → tạo 5 brand → INSERT model Yamaha → BLOCK trên lock T2.
    const flow = seedBetaCatalog(true, file);
    // cho flow kịp chạm INSERT — nó KHÔNG THỂ qua lock của T2, sau sleep chắc
    // chắn đang block (category + 5 brand ĐÃ tạo trong tx CHƯA commit).
    await sleep(500);
    commitT2(); // Yamaha biến mất → FK violation 23503 (KHÔNG phải 23505) → propagate
    let flowError: unknown;
    try {
      await flow;
    } catch (e) {
      flowError = e;
    }
    await t2;
    // lỗi propagate NGUYÊN VẸN (KHÔNG nuốt, KHÔNG classify thành success)
    expect(SqlQueryError.is(flowError)).toBe(true);
    expect((flowError as SqlQueryError).sqlState).toBe("23503");

    // TOÀN BỘ rollback: category + 5 brand + model — 0 row, KHÔNG audit
    expect(await db.orm.public.Category.first({ slug: BETA_SLUG })).toBeNull();
    for (const slug of SEED_BRAND_SLUGS) {
      expect(await db.orm.public.Brand.first({ slug })).toBeNull();
    }
    expect(await db.orm.public.ProductModel.first({ slug: "yamaha-stagepas-600i" })).toBeNull();
    const auditAfter = (await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).all()).length;
    expect(auditAfter).toBe(auditBefore); // KHÔNG audit mới — attempt rollback sạch
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── 12. Race 23505 → chạy lại toàn bộ 1 lần (M3) + cảnh báo (L9) ─────────

  it("race 23505 (M3/L9): tx khác commit category giữa read và create → seed rollback + CHẠY LẠI toàn bộ đúng 1 lần (idempotent); model raced khác category → cảnh báo counts/slugs", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // T2: tạo category beta slug (tên KHÁC — seed KHÔNG đụng row cũ) + brand
    // jbl + model "jbl-charge-5" trong category KHÁC (race-cat) — CHƯA commit
    // → INSERT category của seed block trên unique index entry của T2.
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    const t2 = db.transaction(async (tx) => {
      await tx.orm.public.Category.create({ name: "Race Category", slug: BETA_SLUG, isActive: true });
      const raceCat = await tx.orm.public.Category.create({ name: "Race Cat B", slug: "race-cat-bcs" });
      const jbl = await tx.orm.public.Brand.create({ name: "JBL", slug: "jbl" });
      await tx.orm.public.ProductModel.create({
        brandId: jbl.id,
        categoryId: raceCat.id,
        name: "Charge 5",
        slug: "jbl-charge-5",
        status: "pending",
      });
      signalLockTaken(); // unique index entry đang giữ, tx vẫn mở
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    const { dir, file } = writeTempFounderFile(JSON.stringify([{ brand: "JBL", name: "Charge 5" }]));
    const auditBefore = (await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).all()).length;

    // Flow: seed --apply --models — attempt 1: đọc (MVCC chưa thấy T2) →
    // INSERT category → BLOCK trên unique entry của T2 → T2 commit → 23505
    // → rollback toàn bộ → classify NGOÀI tx → CHẠY LẠI toàn bộ đúng 1 lần.
    const flow = seedBetaCatalog(true, file);
    await sleep(500);
    commitT2();
    const report = await flow;
    await t2;

    expect(report.mode).toBe("apply");
    expect(report.category).toBe(0); // category T2 thắng — create-if-absent
    expect(report.brands).toBe(4); // marshall, sony, bose, soundcore (jbl của T2)
    expect(report.models).toBe(0); // jbl-charge-5 đã có → skip (KHÔNG reassign)
    expect(report.created.categorySlug).toBeNull();
    expect(report.created.brandSlugs).toEqual(["marshall", "sony", "bose", "soundcore"]);
    expect(report.created.modelSlugs).toEqual([]);

    // category của T2 NGUYÊN VẸN — seed KHÔNG update name/isActive row cũ
    const cat = (await db.orm.public.Category.first({ slug: BETA_SLUG }))!;
    expect(cat.name).toBe("Race Category");
    // model raced vẫn ở category cũ của nó — KHÔNG reassign
    const raced = (await db.orm.public.ProductModel.first({ slug: "jbl-charge-5" }))!;
    const raceCat = (await db.orm.public.Category.first({ slug: "race-cat-bcs" }))!;
    expect(raced.categoryId).toBe(raceCat.id);
    created.categories.push(raceCat.id);

    // L9: sau re-run 23505, model đang có khác category kỳ vọng → CẢNH BÁO
    // (chỉ slug + count — KHÔNG giá trị thô)
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("SEED_RACE_MISMATCH");
    expect(warned).toContain("jbl-charge-5");
    warnSpy.mockRestore();

    // đúng 1 audit row cho lần apply này (attempt 1 rollback — không audit)
    const auditAfter = (await db.orm.public.AuditEvent.where({ action: "beta_catalog.seeded" }).all()).length;
    expect(auditAfter).toBe(auditBefore + 1);
    rmSync(dir, { recursive: true, force: true });
  });
});
