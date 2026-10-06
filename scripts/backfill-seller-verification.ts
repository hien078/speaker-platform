/**
 * Backfill SellerVerification từ legacy User.isVerifiedSeller (Batch 2 Task 10
 * — spec §8.2/§8.5/§8.6) — offline maintenance command, KHÔNG bao giờ expose
 * qua HTTP/admin UI (spec §5.1.1 posture).
 *
 * Mapping (spec §8.2 — "where a confident migration rule exists"):
 *   User.isVerifiedSeller = true  →  SellerVerification row
 *     { status: "verified", method: "operations_review",
 *       reviewedAt: now, reviewerId: null,
 *       reasonCode: "migrated_legacy_verified",
 *       note: "migrated from legacy isVerifiedSeller (batch 2)",
 *       policyVersion: "v1" }
 *
 * LƯU Ý QUYỀN (spec §8.2/§8.4): row migrated "verified" MỘT MÌNH KHÔNG thỏa
 * publication gate — seller vẫn cần verified email/phone, khai báo, đồng ý
 * Seller Rules v1, founding_seller active (gate đọc workflow + cohort, không
 * đọc boolean legacy). Legacy boolean giữ nguyên (display-only).
 *
 * Yêu cầu backfill (spec §8.6):
 *   - dry-run mặc định: in count + danh sách id ứng viên (isVerifiedSeller=true
 *     CHƯA có row SellerVerification) — KHÔNG mutate gì.
 *   - --apply: tạo row cho từng ứng viên; idempotent (bỏ qua ai đã có row;
 *     unique violation userId → skip); ghi AuditEvent
 *     "seller_verification.backfill" (actor null — system/offline script).
 *   - Rollback (đã chứng minh qua integration test):
 *       DELETE FROM "SellerVerification" WHERE "reasonCode" = 'migrated_legacy_verified';
 *   - Post-migration verification: tests/integration/seller-verification.test.ts
 *     (dry-run → apply → idempotent) + `npx prisma db verify`.
 *
 * Script import CHỈ plain module (KHÔNG server-only — audit-event.ts là
 * server-only): db từ src/prisma/db.client (plain), AuditEvent ghi TRỰC TIẾP
 * qua db.orm với cùng shape auditEvent dùng (spec §4.6/§4.8 — detail chỉ
 * count, KHÔNG PII).
 *
 * Usage:
 *   npx tsx scripts/backfill-seller-verification.ts            # dry-run (mặc định)
 *   npx tsx scripts/backfill-seller-verification.ts --apply   # chạy thật
 *   (từ chối chạy khi thiếu DATABASE_URL)
 */
import { db } from "../src/prisma/db.client";

export type BackfillReport = {
  mode: "dry-run" | "apply";
  /** User id ứng viên (isVerifiedSeller=true, chưa có row SellerVerification). */
  pendingIds: string[];
  /** Số row đã tạo (chỉ apply; dry-run = 0). */
  createdCount: number;
};

/**
 * Chạy backfill. `isApply=false` → dry-run (chỉ đọc + báo cáo);
 * `isApply=true` → tạo row + audit. Idempotent: ứng viên đã bị loại bởi
 * chính truy vấn ứng viên; race create đồng thời → unique violation 23505
 * trên SellerVerification.userId → skip row đó (không abort cả batch).
 */
export async function backfill(isApply: boolean): Promise<BackfillReport> {
  // Ứng viên: isVerifiedSeller=true (legacy) CHƯA có row SellerVerification.
  const [legacySellers, existingRows] = await Promise.all([
    db.orm.public.User.where({ isVerifiedSeller: true }).select("id").all(),
    db.orm.public.SellerVerification.select("userId").all(),
  ]);
  const alreadyVerified = new Set(existingRows.map((r) => r.userId));
  const pendingIds = legacySellers.map((u) => u.id).filter((id) => !alreadyVerified.has(id));

  if (!isApply) {
    return { mode: "dry-run", pendingIds, createdCount: 0 };
  }

  let createdCount = 0;
  const now = new Date().toISOString();
  for (const userId of pendingIds) {
    try {
      await db.orm.public.SellerVerification.create({
        userId,
        status: "verified",
        method: "operations_review",
        submittedAt: now, // legacy không có mốc gửi — dùng mốc chuyển đổi
        reviewedAt: now,
        reviewerId: null, // system migration — không có reviewer người
        reasonCode: "migrated_legacy_verified",
        note: "migrated from legacy isVerifiedSeller (batch 2)",
        policyVersion: "v1",
      });
      createdCount += 1;
    } catch (e) {
      // Unique violation (userId) = row được tạo đồng thời bởi lần chạy khác —
      // skip (idempotent). Lỗi khác → ném (fail closed, không im lặng mất row).
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes("unique") && !message.includes("23505")) throw e;
    }
  }

  // AuditEvent — cùng shape auditEvent() ghi (actor null = system/offline;
  // detail chỉ count — KHÔNG PII, spec §4.8). ipHash/sessionId null: offline.
  await db.orm.public.AuditEvent.create({
    actorId: null,
    subjectId: null,
    action: "seller_verification.backfill",
    resourceType: "SellerVerification",
    resourceId: null,
    reason: "migrated_legacy_verified",
    policyVersion: "v1",
    sessionId: null,
    detail: `count=${createdCount}`,
    ipHash: null,
  });

  return { mode: "apply", pendingIds, createdCount };
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — integration test import backfill) ──

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL chưa đặt — script offline cần DB rõ ràng (từ chối chạy mù).",
    );
    process.exit(1);
  }
  const isApply = process.argv.includes("--apply");
  if (!isApply) {
    console.log("── dry-run (mặc định) — truyền --apply để chạy thật");
  }
  const report = await backfill(isApply);
  console.log(`── chế độ: ${report.mode}`);
  console.log(`── ứng viên (isVerifiedSeller=true, chưa có row): ${report.pendingIds.length}`);
  for (const id of report.pendingIds) console.log(`   · ${id}`);
  if (isApply) {
    console.log(`── đã tạo: ${report.createdCount} row (reasonCode=migrated_legacy_verified)`);
    console.log("── rollback nếu cần: DELETE FROM \"SellerVerification\" WHERE \"reasonCode\" = 'migrated_legacy_verified';");
  }
  await db.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("backfill-seller-verification.ts");
if (invokedDirectly) {
  await main();
}
