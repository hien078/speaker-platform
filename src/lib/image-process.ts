import "server-only";
import sharp from "sharp";
import type { Metadata as SharpMetadata } from "sharp";

/**
 * Re-encode ảnh upload — Batch 4 Task 3 (spec §5.6.4/§7.5 "safe re-encoding
 * where practical" + metadata/GPS strip).
 *
 * Pipeline decode→pixels→encode qua sharp (libvips — validator đã có của repo
 * ở src/lib/image-validate.ts, KHÔNG parser EXIF tự viết, KHÔNG sniff tự chế):
 * - KHÔNG bao giờ gọi withMetadata() → output KHÔNG mang EXIF/GPS/ICC/XMP nào
 *   (re-encode là strip toàn bộ metadata trong một bước, đồng thời vô hiệu hóa
 *   payload polyglot ghim sau file);
 * - .rotate() auto-orient THEO EXIF TRƯỚC khi strip — không thì ảnh xoay ngang;
 * - resize bounded TRƯỚC encode → output không phình vô hạn;
 * - pages: 1 → GIF/WebP animated lấy frame ĐẦU (static);
 * - limitInputPixels (cap theo định dạng — xem dưới) + failOn: "error" →
 *   decompression bomb fail closed.
 *
 * ─── Decode-memory bound (M1 — review fix, THAY giả định sai của cap cũ) ────
 *
 * Giả định cũ "50MP ≈ 200MB RGBA transient bounded bởi rate limit" là SAI:
 * sharp KHÔNG shrink-on-load — bộ nhớ decode theo ĐỊNH DẠNG chứ không theo cap
 * encoded: PNG interlaced (Adam7) / 16-bit và GIF frame ở 50MP decode tới
 * 200-400MB MỖI LẦN (file solid-colour nén xa dưới cap 5MB encoded), JPEG
 * progressive ~150MB; libuv threadpool mặc định 4 thread → 4 upload song song
 * từ một account ≈ 0.8-1.6GB trên host 1-2GB chung Postgres → OOM. Ba lớp chặn
 * (cộng mem_limit container — docker-compose.prod.yml):
 *
 * (M1a) SEMAPHORE process-wide quanh reencodeImage — tối đa
 *       REENCODE_MAX_CONCURRENT re-encode đồng thời; request thừa XẾP HÀNG chờ
 *       bounded (REENCODE_MAX_QUEUE — H1 review fix 2: đầy → reject NGAY,
 *       không cho 20 waiter giữ ~300MB buffer) trong REENCODE_QUEUE_TIMEOUT_MS
 *       → TOO_BUSY (route → 503 typed) — không bao giờ treo request, không
 *       bao giờ decode song song vô hạn, không bao giờ xếp hàng vô hạn.
 * (M1b) PIXEL CAP THEO ĐỊNH DẠNG — metadata() đọc TRƯỚC khi decode pixels,
 *       cap áp theo format/depth/interlace (recorded choice):
 *        - JPEG: giữ 50MP (IMAGE_MAX_PIXELS) — admitting cảm biến 48MP phone;
 *          progressive JPEG ~150MB transient đã bounded bởi M1a (1 lần);
 *        - PNG/GIF/WebP 8-bit: 24MP (IMAGE_NON_JPEG_MAX_PIXELS) — decode
 *          24MP×4 kênh ≈ 96MB;
 *        - interlaced (isProgressive — Adam7 PNG) HOẶC depth > 8 bit
 *          (depth !== "uchar" — "ushort" = 16-bit PNG; HOẶC bitsPerSample > 8
 *          — L1 review fix 2): 12MP (IMAGE_HEAVY_DECODE_MAX_PIXELS) — decode
 *          ~2× bộ nhớ/pixel; THIẾC signal depth hoàn toàn → fail-closed 12MP;
 *        - định dạng lạ (đã bị validateImage chặn — defensive): 12MP.
 * (M1c) sharp.cache(false) + sharp.concurrency(1) — tắt libvips pixel cache
 *       (mặc định giữ memory theo thread) + threadpool 1 thread process-wide.
 *
 * Caps (hằng số xuất, nguồn duy nhất — image-validate.ts consume lại):
 * IMAGE_MAX_PIXELS là cap TỔNG (header decode); cap theo định dạng chỉ áp
 * ở tầng NÀY (re-encode), không áp ở validateImage (đó là sanity check tổng).
 */

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB encoded — giữ nguyên limit hiện tại
export const IMAGE_MAX_DIM = 12_000; // px/cạnh — đủ cho 50MP 4:3 (8165×6124) và 16:9 (9430×5303)
export const IMAGE_MAX_PIXELS = 50_000_000; // 50MP — cap TỔNG (JPEG giữ nguyên — recorded choice M1b)
export const IMAGE_NON_JPEG_MAX_PIXELS = 24_000_000; // PNG/GIF/WebP 8-bit — decode ≈ 96MB (M1b)
export const IMAGE_HEAVY_DECODE_MAX_PIXELS = 12_000_000; // interlaced / >8-bit — decode ~2×/pixel (M1b)
export const IMAGE_OUTPUT_MAX_BYTES = 5 * 1024 * 1024; // cap kích thước SAU re-encode
export const IMAGE_RESIZE_MAX = { width: 2560, height: 2560 }; // resize TRƯỚC encode — output bounded, OUTPUT_TOO_LARGE chỉ cho input bệnh thái

// ─── M1a — semaphore process-wide quanh re-encode ────────────────────────────

/** Tối đa 1 re-encode đồng thời (recorded choice — host 1-2GB chung Postgres). */
export const REENCODE_MAX_CONCURRENT = 1;
/**
 * Hàng chờ tối đa REENCODE_MAX_QUEUE request (H1 — review fix 2): đầy → reject
 * NGAY (route → 503 TOO_BUSY). KHÔNG cho xếp hàng vô hạn — mỗi waiter đang
 * giữ body đã buffer (~10-15MB formData + Buffer copy), 20 waiter = ~300MB
 * treo trong bộ nhớ vượt mem_limit 768m.
 */
export const REENCODE_MAX_QUEUE = 2;
/** Chờ tối đa 15s trong hàng trước khi TOO_BUSY (route → 503) — 50MP decode ~2-5s. */
export const REENCODE_QUEUE_TIMEOUT_MS = 15_000;

let reencodeInFlight = 0;
type ReencodeWaiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> };
const reencodeWaiters: ReencodeWaiter[] = [];

/**
 * Lấy slot semaphore (internal — test/ops hook, KHÔNG dùng cho logic app).
 * Resolve ngay khi có chỗ; hàng chờ đầy (REENCODE_MAX_QUEUE) → reject NGAY
 * REENCODE_QUEUE_FULL (caller map sang TOO_BUSY); hết `timeoutMs` mà vẫn xếp
 * hàng → reject REENCODE_QUEUE_TIMEOUT (caller map sang TOO_BUSY). FIFO:
 * release() handoff slot TRỰC TIẾP cho waiter đầu tiên (không đếm đôi).
 */
export async function acquireReencodeSlot(timeoutMs: number): Promise<void> {
  if (reencodeInFlight < REENCODE_MAX_CONCURRENT) {
    reencodeInFlight++;
    return;
  }
  // H1 — hàng chờ BOUNDED: đầy thì reject ngay, không cho request thừa xếp hàng
  // giữ buffer chờ trong bộ nhớ (TOCTOU với reencodeQueueHasCapacity của route
  // là chấp nhận được — đây là nơi enforce cap THẬT).
  if (reencodeWaiters.length >= REENCODE_MAX_QUEUE) {
    throw new Error("REENCODE_QUEUE_FULL");
  }
  await new Promise<void>((resolve, reject) => {
    const entry: ReencodeWaiter = {
      resolve,
      timer: setTimeout(() => {
        const i = reencodeWaiters.indexOf(entry);
        if (i >= 0) reencodeWaiters.splice(i, 1);
        reject(new Error("REENCODE_QUEUE_TIMEOUT"));
      }, timeoutMs),
    };
    reencodeWaiters.push(entry);
  });
}

/** Trả slot — handoff FIFO cho waiter kế tiếp (nếu có), ngược lại giảm đếm. */
export function releaseReencodeSlot(): void {
  const next = reencodeWaiters.shift();
  if (next !== undefined) {
    clearTimeout(next.timer);
    next.resolve(); // slot chuyển giao trực tiếp — reencodeInFlight KHÔNG đổi
    return;
  }
  reencodeInFlight = Math.max(0, reencodeInFlight - 1);
}

/**
 * Check sức chứa RẺ (H1b — route gọi TRƯỚC formData()/arrayBuffer): true khi
 * acquire sẽ (a) lấy slot NGAY hoặc (b) còn chỗ xếp hàng. CHỈ là early-exit
 * cho route từ chối KHÔNG đọc body (~10-15MB/request) khi server bận —
 * bản thân acquireReencodeSlot vẫn enforce cap (pre-check không thay thế).
 *
 * b4-holistic round-3 (LOW — capacity pre-check không bound memory): N user
 * đồng thời đều pass pre-check rồi MỚI buffer body (~11-15MB mỗi request:
 * formData + Buffer copy + sharp metadata NGOÀI semaphore) → peak ~15MB × N
 * ngoài budget 768m; ~30 uploader đồng thời OOM-kill container. `extraBodies`
 * = số request ĐANG giữ body (upload route đếm process-wide, tăng đồng bộ
 * với per-user Set add, giảm trong finally) — cap chung một ngân sách:
 * slot + hàng chờ + body đang giữ < CONCURRENT + QUEUE. Đếm đôi (request
 * trong reencodeImage đếm cả body lẫn slot) là conservative — từ chối sớm
 * hơn, an toàn hướng còn lại.
 */
export function reencodeQueueHasCapacity(extraBodies = 0): boolean {
  return (
    reencodeInFlight + reencodeWaiters.length + extraBodies <
    REENCODE_MAX_CONCURRENT + REENCODE_MAX_QUEUE
  );
}

// ─── M1c — sharp process-wide: tắt pixel cache + threadpool 1 thread ─────────

// Chạy MỘT LẦN khi module load (mọi import của route/validator đều qua đây).
// sharp.cache mặc định giữ memory theo thread (unbounded decode cache);
// concurrency mặc định = số core (4) → 4 decode song song. Cả hai bị tắt/thu
// về 1 để M1a là giới hạn THẬT (semaphore 1 mà threadpool 4 thì vô nghĩa).
sharp.cache(false);
sharp.concurrency(1);

// ─── Re-encode pipeline ────────────────────────────────────────────────────────

export type ReencodeResult =
  | { ok: true; buffer: Buffer; width: number; height: number }
  | {
      ok: false;
      reason:
        | "DECODE_FAILED"
        | "REENCODE_FAILED"
        | "OUTPUT_TOO_LARGE"
        | "TOO_MANY_PIXELS"
        | "TOO_BUSY";
    };

/** Options sharp chung cho mọi lần decode input (verbatim theo plan Task 3). */
const DECODE_OPTS = {
  limitInputPixels: IMAGE_MAX_PIXELS,
  pages: 1,
  failOn: "error",
} as const;

/**
 * Pixel cap theo định dạng (M1b — recorded choice, xem header module; L1 review
 * fix 2: depth signal). Internal — test hook như acquire/release, KHÔNG dùng
 * cho logic app.
 *
 * (Structural type — chỉ các trường metadata pipeline đọc, tránh phụ thuộc
 * namespace type của sharp.)
 */
export function pixelCapFor(meta: {
  format?: string | undefined;
  isProgressive?: boolean | undefined;
  bitsPerSample?: number | undefined;
  depth?: string | undefined;
}): number {
  if (meta.format === "jpeg") return IMAGE_MAX_PIXELS;
  // L1: >8-bit theo CẢ depth (libvips band format — "ushort" = 16-bit,
  // "float" = 32-bit) LẪN bitsPerSample; depth non-"uchar" THẮNG dù
  // bitsPerSample khai ≤8. THIẾC cả hai signal → fail-closed 12MP
  // (KHÔNG mặc định 8-bit khi không biết — sharp 0.35 luôn báo depth cho
  // jpeg/png/gif/webp nên đường fail-closed chỉ chặn định dạng lạ).
  const hasDepthSignal = meta.depth !== undefined || meta.bitsPerSample !== undefined;
  const over8Bit =
    (meta.depth !== undefined && meta.depth !== "uchar") ||
    (meta.bitsPerSample !== undefined && meta.bitsPerSample > 8);
  const heavy =
    meta.isProgressive === true ||
    meta.format === undefined ||
    !hasDepthSignal ||
    over8Bit;
  if (heavy) return IMAGE_HEAVY_DECODE_MAX_PIXELS;
  return IMAGE_NON_JPEG_MAX_PIXELS;
}

/**
 * Re-encode buffer ảnh bất kỳ (đã qua validateImage) → WebP sạch metadata.
 * Fail closed: mọi lỗi decode/encode → { ok: false } — caller KHÔNG bao giờ
 * được ghi file khi kết quả không ok.
 *
 * `opts.queueTimeoutMs` (test hook): override thời gian chờ semaphore —
 * production luôn dùng REENCODE_QUEUE_TIMEOUT_MS.
 */
export async function reencodeImage(
  buf: Buffer,
  opts?: { queueTimeoutMs?: number },
): Promise<ReencodeResult> {
  if (!buf || buf.length === 0) return { ok: false, reason: "DECODE_FAILED" };

  // M1a — slot semaphore TRƯỚC mọi decode (kể cả header): hàng đầy (H1) hoặc
  // hết chờ → TOO_BUSY (cả REENCODE_QUEUE_FULL lẫn REENCODE_QUEUE_TIMEOUT).
  try {
    await acquireReencodeSlot(opts?.queueTimeoutMs ?? REENCODE_QUEUE_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: "TOO_BUSY" };
  }

  try {
    // Bước 1 — decode header: magic sai / file cắt cụt / vượt cap TỔNG fail ở đây.
    let meta: SharpMetadata;
    try {
      meta = await sharp(buf, DECODE_OPTS).metadata();
    } catch {
      return { ok: false, reason: "DECODE_FAILED" };
    }

    // Bước 1b (M1b) — cap THEO ĐỊNH DẠNG từ metadata THẬT (trước khi decode
    // pixels): PNG/GIF/WebP 24MP, interlaced/16-bit 12MP, JPEG giữ 50MP.
    const cap = pixelCapFor(meta);
    const pixels = (meta.width ?? 0) * (meta.height ?? 0);
    if (pixels > cap) {
      return { ok: false, reason: "TOO_MANY_PIXELS" };
    }

    // Bước 2 — decode→pixels→encode với cap chặt đã tính (defense-in-depth:
    // limitInputPixels của chính sharp cũng theo cap định dạng, không phải 50MP).
    // .rotate() auto-orient theo EXIF TRƯỚC khi strip; .webp() re-encode nên
    // metadata (EXIF/GPS/ICC/XMP) KHÔNG được ghi lại — withMetadata() KHÔNG bao
    // giờ được gọi ở pipeline này (Task 9 scan pin).
    try {
      const out = await sharp(buf, { ...DECODE_OPTS, limitInputPixels: cap })
        .rotate()
        .resize({ ...IMAGE_RESIZE_MAX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      if (out.data.length > IMAGE_OUTPUT_MAX_BYTES) {
        return { ok: false, reason: "OUTPUT_TOO_LARGE" };
      }
      return { ok: true, buffer: out.data, width: out.info.width, height: out.info.height };
    } catch {
      return { ok: false, reason: "REENCODE_FAILED" };
    }
  } finally {
    releaseReencodeSlot();
  }
}
