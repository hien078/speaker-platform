/**
 * Seed beta catalog (Batch 4 Task 7 — spec §5.6.1 category gate, §1 focus
 * brands, §12.1 core model coverage; A3/A11) — offline maintenance command,
 * Batch 2 backfill-script posture: dry-run mặc định, --apply để mutate,
 * idempotent (create-if-absent theo slug), KHÔNG expose HTTP/admin UI.
 *
 * 1. Category "Loa Bluetooth di động" slug "portable_bluetooth_speaker" —
 *    NGUYÊN VĂN slug trong BETA_PUBLICATION_CATEGORIES (spec §5.6.1) —
 *    create-if-absent theo slug, KHÔNG đụng category khác (A11: seed
 *    "loa-bluetooth" hiện có vẫn active — founder quyết). KHÔNG slugify()
 *    slug này: slugify() strip "_" (snake_case → kebab) và làm hỏng khóa
 *    allowlist (tests/unit/beta-categories.test.ts pin).
 * 2. Brands: đảm bảo JBL, Marshall, Sony, Bose, Soundcore (spec §1 focus
 *    brands) tồn tại — create-if-absent theo slug (Soundcore MỚI — seed
 *    hiện chưa có).
 * 3. --models <founder.json>: danh sách model FOUNDER CUNG CẤP
 *    (brand, name, releaseYear?) — upsert create-if-absent theo slug
 *    (slug = slugify("<brand> <name>") — convention src/prisma/seed-models.ts)
 *    với status "pending" — founder duyệt qua /admin/catalog (A3:
 *    IMPLEMENTER KHÔNG TỰ VIẾT danh sách model từ training data).
 *    KHÔNG BAO GIỜ reassign category/brand/status của model đã tồn tại
 *    (seed-models.ts có sony-srs-xp500/bose-s1-pro approved trong
 *    loa-bluetooth — không đụng).
 * 4. --apply: AuditEvent ghi TRỰC TIẾP qua db.orm.public.AuditEvent.create
 *    với cùng shape helper audit của app dùng (actorId null — system/offline;
 *    detail = counts — KHÔNG PII, spec §4.8). Helper đó là module server-only
 *    (throw dưới tsx) nên script KHÔNG import nó — backfill-seller-
 *    verification.ts precedent.
 *
 * Script import CHỈ plain module (beta-categories.ts, utils.ts —
 * db.client.ts qua DYNAMIC import SAU khi DATABASE_URL được xác nhận trong
 * env THẬT: dotenv chỉ được phép BỔ SUNG config, không phải nguồn đích ngầm
 * định — backfill precedent L3).
 *
 * NODE_ENV=production: từ chối trừ khi --allow-production tường minh (seed
 * catalog vào DB thật phải là hành động có chủ đích — fail closed).
 *
 * Usage:
 *   DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts                              # dry-run (mặc định)
 *   DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts --apply                     # chạy thật
 *   DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts --apply --models founder.json
 *   (từ chối chạy khi process.env thiếu DATABASE_URL — kể cả khi .env có)
 *
 * Rollback (chứng minh qua tests/integration/beta-catalog-seed.test.ts):
 *   xoá ProductModel theo slug list → brand chưa dùng (Soundcore…) →
 *   category "portable_bluetooth_speaker".
 */
import { readFileSync } from "node:fs";

import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";

import { BETA_PUBLICATION_CATEGORIES } from "../src/lib/beta-categories";
import { slugify } from "../src/lib/utils";

/** Tên hiển thị của category beta (plan Task 7 — spec §5.6.1). */
const CATEGORY_NAME = "Loa Bluetooth di động";

/** 5 brand focus spec §1 (plan Task 7) — đảm bảo tồn tại, create-if-absent theo slug. */
const SEED_BRANDS = ["JBL", "Marshall", "Sony", "Bose", "Soundcore"] as const;

export type FounderModelInput = {
  brand: string;
  name: string;
  releaseYear?: number;
};

export type SeedBetaCatalogOptions = {
  /** Cho chạy thật khi NODE_ENV=production (CLI: --allow-production). */
  allowProduction?: boolean;
};

export type SeedBetaCatalogReport = {
  mode: "dry-run" | "apply";
  /** Số Category đã tạo (apply) / sẽ tạo (dry-run) — create-if-absent theo slug. */
  category: number;
  /** Số Brand đã tạo / sẽ tạo (5 brand focus spec §1). */
  brands: number;
  /** Số ProductModel đã tạo / sẽ tạo (--models founder — status "pending"). */
  models: number;
  /** Chi tiết plan — dry-run in ra để review (A3: danh sách model founder hiển thị, KHÔNG tự chế). */
  detail: {
    categorySlug: string;
    categoryExists: boolean;
    brandsToCreate: string[];
    brandsExisting: string[];
    modelsToCreate: string[];
    modelsExisting: string[];
  };
};

/**
 * Đọc + validate file founder models (A3 — danh sách DO FOUNDER cung cấp,
 * KHÔNG phải nội dung do implementer chế). Fail closed với typed
 * SEED_MODELS_FILE_INVALID — KHÔNG mutate gì khi file sai shape.
 */
function parseFounderModelsFile(path: string): FounderModelInput[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`SEED_MODELS_FILE_INVALID: không đọc được file --models (${path})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEED_MODELS_FILE_INVALID: JSON không hợp lệ");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_MODELS_FILE_INVALID: gốc phải là MẢNG [{ brand, name, releaseYear? }]");
  }
  const out: FounderModelInput[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("SEED_MODELS_FILE_INVALID: mỗi mục phải là object { brand, name, releaseYear? }");
    }
    const { brand, name, releaseYear } = item as Record<string, unknown>;
    if (typeof brand !== "string" || brand.trim() === "") {
      throw new Error("SEED_MODELS_FILE_INVALID: brand phải là chuỗi không rỗng");
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("SEED_MODELS_FILE_INVALID: name phải là chuỗi không rỗng");
    }
    if (releaseYear !== undefined && releaseYear !== null && typeof releaseYear !== "number") {
      throw new Error("SEED_MODELS_FILE_INVALID: releaseYear phải là số (hoặc bỏ trống)");
    }
    if (slugify(`${brand.trim()} ${name.trim()}`) === "") {
      throw new Error("SEED_MODELS_FILE_INVALID: brand + name phải cho slug không rỗng");
    }
    out.push({
      brand: brand.trim(),
      name: name.trim(),
      ...(releaseYear !== undefined && releaseYear !== null ? { releaseYear } : {}),
    });
  }
  return out;
}

/**
 * Seed beta catalog. `isApply=false` → dry-run (chỉ đọc + báo cáo plan);
 * `isApply=true` → create-if-absent + audit. Idempotent: mọi entity tra theo
 * slug TRƯỚC khi create; race create đồng thời → unique violation 23505
 * phân loại NGOÀI create qua isUniqueConstraintViolation (KHÔNG message
 * matching) → dùng row bên thắng (create này KHÔNG nằm trong tx callback nào
 * — không có catch-and-continue trong transaction); lỗi khác → ném (fail
 * closed, KHÔNG im lặng mất row).
 */
export async function seedBetaCatalog(
  isApply: boolean,
  modelsFile?: string,
  options?: SeedBetaCatalogOptions,
): Promise<SeedBetaCatalogReport> {
  // Fail closed: seed catalog vào DB production phải là hành động có chủ đích.
  if (process.env.NODE_ENV === "production" && !options?.allowProduction) {
    throw new Error(
      "SEED_REFUSED_PRODUCTION: từ chối seed khi NODE_ENV=production — truyền --allow-production để chạy thật.",
    );
  }
  // L3 (backfill precedent): DATABASE_URL phải có trong MÔI TRƯỜNG THẬT
  // (process.env) TRƯỚC khi db.client/dotenv được nạp — dynamic import,
  // KHÔNG top-level import (từ chối chạy mù vào đích ngầm định từ .env).
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng.");
  }

  // Parse + validate file founder TRƯỚC khi chạm DB (fail sớm, KHÔNG mutate).
  const founderModels = modelsFile ? parseFounderModelsFile(modelsFile) : [];

  // Dynamic import: db.client (kèm dotenv) chỉ nạp SAU khi đích đã được xác nhận.
  const { db } = await import("../src/prisma/db.client");

  // ── Reads — plan create-if-absent (dry-run báo cáo, apply thực hiện) ──

  // Slug category NGUYÊN VĂN từ allowlist (spec §5.6.1) — KHÔNG slugify (A11).
  // Danh sách đang có đúng 1 mục (tests/unit/beta-categories.test.ts pin);
  // thêm category beta công khai khác = explicit product decision (spec §5.6.1).
  const categorySlug: string = BETA_PUBLICATION_CATEGORIES[0];
  const existingCategory = await db.orm.public.Category.where({ slug: categorySlug }).first();

  const brandPlan = SEED_BRANDS.map((name) => ({ name, slug: slugify(name) }));
  const brandSlugs = brandPlan.map((b) => b.slug);
  const existingBrands = await db.orm.public.Brand.where((b) => b.slug.in(brandSlugs)).all();
  const existingBrandSlugs = new Set(existingBrands.map((b) => b.slug));
  // Brand slug → row cho model create: 5 brand seed + brand ngoài 5 đã có trong DB.
  const brandRows = new Map(existingBrands.map((b) => [b.slug, b]));

  // Founder models → slug plan (dedupe theo slug — entry đầu thắng; KHÔNG
  // reassign model đã tồn tại: skip hoàn toàn, kể cả khác category/brand).
  const modelPlan: Array<FounderModelInput & { slug: string; brandSlug: string }> = [];
  const seenModelSlugs = new Set<string>();
  for (const m of founderModels) {
    const brandSlug = slugify(m.brand);
    const slug = slugify(`${m.brand} ${m.name}`);
    if (seenModelSlugs.has(slug)) continue;
    seenModelSlugs.add(slug);
    modelPlan.push({ ...m, slug, brandSlug });
  }

  // Brand của founder model phải nằm trong 5 brand seed HOẶC đã có trong DB —
  // fail closed TRƯỚC khi mutate (KHÔNG tự chế brand ngoài danh sách); brand
  // ngoài 5 nhưng đã có → dùng row đó (KHÔNG tạo brand mới ngoài danh sách).
  const extraBrandSlugs = [...new Set(modelPlan.map((m) => m.brandSlug))].filter(
    (s) => !brandSlugs.includes(s) && !existingBrandSlugs.has(s),
  );
  if (extraBrandSlugs.length > 0) {
    const inDb = await db.orm.public.Brand.where((b) => b.slug.in(extraBrandSlugs)).all();
    const missing = extraBrandSlugs.filter((s) => !inDb.some((b) => b.slug === s));
    if (missing.length > 0) {
      throw new Error(`SEED_MODEL_BRAND_MISSING:${missing.join(",")}`);
    }
    for (const row of inDb) brandRows.set(row.slug, row);
  }

  const existingModels = modelPlan.length
    ? await db.orm.public.ProductModel
        .where((m) => m.slug.in(modelPlan.map((x) => x.slug)))
        .all()
    : [];
  const existingModelSlugs = new Set(existingModels.map((m) => m.slug));

  const plan = {
    categorySlug,
    categoryExists: Boolean(existingCategory),
    brandsToCreate: brandPlan.filter((b) => !existingBrandSlugs.has(b.slug)).map((b) => b.slug),
    brandsExisting: brandSlugs.filter((s) => existingBrandSlugs.has(s)),
    modelsToCreate: modelPlan.filter((m) => !existingModelSlugs.has(m.slug)).map((m) => m.slug),
    modelsExisting: modelPlan.filter((m) => existingModelSlugs.has(m.slug)).map((m) => m.slug),
  };

  if (!isApply) {
    return {
      mode: "dry-run",
      category: plan.categoryExists ? 0 : 1,
      brands: plan.brandsToCreate.length,
      models: plan.modelsToCreate.length,
      detail: plan,
    };
  }

  // ── Apply — create-if-absent từng row (KHÔNG tx bao ngoài: mỗi create là
  //    một implicit tx riêng; unique violation 23505 = race bên kia thắng →
  //    dùng row đó, KHÔNG phải catch-and-continue trong tx callback) ──

  let category = existingCategory;
  let categoryCreated = 0;
  if (!category) {
    try {
      category = await db.orm.public.Category.create({
        name: CATEGORY_NAME,
        slug: categorySlug, // NGUYÊN VĂN — KHÔNG slugify() (A11)
        isActive: true,
      });
      categoryCreated = 1;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      category = await db.orm.public.Category.where({ slug: categorySlug }).first();
    }
    if (!category) throw new Error(`SEED_CATEGORY_MISSING:${categorySlug}`);
  }

  let brandsCreated = 0;
  for (const b of brandPlan) {
    if (brandRows.has(b.slug)) continue;
    try {
      brandRows.set(b.slug, await db.orm.public.Brand.create({ name: b.name, slug: b.slug }));
      brandsCreated += 1;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      const winner = await db.orm.public.Brand.where({ slug: b.slug }).first();
      if (!winner) throw e;
      brandRows.set(b.slug, winner);
    }
  }

  let modelsCreated = 0;
  for (const m of modelPlan) {
    if (existingModelSlugs.has(m.slug)) continue; // đã có — KHÔNG đụng (A3/A11)
    const brand = brandRows.get(m.brandSlug);
    if (!brand) throw new Error(`SEED_MODEL_BRAND_MISSING:${m.brandSlug}`); // pre-flight đã chặn — belt-and-braces
    try {
      await db.orm.public.ProductModel.create({
        brandId: brand.id,
        categoryId: category.id,
        name: m.name,
        slug: m.slug,
        releaseYear: m.releaseYear ?? null,
        status: "pending", // founder duyệt qua /admin/catalog (A3)
      });
      modelsCreated += 1;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      // Race: model slug được tạo đồng thời → skip (idempotent).
    }
  }

  // AuditEvent — CÙNG shape helper audit của app ghi (actorId null =
  // system/offline script; detail chỉ counts — KHÔNG PII, spec §4.8;
  // ipHash/sessionId null: offline). Ghi TRỰC TIẾP qua db.orm vì helper audit
  // là module server-only (throw dưới tsx) — backfill precedent.
  await db.orm.public.AuditEvent.create({
    actorId: null,
    subjectId: null,
    action: "beta_catalog.seeded",
    resourceType: "Category",
    resourceId: category.id,
    reason: null,
    policyVersion: null,
    sessionId: null,
    detail: `category=${categoryCreated} brands=${brandsCreated} models=${modelsCreated}`,
    ipHash: null,
  });

  return {
    mode: "apply",
    category: categoryCreated,
    brands: brandsCreated,
    models: modelsCreated,
    detail: plan,
  };
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — integration test import seedBetaCatalog) ──

/** Đích hiển thị an toàn: host[:port]/db — KHÔNG bao giờ in password. */
function describeTarget(dbUrl: string): string {
  try {
    const url = new URL(dbUrl);
    const port = url.port ? `:${url.port}` : "";
    const dbName = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.hostname}${port}/${dbName}`;
  } catch {
    return "(DATABASE_URL không phân tích được — KHÔNG in nguyên giá trị)";
  }
}

/** Giá trị sau cờ CLI (--models <path>) — undefined khi không có / cờ cuối dòng. */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  // L3 — kiểm tra process.env TRƯỚC khi db.client/dotenv được nạp: script phải
  // được TRỎ ĐÍCH TƯỜNG MINH, không âm thầm lấy .env của repo làm đích.
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng (từ chối chạy mù; .env không được tự động dùng làm đích).",
    );
    process.exit(1);
  }
  const isApply = process.argv.includes("--apply");
  const allowProduction = process.argv.includes("--allow-production");
  const modelsFile = argValue("--models");
  if (process.env.NODE_ENV === "production" && !allowProduction) {
    console.error("✗ SEED_REFUSED_PRODUCTION: NODE_ENV=production — truyền --allow-production để seed thật.");
    process.exit(1);
  }
  if (!isApply) {
    console.log("── dry-run (mặc định) — truyền --apply để chạy thật");
  } else {
    // In đích TRƯỚC khi --apply chạm dữ liệu — không password.
    console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL)} (không in password)`);
  }
  if (modelsFile) console.log(`── models founder (A3 — founder cung cấp): ${modelsFile}`);

  const report = await seedBetaCatalog(isApply, modelsFile, { allowProduction });
  const verb = (n: number) => (report.mode === "apply" ? (n > 0 ? "đã tạo" : "đã có (create-if-absent)") : n > 0 ? "SẼ TẠO" : "đã có");
  console.log(`── chế độ: ${report.mode}`);
  console.log(`── category "${report.detail.categorySlug}": ${verb(report.category)}`);
  if (report.detail.brandsToCreate.length > 0) {
    console.log(`── brand ${verb(report.brands)}: ${report.detail.brandsToCreate.join(", ")}`);
  }
  if (report.detail.brandsExisting.length > 0) {
    console.log(`── brand đã có (không đụng): ${report.detail.brandsExisting.join(", ")}`);
  }
  if (report.detail.modelsToCreate.length > 0) {
    console.log(`── model founder ${verb(report.models)} (status pending — founder duyệt qua /admin/catalog):`);
    for (const slug of report.detail.modelsToCreate) console.log(`   · ${slug}`);
  }
  if (report.detail.modelsExisting.length > 0) {
    console.log(`── model founder đã có (KHÔNG reassign category/brand): ${report.detail.modelsExisting.join(", ")}`);
  }
  console.log(`── kết quả: category=${report.category} brands=${report.brands} models=${report.models}`);
  if (isApply) {
    console.log(
      "── rollback nếu cần: xoá ProductModel theo slug list → brand chưa dùng → category \"portable_bluetooth_speaker\" (chứng minh qua tests/integration/beta-catalog-seed.test.ts).",
    );
  }
  const { db } = await import("../src/prisma/db.client");
  await db.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("seed-beta-catalog.ts");
if (invokedDirectly) {
  await main();
}
