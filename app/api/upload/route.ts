import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getCurrentUser } from "@/src/lib/auth";
import { rateLimitRequest } from "@/src/lib/rate-limit";
import { validateImage } from "@/src/lib/image-validate";
import { captureError } from "@/src/lib/observability";

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Upload ảnh bậc tự quản (lưu vào public/uploads).
 * Bảo mật: rate limit/IP, magic bytes + sharp decode (chống SVG/script/spoof
 * MIME), cap kích thước + pixel. Production: thay bằng Cloudinary / S3.
 */
export async function POST(request: Request) {
  const limited = await rateLimitRequest(request, "upload", {
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Thiếu file" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return Response.json({ error: "Ảnh tối đa 5MB" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const verdict = await validateImage(buf, file.type, MAX_SIZE);
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

  const name = `${randomUUID()}.${verdict.ext}`;
  const dir = path.join(process.cwd(), "public", "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buf);

  return Response.json({ url: `/uploads/${name}` });
}
