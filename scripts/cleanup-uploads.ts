/**
 * Dọn ảnh upload MỒ CÔI (b4-holistic round-3 LOW — per-user storage quota,
 * phần cleanup) — offline maintenance command, KHÔNG expose qua HTTP/admin UI.
 *
 * Vấn đề: mọi upload được chấp nhận ghi MỘT ListingImageUpload row + MỘT file
 * (data/uploads) KỂ CẢ khi không bao giờ gắn vào tin nào (seller bỏ bước 5,
 * đổi ảnh trước khi lưu, draft bị xoá…). Không có gì xoá file này — đĩa volume
 * uploads (cùng host với pgdata) đầy dần theo thời gian. Quota 24h
 * (UPLOAD_DAILY_MAX — app/api/upload/route.ts) chặn TỐC ĐỘ; script này thu
 * hồi DUNG LƯỢNG của những file đã chắc chắn mồ côi.
 *
 * An toàn (fail-closed theo hướng KHÔNG xoá nhầm):
 *  - CHọ xét row ListingImageUpload CŨ HƠN --grace-days (mặc định 7) — upload
 *    mới (đang trong phiên soạn tin) không bao giờ bị dọn; age check loại race
 *    "upload xong nhưng listing save chưa kịp chạy".
 *  - CHỈ xoá khi KHÔNG có ListingImage row nào mang url /uploads/<storageKey>
 *    (attached = sản phẩm đang sống — giữ nguyên). Ảnh pre-Batch-4 không có
 *    ownership row → script không đụng (chỉ làm việc trên row Batch 4+).
 *  - File bị xoá best-effort SAU row (row mồ côi vô hại — file mồ côi tốn đĩa
 *    mới là vấn đề); unlink fail → in lỗi, KHÔNG nuốt im lặng, KHÔNG rollback
 *    row (chạy lại lần sau tự lành).
 *  - dry-run MẶC ĐỊNH (chỉ đọc + báo cáo); --apply mới xoá. Idempotent.
 *
 * Review fix L3 (backfill precedent): DATABASE_URL phải có trong MÔI TRƯỜNG
 * THẬT (process.env) TRƯỚC khi db.client/dotenv nạp — dynamic import.
 *
 * Usage:
 *   DATABASE_URL=… npx tsx scripts/cleanup-uploads.ts                     # dry-run (mặc định)
 *   DATABASE_URL=… npx tsx scripts/cleanup-uploads.ts --apply            # xoá thật
 *   DATABASE_URL=… npx tsx scripts/cleanup-uploads.ts --apply --grace-days 14
 *   (chạy qua image migrate của compose như các script offline khác — xem
 *    docs/deployment.md §2; UPLOADS_DIR phải trỏ đúng volume, mặc định data/uploads)
 */
import { unlink } from "node:fs/promises";
import path from "node:path";

export type CleanupUploadsReport = {
  mode: "dry-run" | "apply";
  /** Số row ứng viên (cũ hơn grace, KHÔNG attached). */
  orphanCount: number;
  /** Số row đã xoá (chỉ apply; dry-run = 0). */
  deletedRows: number;
  /** Số file đã xoá thành công (chỉ apply). */
  deletedFiles: number;
  /** Số file xoá THẤT BẠI (row vẫn đã xoá — chạy lại lần sau tự lành). */
  unlinkFailures: Array<{ storageKey: string; error: string }>;
};

/** Ngưỡng tuổi mặc định (ngày) trước khi upload chưa gắn được coi là mồ côi. */
const DEFAULT_GRACE_DAYS = 7;

export async function cleanupUploads(
  isApply: boolean,
  graceDays = DEFAULT_GRACE_DAYS,
): Promise<CleanupUploadsReport> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng.");
  }
  // Dynamic import: db.client (kèm dotenv) chỉ nạp SAU khi đích đã được xác nhận.
  const { db } = await import("../src/prisma/db.client");
  // UPLOADS_DIR đọc SAU env xác nhận — cùng resolution với app runtime.
  const { UPLOADS_DIR } = await import("../src/lib/uploads-storage");

  const cutoffIso = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString();

  // Ứng viên: row cũ hơn grace (chỉ đọc — dry-run và apply cùng query).
  const candidates = await db.orm.public.ListingImageUpload
    .where((u) => u.createdAt.lt(cutoffIso))
    .all();

  // Attached-set: MỘT query cho cả list (beta scale — vài nghìn url); so khớp
  // url ĐẦY ĐỦ "/uploads/<storageKey>" (không phải substring — không false-positive).
  const attachedUrls = new Set<string>();
  const images = await db.orm.public.ListingImage.select("url").all();
  for (const img of images) attachedUrls.add(img.url);

  const orphans = candidates.filter((u) => !attachedUrls.has(`/uploads/${u.storageKey}`));

  const report: CleanupUploadsReport = {
    mode: isApply ? "apply" : "dry-run",
    orphanCount: orphans.length,
    deletedRows: 0,
    deletedFiles: 0,
    unlinkFailures: [],
  };
  if (!isApply || orphans.length === 0) return report;

  for (const orphan of orphans) {
    // ROW FIRST (ngược với upload): xoá row trước — file mồ côi tốn đĩa là
    // vấn đề, row mồ côi vô hại. File fail → row vẫn đã xoá, báo lỗi, chạy
    // lại lần sau file tự dọn (row không còn → không lặp).
    await db.orm.public.ListingImageUpload.where({ id: orphan.id }).delete();
    report.deletedRows += 1;
    try {
      await unlink(path.join(UPLOADS_DIR, orphan.storageKey));
      report.deletedFiles += 1;
    } catch (e) {
      // ENOENT (file đã mất) → không phải lỗi; lỗi khác (EACCES/ENOTDIR) → báo.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        report.unlinkFailures.push({
          storageKey: orphan.storageKey,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return report;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL chưa đặt trong môi trường — script offline cần DB rõ ràng.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const isApply = args.includes("--apply");
  const graceIdx = args.indexOf("--grace-days");
  const graceDays =
    graceIdx >= 0 && args[graceIdx + 1] != null && Number.isInteger(Number(args[graceIdx + 1]))
      ? Number(args[graceIdx + 1])
      : DEFAULT_GRACE_DAYS;

  if (!isApply) console.log("── dry-run (mặc định) — truyền --apply để xoá thật");
  console.log(`── grace: ${graceDays} ngày (upload chưa gắn CŨ HƠN ngưỡng mới được dọn)`);

  const report = await cleanupUploads(isApply, graceDays);
  console.log(`── chế độ: ${report.mode}`);
  console.log(`── upload mồ côi (cũ hơn ${graceDays} ngày, chưa gắn vào tin nào): ${report.orphanCount}`);
  if (report.mode === "apply") {
    console.log(`── row đã xoá: ${report.deletedRows} · file đã xoá: ${report.deletedFiles}`);
    for (const fail of report.unlinkFailures) {
      console.error(`✗ unlink thất bại ${fail.storageKey}: ${fail.error}`);
    }
    if (report.unlinkFailures.length > 0) process.exitCode = 1;
  }
}

// Chỉ chạy main khi được gọi trực tiếp (tsx scripts/…), không khi import cho test.
if (process.argv[1] != null && process.argv[1].endsWith("cleanup-uploads.ts")) {
  void main();
}
