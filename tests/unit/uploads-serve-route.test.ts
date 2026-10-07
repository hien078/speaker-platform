/**
 * GET /uploads/[key] (b4-holistic round-3 HIGH — upload-resource) — route
 * handler đọc đĩa MỘI request.
 *
 * Hợp đồng (finding + verified fix):
 *  - File upload sống NGOÀI public/ (UPLOADS_DIR) — Next production chỉ serve
 *    file public/ tồn tại khi START (scan 1 lần lúc boot → upload sau start
 *    404 — đã reproduce trên standalone server thật).
 *  - key regex CHẬT: uuid v4 lowercase hex + ext ∈ allowlist (jpg|png|webp|gif
 *    — khớp LISTING_IMAGE_URL_PATTERN, bao gồm key pre-Batch-4) → traversal
 *    404 SẰN, không chạm filesystem.
 *  - 200 kèm Content-Type từ extension ĐÃ validate + nosniff + CSP
 *    default-src 'none'; sandbox + Cache-Control immutable (key uuid —
 *    không bao giờ ghi đè).
 *  - ENOENT/thiếu file → 404 (KHÔNG 500).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const tmpState = vi.hoisted(() => ({ dir: "" as string }));

beforeEach(async () => {
  tmpState.dir = await mkdtemp(path.join(tmpdir(), "uploads-serve-"));
  vi.stubEnv("UPLOADS_DIR", tmpState.dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tmpState.dir !== "") {
    await rm(tmpState.dir, { recursive: true, force: true });
    tmpState.dir = "";
  }
});

/** Import route handler SAU khi UPLOADS_DIR đã stub (module đọc env lúc load). */
async function loadRoute() {
  const mod = await import("../../app/uploads/[key]/route");
  return mod.GET as (
    request: Request,
    ctx: { params: Promise<{ key: string }> },
  ) => Promise<Response>;
}

const ctxOf = (key: string) => ({ params: Promise.resolve({ key }) });

const UUID = "99998888-7777-6666-5555-444433332221";

describe("GET /uploads/[key] — serve file đọc đĩa mỗi request (b4-holistic HIGH)", () => {
  it("file CÓ trên đĩa → 200 + Content-Type theo extension + nosniff + CSP sandbox + immutable", async () => {
    const GET = await loadRoute();
    await writeFile(path.join(tmpState.dir, `${UUID}.webp`), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const res = await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.webp`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0x52, 0x49, 0x46, 0x46]));
  });

  it("mỗi extension legacy có Content-Type đúng (jpg → image/jpeg, png, gif)", async () => {
    const GET = await loadRoute();
    await writeFile(path.join(tmpState.dir, `${UUID}.jpg`), "j");
    await writeFile(path.join(tmpState.dir, `${UUID}.png`), "p");
    await writeFile(path.join(tmpState.dir, `${UUID}.gif`), "g");

    expect((await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.jpg`))).headers.get("content-type")).toBe("image/jpeg");
    expect((await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.png`))).headers.get("content-type")).toBe("image/png");
    expect((await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.gif`))).headers.get("content-type")).toBe("image/gif");
  });

  it("file KHÔNG tồn tại (upload chưa bao giờ xảy ra / đã dọn) → 404, KHÔNG 500", async () => {
    const GET = await loadRoute();
    const res = await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.webp`));
    expect(res.status).toBe(404);
  });

  it("key sai định dạng → 404 SẲN (traversal/extension lạ/uuid hoa KHÔNG chạm filesystem)", async () => {
    const GET = await loadRoute();
    // file "passwd" nằm SẴN trong dir — mọi path traversal vẫn phải 404
    await writeFile(path.join(tmpState.dir, "passwd"), "secret");
    await mkdir(path.join(tmpState.dir, "sub"));

    for (const bad of [
      "..%2f..%2fetc%2fpasswd.webp",
      `${UUID}.txt`,
      `${UUID.toUpperCase()}.webp`,
      `${UUID}.webp%00.jpg`,
      "no-uuid.webp",
      `${UUID}.jpg/../passwd`,
      "",
    ]) {
      const res = await GET(new Request("http://localhost/uploads/x"), ctxOf(bad));
      expect(res.status, `key "${bad}" phải 404`).toBe(404);
    }
  });

  it("key trỏ THƯ MỤC (không phải file) → 404, không stream directory", async () => {
    const GET = await loadRoute();
    await mkdir(path.join(tmpState.dir, `${UUID}.webp`));
    const res = await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.webp`));
    expect(res.status).toBe(404);
  });
});
