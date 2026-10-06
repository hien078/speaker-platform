import "server-only";
import sharp from "sharp";
import { IMAGE_MAX_DIM, IMAGE_MAX_PIXELS } from "@/src/lib/image-process";

/**
 * Validate ảnh upload — KHÔNG tin MIME do client khai báo:
 * 1. Magic bytes phải khớp định dạng khai báo (chống spoof MIME).
 * 2. sharp decode header thật — định dạng + kích thước phải hợp lệ
 *    (chống SVG/script payload, chống file cắt cụt).
 * 3. Cap kích thước + số pixel — chống resource exhaustion lúc render.
 * SVG không bao giờ cho phép (script payload chạy trong <img> trên vài browser cũ).
 *
 * Batch 4 Task 3: caps (50MP / 12k px — siết từ 40MP / 10k) chuyển về
 * src/lib/image-process.ts làm NGUỒN DUY NHẤT — re-encode pipeline dùng
 * chung cùng bộ cap, không định nghĩa lại ở đây.
 */

const MAGIC: { mime: string; ext: string; bytes: number[] }[] = [
  { mime: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", ext: "gif", bytes: [0x47, 0x49, 0x46, 0x38] }, // "GIF8" (7a/9a)
  { mime: "image/webp", ext: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" + bytes 8..11 == "WEBP"
];

export type ImageValidation =
  | { ok: true; ext: string; width: number; height: number }
  | { ok: false; reason: string };

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function sharpFormat(mime: string): string {
  switch (mime) {
    case "image/jpeg": return "jpeg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "";
  }
}

export async function validateImage(
  buf: Buffer,
  declaredMime: string,
  maxBytes: number,
): Promise<ImageValidation> {
  if (!buf || buf.length === 0) return { ok: false, reason: "EMPTY" };
  if (buf.length > maxBytes) return { ok: false, reason: "TOO_LARGE" };

  const entry = MAGIC.find((m) => m.mime === declaredMime);
  if (!entry) return { ok: false, reason: "MIME_NOT_ALLOWED" };
  if (!startsWith(buf, entry.bytes)) return { ok: false, reason: "MAGIC_MISMATCH" };
  if (declaredMime === "image/webp" && buf.toString("ascii", 8, 12) !== "WEBP") {
    return { ok: false, reason: "MAGIC_MISMATCH" };
  }

  try {
    const meta = await sharp(buf).metadata();
    if (meta.format !== sharpFormat(declaredMime)) {
      return { ok: false, reason: "FORMAT_MISMATCH" };
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 1 || height < 1) return { ok: false, reason: "BAD_DIMENSIONS" };
    if (width > IMAGE_MAX_DIM || height > IMAGE_MAX_DIM) {
      return { ok: false, reason: "TOO_LARGE_DIMENSIONS" };
    }
    if (width * height > IMAGE_MAX_PIXELS) return { ok: false, reason: "TOO_MANY_PIXELS" };
    return { ok: true, ext: entry.ext, width, height };
  } catch {
    return { ok: false, reason: "DECODE_FAILED" };
  }
}
