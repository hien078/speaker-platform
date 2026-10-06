import "server-only";
import sharp from "sharp";

/**
 * Re-encode ảnh upload — Batch 4 Task 3 (spec §5.6.4/§7.5 "safe re-encoding
 * where practical" + metadata/GPS strip).
 *
 * Pipeline decode→pixels→encode qua sharp (libvips — validator đã có của repo
 * ở src/lib/image-validate.ts, KHÔNG parser EXIF tự viết, KHÔNG sniff tự chế):
 * - KHÔNG bao giờ gọi withMetadata() → output KHÔNG mang EXIF/GPS nào (re-encode
 *   là strip toàn bộ metadata trong một bước, đồng thời vô hiệu hóa payload
 *   polyglot ghim sau file);
 * - .rotate() auto-orient THEO EXIF TRƯỚC khi strip — không thì ảnh xoay ngang;
 * - resize bounded TRƯỚC encode → output không phình vô hạn;
 * - pages: 1 → GIF animated lấy frame đầu (static);
 * - limitInputPixels + failOn: "error" → decompression bomb fail closed.
 *
 * Caps (hằng số xuất, nguồn duy nhất — image-validate.ts consume lại):
 * - 50MP/12k px siết-tăng từ 40MP/10k: admitting cảm biến 48MP của điện thoại
 *   (phổ biến nhất) trong khi bound worst-case decode ≈ 200MB RGBA transient
 *   (bounded thêm bởi rate limit + topology single-instance); mode 108/200MP
 *   bị từ chối — người dùng downscale (hiếm cho ảnh sản phẩm). Cap cũ 40MP chặn
 *   cả 48MP.
 */

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB encoded — giữ nguyên limit hiện tại
export const IMAGE_MAX_DIM = 12_000; // px/cạnh — siết từ 10.000 (hiện tại): đủ cho 50MP 4:3 (8165×6124) và 16:9 (9430×5303)
export const IMAGE_MAX_PIXELS = 50_000_000; // 50MP — siết-tăng từ 40MP (hiện tại)
export const IMAGE_OUTPUT_MAX_BYTES = 5 * 1024 * 1024; // cap kích thước SAU re-encode
export const IMAGE_RESIZE_MAX = { width: 2560, height: 2560 }; // resize TRƯỚC encode — output bounded, OUTPUT_TOO_LARGE chỉ cho input bệnh thái

export type ReencodeResult =
  | { ok: true; buffer: Buffer; width: number; height: number }
  | { ok: false; reason: "DECODE_FAILED" | "REENCODE_FAILED" | "OUTPUT_TOO_LARGE" };

/** Options sharp chung cho mọi lần decode input (verbatim theo plan Task 3). */
const DECODE_OPTS = {
  limitInputPixels: IMAGE_MAX_PIXELS,
  pages: 1,
  failOn: "error",
} as const;

/**
 * Re-encode buffer ảnh bất kỳ (đã qua validateImage) → WebP sạch metadata.
 * Fail closed: mọi lỗi decode/encode → { ok: false } — caller KHÔNG bao giờ
 * được ghi file khi kết quả không ok.
 */
export async function reencodeImage(buf: Buffer): Promise<ReencodeResult> {
  if (!buf || buf.length === 0) return { ok: false, reason: "DECODE_FAILED" };

  try {
    // Bước 1 — decode header: magic sai / file cắt cụt / vượt pixel cap fail ở đây.
    await sharp(buf, DECODE_OPTS).metadata();
  } catch {
    return { ok: false, reason: "DECODE_FAILED" };
  }

  try {
    // Bước 2 — decode→pixels→encode. .rotate() auto-orient theo EXIF TRƯỚC khi
    // strip; .webp() re-encode nên metadata (EXIF/GPS) KHÔNG được ghi lại —
    // withMetadata() KHÔNG bao giờ được gọi ở pipeline này (Task 9 scan pin).
    const out = await sharp(buf, DECODE_OPTS)
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
}
