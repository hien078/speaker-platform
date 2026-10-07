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
 *
 * b4-holistic round-4 (HIGH regression — FileHandle owns the fd): stream qua
 * `handle.createReadStream()` (KHÔNG `createReadStream(path, {fd: handle.fd})`
 * — raw fd + autoClose đóng fd bằng stream trong khi FileHandle vẫn "sở hữu"
 * fd đó; GC sau này đóng lại fd ĐÃ TÁI SỬ DỤNG → cắt socket DB / hỏng ghi
 * upload khác / EBADF crash — đã reproduce trên Node 26: uncaught
 * "Closing file descriptor N on garbage collection failed"). Mọi path rời
 * route (kể cả !isFile) PHẢI close handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// ─── b4-holistic round-4 (HIGH) — FileHandle owns the fd ──────────────────────

describe("GET /uploads/[key] — FileHandle không leak fd (b4-holistic round-4 HIGH)", () => {
  /** Source route — pin hợp đồng stream/close (deterministic mọi môi trường). */
  const routeSource = readFileSync(
    path.join(fileURLToPath(new URL("../..", import.meta.url)), "app/uploads/[key]/route.ts"),
    "utf8",
  );

  it("stream qua handle.createReadStream() — FileHandle sở hữu fd, KHÔNG raw fd", async () => {
    // Trước fix: truyền raw fd number của handle vào createReadStream kèm
    // autoClose — stream tự đóng fd, FileHandle không bao giờ close → GC đóng
    // lại fd đã bị kernel tái sử dụng (EBADF crash / cắt socket DB —
    // reproduce Node 26). Sau fix: FileHandle owns the fd.
    expect(routeSource).toContain("handle.createReadStream()");
    expect(routeSource).not.toMatch(/\bfd:\s*handle\.fd\b/);
    expect(routeSource).not.toMatch(/\bfd:\s*handle\b/);
  });

  it("mọi path rời route KHÔNG stream đều close handle (ENOENT-open, !isFile, error)", () => {
    // !isFile (directory) → close TRƯỚC khi 404; error path → close trong catch.
    // Hai chỗ close (nhánh !isFile + catch) — KHÔNG path nào rời route để
    // handle chờ GC.
    const closes = routeSource.match(/await handle\.close\(\)\.catch\(\(\) => \{\}\);/g) ?? [];
    expect(closes.length).toBe(2);
    // nhánh !isFile close TRƯỚC khi return notFound
    const notFileIdx = routeSource.indexOf("!st.isFile()");
    const closeIdx = routeSource.indexOf("await handle.close().catch(() => {});", notFileIdx);
    const notFoundIdx = routeSource.indexOf("return notFound();", notFileIdx);
    expect(notFileIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(notFileIdx);
    expect(closeIdx).toBeLessThan(notFoundIdx);
  });

  it("serve xong + force GC → KHÔNG 'Closing file descriptor' warning/EBADF (leak reproduce)", async () => {
    // Reproduce leak thật: serve file, consume response ĐẦY ĐỦ (client thật),
    // drop mọi reference, gc (vitest.config.ts execArgv --expose-gc) →
    // FileHandle bị GC mà chưa close → uncaught EBADF "Closing file descriptor
    // N on garbage collection failed" (đã quan sát trên Node 26 trước fix).
    // Sau fix: stream end → FileHandle đã close → GC no-op, KHÔNG event nào.
    if (typeof globalThis.gc !== "function") {
      throw new Error("thiếu --expose-gc (vitest.config.ts execArgv) — test leak fd không chạy được");
    }
    const GET = await loadRoute();
    await writeFile(path.join(tmpState.dir, `${UUID}.webp`), Buffer.alloc(4096, 0x61));

    const events: string[] = [];
    const onWarning = (w: Error) => events.push(`WARNING: ${w.message}`);
    const onUncaught = (e: Error) => events.push(`UNCAUGHT: ${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}`);
    process.on("warning", onWarning);
    process.on("uncaughtException", onUncaught);
    try {
      const res = await GET(new Request("http://localhost/uploads/x"), ctxOf(`${UUID}.webp`));
      expect(res.status).toBe(200);
      // consume TOÀN BỘ body — autoClose/end chạy như client thật
      await res.arrayBuffer();

      // drop reference + force GC lặp (finalizer close là async — cho nó thì giờ)
      for (let i = 0; i < 4; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      process.off("warning", onWarning);
      process.off("uncaughtException", onUncaught);
    }
    // Trước fix: ["UNCAUGHT: EBADF EBADF: Closing file descriptor N on garbage
    // collection failed …"] — đã reproduce. Sau fix: [] (handle đã đóng).
    expect(events).toEqual([]);
  });
});
