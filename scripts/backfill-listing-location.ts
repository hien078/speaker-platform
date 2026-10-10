/**
 * Backfill Listing.locationSource (+ provinceLevelCode CHỈ WHERE NULL) —
 * Batch 5 Task 2 (spec §5.9/§8.3/§8.6, FD-1, S4) — offline maintenance
 * command, KHÔNG bao giờ expose qua HTTP/admin UI (spec §5.1.1 posture —
 * Batch 2 backfill-seller-verification.ts precedent).
 *
 * Mapping (FD-1 — founder-approved rule, đáy /tmp/loaviet/provinces-34.md;
 * delegate resolveLegacyProvince của registry src/lib/provinces.ts —
 * corrections item 1: KHÔNG normalizer riêng):
 *   MỌI Listing WHERE locationSource IS NULL (S4 — idempotent, không đè gì đã có):
 *    1. provinceLevelCode HỢP LỆ (isProvinceCode — mã do Batch 4 form ghi)
 *       → locationSource = "seller_declared" (KHÔNG đụng mã, KHÔNG đụng city)
 *         — record id vào declaredIds (rollback chỉ null locationSource — B3);
 *    2. provinceLevelCode NULL → resolveLegacyLocation(city) theo FD-1 rule:
 *         mapped     → provinceLevelCode = mã registry + locationSource = "legacy_mapped"
 *                      (CAS thêm provinceLevelCode IS NULL — S4: backfill chỉ
 *                      ghi mã WHERE NULL, không bao giờ đè mã);
 *         unresolved → locationSource = "unresolved" (KHÔNG ghi mã — KHÔNG đoán;
 *                      "Khác"/quận/huyện/typo → fail closed, spec §8.3).
 *   Mã NON-NULL nhưng NGOÀI registry (đã bị ai đó ghi trực tiếp) → KHÔNG đụng
 *   (fail closed — không đè mã không validate được, không đoán); row giữ
 *   locationSource NULL và scan sau vẫn gặp (honest, không im lặng biến mất).
 *   city / locationDisplayName KHÔNG BAO GIỜ bị đụng — legacy text giữ nguyên
 *   byte (spec §8.3 preserve).
 *
 * Yêu cầu backfill (spec §8.6):
 *   - dry-run mặc định: in count theo từng resolution — KHÔNG mutate gì;
 *   - --apply: in ĐÍCH (host[:port]/db — KHÔNG password) trước khi chạy;
 *   - idempotent: predicate scan locationSource IS NULL — lần chạy sau 0 row
 *     mới (alreadyDone = số row đã có locationSource);
 *   - rollback (B3 — chỉ null ĐÚNG những gì backfill ghi, xem dưới);
 *   - post-migration verification: tests/integration/listing-location.test.ts
 *     (dry-run → apply → idempotent → rollback) + `npx prisma db verify`.
 *
 * Guard --apply (b5-review T2 — seed-beta-catalog posture, b4-holistic
 * round-3/round-4): backfill vào DB production/non-local phải là hành động CÓ
 * CHỦ ĐÍCH — guard quyết TỪ ĐÍCH (host DATABASE_URL ≠ localhost/127.0.0.1/::1
 * → BACKFILL_REFUSED_NONLOCAL) + belt-and-braces NODE_ENV=production →
 * BACKFILL_REFUSED_PRODUCTION; --allow-production mở cả hai. DRY-RUN KHÔNG bị
 * guard (chỉ đọc + in counts — compose service migrate set NODE_ENV=production
 * nên guard chặn cả dry-run sẽ phá bước doc bắt buộc).
 *
 * Rollback (B3 — SQL documented, chạy qua psql):
 *   UPDATE "Listing" SET "provinceLevelCode" = NULL, "locationSource" = NULL
 *     WHERE "locationSource" IN ('legacy_mapped', 'unresolved');
 *   UPDATE "Listing" SET "locationSource" = NULL WHERE id IN (<declaredIds>);
 *   -- CẢ HAI trường của dòng 1 đều do backfill ghi; dòng 2 CHỈ locationSource —
 *   -- mã trên các row declared là data seller-declared của Batch 4, KHÔNG bao
 *   -- giờ bị null (B3).
 *
 * Script import CHỈ plain module (provinces.ts/location.ts — KHÔNG server-only;
 * audit-event.ts là server-only nên backfill KHÔNG ghi AuditEvent — đây là
 * data backfill, không phải hành vi admin/người dùng). DATABASE_URL phải có
 * trong MÔI TRƯỜNG THẬT (process.env) TRƯỚC khi db.client/dotenv được nạp —
 * dynamic import, KHÔNG top-level import (dotenv chỉ được phép BỔ SUNG
 * config, không được là nguồn ngầm định đích).
 *
 * Usage (trên VPS chạy qua image migrate — xem docs/deployment.md §2):
 *   docker compose -f docker-compose.prod.yml run --rm \
 *     -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
 *     migrate npx tsx scripts/backfill-listing-location.ts                       # dry-run
 *   … scripts/backfill-listing-location.ts --apply --allow-production            # chạy thật
 * Local dev/test (DATABASE_URL 127.0.0.1/localhost):
 *   DATABASE_URL=… npx tsx scripts/backfill-listing-location.ts                 # dry-run (mặc định)
 *   DATABASE_URL=… npx tsx scripts/backfill-listing-location.ts --apply          # chạy thật
 *   (từ chối chạy khi process.env thiếu DATABASE_URL — kể cả khi .env có)
 */
import { isProvinceCode } from "../src/lib/provinces";
import { resolveLegacyLocation } from "../src/lib/location";
import { isLocalSeedTarget } from "./seed-beta-catalog";

/** Báo cáo backfill — counts theo từng resolution (spec §8.6 dry-run/apply). */
export type BackfillListingLocationReport = {
  mode: "dry-run" | "apply";
  /** Row quét được (locationSource IS NULL — ứng viên). */
  scanned: number;
  /** Row map được qua FD-1 rule → provinceLevelCode + legacy_mapped (apply; dry-run = would-be). */
  mapped: number;
  /** Row legacy không authoritative → unresolved (apply; dry-run = would-be). */
  unresolved: number;
  /** Row mang mã Batch-4 hợp lệ → seller_declared (apply; dry-run = would-be). */
  declaredBackfilled: number;
  /** Row đã có locationSource từ trước (scan predicate bỏ qua) + row thua CAS race. */
  alreadyDone: number;
  /** Id các row run NÀY đánh dấu seller_declared — input rollback (B3). Dry-run = []. */
  declaredIds: string[];
};

/** Cho --apply thật khi NODE_ENV=production / đích non-local (CLI: --allow-production). */
export type BackfillListingLocationOptions = {
  allowProduction?: boolean;
};

/**
 * Chạy backfill. `isApply=false` → dry-run (chỉ đọc + báo cáo would-be counts);
 * `isApply=true` → ghi từng row với CAS (compare-and-set theo giá trị đã đọc:
 * `.where(locationSource.isNull())` — writer khác chen giữa scan và write →
 * 0 rows → skip, KHÔNG bao giờ đè). Mọi write là conditional updateAll
 * (corrections item 13 — không single-row .update()).
 */
export async function backfillListingLocation(
  isApply: boolean,
  options?: BackfillListingLocationOptions,
): Promise<BackfillListingLocationReport> {
  // Fail closed khi thiếu cấu hình đích (cả khi gọi trực tiếp từ test).
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng.");
  }
  // Fail closed (b5-review T2): backfill vào DB production/non-local phải là
  // hành động có chủ đích — guard TỪ ĐÍCH (isLocalSeedTarget của seed-beta-
  // catalog, b4-holistic round-3 posture) + belt-and-braces NODE_ENV. Dry-run
  // (chỉ đọc + in counts) KHÔNG bị guard.
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

  // Scan: mọi row chưa có locationSource (idempotent — S4: không đè gì đã có).
  const pending = await db.orm.public.Listing
    .where((l) => l.locationSource.isNull())
    .select("id", "city", "provinceLevelCode")
    .all();

  // Row đã xong (locationSource IS NOT NULL) — bị predicate scan bỏ qua.
  const doneAgg = await db.orm.public.Listing
    .where((l) => l.locationSource.isNotNull())
    .aggregate((a) => ({ total: a.count() }));

  const report: BackfillListingLocationReport = {
    mode: isApply ? "apply" : "dry-run",
    scanned: pending.length,
    mapped: 0,
    unresolved: 0,
    declaredBackfilled: 0,
    alreadyDone: doneAgg.total,
    declaredIds: [],
  };

  for (const row of pending) {
    // ─── 1. Mã hợp lệ do Batch 4 ghi → seller_declared (KHÔNG đụng mã/city) ───
    if (row.provinceLevelCode != null && isProvinceCode(row.provinceLevelCode)) {
      if (!isApply) {
        report.declaredBackfilled += 1;
        continue;
      }
      const claimed = await db.orm.public.Listing
        .where({ id: row.id })
        .where((l) => l.locationSource.isNull()) // CAS theo giá trị đã đọc
        .where({ provinceLevelCode: row.provinceLevelCode }) // CAS mã ĐÃ QUÉT —
        // b5-review T2 SPLIT: legacy edit concurrent (corrections item 3: city
        // đổi → re-resolve → mã NULL + source NULL) không thể khiến row bị đánh
        // seller_declared với mã NULL (rồi rơi khỏi mọi scan sau + vào declaredIds
        // như thể mã Batch 4 tồn tại) — mã đổi giữa scan và write → 0 rows → alreadyDone.
        .updateAll({ locationSource: "seller_declared" });
      if (claimed.length === 0) {
        report.alreadyDone += 1; // writer khác đã ghi giữa scan và write
        continue;
      }
      report.declaredBackfilled += 1;
      report.declaredIds.push(row.id); // rollback input (B3)
      continue;
    }

    // ─── 2. Mã NULL → resolve legacy city qua FD-1 rule ─────────────────────
    if (row.provinceLevelCode == null) {
      const resolution = resolveLegacyLocation(row.city);
      if (resolution.source === "legacy_mapped") {
        if (!isApply) {
          report.mapped += 1;
          continue;
        }
        // CAS thêm provinceLevelCode IS NULL — S4: backfill chỉ ghi mã
        // WHERE NULL, không bao giờ đè mã (kể cả mã do writer khác vừa ghi).
        const claimed = await db.orm.public.Listing
          .where({ id: row.id })
          .where((l) => l.locationSource.isNull())
          .where((l) => l.provinceLevelCode.isNull())
          .updateAll({
            provinceLevelCode: resolution.provinceLevelCode,
            locationSource: "legacy_mapped",
          });
        if (claimed.length === 0) {
          report.alreadyDone += 1;
          continue;
        }
        report.mapped += 1;
        continue;
      }
      // unresolved — KHÔNG ghi mã (KHÔNG đoán — spec §8.3)
      if (!isApply) {
        report.unresolved += 1;
        continue;
      }
      const claimed = await db.orm.public.Listing
        .where({ id: row.id })
        .where((l) => l.locationSource.isNull())
        .updateAll({ locationSource: "unresolved" });
      if (claimed.length === 0) {
        report.alreadyDone += 1;
        continue;
      }
      report.unresolved += 1;
      continue;
    }
    // Mã NON-NULL nhưng ngoài registry — fail closed: KHÔNG đè mã, KHÔNG đoán;
    // row giữ locationSource NULL (scan sau gặp lại — không im lặng biến mất).
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
  const allowProduction = process.argv.includes("--allow-production");
  // Guard từ ĐÍCH + NODE_ENV (belt-and-braces) — CHỈ --apply; dry-run được phép
  // (b5-review T2 — seed-beta-catalog posture, guard trong hàm export lặp lại
  // cho caller trực tiếp).
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
    console.log("── dry-run (mặc định) — truyền --apply để chạy thật");
  } else {
    // In đích TRƯỚC khi --apply chạm dữ liệu — không password.
    console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL)} (không in password)`);
  }
  const report = await backfillListingLocation(isApply, { allowProduction });
  console.log(`── chế độ: ${report.mode}`);
  console.log(`── quét (locationSource IS NULL): ${report.scanned}`);
  console.log(`── đã xong từ trước (locationSource NOT NULL + thua CAS): ${report.alreadyDone}`);
  console.log(`── map theo FD-1 → legacy_mapped: ${report.mapped}`);
  console.log(`── không authoritative → unresolved: ${report.unresolved}`);
  console.log(`── mã Batch-4 hợp lệ → seller_declared: ${report.declaredBackfilled}`);
  if (isApply) {
    console.log(`── declaredIds (rollback input — B3): ${report.declaredIds.join(", ") || "(none)"}`);
    console.log(
      "── rollback nếu cần (xem header script): null locationSource (+provinceLevelCode) của legacy_mapped/unresolved; CHỈ locationSource của declaredIds.",
    );
  }
  const { db } = await import("../src/prisma/db.client");
  await db.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("backfill-listing-location.ts");
if (invokedDirectly) {
  await main();
}
