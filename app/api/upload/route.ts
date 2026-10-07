import { randomUUID } from "node:crypto";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { getCurrentUser, type SessionUser } from "@/src/lib/auth";
import { checkRateLimit, rateLimitRequest, tooManyRequestsResponse } from "@/src/lib/rate-limit";
import { validateImage } from "@/src/lib/image-validate";
import {
  IMAGE_MAX_BYTES,
  reencodeImage,
  reencodeQueueHasCapacity,
} from "@/src/lib/image-process";
import { isUserSuspended } from "@/src/lib/moderation";
import { db } from "@/src/prisma/db.client";
import { captureError } from "@/src/lib/observability";
import { UPLOADS_DIR } from "@/src/lib/uploads-storage";

/**
 * Upload ảnh bậc tự quản (lưu vào public/uploads) — Batch 4 Task 3 hardening
 * (spec §5.6.4/§7.5):
 * - early Content-Length reject (413) TRƯỚC khi buffer body; KHÔNG Content-Length
 *   (chunked/stream) → 411 (L1 — không có precheck thì formData() buffer vô hạn
 *   body không khai dài; nginx client_max_body_size 10M — docs/deployment.md §3
 *   — là defense-in-depth ở layer proxy trước khi request tới đây);
 * - rate limit IP (hiện có) + rate limit PER-USER ≤ per-IP (§7.1) — per-user
 *   SAU các check rẻ (b4-holistic round-3: busy/in-progress/quota không tốn
 *   token user);
 * - user đang bị đình chỉ (Batch 3 isUserSuspended — đọc FRESH từ DB) →
 *   403 ACCOUNT_SUSPENDED (L4);
 * - b4-holistic round-3 (LOW): per-user storage quota 24h (UPLOAD_DAILY_MAX)
 *   → 429 UPLOAD_QUOTA — một account không fill được đĩa Postgres đang chia sẻ;
 * - H1 (review fix 2 — bound bộ nhớ body-buffer + hàng chờ re-encode):
 *   (a) hàng chờ re-encode BOUNDED (REENCODE_MAX_QUEUE — image-process.ts):
 *       đầy → TOO_BUSY NGAY, không cho 20 request xếp hàng giữ ~300MB buffer;
 *   (b) capacity pre-check (reencodeQueueHasCapacity) TRƯỚC formData()/
 *       arrayBuffer — server bận từ chối KHÔNG đọc body (~10-15MB/request);
 *       pre-check chỉ là early-exit, cap thật vẫn do acquireReencodeSlot
 *       enforce bên trong reencodeImage (TOCTOU giữa 2 điểm chấp nhận được);
 *   (c) tối đa MỘT upload in-flight mỗi user (in-process Set — topology 1
 *       instance như rate-limit.ts): request thứ 2 cùng user → 429 typed
 *       UPLOAD_IN_PROGRESS, slot trả trong finally trên MỌI path;
 * - multipart hỏng → 400 INVALID_BODY (L3 — KHÔNG để exception formData leak
 *   thành 500);
 * - magic bytes + sharp decode + caps (validateImage — caps 50MP/12k px từ
 *   image-process.ts, nguồn duy nhất);
 * - RE-ENCODE WebP qua sharp: decode→pixels→encode strip TOÀN BỘ metadata
 *   (EXIF/GPS), auto-orient trước strip, resize-bounded — file ghi ra là
 *   buffer ĐÃ re-encode, KHÔNG BAO GIỜ buffer gốc (Review Focus 1);
 * - semaphore decode-memory bound (M1 — image-process.ts): re-encode bận quá
 *   (hàng đầy/hết chờ hàng) → 503 TOO_BUSY + Retry-After, KHÔNG ghi file/row;
 * - storageKey random UUID + ".webp" (không dùng tên file client); row
 *   ListingImageUpload (ownership) ghi TRƯỚC file — row mồ côi vô hại
 *   (storageKey unique, không có file), FILE mồ côi public-reachable không
 *   owner mới là vấn đề; writeFile fail → unlink file partial best-effort
 *   (L2 — lỗi unlink đi qua captureError, KHÔNG nuốt im lặng) + xoá row
 *   best-effort + 500.
 * Response shape { url } GIỮ NGUYÊN — ImagePicker giữ hoạt động.
 * Production: thay bằng Cloudinary / S3 (ownership table đã trừu tượng hóa).
 */

/** Dư lượng cho multipart envelope ngoài phần file (~512KB) — ngưỡng Content-Length sớm */
const CONTENT_LENGTH_GRACE = 512 * 1024;

/**
 * H1c — tối đa MỘT upload đang xử lý mỗi user (in-process Set, keyed theo
 * user id — cùng topology 1-instance với rate-limit.ts). Check+add đồng bộ
 * (không await giữa hai lệnh) nên không race; delete trong finally của POST
 * nên MỌI path (kể cả throw) đều trả slot.
 */
const uploadsInFlightByUser = new Set<string>();

/**
 * b4-holistic round-3 (LOW — capacity pre-check không bound memory): số
 * request đang GIỮ body (đã qua các check, sắp/sđang buffer formData +
 * Buffer copy ~11-15MB) — process-wide, đếm chung ngân sách với slot +
 * hàng chờ re-encode (reencodeQueueHasCapacity(extraBodies)). Tăng đồng bộ
 * ngay sau per-user Set add (không await giữa hai lệnh), giảm trong finally.
 */
let uploadBodiesInFlight = 0;

/**
 * b4-holistic round-3 (LOW — per-user storage quota): cap số upload MỖI USER
 * mỗi 24h (rolling, đếm ListingImageUpload theo @@index([ownerUserId,
 * createdAt])). Trước fix: throttle duy nhất là 20/10 phút — 2.8MB webp ×
 * 2880 upload/ngày ≈ 8GB/ngày/user làm đầy đĩa Postgres đang CHIA SẺ
 * (ENOSPC → toàn marketplace sập, không chỉ upload). 60 ≈ 3× cap ảnh một
 * tin × vài tin — đủ cho seller beta hoạt động bình thường. POLICY: số này
 * là quyết định sản phẩm — ghi nhận cùng A8 (retention) trong register.
 */
const UPLOAD_DAILY_MAX = 60;

export async function POST(request: Request) {
  // 0. Early body reject — KHÔNG buffer body quá lớn (spec §7.5 encoded-size limit)
  //    L1: Content-Length là BẮT BUỘC — HTTP framing đảm bảo server chỉ đọc đúng
  //    số byte đã khai (body dài hơn bị cắt, ngắn hơn → formData fail), nên
  //    precheck theo header là sound; thiếu header (chunked/stream) → 411.
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader === null) {
    return Response.json({ error: "CONTENT_LENGTH_REQUIRED" }, { status: 411 });
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isInteger(contentLength) || contentLength < 0) {
    return Response.json({ error: "INVALID_CONTENT_LENGTH" }, { status: 400 });
  }
  if (contentLength > IMAGE_MAX_BYTES + CONTENT_LENGTH_GRACE) {
    return Response.json({ error: "Ảnh tối đa 5MB" }, { status: 413 });
  }

  // 1. Rate limit IP (hiện có) — flood guard CHƯA đăng nhập, giữ ĐẦU TIÊN
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

  // 3. L4 — suspended user không được upload (Batch 3 isUserSuspended: episode
  //    active đọc FRESH từ DB mỗi request; lifted không chặn). Chặn TRƯỚC khi
  //    buffer file — không ghi file/row cho user bị đình chỉ.
  if (await isUserSuspended(user.id)) {
    return Response.json({ error: "ACCOUNT_SUSPENDED" }, { status: 403 });
  }

  // 3b. b4-holistic round-3 (LOW — per-user storage quota): đếm upload 24h của
  //     user (ListingImageUpload theo @@index([ownerUserId, createdAt]) —
  //     rẻ). Vượt cap → 429 typed, KHÔNG đọc body, KHÔNG ghi file/row. Đặt
  //     TRƯỚC per-user rate limit để bị từ chối vì quota KHÔNG tốn token
  //     20/10 phút của user (giữ budget cho lần thử hợp lệ ngày mai).
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const quota = await db.orm.public.ListingImageUpload
    .where({ ownerUserId: user.id })
    .where((u) => u.createdAt.gt(dayAgoIso))
    .aggregate((a) => ({ c: a.count() }));
  if (quota.c >= UPLOAD_DAILY_MAX) {
    return Response.json(
      { error: "UPLOAD_QUOTA", message: `Bạn đã tải tối đa ${UPLOAD_DAILY_MAX} ảnh trong 24 giờ.` },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  // 4. H1b — capacity pre-check TRƯỚC formData()/arrayBuffer: server đang bận
  //    (slot + hàng chờ re-encode + body đang giữ đầy) → 503 NGAY, KHÔNG đọc
  //    body. Mỗi request nếu đi tiếp sẽ buffer ~10-15MB (formData + Buffer
  //    copy) trước khi tới lượt acquire — từ chối sớm ở đây là tầng chặn OOM
  //    thật sự. Pre-check chỉ là early-exit: cap vẫn do acquireReencodeSlot
  //    enforce (bên dưới). extraBodies = uploadBodiesInFlight (đếm process-wide
  //    — N user đồng thời không còn cùng pass pre-check rồi buffer hết body).
  if (!reencodeQueueHasCapacity(uploadBodiesInFlight)) {
    return Response.json(
      { error: "TOO_BUSY" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }

  // 5. H1c — tối đa 1 upload in-flight mỗi user: has+add đồng bộ (không await
  //    giữa hai lệnh) nên 2 request song song không lọt cả hai; slot trả trong
  //    finally bên dưới trên MỌI path (kể cả throw bên trong ingestUpload).
  //    b4-holistic round-3: các check RẺ (suspension/quota/capacity/in-flight)
  //    chạy TRƯỚC per-user rate limit — bị từ chối vì busy/in-progress là
  //    kết quả BÌNH THƯỜNG của form 8 picker (client serialize + retry), không
  //    nên tốn 20/10 phút budget của user (trước fix: retry qua lúc bận →
  //    RATE_LIMITED 10 phút mà chưa lưu được ảnh nào).
  if (uploadsInFlightByUser.has(user.id)) {
    return Response.json(
      { error: "UPLOAD_IN_PROGRESS" },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  }
  uploadsInFlightByUser.add(user.id);
  // Body counter tăng ĐỒNG BỘ ngay sau Set add (không await giữa hai lệnh) —
  // mọi request có thể buffer body đếm chung ngân sách capacity (bước 4);
  // giảm trong finally cùng slot per-user.
  uploadBodiesInFlight++;
  try {
    // 6. Per-USER limit ≤ per-IP (§7.1) — một user không vượt được bucket IP
    //    của chính mình. SAU các check rẻ ở trên: request bị từ chối vì
    //    busy/in-progress/quota KHÔNG tốn token user (chỉ request thực sự
    //    đọc body mới vào bucket).
    const userLimit = checkRateLimit(`upload:user:${user.id}`, {
      limit: 20,
      windowMs: 10 * 60_000,
    });
    if (!userLimit.allowed) {
      return tooManyRequestsResponse(userLimit.retryAfterSec);
    }
    return await ingestUpload(request, user);
  } finally {
    uploadBodiesInFlight--;
    uploadsInFlightByUser.delete(user.id);
  }
}

/**
 * Body processing (formData → validate → re-encode → row → file → response) —
 * chạy trong slot in-flight per-user (H1c). Mọi return path KHÔNG ghi gì khi
 * thất bại; mọi throw được caller bắt (finally vẫn trả slot).
 */
async function ingestUpload(request: Request, user: SessionUser): Promise<Response> {
  // 7. Parse multipart — L3: multipart hỏng là LỖI NGƯỜI DÙNG (400 typed),
  //    không phải 500; KHÔNG buffer gì trước bước này.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e) {
    captureError("upload", e, { userId: user.id });
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Thiếu file" }, { status: 400 });
  }

  // 8. file.size TRƯỚC khi buffer
  if (file.size > IMAGE_MAX_BYTES) {
    return Response.json({ error: "Ảnh tối đa 5MB" }, { status: 400 });
  }

  // 9. Magic bytes + sharp decode + caps (50MP/12k px — Batch 4)
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

  // 10. Re-encode WebP — strip EXIF/GPS, auto-orient, resize-bounded (fail → KHÔNG lưu file)
  //     M1a: semaphore đầy (hàng đầy H1/hết chờ hàng) → 503 typed — client retry
  //     sau, KHÔNG ghi file/row, KHÔNG treo request.
  const out = await reencodeImage(buf);
  if (!out.ok) {
    if (out.reason === "TOO_BUSY") {
      return Response.json(
        { error: "TOO_BUSY" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    captureError("upload", new Error(`image re-encode rejected: ${out.reason}`), {
      userId: user.id,
    });
    return Response.json(
      { error: "Không xử lý được ảnh (chỉ JPEG / PNG / WebP / GIF)" },
      { status: 400 },
    );
  }

  // 11. ROW FIRST — storageKey random dùng cho CẢ row lẫn file (tạo trước cả hai)
  //     b4-holistic round-3 HIGH: dir NGOÀI public/ (UPLOADS_DIR — data/uploads,
  //     volume riêng trong compose) — Next production chỉ serve file public/
  //     TỒN TẠI KHI START; serving đi qua app/uploads/[key] (đọc đĩa mỗi request).
  const storageKey = `${randomUUID()}.webp`;
  const dir = UPLOADS_DIR;
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

  // 12. Ghi buffer ĐÃ re-encode — KHÔNG BAO GIỜ buffer gốc (Review Focus 1)
  try {
    await writeFile(path.join(dir, storageKey), out.buffer);
  } catch (e) {
    // L2: writeFile có thể đã ghi MỘT PHẦN file (ENOSPC/EIO giữa chừng) —
    // file partial public-reachable không owner là vấn đề → unlink best-effort
    // (không chặn response). Lỗi unlink KHÔNG được nuốt im lặng (review fix 2):
    // capture qua captureError — meta chỉ storageKey (UUID sinh server-side,
    // không path/PII người dùng).
    unlink(path.join(dir, storageKey)).catch((unlinkErr) => {
      captureError("upload", unlinkErr, { userId: user.id, storageKey });
    });
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

  // 13. Response shape { url } giữ nguyên — ImagePicker giữ hoạt động
  return Response.json({ url: `/uploads/${storageKey}` });
}
