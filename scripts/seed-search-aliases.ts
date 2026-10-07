/**
 * Seed search aliases (Batch 5 Task 5 — S9/A7, spec §5.7) — offline
 * maintenance command, seed-beta-catalog posture: dry-run mặc định,
 * --apply để mutate, idempotent (create-if-absent theo (alias, target)),
 * KHÔNG expose HTTP/admin UI.
 *
 * A7: IMPLEMENTER KHÔNG TỰ BIÊN alias catalog từ training data — content
 * EMPTY mặc định (không --aliases → không tạo gì), hoặc FOUNDER-SUPPLIED qua
 * `--aliases <founder.json>`: `[{ "alias": "soundlink", "target": "model",
 * "productModelId": "<uuid>" }, { "alias": "loa jbl", "target": "brand",
 * "brandId": "<uuid>" }]`. Alias lưu DẠNG CHUẨN HÓA (normalizeSearchText —
 * khóa tra cứu của resolveSearchQuery, src/lib/search-resolve.ts); target
 * ⇒ id set đúng MỘT catalog entity (corrections #5 — check constraint
 * `search_alias_target_ids` bắt thêm ở DB).
 *
 * Fail closed TRƯỚC khi mutate (M5 pattern của seed-beta-catalog): file
 * ≤ 1MB / ≤ 500 mục, chỉ khoá alias/target/brandId/productModelId được
 * phép (khoá lạ → typed error nêu tên khoá), alias phải là query hợp lệ
 * (blank/> 120 ký tự/control chars — isMalformedQuery: alias dài hơn không
 * bao giờ khớp query hợp lệ), duplicate (alias-chuẩn-hóa, target) TRONG
 * file → typed error nêu CẢ HAI index mục. Mọi message lỗi chỉ mang index
 * mục + tên khoá — KHÔNG echo giá trị thô.
 *
 * --apply: MỘT db.transaction bao toàn bộ creates (tx.orm ONLY, KHÔNG
 * catch trong callback — lỗi giữa chừng → rollback toàn bộ, 0 row);
 * 23505 (race với lần chạy khác) propagate ra khỏi tx, classify NGOÀI qua
 * isUniqueConstraintViolation (KHÔNG message matching) → chạy lại TOÀN
 * BỘ đúng MỘT lần (idempotent — create-if-absent đọc lại state mới).
 *
 * Guard từ ĐÍCH (b4-holistic round-3 posture, isLocalSeedTarget của
 * seed-beta-catalog): --apply vào DB non-local (vd compose migrate →
 * db:5432) → SEED_REFUSED_NONLOCAL trừ khi --allow-production; belt-and-
 * braces NODE_ENV=production → SEED_REFUSED_PRODUCTION (dry-run được phép
 * — chỉ đọc + in plan).
 *
 * Script import CHỈ plain module (search-normalize.ts, isLocalSeedTarget
 * từ seed-beta-catalog — plain; db.client.ts qua DYNAMIC import SAU khi
 * DATABASE_URL được xác nhận trong env THẬT — backfill precedent L3).
 *
 * Usage:
 *   DATABASE_URL=… npx tsx scripts/seed-search-aliases.ts                          # dry-run (mặc định)
 *   DATABASE_URL=… npx tsx scripts/seed-search-aliases.ts --apply                  # chạy thật (local)
 *   DATABASE_URL=… npx tsx scripts/seed-search-aliases.ts --apply --aliases founder.json
 *   DATABASE_URL=… npx tsx scripts/seed-search-aliases.ts --apply --allow-production   # non-local/production
 *
 * Rollback: xoá các row run này TẠO theo (alias, target) — script in danh
 * sách ở cuối mỗi lần --apply. (FK onDelete: Cascade từ Task 1 — brand/
 * model bị xoá dọn alias theo.)
 */
import { readFileSync, statSync } from "node:fs";

import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";

import { isLocalSeedTarget } from "./seed-beta-catalog";
import { isMalformedQuery, normalizeSearchText } from "../src/lib/search-normalize";

// ── Caps của file founder (fail closed trước khi chạm DB — M5 pattern) ──
/** File founder ≤ 1MB — KHÔNG nạp file khổng lồ vào bộ nhớ. */
const ALIASES_FILE_MAX_BYTES = 1_000_000;
/** ≤ 500 mục — danh sách founder hợp lý, chặn file spam. */
const ALIASES_FILE_MAX_ITEMS = 500;

/** Alias đã chuẩn hóa (không dấu, không khoảng trắng thừa) — hợp lệ mọi môi trường. */
export type FounderAliasEntry =
  | { alias: string; target: "brand"; brandId: string }
  | { alias: string; target: "model"; productModelId: string };

export type SeedSearchAliasesReport = {
  mode: "dry-run" | "apply";
  /** Apply: rows run này tạo. Dry-run: LUÔN 0 (KHÔNG ghi gì). */
  created: number;
  /** Rows còn thiếu hôm nay (dry-run in plan; apply = created). */
  planned: number;
  /** Rows đã có — create-if-absent bỏ qua (idempotent). */
  existing: number;
};

export type SeedSearchAliasesOptions = {
  /** Cho --apply thật khi NODE_ENV=production / đích non-local (CLI: --allow-production). */
  allowProduction?: boolean;
};

/**
 * Đọc + validate file founder aliases (A7 — content DO FOUNDER cung cấp).
 * Fail closed với typed SEED_ALIASES_FILE_INVALID — KHÔNG mutate gì khi
 * file sai shape. Mọi lỗi ở mức mục đều mang index mục; KHÔNG echo giá trị
 * thô — chỉ index/tên khoá/độ dài. Alias chuẩn hóa NGAY tại parse (dạng
 * lưu = dạng tra cứu của resolveSearchQuery).
 */
function parseFounderAliasesFile(path: string): FounderAliasEntry[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`SEED_ALIASES_FILE_INVALID:unreadable:${path}`);
  }
  if (size > ALIASES_FILE_MAX_BYTES) {
    throw new Error(`SEED_ALIASES_FILE_INVALID:file_too_large:${size}>${ALIASES_FILE_MAX_BYTES}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`SEED_ALIASES_FILE_INVALID:unreadable:${path}`);
  }
  // belt-and-braces: file đổi kích thước giữa stat và read (TOCTOU)
  if (Buffer.byteLength(raw, "utf8") > ALIASES_FILE_MAX_BYTES) {
    throw new Error(
      `SEED_ALIASES_FILE_INVALID:file_too_large:${Buffer.byteLength(raw, "utf8")}>${ALIASES_FILE_MAX_BYTES}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEED_ALIASES_FILE_INVALID:json_invalid");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_ALIASES_FILE_INVALID:root_not_array");
  }
  if (parsed.length > ALIASES_FILE_MAX_ITEMS) {
    throw new Error(`SEED_ALIASES_FILE_INVALID:too_many_items:${parsed.length}>${ALIASES_FILE_MAX_ITEMS}`);
  }

  const out: FounderAliasEntry[] = [];
  // (alias-chuẩn-hóa, target) → index mục đầu tiên — duplicate trong file → typed error
  const seen = new Map<string, number>();
  for (let i = 0; i < parsed.length; i++) {
    const item: unknown = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:not_object`);
    }
    const unknownKey = Object.keys(item).find(
      (k) => k !== "alias" && k !== "target" && k !== "brandId" && k !== "productModelId",
    );
    if (unknownKey !== undefined) {
      throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:unknown_key:${unknownKey}`);
    }
    const { alias, target, brandId, productModelId } = item as Record<string, unknown>;
    if (typeof alias !== "string" || alias.trim() === "") {
      throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:alias_empty_or_not_string`);
    }
    // Alias phải là query hợp lệ (blank/> 120/control chars) — alias dài hơn
    // không bao giờ khớp query hợp lệ nên không có giá trị tra cứu.
    if (isMalformedQuery(alias)) {
      throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:alias_malformed`);
    }
    const normalizedAlias = normalizeSearchText(alias);
    if (normalizedAlias === "") {
      throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:alias_normalizes_empty`);
    }
    if (target !== "brand" && target !== "model") {
      throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:target_not_brand_or_model`);
    }
    if (target === "brand") {
      if (typeof brandId !== "string" || brandId.trim() === "") {
        throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:brand_id_empty_or_not_string`);
      }
      if (productModelId !== undefined) {
        throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:target_brand_with_product_model_id`);
      }
      const key = `${normalizedAlias}\u0000brand`;
      const firstIndex = seen.get(key);
      if (firstIndex !== undefined) {
        throw new Error(
          `SEED_ALIASES_FILE_INVALID:duplicate:${normalizedAlias}:target=brand:items[${firstIndex},${i}]`,
        );
      }
      seen.set(key, i);
      out.push({ alias: normalizedAlias, target: "brand", brandId: brandId.trim() });
    } else {
      if (typeof productModelId !== "string" || productModelId.trim() === "") {
        throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:product_model_id_empty_or_not_string`);
      }
      if (brandId !== undefined) {
        throw new Error(`SEED_ALIASES_FILE_INVALID:item[${i}]:target_model_with_brand_id`);
      }
      const key = `${normalizedAlias}\u0000model`;
      const firstIndex = seen.get(key);
      if (firstIndex !== undefined) {
        throw new Error(
          `SEED_ALIASES_FILE_INVALID:duplicate:${normalizedAlias}:target=model:items[${firstIndex},${i}]`,
        );
      }
      seen.set(key, i);
      out.push({ alias: normalizedAlias, target: "model", productModelId: productModelId.trim() });
    }
  }
  return out;
}

/**
 * Seed search aliases. `isApply=false` → dry-run (chỉ đọc + báo plan);
 * `isApply=true` → MỘT db.transaction bao toàn bộ creates. Idempotent:
 * create-if-absent theo (alias, target) đọc TRONG tx; race create đồng thời
 * → unique violation 23505 propagate ra khỏi tx (callback KHÔNG catch),
 * classify NGOÀI qua isUniqueConstraintViolation → chạy lại toàn bộ đúng
 * MỘT lần; lỗi khác → ném (fail closed, KHÔNG im lặng mất row).
 */
export async function seedSearchAliases(
  isApply: boolean,
  aliasesFile?: string,
  options?: SeedSearchAliasesOptions,
): Promise<SeedSearchAliasesReport> {
  // DATABASE_URL phải có trong MÔI TRƯỜNG THẬT (process.env) TRƯỚC khi
  // db.client/dotenv được nạp — dynamic import, KHÔNG top-level (từ chối
  // chạy mù vào đích ngầm định từ .env — backfill precedent L3). Check
  // TRƯỚC guard đích: thiếu URL = không có đích nào để chặn.
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng.");
  }

  // Fail closed: seed vào DB production/non-local phải là hành động có chủ đích
  // (guard từ ĐÍCH — isLocalSeedTarget của seed-beta-catalog, b4-holistic round-3).
  if (isApply && !options?.allowProduction && !isLocalSeedTarget(process.env.DATABASE_URL)) {
    throw new Error(
      "SEED_REFUSED_NONLOCAL: --apply vào DB non-local phải là hành động có chủ đích — truyền --allow-production.",
    );
  }
  // Belt-and-braces CHỈ --apply (dry-run chỉ đọc + in plan — được phép dưới
  // NODE_ENV=production, vd compose service migrate).
  if (isApply && process.env.NODE_ENV === "production" && !options?.allowProduction) {
    throw new Error(
      "SEED_REFUSED_PRODUCTION: từ chối seed --apply khi NODE_ENV=production — truyền --allow-production để chạy thật (dry-run không cần).",
    );
  }

  // Parse + validate file founder TRƯỚC khi chạm DB (fail sớm, KHÔNG mutate).
  const entries = aliasesFile ? parseFounderAliasesFile(aliasesFile) : [];

  // Dynamic import: db.client (kèm dotenv) chỉ nạp SAU khi đích đã được xác nhận.
  const { db } = await import("../src/prisma/db.client");

  // Target phải tồn tại trong catalog (fail closed TRƯỚC khi mutate — FK
  // bắt thêm ở DB; alias trỏ model pending VẪN được nhận: resolveSearchQuery
  // filter approved lúc tra, alias tự "sống" khi model được duyệt).
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.target === "brand") {
      const brand = await db.orm.public.Brand.first({ id: entry.brandId });
      if (brand === null) throw new Error(`SEED_ALIAS_TARGET_MISSING:item[${i}]:brand`);
    } else {
      const model = await db.orm.public.ProductModel.first({ id: entry.productModelId });
      if (model === null) throw new Error(`SEED_ALIAS_TARGET_MISSING:item[${i}]:model`);
    }
  }

  if (!isApply) {
    // Dry-run: đếm plan (đọc, KHÔNG ghi).
    let planned = 0;
    let existing = 0;
    for (const entry of entries) {
      const present = await db.orm.public.SearchAlias
        .where({ alias: entry.alias, target: entry.target })
        .first();
      if (present === null) planned += 1;
      else existing += 1;
    }
    return { mode: "dry-run", created: 0, planned, existing };
  }

  // Apply — MỘT db.transaction bao toàn bộ creates. Callback dùng tx.orm
  // ONLY, KHÔNG catch: mọi lỗi (kể cả 23505) propagate ra ngoài → rollback
  // toàn bộ → 0 row (KHÔNG BAO GIỜ partial write).
  const runApplyAttempt = (): Promise<{ created: number; existing: number }> =>
    db.transaction(async (tx) => {
      let created = 0;
      let existing = 0;
      for (const entry of entries) {
        const present = await tx.orm.public.SearchAlias
          .where({ alias: entry.alias, target: entry.target })
          .first();
        if (present !== null) {
          existing += 1;
          continue;
        }
        await tx.orm.public.SearchAlias.create({
          alias: entry.alias,
          target: entry.target,
          brandId: entry.target === "brand" ? entry.brandId : null,
          productModelId: entry.target === "model" ? entry.productModelId : null,
        });
        created += 1;
      }
      return { created, existing };
    });

  let outcome: { created: number; existing: number };
  try {
    outcome = await runApplyAttempt();
  } catch (e) {
    // 23505 = race với lần chạy khác (tx ĐÃ rollback toàn bộ). Classify
    // NGOÀI tx qua isUniqueConstraintViolation (KHÔNG message matching) →
    // chạy lại TOÀN BỘ đúng MỘT lần (idempotent). Lần chạy lại mà lại
    // 23505 → propagate (fail closed). Lỗi khác → propagate NGAY.
    if (!isUniqueConstraintViolation(e)) throw e;
    outcome = await runApplyAttempt();
  }
  return { mode: "apply", created: outcome.created, planned: outcome.created, existing: outcome.existing };
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — unit test import seedSearchAliases) ──

const USAGE =
  "Usage: DATABASE_URL=… npx tsx scripts/seed-search-aliases.ts [--apply] [--aliases <founder.json>] [--allow-production]";

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

async function main(): Promise<void> {
  // DATABASE_URL phải có trong env THẬT TRƯỚC khi db.client/dotenv nạp.
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng (từ chối chạy mù; .env không được tự động dùng làm đích).",
    );
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const isApply = argv.includes("--apply");
  const allowProduction = argv.includes("--allow-production");
  const aliasesIndex = argv.indexOf("--aliases");
  let aliasesFile: string | undefined;
  if (aliasesIndex !== -1) {
    const value = argv[aliasesIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error("✗ --aliases cần đường dẫn file JSON founder (vd: --aliases founder.json)");
      console.error(`── ${USAGE}`);
      process.exit(1);
    }
    aliasesFile = value;
  } else {
    const equalsForm = argv.find((a) => a.startsWith("--aliases"));
    if (equalsForm !== undefined) {
      console.error(`✗ --aliases không hỗ trợ dạng "${equalsForm}" — dùng: --aliases <founder.json>`);
      console.error(`── ${USAGE}`);
      process.exit(1);
    }
  }
  // Guard từ ĐÍCH + NODE_ENV (belt-and-braces) — CHỈ --apply; dry-run được phép.
  if (isApply && !allowProduction && !isLocalSeedTarget(process.env.DATABASE_URL)) {
    console.error(
      `✗ SEED_REFUSED_NONLOCAL: --apply vào đích non-local ${describeTarget(process.env.DATABASE_URL)} — truyền --allow-production (hành động có chủ đích).`,
    );
    process.exit(1);
  }
  if (isApply && process.env.NODE_ENV === "production" && !allowProduction) {
    console.error("✗ SEED_REFUSED_PRODUCTION: NODE_ENV=production — truyền --allow-production để seed thật (dry-run không cần).");
    process.exit(1);
  }
  if (!isApply) {
    console.log("── dry-run (mặc định) — truyền --apply để chạy thật");
  } else {
    console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL)} (không in password)`);
  }
  if (aliasesFile) console.log(`── aliases founder (A7 — founder cung cấp): ${aliasesFile}`);

  const report = await seedSearchAliases(isApply, aliasesFile, { allowProduction });
  console.log(`── chế độ: ${report.mode}`);
  console.log(`── kết quả: created=${report.created} planned=${report.planned} existing=${report.existing}`);
  if (report.mode === "apply" && report.created > 0) {
    console.log("── rollback nếu cần: xoá các row run này TẠO theo (alias, target) — script không giữ danh sách riêng (create-if-absent đọc lại được).");
  }
  const { db } = await import("../src/prisma/db.client");
  await db.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("seed-search-aliases.ts");
if (invokedDirectly) {
  await main();
}
