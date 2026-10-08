/**
 * Backfill Listing.searchTextNormalized — Batch 5 Task 4 (spec §5.7/§8.6, S-4)
 * — offline maintenance command, KHÔNG bao giờ expose qua HTTP/admin UI
 * (spec §5.1.1 posture — scripts/backfill-listing-location.ts precedent).
 *
 * searchTextNormalized = normalizeSearchText(title + brand.name + model.name)
 * (src/lib/search-normalize.ts — Batch 5 Task 3, đơn nguồn chuẩn hóa) — cột
 * DERIVED, luôn tính lại được:
 *  - mặc định: MỌI Listing WHERE searchTextNormalized IS NULL → load row +
 *    brand.name + productModel.name (.include) → normalize → conditional
 *    updateAll — CAS `.where(searchTextNormalized.isNull())` (corrections item
 *    13: KHÔNG bao giờ single-row .update(); writer khác chen giữa scan và
 *    write → 0 rows → alreadyDone, KHÔNG đè text mới hơn do action ghi);
 *  - --recompute-all: MỌI row tính lại (S-4 — sửa staleness) — CAS theo
 *    `updatedAt` đã quét (row bị edit giữa scan và write → 0 rows → skip,
 *    KHÔNG clobber text mới hơn) + SKIP row có text ĐÚNG rồi (không ghi lại
 *    giá trị giống hệt — không bump updatedAt oan trên toàn bảng).
 *
 * STALENESS PROCEDURE (S-4 — searchTextNormalized nhúng TÊN brand/model nên
 * trôi khi brand/model rename, catalog merge, seed Batch 4):
 *  - chạy `--recompute-all` sau `seed-beta-catalog --apply`, sau MỌI lần
 *    /admin/catalog edit/merge brand-model (mergeModelAction re-point
 *    productModelId/brandId của listings — src/lib/actions/catalog.ts), và
 *    sau bất kỳ thao tác đổi tên catalog nào;
 *  - KHÔNG hook vào action catalog của Batch 4 (file họ, call họ — coordination
 *    note, plan Task 4 Step 3); repair = chạy lại `--recompute-all`;
 *  - Task 7 (search page) match CHỈ searchTextNormalized (bỏ
 *    title.fullTextMatches) → chạy `--apply` là BƯỚC BẮT BUỘC ngay sau
 *    migrate (row NULL = unsearchable — corrections item 14; document ở
 *    runbook/deployment khi Task 7 land).
 *
 * Yêu cầu backfill (spec §8.6):
 *  - dry-run mặc định: in would-be counts — KHÔNG mutate gì;
 *  - --apply: in ĐÍCH (host[:port]/db — KHÔNG password) trước khi chạy;
 *  - idempotent: predicate scan searchTextNormalized IS NULL — lần sau 0 row
 *    mới (alreadyDone = row đã có text + row thua CAS + row text ĐÚNG rồi);
 *  - rollback: KHÔNG cần — cột derived, luôn tính lại được (chạy lại backfill
 *    mặc định / --recompute-all); script KHÔNG có op destructive nào;
 *  - post-migration verification: tests/integration/listing-search-text.test.ts
 *    (dry-run → apply → idempotent → recompute-all → full-text queryability)
 *    + `npx prisma db verify`.
 *
 * Guard --apply (b5-review T2 posture — seed-beta-catalog /
 * backfill-listing-location): backfill vào DB production/non-local phải là
 * hành động CÓ CHỦ ĐÍCH — guard quyết TỪ ĐÍCH (host DATABASE_URL ≠
 * localhost/127.0.0.1/::1 → BACKFILL_REFUSED_NONLOCAL) + belt-and-braces
 * NODE_ENV=production → BACKFILL_REFUSED_PRODUCTION; --allow-production mở cả
 * hai. DRY-RUN KHÔNG bị guard (chỉ đọc + in counts — compose service migrate
 * set NODE_ENV=production nên guard chặn cả dry-run sẽ phá bước doc bắt buộc).
 *
 * Script import CHỈ plain module (search-normalize.ts / seed-beta-catalog
 * isLocalSeedTarget — KHÔNG server-only). DATABASE_URL phải có trong MÔI
 * TRƯỜNG THẬT (process.env) TRƯỚC khi db.client/dotenv được nạp — dynamic
 * import, KHÔNG top-level import (dotenv chỉ được phép BỔ SUNG config,
 * không được là nguồn ngầm định đích).
 *
 * Usage (trên VPS chạy qua image migrate — xem docs/deployment.md §2):
 *   docker compose -f docker-compose.prod.yml run --rm \
 *     -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
 *     migrate npx tsx scripts/backfill-listing-search-text.ts                  # dry-run
 *   … scripts/backfill-listing-search-text.ts --apply --allow-production       # chạy thật
 *   … scripts/backfill-listing-search-text.ts --apply --recompute-all --allow-production
 * Local dev/test (DATABASE_URL 127.0.0.1/localhost):
 *   DATABASE_URL=… npx tsx scripts/backfill-listing-search-text.ts              # dry-run (mặc định)
 *   DATABASE_URL=… npx tsx scripts/backfill-listing-search-text.ts --apply      # chạy thật
 *   (từ chối chạy khi process.env thiếu DATABASE_URL — kể cả khi .env có)
 */
import { normalizeSearchText } from "../src/lib/search-normalize";
import { isLocalSeedTarget } from "./seed-beta-catalog";

/** Báo cáo backfill (spec §8.6 dry-run/apply — counts in ra console). */
export type BackfillListingSearchTextReport = {
  mode: "dry-run" | "apply";
  recomputeAll: boolean;
  /** Row quét được (ứng viên): null-text (mặc định); MỌI row khi --recompute-all. */
  scanned: number;
  /** Row ghi thành công (apply); dry-run = would-be. */
  updated: number;
  /** Row bỏ qua: đã có text (predicate scan) + text ĐÚNG rồi (recompute-all) + thua CAS race. */
  alreadyDone: number;
};

/** Options cho --recompute-all (S-4) + --allow-production (guard b5-review T2). */
export type BackfillListingSearchTextOptions = {
  recomputeAll?: boolean;
  allowProduction?: boolean;
};

/** searchTextNormalized của một row — normalizeSearchText(title + brand + model). */
const listingSearchText = (
  title: string,
  brandName: string | null | undefined,
  modelName: string | null | undefined,
): string => normalizeSearchText([title, brandName ?? "", modelName ?? ""].join(" "));

/**
 * Chạy backfill. `isApply=false` → dry-run (chỉ đọc + báo cáo would-be counts);
 * `isApply=true` → ghi từng row với conditional updateAll (compare-and-set —
 * corrections item 13):
 *  - mặc định: CAS `.where(searchTextNormalized.isNull())` — action
 *    (create/update/draft/submit) ghi text giữa scan và write → 0 rows →
 *    alreadyDone, KHÔNG đè;
 *  - --recompute-all: CAS theo `updatedAt` đã quét — row bị edit giữa scan và
 *    write (updatedAt tự bump) → 0 rows → skip, KHÔNG clobber text mới hơn.
 */
export async function backfillListingSearchText(
  isApply: boolean,
  options?: BackfillListingSearchTextOptions,
): Promise<BackfillListingSearchTextReport> {
  const recomputeAll = options?.recomputeAll === true;
  // Fail closed khi thiếu cấu hình đích (cả khi gọi trực tiếp từ test) — TRƯỚC
  // khi db.client/dotenv được nạp.
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng.");
  }
  // Fail closed (b5-review T2 posture): --apply vào DB production/non-local
  // phải là hành động có chủ đích — guard TỪ ĐÍCH + belt-and-braces NODE_ENV.
  // Dry-run (chỉ đọc + in counts) KHÔNG bị guard.
  if (isApply && !options?.allowProduction && !isLocalSeedTarget(process.env.DATABASE_URL)) {
    throw new Error(
      "BACKFILL_REFUSED_NONLOCAL: --apply vào DB non-local phải là hành động có chủ đích — truyền --allow-production.",
    );
  }
  if (isApply && process.env.NODE_ENV === "production" && !options?.allowProduction) {
    throw new Error(
      "BACKFILL_REFUSED_PRODUCTION: từ chối backfill --apply khi NODE_ENV=production — truyền --allow-production để chạy thật (dry-run không cần).",
    );
  }
  // Dynamic import: db.client (kèm dotenv) chỉ nạp SAU khi đích đã được xác nhận.
  const { db } = await import("../src/prisma/db.client");

  // Scan: default = row null-text (idempotent — S-4: không đè gì đã có);
  // --recompute-all = MỌI row (tính lại staleness). Tên brand/model qua
  // .include (relation nullable — row không brand/model → null → title-only).
  const scanQuery = () =>
    db.orm.public.Listing
      .select("id", "title", "searchTextNormalized", "updatedAt")
      .include("brand", (b) => b.select("name"))
      .include("productModel", (m) => m.select("name"));
  const rows = recomputeAll
    ? await scanQuery().all()
    : await scanQuery().where((l) => l.searchTextNormalized.isNull()).all();

  // Row đã xong (searchTextNormalized NOT NULL — default mode) — predicate scan bỏ qua.
  const doneAgg = recomputeAll
    ? { total: 0 }
    : await db.orm.public.Listing
        .where((l) => l.searchTextNormalized.isNotNull())
        .aggregate((a) => ({ total: a.count() }));

  const report: BackfillListingSearchTextReport = {
    mode: isApply ? "apply" : "dry-run",
    recomputeAll,
    scanned: rows.length,
    updated: 0,
    alreadyDone: doneAgg.total,
  };

  for (const row of rows) {
    const text = listingSearchText(row.title, row.brand?.name, row.productModel?.name);

    // --recompute-all: row đã ĐÚNG text → KHÔNG ghi lại (giá trị giống hệt —
    // không bump updatedAt oan); dry-run đếm would-be theo cùng quy tắc.
    if (recomputeAll && row.searchTextNormalized === text) {
      report.alreadyDone += 1;
      continue;
    }
    if (!isApply) {
      report.updated += 1; // would-be
      continue;
    }

    // Conditional updateAll (corrections item 13 — KHÔNG single-row .update()):
    //  - default: CAS isNull — writer khác đã ghi giữa scan và write → 0 rows;
    //  - recompute-all: CAS updatedAt đã quét — row bị edit giữa scan và write
    //    → 0 rows → skip (KHÔNG clobber text mới hơn của action).
    const claimed = recomputeAll
      ? await db.orm.public.Listing
          .where({ id: row.id, updatedAt: row.updatedAt })
          .updateAll({ searchTextNormalized: text })
      : await db.orm.public.Listing
          .where({ id: row.id })
          .where((l) => l.searchTextNormalized.isNull())
          .updateAll({ searchTextNormalized: text });
    if (claimed.length === 0) {
      report.alreadyDone += 1; // writer khác đã ghi giữa scan và write
      continue;
    }
    report.updated += 1;
  }
  return report;
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — integration test import hàm) ──────

/** Đích hiển thị an toàn: host[:port]/db — KHÔNG bao giờ in password. */
function describeTarget(dbUrl: string): string {
  try {
    const url = new URL(dbUrl);
    const port = url.port ? `:${url.port}` : "";
    const db = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.hostname}${port}/${db}`;
  } catch {
    return "(DATABASE_URL không phân tích được — KHÔNG in nguyên giá trị)";
  }
}

async function main(): Promise<void> {
  // Kiểm tra process.env TRƯỚC khi db.client/dotenv được nạp: script phải được
  // TRỎ ĐÍCH TƯỜNG MINH, không âm thầm lấy .env của repo.
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng (từ chối chạy mù; .env không được tự động dùng làm đích).",
    );
    process.exit(1);
  }
  const isApply = process.argv.includes("--apply");
  const recomputeAll = process.argv.includes("--recompute-all");
  const allowProduction = process.argv.includes("--allow-production");
  // Guard từ ĐÍCH + NODE_ENV (belt-and-braces) — CHỈ --apply; dry-run được phép
  // (b5-review T2 — guard trong hàm export lặp lại cho caller trực tiếp).
  if (isApply && !allowProduction && !isLocalSeedTarget(process.env.DATABASE_URL)) {
    console.error(
      `✗ BACKFILL_REFUSED_NONLOCAL: --apply vào đích non-local ${describeTarget(process.env.DATABASE_URL)} — truyền --allow-production (hành động có chủ đích).`,
    );
    process.exit(1);
  }
  if (isApply && process.env.NODE_ENV === "production" && !allowProduction) {
    console.error("✗ BACKFILL_REFUSED_PRODUCTION: NODE_ENV=production — truyền --allow-production để chạy thật (dry-run không cần).");
    process.exit(1);
  }
  if (!isApply) {
    console.log(
      recomputeAll
        ? "── dry-run --recompute-all (mặc định) — truyền --apply --recompute-all để chạy thật"
        : "── dry-run (mặc định) — truyền --apply để chạy thật (+ --recompute-all để tính lại MỌI row)",
    );
  } else {
    // In đích TRƯỚC khi --apply chạm dữ liệu — không password.
    console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL)} (không in password)`);
  }
  const report = await backfillListingSearchText(isApply, { recomputeAll, allowProduction });
  console.log(`── chế độ: ${report.mode}${report.recomputeAll ? " (--recompute-all)" : ""}`);
  console.log(`── quét: ${report.scanned}`);
  console.log(`── ${report.mode === "apply" ? "đã ghi" : "would-be ghi"}: ${report.updated}`);
  console.log(
    `── bỏ qua (đã có text / text ĐÚNG rồi / thua CAS): ${report.alreadyDone}`,
  );
  console.log(
    "── rollback: KHÔNG cần — cột derived, luôn tính lại được (chạy lại backfill / --recompute-all); xem header script.",
  );
  const { db } = await import("../src/prisma/db.client");
  await db.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("backfill-listing-search-text.ts");
if (invokedDirectly) {
  await main();
}
