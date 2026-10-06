/**
 * Listing image ownership authorization (Batch 4 Task 2 — spec §5.6.4
 * "ownership authorization") — per-URL check THEO THỨ TỰ (B1), Review Focus 4.
 *
 * Server-only domain module (KHÔNG "use server" — không phải action; client
 * component KHÔNG BAO GIỜ import — import db). HÀM CHỈ READ — không write
 * row nào; caller (listing actions — Task 4) gọi TRƯỚC mọi ListingImage write
 * nên url lạ bị chặn trước khi ảnh lưu.
 *
 * Rules per URL (Legacy Migration Decisions — spec §8/§5.6.4):
 *  (1) url khớp LISTING_IMAGE_URL_PATTERN (/uploads/<uuid>.<ext> — storage key
 *      ngẫu nhiên của upload route) → tra ListingImageUpload theo storageKey =
 *      basename(url); row tồn tại → ownerUserId PHẢI = sellerId (sai →
 *      IMAGE_NOT_OWNED — row của user khác chặn KỂ CẢ khi url đã gắn vào listing
 *      này — cross-account image theft). Url phải BẰNG /uploads/<storageKey>
 *      CHÍNH XÁC — pattern gate TRƯỚC lookup nên tra theo basename mà KHÔNG khớp
 *      pattern (vd https://evil/x/<uuid-của-chính-seller>.webp) KHÔNG bao giờ
 *      đi vào rule (1) → IMAGE_URL_INVALID (chống bypass basename).
 *      Row KHÔNG tồn tại (ảnh /uploads/ pre-Batch-4): chỉ giữ khi ĐÃ GẮN vào
 *      listing này (rule 2); detached → IMAGE_NOT_OWNED (re-attach bị chặn —
 *      seller re-upload, re-encode; accepted compat behavior).
 *  (2) không qua rule (1) NHƯNG đã gắn vào listing này (ListingImage row
 *      listingId+url tồn tại) → CHỈ chấp nhận khi url khớp
 *      ATTACHED_IMAGE_PATH_PATTERN (/img|/uploads path sạch) và KHÔNG chứa
 *      ".." (ảnh seed /img/… và ảnh /uploads/ pre-Batch-4 ĐÃ GẮN được giữ
 *      nguyên — B1 compat pin).
 *  (3) còn lại → IMAGE_URL_INVALID — kể cả URL có scheme (http/https/javascript)
 *      đã gắn vào listing (KHÔNG bao giờ tin URL ngoài, kể cả tại approve).
 *
 * Thêm: url trùng lặp → IMAGE_DUPLICATE; imageSlots lệch độ dài (khi có) →
 * IMAGE_SLOT_MISMATCH. Mọi url resolve xong mới trả về — fail trước khi
 * ListingImage write nào của caller chạy.
 */
import "server-only";
import { db } from "@/src/prisma/db.client";

/**
 * URL của ảnh upload MỚI (Batch 4) — /uploads/<uuid>.<ext> với storage key
 * ngẫu nhiên (crypto.randomUUID) sinh bởi upload route (Task 3). Hex thường
 * (uuid v4 lowercase), extension trong allowlist của validateImage.
 */
export const LISTING_IMAGE_URL_PATTERN =
  /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

/**
 * Path ảnh ĐÃ GẮN được giữ (rule 2): /img/… (seed) hoặc /uploads/… (pre-Batch-4)
 * — path tương đối sạch, KHÔNG scheme, KHÔNG traversal (".." bị chặn riêng).
 */
export const ATTACHED_IMAGE_PATH_PATTERN =
  /^\/(img|uploads)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export type ListingImagesOwnershipInput = {
  sellerId: string;
  /** Listing đang sửa (rule 2 cần); undefined khi tạo mới. */
  listingId?: string;
  imageUrls: string[];
  /** Song song imageUrls (zip theo index) — chỉ check ĐỘ DÀI ở đây (giá trị do schema validate). */
  imageSlots?: (string | null)[];
};

/**
 * Kiểm MỌI url trong input thuộc quyền seller — throw typed error với code
 * ĐẦU TIÊN sai. Chỉ READ (không write) — caller gọi trước mọi ListingImage
 * write (mọi url resolve xong mới trả về).
 */
export async function assertListingImagesOwned(
  input: ListingImagesOwnershipInput,
): Promise<void> {
  const { sellerId, listingId, imageUrls, imageSlots } = input;

  // (a) slot length mismatch — pure input shape, chặn trước mọi db read
  if (imageSlots !== undefined && imageSlots.length !== imageUrls.length) {
    throw new Error("IMAGE_SLOT_MISMATCH");
  }

  // (b) url trùng lặp trong input — pure, chặn trước mọi db read
  if (new Set(imageUrls).size !== imageUrls.length) {
    throw new Error("IMAGE_DUPLICATE");
  }

  // (c) tập url đã gắn vào listing này (rule 2) — MỘT read cho cả list
  const attachedUrls = new Set<string>();
  if (listingId !== undefined) {
    const rows = await db.orm.public.ListingImage.where({ listingId }).all();
    for (const row of rows) attachedUrls.add(row.url);
  }

  // (d) per-URL rules theo thứ tự (1) → (2) → (3)
  for (const url of imageUrls) {
    if (LISTING_IMAGE_URL_PATTERN.test(url)) {
      // (1) upload URL — ownership row theo storageKey = basename (pattern đã
      //     đảm bảo url BẰNG /uploads/<basename> — scheme/traversal không vào đây)
      const storageKey = url.slice("/uploads/".length);
      const upload = await db.orm.public.ListingImageUpload.first({ storageKey });
      if (upload !== null) {
        if (upload.ownerUserId !== sellerId) {
          // row của user khác chặn KỂ CẢ khi url đã gắn vào listing này
          throw new Error("IMAGE_NOT_OWNED");
        }
        continue; // owned by seller → pass
      }
      // row-less /uploads/<uuid>.<ext>: pre-Batch-4 upload — chỉ giữ khi ĐÃ GẮN
      if (attachedUrls.has(url)) continue; // rule (2) — B1 compat
      // detached (hoặc của listing khác) → không có ownership row → chặn
      throw new Error("IMAGE_NOT_OWNED");
    }

    // không khớp upload pattern → rule (2) attached compat hoặc rule (3) reject
    if (attachedUrls.has(url)) {
      if (ATTACHED_IMAGE_PATH_PATTERN.test(url) && !url.includes("..")) {
        continue; // ảnh seed /img/… + ảnh /uploads/ pre-Batch-4 ĐÃ GẮN — giữ nguyên
      }
      // đã gắn nhưng scheme/traversal — KHÔNG bao giờ tin URL ngoài (kể cả approve)
      throw new Error("IMAGE_URL_INVALID");
    }

    // (3) còn lại — URL lạ chưa gắn: scheme/traversal/rỗng → reject
    throw new Error("IMAGE_URL_INVALID");
  }
}
