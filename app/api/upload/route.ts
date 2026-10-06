import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getCurrentUser } from "@/src/lib/auth";
import { checkRateLimit, rateLimitRequest, tooManyRequestsResponse } from "@/src/lib/rate-limit";
import { validateImage } from "@/src/lib/image-validate";
import { IMAGE_MAX_BYTES, reencodeImage } from "@/src/lib/image-process";
import { db } from "@/src/prisma/db.client";
import { captureError } from "@/src/lib/observability";

/**
 * Upload ảnh bậc tự quản (lưu vào public/uploads) — Batch 4 Task 3 hardening
 * (spec §5.6.4/§7.5):
 * - early Content-Length reject (413) TRƯỚC khi buffer body;
 * - rate limit IP (hiện có) + rate limit PER-USER ≤ per-IP (§7.1);
 * - magic bytes + sharp decode + caps (validateImage — caps 50MP/12k px từ
 *   image-process.ts, nguồn duy nhất);
 * - RE-ENCODE WebP qua sharp: decode→pixels→encode strip TOÀN BỘ metadata
 *   (EXIF/GPS), auto-orient trước strip, resize-bounded — file ghi ra là
 *   buffer ĐÃ re-encode, KHÔNG BAO GIỜ buffer gốc (Review Focus 1);
 * - storageKey random UUID + ".webp" (không dùng tên file client); row
 *   ListingImageUpload (ownership) ghi TRƯỚC file — row mồ côi vô hại
 *   (storageKey unique, không có file), FILE mồ côi public-reachable không
 *   owner mới là vấn đề; writeFile fail → xoá row best-effort + 500.
 * Response shape { url } GIỮ NGUYÊN — ImagePicker giữ hoạt động.
 * Production: thay bằng Cloudinary / S3 (ownership table đã trừu tượng hóa).
 */

/** Dư lượng cho multipart envelope ngoài phần file (~512KB) — ngưỡng Content-Length sớm */
const CONTENT_LENGTH_GRACE = 512 * 1024;

export async function POST(request: Request) {
  // 0. Early body reject — KHÔNG buffer body quá lớn (spec §7.5 encoded-size limit)
  const contentLength = Number(request.headers.get("content-length"));
  if (
    request.headers.get("content-length") !== null &&
    Number.isFinite(contentLength) &&
    contentLength > IMAGE_MAX_BYTES + CONTENT_LENGTH_GRACE
  ) {
    return Response.json({ error: "Ảnh tối đa 5MB" }, { status: 413 });
  }

  // 1. Rate limit IP (hiện có)
  const limited = await rateLimitRequest(request, "upload", {
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (limited) return limited;

  // 2. Auth
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  // 3. Per-USER limit ≤ per-IP (§7.1) — một user không vượt được bucket IP của chính mình
  const userLimit = checkRateLimit(`upload:user:${user.id}`, {
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (!userLimit.allowed) {
    return tooManyRequestsResponse(userLimit.retryAfterSec);
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Thiếu file" }, { status: 400 });
  }

  // 4. file.size TRƯỚC khi buffer
  if (file.size > IMAGE_MAX_BYTES) {
    return Response.json({ error: "Ảnh tối đa 5MB" }, { status: 400 });
  }

  // 5. Magic bytes + sharp decode + caps (50MP/12k px — Batch 4)
  const buf = Buffer.from(await file.arrayBuffer());
  const verdict = await validateImage(buf, file.type, IMAGE_MAX_BYTES);
  if (!verdict.ok) {
    // reason không leak chi tiết nội bộ — log có scope để truy vết
    captureError("upload", new Error(`image rejected: ${verdict.reason}`), {
      userId: user.id,
    });
    return Response.json(
      { error: "File không phải ảnh hợp lệ (chỉ JPEG / PNG / WebP / GIF)" },
      { status: 400 },
    );
  }

  // 6. Re-encode WebP — strip EXIF/GPS, auto-orient, resize-bounded (fail → KHÔNG lưu file)
  const out = await reencodeImage(buf);
  if (!out.ok) {
    captureError("upload", new Error(`image re-encode rejected: ${out.reason}`), {
      userId: user.id,
    });
    return Response.json(
      { error: "Không xử lý được ảnh (chỉ JPEG / PNG / WebP / GIF)" },
      { status: 400 },
    );
  }

  // 7. ROW FIRST — storageKey random dùng cho CẢ row lẫn file (tạo trước cả hai)
  const storageKey = `${randomUUID()}.webp`;
  const dir = path.join(process.cwd(), "public", "uploads");
  try {
    await mkdir(dir, { recursive: true });
    await db.orm.public.ListingImageUpload.create({
      ownerUserId: user.id,
      storageKey,
      bytes: out.buffer.length,
      width: out.width,
      height: out.height,
    });
  } catch (e) {
    // mkdir/create fail → chưa có file, chưa có row (hoặc row create fail) — sạch
    captureError("upload", e, { userId: user.id });
    return Response.json({ error: "UPLOAD_FAILED" }, { status: 500 });
  }

  // 8. Ghi buffer ĐÃ re-encode — KHÔNG BAO GIỜ buffer gốc (Review Focus 1)
  try {
    await writeFile(path.join(dir, storageKey), out.buffer);
  } catch (e) {
    // File không ghi được → xoá row (best-effort): row mồ côi vô hại, FILE mồ côi
    // public-reachable không owner mới là vấn đề.
    try {
      await db.orm.public.ListingImageUpload.where({ storageKey }).deleteAndCount();
    } catch {
      // best-effort — lỗi đã capture bên dưới
    }
    captureError("upload", e, { userId: user.id });
    return Response.json({ error: "UPLOAD_FAILED" }, { status: 500 });
  }

  // 9. Response shape { url } giữ nguyên — ImagePicker giữ hoạt động
  return Response.json({ url: `/uploads/${storageKey}` });
}
