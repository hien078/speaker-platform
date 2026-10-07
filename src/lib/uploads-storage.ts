import path from "node:path";

/**
 * Thư mục lưu file upload (b4-holistic round-3 HIGH — upload-resource):
 * NGOÀI public/ — Next production (standalone) chỉ serve file public/ TỒN TẠI
 * KHI SERVER START (filesystem checker scan MỘT LẦN vào boot): file upload
 * sau boot trả 404 mãi mãi. Serving đi qua route handler app/uploads/[key]
 * (đọc đĩa MỌI request) — thư mục phải nằm NGOÀI public/ nếu không file cũ
 * tại boot vẫn được static path serve (static path ĐỚI TRƯỚC route handler).
 *
 * - Docker (docker-compose.prod.yml): volume `uploads` mount tại /app/data/uploads.
 * - Dev/test: <repo>/data/uploads (gitignored).
 * - Override qua UPLOADS_DIR cho deploy khác (đúng pattern env của compose).
 */
export const UPLOADS_DIR =
  process.env.UPLOADS_DIR ?? path.join(process.cwd(), "data", "uploads");
