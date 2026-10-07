import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { UPLOADS_DIR } from "@/src/lib/uploads-storage";
import { captureError } from "@/src/lib/observability";

/**
 * GET /uploads/[key] — serve file upload đọc ĐĨA MỌI REQUEST (b4-holistic
 * round-3 HIGH — upload-resource).
 *
 * Trước fix: file upload lưu trong public/uploads và được serve bởi static
 * path của Next. Ở production (output: standalone), Next scan public/ MỘT
 * LẦN khi server start vào một Set và chỉ serve path nằm trong Set — MỌI ảnh
 * upload sau lần restart container trả 404 (picker preview, admin review
 * card, gallery công khai đều vỡ). Đã reproduce: build + start standalone,
 * ghi file vào public/uploads SAU start → GET 404 (file tại boot → 200).
 *
 * Sau fix (verified fix của finding — preferred option):
 *  - File upload ghi ra NGOÀI public/ (UPLOADS_DIR — data/uploads, volume
 *    riêng trong compose) → static path không đới trước; URL /uploads/<key>
 *    GIỮ NGUYÊN (row ListingImage + ListingImageUpload.storageKey cũ không đổi).
 *  - Route handler này đọc đĩa MỘI request: file mới upload serve được NGAY
 *    không cần restart.
 *  - key regex CHẬT: uuid v4 lowercase hex + extension trong allowlist của
 *    validateImage (jpg|png|webp|gif — đúng LISTING_IMAGE_URL_PATTERN của
 *    src/lib/listing-images.ts, bao gồm cả key pre-Batch-4 `<uuid>.<ext>` của
 *    route upload cũ) → path traversal/extension lạ 404 SẰN, KHÔNG bao giờ
 *    chạm path.join với input ngoài allowlist.
 *  - Headers (spec §7.5 — như next.config.ts đã pin): Content-Type từ
 *    extension ĐÃ validate (KHÔNG sniff), nosniff, CSP default-src 'none';
 *    sandbox (chặn mọi thực thi/nhúng — polyglot đã bị re-encode neutralize
 *    ở tầng upload, đây là lớp hai cho file pre-Batch-4 còn trên đĩa),
 *    Cache-Control immutable (key là uuid ngẫu nhiên — không bao giờ ghi đè).
 *  - Stream từ FileHandle (open → fstat → handle.createReadStream()): KHÔNG
 *    readFile cả file vào bộ nhớ, KHÔNG TOCTOU giữa stat và open. FileHandle
 *    SỞ HỮU fd — stream end/destroy/error tự close handle (b4-holistic
 *    round-4 HIGH: raw fd + autoClose để GC đóng fd đã tái sử dụng → EBADF).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Key hợp lệ — uuid v4 lowercase hex + extension allowlist (khớp pattern upload). */
const UPLOAD_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

/** Content-Type từ extension ĐÃ validate — không sniff, không tin file. */
const UPLOAD_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const notFound = (): Response =>
  new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });

export async function GET(
  _request: Request,
  ctx: RouteContext<"/uploads/[key]">,
): Promise<Response> {
  const { key } = await ctx.params;
  // Regex chặt TRƯỚC khi chạm path — key lạ (traversal, extension khác, hoa)
  // không bao giờ tới filesystem.
  if (typeof key !== "string" || !UPLOAD_KEY_RE.test(key)) return notFound();
  const ext = key.slice(key.lastIndexOf(".") + 1) as keyof typeof UPLOAD_CONTENT_TYPE;

  const filePath = path.join(UPLOADS_DIR, key);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch {
    return notFound(); // ENOENT/ENOTDIR — file chưa upload / đã dọn
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      // directory/đường dẫn lạ → 404 — CLOSE handle trước khi rời route
      // (b4-holistic round-4 HIGH: mọi path không stream đều phải close,
      // không chờ GC).
      await handle.close().catch(() => {});
      return notFound();
    }
    // Stream từ FileHandle — b4-holistic round-4 (HIGH regression): FileHandle
    // SỞ HỮU fd (handle.createReadStream() đóng handle khi stream end/destroy/
    // error — kể cả client abort giữa chừng). Trước fix: truyền RAW fd number
    // của handle vào createReadStream kèm autoClose — stream tự đóng fd trong
    // khi FileHandle vẫn "sở hữu" fd đó và KHÔNG BAO GIỜ được close → GC sau
    // này đóng lại fd đã bị kernel TÁI SỬ DỤNG (socket DB, file upload khác)
    // → cắt connection/hỏng ghi/EBADF; Node ≥24 còn throw ERR_INVALID_STATE
    // "closed during garbage collection" crash cả process (đã reproduce:
    // tests/unit/uploads-serve-route.test.ts gc leak test).
    // Vẫn KHÔNG readFile cả file vào bộ nhớ, KHÔNG TOCTOU stat↔open.
    const nodeStream = handle.createReadStream();
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": UPLOAD_CONTENT_TYPE[ext] ?? "application/octet-stream",
        "Content-Length": String(st.size),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // Key là uuid ngẫu nhiên sinh server-side — nội dung không bao giờ
        // đổi sau khi upload → immutable an toàn (spec §7.5).
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    await handle.close().catch(() => {});
    captureError("uploads.serve", e, { key }); // meta chỉ key (uuid server-side)
    return notFound();
  }
}
