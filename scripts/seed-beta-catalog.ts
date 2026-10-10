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
 *    (brand, name, releaseYear?) — validate FAIL CLOSED trước khi chạm DB
 *    (review fix H1/H2/M4/M5): releaseYear phải là Int trong
 *    1990..(năm hiện tại + 1) (H1 — cột Int, KHÔNG để 2024.5/1e12/-5 chết
 *    giữa chừng apply), chỉ khoá brand/name/releaseYear được phép (khoá lạ
 *    → typed error nêu tên khoá), caps file ≤ 1MB / ≤ 500 mục /
 *    brand,name ≤ 100 ký tự sau trim (M5), duplicate slug TRONG file →
 *    typed error nêu slug + CẢ HAI index mục (M4 — trước đây mục đầu thắng
 *    im lặng). Mọi message lỗi chỉ mang index mục + tên khoá/slug —
 *    KHÔNG echo giá trị thô. Upsert create-if-absent theo slug
 *    (slug = slugify("<brand> <name>") — convention src/prisma/seed-models.ts)
 *    với status "pending" — founder duyệt qua /admin/catalog (A3:
 *    IMPLEMENTER KHÔNG TỰ VIẾT danh sách model từ training data).
 *    KHÔNG BAO GIỜ reassign category/brand/status của model đã tồn tại
 *    (seed-models.ts có sony-srs-xp500/bose-s1-pro approved trong
 *    loa-bluetooth — không đụng).
 * 4. --apply (review fix M3): TOÀN BỘ creates + AuditEvent "beta_catalog.seeded"
 *    nằm trong MỘT db.transaction — tx.orm ONLY (KHÔNG BAO GIỜ db.orm trong
 *    callback), KHÔNG catch trong callback: lỗi giữa chừng → rollback toàn bộ
 *    (0 row, không audit — KHÔNG BAO GIỜ partial write). 23505 (race với lần
 *    chạy khác) propagate ra khỏi tx, classify NGOÀI qua
 *    isUniqueConstraintViolation (KHÔNG message matching) → chạy lại TOÀN
 *    BỘ seed đúng MỘT lần (idempotent); model đang có khác brand/category
 *    kỳ vọng sau re-run → cảnh báo counts/slugs (review fix L9). AuditEvent
 *    ghi TRỰC TIẾP qua tx.orm với cùng shape helper audit của app dùng
 *    (actorId null — system/offline; detail = counts — KHÔNG PII, spec
 *    §4.8). Helper đó là module server-only (throw dưới tsx) nên script
 *    KHÔNG import nó — backfill-seller-verification.ts precedent.
 *
 * Script import CHỈ plain module (beta-categories.ts, utils.ts —
 * db.client.ts qua DYNAMIC import SAU khi DATABASE_URL được xác nhận trong
 * env THẬT: dotenv chỉ được phép BỔ SUNG config, không phải nguồn đích ngầm
 * định — backfill precedent L3).
 *
 * NODE_ENV=production: từ chối --apply trừ khi --allow-production tường minh
 * (seed catalog vào DB thật phải là hành động có chủ đích — fail closed);
 * DRY-RUN được phép (chỉ đọc + in plan — b4-holistic round-4: compose service
 * migrate set NODE_ENV=production nên guard cũ chặn cả dry-run, bước bắt buộc
 * trong docs/deployment.md §2 không chạy được như doc ghi).
 * b4-holistic round-3: --apply vào DB NON-LOCAL (host ≠ localhost/127.0.0.1/
 * ::1 — vd compose migrate → db:5432) cũng từ chối trừ khi --allow-production
 * — guard quyết từ ĐÍCH, không chỉ từ NODE_ENV (stage migrate không set
 * NODE_ENV nên guard cũ không bao giờ cháy trên VPS).
 *
 * Usage (trên VPS chạy qua image migrate — xem docs/deployment.md §2):
 *   docker compose -f docker-compose.prod.yml run --rm \
 *     -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
 *     migrate npx tsx scripts/seed-beta-catalog.ts                       # dry-run
 *   … scripts/seed-beta-catalog.ts --apply --allow-production            # chạy thật
 * Local dev/test (DATABASE_URL 127.0.0.1):
 *   DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts                              # dry-run (mặc định)
 *   DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts --apply                     # chạy thật
 *   DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts --apply --models founder.json
 *   (--models thiếu path / đứng trước cờ khác → exit 1 + usage — review fix M6;
 *    từ chối chạy khi process.env thiếu DATABASE_URL — kể cả khi .env có)
 *
 * Rollback (review fix L7 — CHỈ xoá những slug run này TẠO, script in ra
 * thành list ở cuối mỗi lần --apply; KHÔNG BAO GIỜ theo heuristic
 * "brand chưa dùng" — brand có thể đã bị listing khác dùng):
 *   ProductModel theo slug list → Brand theo slug list → Category theo slug.
 */
import { readFileSync, statSync } from "node:fs";

import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";

import { BETA_PUBLICATION_CATEGORIES } from "../src/lib/beta-categories";
import { slugify } from "../src/lib/utils";

/** Tên hiển thị của category beta (plan Task 7 — spec §5.6.1). */
const CATEGORY_NAME = "Loa Bluetooth di động";

/** 5 brand focus spec §1 (plan Task 7) — đảm bảo tồn tại, create-if-absent theo slug. */
const SEED_BRANDS = ["JBL", "Marshall", "Sony", "Bose", "Soundcore"] as const;

// ── Review fix M5 — caps của file founder (fail closed trước khi chạm DB) ──
/** File founder ≤ 1MB — KHÔNG nạp file khổng lồ vào bộ nhớ. */
const MODELS_FILE_MAX_BYTES = 1_000_000;
/** ≤ 500 mục — danh sách founder hợp lý, chặn file spam. */
const MODELS_FILE_MAX_ITEMS = 500;
/** brand/name ≤ 100 ký tự (sau trim) — cap trường text tự do. */
const MODEL_FIELD_MAX_CHARS = 100;

// ── Review fix H1 — releaseYear hợp lệ: Int, 1990..(năm hiện tại + 1) ──
const RELEASE_YEAR_MIN = 1990;
const RELEASE_YEAR_MAX = new Date().getFullYear() + 1;

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
    /** L8 — isActive của category ĐANG CÓ (null khi chưa có). Seed KHÔNG bao giờ đổi nó. */
    categoryIsActive: boolean | null;
    brandsToCreate: string[];
    brandsExisting: string[];
    modelsToCreate: string[];
    modelsExisting: string[];
  };
  /**
   * L7 — slug MỌI row run này TẠO (chỉ apply; dry-run = rỗng). Rollback list:
   * xoá CHỈ những slug này (theo thứ tự ngược) — KHÔNG bao giờ heuristic
   * "brand chưa dùng".
   */
  created: {
    categorySlug: string | null;
    brandSlugs: string[];
    modelSlugs: string[];
  };
};

/** CLI args đã parse (M6) — main() in usage + exit 1 khi usageError có mặt. */
export type SeedCliArgs = {
  isApply: boolean;
  allowProduction: boolean;
  modelsFile?: string;
  usageError?: string;
};

/**
 * Đọc + validate file founder models (A3 — danh sách DO FOUNDER cung cấp,
 * KHÔNG phải nội dung do implementer chế). Fail closed với typed
 * SEED_MODELS_FILE_INVALID — KHÔNG mutate gì khi file sai shape. Mọi lỗi ở
 * mức mục đều mang index mục (M5); KHÔNG echo giá trị thô — chỉ index/tên
 * khoá/slug/độ dài.
 */
function parseFounderModelsFile(path: string): FounderModelInput[] {
  // M5 — cap kích thước TRƯỚC khi đọc (fail nhanh, KHÔNG nạp file khổng lồ)
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`SEED_MODELS_FILE_INVALID:unreadable:${path}`);
  }
  if (size > MODELS_FILE_MAX_BYTES) {
    throw new Error(`SEED_MODELS_FILE_INVALID:file_too_large:${size}>${MODELS_FILE_MAX_BYTES}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`SEED_MODELS_FILE_INVALID:unreadable:${path}`);
  }
  // belt-and-braces: file đổi kích thước giữa stat và read (TOCTOU)
  if (Buffer.byteLength(raw, "utf8") > MODELS_FILE_MAX_BYTES) {
    throw new Error(
      `SEED_MODELS_FILE_INVALID:file_too_large:${Buffer.byteLength(raw, "utf8")}>${MODELS_FILE_MAX_BYTES}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEED_MODELS_FILE_INVALID:json_invalid");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_MODELS_FILE_INVALID:root_not_array");
  }
  if (parsed.length > MODELS_FILE_MAX_ITEMS) {
    throw new Error(`SEED_MODELS_FILE_INVALID:too_many_items:${parsed.length}>${MODELS_FILE_MAX_ITEMS}`);
  }
  const out: FounderModelInput[] = [];
  const seenSlugs = new Map<string, number>(); // slug → index mục đầu tiên (M4)
  for (let i = 0; i < parsed.length; i++) {
    const item: unknown = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:not_object`);
    }
    // M5 — chỉ brand/name/releaseYear được phép; khoá lạ → typed error nêu TÊN KHOÁ
    const unknownKey = Object.keys(item).find((k) => k !== "brand" && k !== "name" && k !== "releaseYear");
    if (unknownKey !== undefined) {
      throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:unknown_key:${unknownKey}`);
    }
    const { brand, name, releaseYear } = item as Record<string, unknown>;
    if (typeof brand !== "string" || brand.trim() === "") {
      throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:brand_empty_or_not_string`);
    }
    if (brand.trim().length > MODEL_FIELD_MAX_CHARS) {
      throw new Error(
        `SEED_MODELS_FILE_INVALID:item[${i}]:brand_too_long:${brand.trim().length}>${MODEL_FIELD_MAX_CHARS}`,
      );
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:name_empty_or_not_string`);
    }
    if (name.trim().length > MODEL_FIELD_MAX_CHARS) {
      throw new Error(
        `SEED_MODELS_FILE_INVALID:item[${i}]:name_too_long:${name.trim().length}>${MODEL_FIELD_MAX_CHARS}`,
      );
    }
    if (releaseYear !== undefined && releaseYear !== null) {
      // H1 — releaseYear là cột Int: 2024.5 / 1e12 / -5 phải hỏng Ở PARSE
      // (fail closed TRƯỚC khi chạm DB), KHÔNG chết giữa chừng apply.
      if (typeof releaseYear !== "number" || !Number.isFinite(releaseYear)) {
        throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:release_year_not_number`);
      }
      if (!Number.isInteger(releaseYear)) {
        throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:release_year_not_integer`);
      }
      if (releaseYear < RELEASE_YEAR_MIN || releaseYear > RELEASE_YEAR_MAX) {
        throw new Error(
          `SEED_MODELS_FILE_INVALID:item[${i}]:release_year_out_of_range:${RELEASE_YEAR_MIN}..${RELEASE_YEAR_MAX}`,
        );
      }
    }
    const brandTrim = brand.trim();
    const nameTrim = name.trim();
    const slug = slugify(`${brandTrim} ${nameTrim}`);
    if (slug === "") {
      throw new Error(`SEED_MODELS_FILE_INVALID:item[${i}]:slug_empty`);
    }
    // M4 — duplicate slug TRONG file: typed error nêu slug + CẢ HAI index
    // mục (trước đây mục đầu thắng im lặng — founder không biết file trùng).
    const firstIndex = seenSlugs.get(slug);
    if (firstIndex !== undefined) {
      throw new Error(`SEED_MODELS_FILE_INVALID:duplicate_slug:${slug}:items[${firstIndex},${i}]`);
    }
    seenSlugs.set(slug, i);
    out.push({
      brand: brandTrim,
      name: nameTrim,
      ...(releaseYear !== undefined && releaseYear !== null ? { releaseYear } : {}),
    });
  }
  return out;
}

/**
 * Parse CLI args (M6). `--models` thiếu path (hoặc đứng trước cờ khác, hoặc
 * dạng `--models=<path>`) → usageError — main() in usage + exit 1: KHÔNG
 * âm thầm chạy seed không có model list khi operator gõ sai.
 */
export function parseSeedCliArgs(argv: string[]): SeedCliArgs {
  const isApply = argv.includes("--apply");
  const allowProduction = argv.includes("--allow-production");
  let modelsFile: string | undefined;
  let usageError: string | undefined;
  const i = argv.indexOf("--models");
  if (i !== -1) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      usageError = "--models cần đường dẫn file JSON founder (vd: --models founder.json)";
    } else {
      modelsFile = value;
    }
  } else {
    const equalsForm = argv.find((a) => a.startsWith("--models"));
    if (equalsForm !== undefined) {
      usageError = `--models không hỗ trợ dạng "${equalsForm}" — dùng: --models <founder.json>`;
    }
  }
  return { isApply, allowProduction, modelsFile, usageError };
}

/** Kết quả MỘT lần chạy apply (trong tx) — dùng cho cả lần đầu và lần chạy lại 23505. */
type ApplyOutcome = {
  counts: { category: number; brands: number; models: number };
  created: SeedBetaCatalogReport["created"];
  plan: SeedBetaCatalogReport["detail"];
  /** L9 — slug các model ĐANG CÓ khác brand/category kỳ vọng (chỉ cảnh báo sau re-run 23505). */
  racedMismatchSlugs: string[];
};

/**
 * Seed beta catalog. `isApply=false` → dry-run (chỉ đọc + báo cáo plan);
 * `isApply=true` → MỘT db.transaction bao toàn bộ creates + audit (M3).
 * Idempotent: mọi entity tra theo slug TRƯỚC khi create (trong cùng tx);
 * race create đồng thời → unique violation 23505 propagate ra khỏi tx
 * (callback KHÔNG catch — tx rollback toàn bộ), classify NGOÀI qua
 * isUniqueConstraintViolation (KHÔNG message matching) → chạy lại toàn bộ
 * đúng MỘT lần; lỗi khác → ném (fail closed, KHÔNG im lặng mất row).
 */
export async function seedBetaCatalog(
  isApply: boolean,
  modelsFile?: string,
  options?: SeedBetaCatalogOptions,
): Promise<SeedBetaCatalogReport> {
  // Fail closed: seed catalog vào DB production phải là hành động có chủ đích.
  // b4-holistic round-3: guard quyết từ ĐÍCH (DATABASE_URL host) — --apply vào
  // DB NON-LOCAL (vd compose migrate → db:5432, host "db") yêu cầu
  // --allow-production tường minh. Guard NODE_ENV cũ không bao giờ cháy trên
  // VPS (stage migrate không set NODE_ENV) — giữ làm belt-and-braces bên dưới.
  if (
    isApply &&
    !options?.allowProduction &&
    !isLocalSeedTarget(process.env.DATABASE_URL ?? "")
  ) {
    throw new Error(
      "SEED_REFUSED_NONLOCAL: --apply vào DB non-local phải là hành động có chủ đích — truyền --allow-production.",
    );
  }
  // Belt-and-braces CHỈ --apply (b4-holistic round-4 — review fix L10 thu hẹp):
  // NODE_ENV=production → từ chối MUTATE trừ khi --allow-production. Dry-run
  // (chỉ đọc + in plan) ĐƯỢC PHÉP — compose service migrate set
  // NODE_ENV=production (5adcbe2) nên guard cũ chặn cả dry-run (bước BẮT
  // BUỘC trong docs/deployment.md §2 bước 5) → operator không xem được plan
  // như doc ghi. --apply đã có guard TỪ ĐÍCH (isLocalSeedTarget) phía trên.
  if (isApply && process.env.NODE_ENV === "production" && !options?.allowProduction) {
    throw new Error(
      "SEED_REFUSED_PRODUCTION: từ chối seed --apply khi NODE_ENV=production — truyền --allow-production để chạy thật (dry-run không cần).",
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

  // ── Reads — plan create-if-absent (dry-run báo cáo, apply thực hiện).
  // Dùng được trên db.orm (dry-run) VÀ tx.orm (trong tx của apply) — cùng type.

  const readSeedPlan = async (orm: typeof db.orm) => {
    // Slug category NGUYÊN VĂN từ allowlist (spec §5.6.1) — KHÔNG slugify (A11).
    // Danh sách đang có đúng 1 mục (tests/unit/beta-categories.test.ts pin);
    // thêm category beta công khai khác = explicit product decision (spec §5.6.1).
    const categorySlug: string = BETA_PUBLICATION_CATEGORIES[0];
    const existingCategory = await orm.public.Category.where({ slug: categorySlug }).first();

    const brandPlan = SEED_BRANDS.map((name) => ({ name, slug: slugify(name) }));
    const brandSlugs = brandPlan.map((b) => b.slug);
    const existingBrands = await orm.public.Brand.where((b) => b.slug.in(brandSlugs)).all();
    const existingBrandSlugs = new Set(existingBrands.map((b) => b.slug));
    // Brand slug → row cho model create: 5 brand seed + brand ngoài 5 đã có trong DB.
    const brandRows = new Map(existingBrands.map((b) => [b.slug, b]));

    // Founder models → slug plan (parse ĐÃ reject duplicate slug trong file — M4;
    // KHÔNG reassign model đã tồn tại: skip hoàn toàn, kể cả khác category/brand).
    const modelPlan = founderModels.map((m) => ({
      ...m,
      brandSlug: slugify(m.brand),
      slug: slugify(`${m.brand} ${m.name}`),
    }));

    // Brand của founder model phải nằm trong 5 brand seed HOẶC đã có trong DB —
    // fail closed TRƯỚC khi mutate (KHÔNG tự chế brand ngoài danh sách); brand
    // ngoài 5 nhưng đã có → dùng row đó (KHÔNG tạo brand mới ngoài danh sách).
    const extraBrandSlugs = [...new Set(modelPlan.map((m) => m.brandSlug))].filter(
      (s) => !brandSlugs.includes(s) && !existingBrandSlugs.has(s),
    );
    if (extraBrandSlugs.length > 0) {
      const inDb = await orm.public.Brand.where((b) => b.slug.in(extraBrandSlugs)).all();
      const missing = extraBrandSlugs.filter((s) => !inDb.some((b) => b.slug === s));
      if (missing.length > 0) {
        throw new Error(`SEED_MODEL_BRAND_MISSING:${missing.join(",")}`);
      }
      for (const row of inDb) brandRows.set(row.slug, row);
    }

    const existingModels = modelPlan.length
      ? await orm.public.ProductModel
          .where((m) => m.slug.in(modelPlan.map((x) => x.slug)))
          .all()
      : [];
    const existingModelSlugs = new Set(existingModels.map((m) => m.slug));

    const plan = {
      categorySlug,
      categoryExists: Boolean(existingCategory),
      // L8 — isActive của category đang có (null khi chưa có): dry-run in rõ,
      // cảnh báo khi inactive (seed KHÔNG tự kích hoạt — founder quyết).
      categoryIsActive: existingCategory ? existingCategory.isActive : null,
      brandsToCreate: brandPlan.filter((b) => !existingBrandSlugs.has(b.slug)).map((b) => b.slug),
      brandsExisting: brandSlugs.filter((s) => existingBrandSlugs.has(s)),
      modelsToCreate: modelPlan.filter((m) => !existingModelSlugs.has(m.slug)).map((m) => m.slug),
      modelsExisting: modelPlan.filter((m) => existingModelSlugs.has(m.slug)).map((m) => m.slug),
    };

    // L9 — model ĐANG CÓ so với kỳ vọng (brand so theo SLUG — row id có thể của
    // lần chạy khác; category so với id category beta): khác nhau → slug vào
    // danh sách cảnh báo. Chỉ được DÙNG sau khi chạy lại 23505 — đường thường
    // vẫn im lặng vì skip model cũ là hành vi đúng (A3/A11).
    const existingBrandIds = [...new Set(existingModels.map((m) => m.brandId))];
    const existingBrandRows = existingBrandIds.length
      ? await orm.public.Brand.where((b) => b.id.in(existingBrandIds)).all()
      : [];
    const brandIdToSlug = new Map(existingBrandRows.map((b) => [b.id, b.slug]));
    const racedMismatchSlugs = existingModels
      .filter((row) => {
        const entry = modelPlan.find((m) => m.slug === row.slug);
        if (!entry) return false;
        return brandIdToSlug.get(row.brandId) !== entry.brandSlug || row.categoryId !== existingCategory?.id;
      })
      .map((row) => row.slug);

    return {
      categorySlug,
      existingCategory,
      brandPlan,
      brandRows,
      existingModelSlugs,
      modelPlan,
      plan,
      racedMismatchSlugs,
    };
  };

  if (!isApply) {
    const { plan } = await readSeedPlan(db.orm);
    if (plan.categoryExists && plan.categoryIsActive === false) {
      console.warn(
        "⚠ category beta đang có nhưng isActive=false — seed KHÔNG tự kích hoạt lại (create-if-absent — founder quyết).",
      );
    }
    return {
      mode: "dry-run",
      category: plan.categoryExists ? 0 : 1,
      brands: plan.brandsToCreate.length,
      models: plan.modelsToCreate.length,
      detail: plan,
      created: { categorySlug: null, brandSlugs: [], modelSlugs: [] },
    };
  }

  // ── Apply — M3: MỘT db.transaction bao TOÀN BỘ creates + audit. Callback
  //    dùng tx.orm ONLY (KHÔNG BAO GIỜ db.orm trong callback) và KHÔNG
  //    catch: mọi lỗi (kể cả 23505) propagate ra ngoài → rollback toàn bộ
  //    → 0 row, không audit (KHÔNG BAO GIỜ partial write).

  const runApplyAttempt = async (): Promise<ApplyOutcome> => {
    return db.transaction(async (tx) => {
      const { categorySlug, existingCategory, brandPlan, brandRows, existingModelSlugs, modelPlan, plan, racedMismatchSlugs } =
        await readSeedPlan(tx.orm);

      // Category — create-if-absent theo slug (NGUYÊN VĂN — KHÔNG slugify, A11)
      const categoryCreated = existingCategory ? 0 : 1;
      const betaCategory = existingCategory
        ? existingCategory
        : await tx.orm.public.Category.create({
            name: CATEGORY_NAME,
            slug: categorySlug,
            isActive: true,
          });

      // Brands — create-if-absent theo slug (5 brand focus spec §1)
      let brandsCreated = 0;
      const createdBrandSlugs: string[] = [];
      for (const b of brandPlan) {
        if (brandRows.has(b.slug)) continue;
        brandRows.set(b.slug, await tx.orm.public.Brand.create({ name: b.name, slug: b.slug }));
        brandsCreated += 1;
        createdBrandSlugs.push(b.slug);
      }

      // Models — create-if-absent theo slug, status "pending" (A3 — founder
      // duyệt qua /admin/catalog; KHÔNG model nào tự động approved).
      let modelsCreated = 0;
      const createdModelSlugs: string[] = [];
      for (const m of modelPlan) {
        if (existingModelSlugs.has(m.slug)) continue; // đã có — KHÔNG đụng (A3/A11)
        const brand = brandRows.get(m.brandSlug);
        if (!brand) throw new Error(`SEED_MODEL_BRAND_MISSING:${m.brandSlug}`); // pre-flight đã chặn — belt-and-braces
        await tx.orm.public.ProductModel.create({
          brandId: brand.id,
          categoryId: betaCategory.id,
          name: m.name,
          slug: m.slug,
          releaseYear: m.releaseYear ?? null,
          status: "pending",
        });
        modelsCreated += 1;
        createdModelSlugs.push(m.slug);
      }

      // AuditEvent — CÙNG shape helper audit của app ghi (actorId null =
      // system/offline script; detail chỉ counts — KHÔNG PII, spec §4.8;
      // ipHash/sessionId null: offline). Ghi TRỰC TIẾP qua tx.orm TRONG tx
      // (auditEventTx shape — helper là server-only, throw dưới tsx, KHÔNG
      // import được; backfill precedent): audit sống chết cùng creates (M3).
      await tx.orm.public.AuditEvent.create({
        actorId: null,
        subjectId: null,
        action: "beta_catalog.seeded",
        resourceType: "Category",
        resourceId: betaCategory.id,
        reason: null,
        policyVersion: null,
        sessionId: null,
        detail: `category=${categoryCreated} brands=${brandsCreated} models=${modelsCreated}`,
        ipHash: null,
      });

      return {
        counts: { category: categoryCreated, brands: brandsCreated, models: modelsCreated },
        created: {
          categorySlug: categoryCreated === 1 ? categorySlug : null,
          brandSlugs: createdBrandSlugs,
          modelSlugs: createdModelSlugs,
        },
        plan,
        racedMismatchSlugs,
      };
    });
  };

  let outcome: ApplyOutcome;
  try {
    outcome = await runApplyAttempt();
  } catch (e) {
    // 23505 = race với lần chạy khác (tx ĐÃ rollback toàn bộ — 0 row, không
    // audit). Classify NGOÀI tx qua isUniqueConstraintViolation (KHÔNG message
    // matching) → CHẠY LẠI TOÀN BỘ seed đúng MỘT lần (idempotent — create-if-
    // absent đọc lại state mới). Lần chạy lại mà lại 23505 → propagate (fail
    // closed). Lỗi khác → propagate NGAY (fail closed, KHÔNG im lặng mất row).
    if (!isUniqueConstraintViolation(e)) throw e;
    outcome = await runApplyAttempt();
    // L9 — model đang có khác brand/category kỳ vọng sau re-run → cảnh báo
    // (chỉ slug + count — KHÔNG giá trị thô).
    if (outcome.racedMismatchSlugs.length > 0) {
      console.warn(
        `SEED_RACE_MISMATCH: ${outcome.racedMismatchSlugs.length} model đã tồn tại với brand/category KHÁC kỳ vọng (sau khi chạy lại 23505): ${outcome.racedMismatchSlugs.join(", ")}`,
      );
    }
  }
  if (outcome.plan.categoryExists && outcome.plan.categoryIsActive === false) {
    console.warn(
      "⚠ category beta đang có nhưng isActive=false — seed KHÔNG tự kích hoạt lại (create-if-absent — founder quyết).",
    );
  }
  return {
    mode: "apply",
    category: outcome.counts.category,
    brands: outcome.counts.brands,
    models: outcome.counts.models,
    detail: outcome.plan,
    created: outcome.created,
  };
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — integration test import seedBetaCatalog) ──

const USAGE =
  "Usage: DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts [--apply] [--models <founder.json>] [--allow-production]";

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

/**
 * b4-holistic round-3 (LOW — guard không bao giờ cháy): host đích có local
 * không (localhost/127.0.0.1/::1). Guard --apply quyết từ ĐÍCH, KHÔNG từ
 * NODE_ENV — trên VPS production, seed CHỈ chạy được trong container migrate
 * (db không publish port) và stage migrate KHÔNG set NODE_ENV (chỉ runner
 * stage) nên guard NODE_ENV cũ KHÔNG BAO GIỜ cháy đúng nơi nó cần bảo vệ.
 * Parse fail → non-local (fail closed).
 */
export function isLocalSeedTarget(dbUrl: string): boolean {
  try {
    const host = new URL(dbUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
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
  const args = parseSeedCliArgs(process.argv);
  // M6 — --models thiếu path (hoặc đứng trước cờ khác) → usage + exit 1:
  // KHÔNG âm thầm chạy seed không có model list khi operator gõ sai.
  if (args.usageError) {
    console.error(`✗ ${args.usageError}`);
    console.error(`── ${USAGE}`);
    process.exit(1);
  }
  // Belt-and-braces CHỈ --apply (b4-holistic round-4 — thu hẹp như guard trong
  // seedBetaCatalog): dry-run dưới NODE_ENV=production (compose migrate) được
  // phép — chỉ ĐỌC + in plan; --apply đã có guard từ ĐÍCH phía dưới.
  if (args.isApply && process.env.NODE_ENV === "production" && !args.allowProduction) {
    console.error("✗ SEED_REFUSED_PRODUCTION: NODE_ENV=production — truyền --allow-production để seed thật (dry-run không cần).");
    process.exit(1);
  }
  // b4-holistic round-3: guard từ ĐÍCH — --apply vào DB non-local (compose
  // migrate → db:5432) yêu cầu --allow-production; local (127.0.0.1/::1) thoải
  // mái (dev/test scratch).
  if (args.isApply && !args.allowProduction && !isLocalSeedTarget(process.env.DATABASE_URL)) {
    console.error(
      `✗ SEED_REFUSED_NONLOCAL: --apply vào đích non-local ${describeTarget(process.env.DATABASE_URL)} — truyền --allow-production (hành động có chủ đích).`,
    );
    process.exit(1);
  }
  if (!args.isApply) {
    console.log("── dry-run (mặc định) — truyền --apply để chạy thật");
  } else {
    // In đích TRƯỚC khi --apply chạm dữ liệu — không password.
    console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL)} (không in password)`);
  }
  if (args.modelsFile) console.log(`── models founder (A3 — founder cung cấp): ${args.modelsFile}`);

  const report = await seedBetaCatalog(args.isApply, args.modelsFile, { allowProduction: args.allowProduction });
  const verb = (n: number) =>
    report.mode === "apply" ? (n > 0 ? "đã tạo" : "đã có (create-if-absent)") : n > 0 ? "SẼ TẠO" : "đã có";
  console.log(`── chế độ: ${report.mode}`);
  // L8 — in rõ isActive của category ĐANG CÓ (cảnh báo inactive đã phát từ
  // seedBetaCatalog — cả dry-run lẫn apply).
  if (report.detail.categoryExists) {
    console.log(
      `── category "${report.detail.categorySlug}": đã có (isActive=${report.detail.categoryIsActive})`,
    );
  } else {
    console.log(`── category "${report.detail.categorySlug}": ${verb(report.category)}`);
  }
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
  if (args.isApply) {
    // L7 — rollback list: CHỈ những slug run này TẠO (in thành list ở đây);
    // KHÔNG BAO GIỜ heuristic "brand chưa dùng" — brand có thể đã bị listing
    // khác dùng giữa chừng, xoá theo slug run này tạo là đủ và an toàn.
    const c = report.created;
    if (c.categorySlug === null && c.brandSlugs.length === 0 && c.modelSlugs.length === 0) {
      console.log("── rollback: run này KHÔNG tạo row mới — không có gì cần xoá.");
    } else {
      console.log(
        '── rollback nếu cần (CHỈ những slug run này TẠO — KHÔNG xoá theo heuristic "brand chưa dùng"):',
      );
      let step = 1;
      if (c.modelSlugs.length > 0) console.log(`   ${step++}. ProductModel theo slug: ${c.modelSlugs.join(", ")}`);
      if (c.brandSlugs.length > 0) console.log(`   ${step++}. Brand theo slug: ${c.brandSlugs.join(", ")}`);
      if (c.categorySlug !== null) console.log(`   ${step++}. Category theo slug: ${c.categorySlug}`);
    }
  }
  const { db } = await import("../src/prisma/db.client");
  await db.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("seed-beta-catalog.ts");
if (invokedDirectly) {
  await main();
}
