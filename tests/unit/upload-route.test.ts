/**
 * POST /api/upload — Batch 4 Task 3 upload hardening (spec §5.6.4/§7.5).
 *
 * Hợp đồng (plan Task 3):
 *  - 401 TRƯỚC khi buffer file (hiện có — pin lại);
 *  - Content-Length > ~5.5MB → 413 TRƯỚC request.formData() (early body reject);
 *  - file.size > cap → 400 TRƯỚC khi buffer (arrayBuffer không được gọi);
 *  - file ghi ra là buffer ĐÃ RE-ENCODE (WebP, EXIF/GPS strip), KHÔNG BAO GIỜ
 *    buffer gốc (Review Focus 1);
 *  - ListingImageUpload row (ownership) ghi TRƯỚC file — ROW FIRST; writeFile
 *    fail → xoá row best-effort + 500 (row mồ côi vô hại, file mồ côi mới là
 *    vấn đề);
 *  - per-USER rate limit ≤ per-IP (§7.1) — 21st upload trong 10 phút → 429
 *    (test bật TRUST_PROXY_HEADERS + đổi x-real-ip mỗi request, nếu không
 *    bucket IP "local" chung sẽ chặn trước, che mất bucket per-user);
 *  - re-encode fail → 400, KHÔNG ghi file, KHÔNG tạo row;
 *  - SVG (khai báo svg+xml hoặc giả danh png) → validateImage từ chối
 *    (MIME_NOT_ALLOWED / MAGIC_MISMATCH) — pin lại ở tầng route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

// ─── fs mock — spy writeFile/mkdir/unlink, KHÔNG chạm đĩa thật ─────────────────

const orderState = vi.hoisted(() => ({ events: [] as string[] }));
const fsState = vi.hoisted(() => ({
  writes: [] as Array<{ path: string; buffer: Buffer }>,
  unlinks: [] as string[],
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {
    orderState.events.push("mkdir");
  }),
  writeFile: vi.fn(async (p: unknown, data: unknown) => {
    orderState.events.push("write");
    fsState.writes.push({ path: String(p), buffer: Buffer.from(data as Uint8Array) });
  }),
  // L2 — route xoá file MỘT PHẦN best-effort khi writeFile fail
  unlink: vi.fn(async (p: unknown) => {
    orderState.events.push("unlink");
    fsState.unlinks.push(String(p));
  }),
}));

// ─── db mock — in-memory ListingImageUpload + UserSuspension ─────────────────

const dbState = vi.hoisted(() => ({
  uploads: [] as Array<Record<string, unknown>>,
  createdKeys: [] as string[],
  deletes: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => ({
  db: {
    orm: {
      public: {
        ListingImageUpload: {
          create: vi.fn(async (data: Record<string, unknown>) => {
            const row = { id: `upload-${dbState.uploads.length + 1}`, ...data };
            dbState.uploads.push(row);
            dbState.createdKeys.push(String(data.storageKey));
            orderState.events.push("row");
            return row;
          }),
          where: (pred: Record<string, unknown>) => ({
            deleteAndCount: vi.fn(async () => {
              dbState.deletes.push(pred);
              orderState.events.push("delete");
              const before = dbState.uploads.length;
              dbState.uploads = dbState.uploads.filter(
                (r) => !Object.entries(pred).every(([k, v]) => r[k] === v),
              );
              return before - dbState.uploads.length;
            }),
          }),
        },
        // Batch 3 isUserSuspended đọc UserSuspension active (L4)
        UserSuspension: {
          where: (pred: Record<string, unknown>) => ({
            first: vi.fn(async () => {
              const rows = dbState.suspensions.filter((r) =>
                Object.entries(pred).every(([k, v]) => r[k] === v),
              );
              return rows[0] ?? null;
            }),
          }),
        },
      },
    },
  },
}));

// ─── auth mock — session user fixture ────────────────────────────────────────

const authState = vi.hoisted(() => ({ user: null as null | { id: string } }));

vi.mock("@/src/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── observability mock — pin captureError scope/reason, giữ output sạch ─────

const obsState = vi.hoisted(() => ({
  errors: [] as Array<{ scope: string; message: string; meta?: Record<string, unknown> }>,
}));

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn((scope: string, error: unknown, meta?: Record<string, unknown>) => {
    obsState.errors.push({
      scope,
      message: error instanceof Error ? error.message : String(error),
      meta,
    });
  }),
  captureEvent: vi.fn(),
}));

// ─── image-process mock — wrapper đếm được quanh reencodeImage THẬT ──────────
// (cross-module recipe — same-module spy không chạy được trong vitest; default
// delegate sang bản thật nên mọi test hiện có giữ nguyên hành vi)

vi.mock("@/src/lib/image-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/image-process")>();
  return { ...actual, reencodeImage: vi.fn(actual.reencodeImage) };
});

import { POST } from "../../app/api/upload/route";
import { resetRateLimits } from "@/src/lib/rate-limit";
import {
  IMAGE_MAX_BYTES,
  acquireReencodeSlot,
  reencodeImage,
  reencodeQueueHasCapacity,
  releaseReencodeSlot,
} from "@/src/lib/image-process";
import { unlink, writeFile } from "node:fs/promises";
import nextConfig from "../../next.config";

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } })
    .png()
    .toBuffer();
}

/** Buffer<ArrayBufferLike> không gán được cho BlobPart — copy qua Uint8Array. */
function pngFile(buf: Buffer, name = "a.png", type = "image/png"): File {
  return new File([new Uint8Array(buf)], name, { type });
}

/**
 * Request upload — undici KHÔNG tự set Content-Length cho FormData body, route
 * (L1) giờ yêu cầu header nên test set thủ công (framing thật do server đảm
 * bảo — route chỉ dùng header làm precheck bound).
 */
function uploadRequest(file: File, headers: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.append("file", file);
  return new Request("http://localhost:3000/api/upload", {
    method: "POST",
    body: fd,
    headers: { "content-length": "2048", ...headers },
  });
}

/** Request KHÔNG có Content-Length (chunked/stream — L1 reject path). */
function requestWithoutLength(body?: FormData): Request {
  return new Request("http://localhost:3000/api/upload", {
    method: "POST",
    body: body ?? new FormData(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  orderState.events.length = 0;
  fsState.writes.length = 0;
  fsState.unlinks.length = 0;
  dbState.uploads.length = 0;
  dbState.createdKeys.length = 0;
  dbState.deletes.length = 0;
  dbState.suspensions.length = 0;
  obsState.errors.length = 0;
  authState.user = { id: "user-1" };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/upload — auth + early rejects", () => {
  it("unauthenticated POST → 401 before any file buffering", async () => {
    authState.user = null;
    const request = uploadRequest(pngFile(await tinyPng()));
    const formDataSpy = vi.spyOn(request, "formData");

    const res = await POST(request);

    expect(res.status).toBe(401);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("Content-Length over ~5.5MB → 413 before request.formData()", async () => {
    const request = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: { "content-length": String(IMAGE_MAX_BYTES + 512 * 1024 + 1) },
    });
    const formDataSpy = vi.spyOn(request, "formData").mockResolvedValue(new FormData());

    const res = await POST(request);

    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("file.size over cap → 400 before buffering (arrayBuffer not called)", async () => {
    const file = pngFile(await tinyPng());
    Object.defineProperty(file, "size", { value: IMAGE_MAX_BYTES + 1 });
    const arrayBufferSpy = vi.spyOn(file, "arrayBuffer");
    const fd = new FormData();
    fd.append("file", file);
    const request = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: { "content-length": "2048" },
    });
    vi.spyOn(request, "formData").mockResolvedValue(fd);

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });
});

// ─── Review fix L1 — Content-Length bắt buộc (chunked/stream bypass precheck) ──

describe("POST /api/upload — Content-Length precheck (L1)", () => {
  it("request KHÔNG có Content-Length (chunked/stream) → 411 TRƯỚC formData()", async () => {
    const request = requestWithoutLength();
    const formDataSpy = vi.spyOn(request, "formData").mockResolvedValue(new FormData());

    const res = await POST(request);

    expect(res.status).toBe(411);
    expect(((await res.json()) as { error: string }).error).toBe("CONTENT_LENGTH_REQUIRED");
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("Content-Length không phải số nguyên ≥0 → 400 INVALID_CONTENT_LENGTH", async () => {
    const bad = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: { "content-length": "abc" },
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("INVALID_CONTENT_LENGTH");

    const negative = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: { "content-length": "-5" },
    });
    const res2 = await POST(negative);
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: string }).error).toBe("INVALID_CONTENT_LENGTH");
  });

  it("Content-Length hợp lệ nhỏ → đi tiếp tới auth (401 khi chưa đăng nhập)", async () => {
    authState.user = null;
    const res = await POST(uploadRequest(pngFile(await tinyPng())));
    expect(res.status).toBe(401);
  });
});

// ─── Review fix L3 — malformed multipart → 400 INVALID_BODY ───────────────────

describe("POST /api/upload — malformed multipart (L3)", () => {
  it("request.formData() throw (multipart hỏng) → 400 INVALID_BODY, không ghi file/row", async () => {
    const request = uploadRequest(pngFile(await tinyPng()));
    vi.spyOn(request, "formData").mockRejectedValue(new Error("terminated: bad multipart"));

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("INVALID_BODY");
    expect(fsState.writes.length).toBe(0);
    expect(dbState.uploads.length).toBe(0);
    expect(obsState.errors.some((e) => e.scope === "upload")).toBe(true);
  });
});

// ─── Review fix L4 — suspended user không được upload ─────────────────────────

describe("POST /api/upload — suspension guard (L4 — Batch 3 isUserSuspended)", () => {
  it("user đang bị đình chỉ (UserSuspension active) → 403 ACCOUNT_SUSPENDED, không file/row", async () => {
    dbState.suspensions.push({ id: "susp-1", userId: "user-1", status: "active" });
    const res = await POST(uploadRequest(pngFile(await tinyPng())));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("ACCOUNT_SUSPENDED");
    expect(fsState.writes.length).toBe(0);
    expect(dbState.uploads.length).toBe(0);
    expect(orderState.events).toEqual([]); // chặn TRƯỚC mkdir/row/write
  });

  it("suspension đã lifted KHÔNG chặn (chỉ episode active)", async () => {
    dbState.suspensions.push({ id: "susp-1", userId: "user-1", status: "lifted" });
    const res = await POST(uploadRequest(pngFile(await tinyPng())));

    expect(res.status).toBe(200);
    expect(fsState.writes.length).toBe(1);
  });
});

// ─── Review fix M1a — semaphore đầy → 503 TOO_BUSY (typed) ─────────────────────

describe("POST /api/upload — re-encode busy → 503 (M1a)", () => {
  it("reencodeImage TOO_BUSY → 503 + Retry-After, KHÔNG ghi file/row", async () => {
    vi.mocked(reencodeImage).mockImplementationOnce(
      async () => ({ ok: false, reason: "TOO_BUSY" }),
    );
    const res = await POST(uploadRequest(pngFile(await tinyPng())));

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("TOO_BUSY");
    expect(res.headers.get("retry-after")).toBeDefined();
    expect(fsState.writes.length).toBe(0);
    expect(dbState.uploads.length).toBe(0);
    expect(orderState.events).toEqual([]); // chặn TRƯỚC mkdir/row/write
  });
});

// ─── Review fix 2 (H1) — queue bounded: pre-check TRƯỚC body + 1 in-flight/user ─

describe("POST /api/upload — H1: capacity pre-check + per-user in-flight", () => {
  it("H1b — queue re-encode ĐẦY (slot + 2 waiter) → 503 TOO_BUSY TRƯỚC formData (KHÔNG đọc body)", async () => {
    const request = uploadRequest(pngFile(await tinyPng()));
    const formDataSpy = vi.spyOn(request, "formData");
    // chiếm slot duy nhất + đầy hàng chờ (2 waiter) — pre-check phải fail
    await acquireReencodeSlot(60_000);
    void acquireReencodeSlot(60_000).catch(() => {}); // waiter 1
    void acquireReencodeSlot(60_000).catch(() => {}); // waiter 2 — đầy
    try {
      expect(reencodeQueueHasCapacity()).toBe(false); // precondition
      const res = await POST(request);

      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("TOO_BUSY");
      expect(res.headers.get("retry-after")).toBeDefined();
      expect(formDataSpy).not.toHaveBeenCalled(); // KHÔNG buffer body ~10-15MB
      expect(fsState.writes.length).toBe(0);
      expect(dbState.uploads.length).toBe(0);
      expect(orderState.events).toEqual([]); // chặn TRƯỚC mkdir/row/write
    } finally {
      releaseReencodeSlot(); // handoff waiter 1
      releaseReencodeSlot(); // handoff waiter 2
      releaseReencodeSlot(); // đếm về 0 — sạch cho test sau
    }
  });

  it("H1c — 2 upload song song CÙNG user → request thứ 2 bị 429 UPLOAD_IN_PROGRESS (không đọc body), first vẫn hoàn tất 200", async () => {
    const input = await tinyPng();
    // reencodeImage treo cho request ĐẦU — giữ nó in-flight khi request 2 tới
    let finishFirst!: (value: Awaited<ReturnType<typeof reencodeImage>>) => void;
    let reencodeEntered!: () => void;
    const entered = new Promise<void>((r) => {
      reencodeEntered = r;
    });
    vi.mocked(reencodeImage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reencodeEntered();
          finishFirst = resolve;
        }),
    );

    const first = POST(uploadRequest(pngFile(input)));
    await entered; // request 1 đã vào reencode → đang in-flight

    const secondRequest = uploadRequest(pngFile(input));
    const formDataSpy = vi.spyOn(secondRequest, "formData");
    const second = await POST(secondRequest);

    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe("UPLOAD_IN_PROGRESS");
    expect(second.headers.get("retry-after")).toBeDefined();
    expect(formDataSpy).not.toHaveBeenCalled(); // chặn TRƯỚC khi buffer body
    expect(fsState.writes.length).toBe(0); // request 2 không ghi gì

    // hoàn tất request 1 → 200 (row + file), slot in-flight được trả
    finishFirst({ ok: true, buffer: Buffer.from(input), width: 1, height: 1 });
    const res1 = await first;
    expect(res1.status).toBe(200);
    expect(fsState.writes.length).toBe(1);
    expect(dbState.uploads.length).toBe(1);
  });

  it("H1c — slot in-flight được trả qua finally sau khi upload LỖI → upload kế tiếp KHÔNG bị 429", async () => {
    vi.mocked(reencodeImage).mockImplementationOnce(
      async () => ({ ok: false, reason: "REENCODE_FAILED" }),
    );
    const res1 = await POST(uploadRequest(pngFile(await tinyPng())));
    expect(res1.status).toBe(400);

    // finally đã trả slot → request kế tiếp cùng user chạy bình thường
    const res2 = await POST(uploadRequest(pngFile(await tinyPng())));
    expect(res2.status).toBe(200);
    expect(fsState.writes.length).toBe(1); // chỉ request 2 ghi file
  });

  it("L2 — unlink fail cũng đi qua captureError (KHÔNG nuốt im lặng), response vẫn 500 + row dọn", async () => {
    vi.mocked(writeFile).mockImplementationOnce(async () => {
      throw new Error("ENOSPC");
    });
    vi.mocked(unlink).mockRejectedValueOnce(new Error("EBUSY"));
    const res = await POST(uploadRequest(pngFile(await tinyPng())));

    expect(res.status).toBe(500);
    // flush microtask cho .catch handler của unlink chạy
    await new Promise((r) => setTimeout(r, 0));
    expect(
      obsState.errors.some((e) => e.scope === "upload" && e.message.includes("EBUSY")),
    ).toBe(true);
    expect(dbState.deletes).toEqual([{ storageKey: dbState.createdKeys[0] }]);
  });
});

describe("POST /api/upload — re-encode + ownership row (Review Focus 1)", () => {
  it("the stored file is the re-encode output, not the upload", async () => {
    const input = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#c0ffee" } })
      .png()
      .toBuffer();

    const res = await POST(uploadRequest(pngFile(input)));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/);

    expect(fsState.writes.length).toBe(1);
    const written = fsState.writes[0]!.buffer;
    const expected = await reencodeImage(input);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    // file ghi ra == re-encode output, != upload bytes (Review Focus 1)
    expect(written.equals(expected.buffer)).toBe(true);
    expect(written.equals(input)).toBe(false);
    const writtenMeta = await sharp(written).metadata();
    expect(writtenMeta.format).toBe("webp");
  });

  it("storageKey is shared by row + file + response URL; the row is created BEFORE the file write", async () => {
    const input = await tinyPng();

    const res = await POST(uploadRequest(pngFile(input)));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    const storageKey = body.url.replace("/uploads/", "");

    // cùng một storageKey cho cả row lẫn file — sinh TRƯỚC cả hai
    expect(dbState.createdKeys).toEqual([storageKey]);
    expect(fsState.writes.length).toBe(1);
    expect(fsState.writes[0]!.path).toContain(storageKey);
    // ROW FIRST — row mồ côi vô hại, file mồ côi (public, không owner) mới là vấn đề
    expect(orderState.events).toEqual(["mkdir", "row", "write"]);

    // row ownership ghi đúng nội dung re-encode
    const row = dbState.uploads[0]!;
    expect(row.ownerUserId).toBe("user-1");
    expect(row.storageKey).toBe(storageKey);
    expect(row.bytes).toBe(fsState.writes[0]!.buffer.length);
    const expected = await reencodeImage(input);
    if (!expected.ok) throw new Error("reencode failed in fixture");
    expect(row.width).toBe(expected.width);
    expect(row.height).toBe(expected.height);
  });

  it("a writeFile failure deletes the row (best-effort) and returns 500", async () => {
    // mockImplementationOnce (không phải mockRejectedValueOnce) để event "write"
    // vẫn được ghi lại trước khi throw — chứng minh thứ tự row → write → delete
    vi.mocked(writeFile).mockImplementationOnce(async (p: unknown, data: unknown) => {
      orderState.events.push("write");
      fsState.writes.push({ path: String(p), buffer: Buffer.from(data as Uint8Array) });
      throw new Error("EIO");
    });
    const input = await tinyPng();

    const res = await POST(uploadRequest(pngFile(input)));

    expect(res.status).toBe(500);
    // row đã tạo bị xoá theo đúng storageKey — không để lại row mồ côi
    // (L2: file partial cũng bị unlink best-effort trước khi dọn row)
    expect(dbState.deletes).toEqual([{ storageKey: dbState.createdKeys[0] }]);
    expect(dbState.uploads.length).toBe(0);
    expect(orderState.events).toEqual(["mkdir", "row", "write", "unlink", "delete"]);
  });

  it("L2 — writeFile fail sau khi ghi MỘT PHẦN → file partial bị unlink best-effort (không để file công khai không owner)", async () => {
    vi.mocked(writeFile).mockImplementationOnce(async (p: unknown, data: unknown) => {
      orderState.events.push("write");
      // ghi MỘT PHẦN rồi lỗi — đúng dạng ENOSPC/EIO giữa chừng
      fsState.writes.push({ path: String(p), buffer: Buffer.from(data as Uint8Array) });
      throw new Error("ENOSPC");
    });
    const input = await tinyPng();

    const res = await POST(uploadRequest(pngFile(input)));

    expect(res.status).toBe(500);
    // file partial bị xoá theo đúng path storageKey — best-effort, không crash
    expect(fsState.unlinks).toHaveLength(1);
    expect(fsState.unlinks[0]).toContain(String(dbState.createdKeys[0]));
    // row cũng bị dọn (giữ nguyên bất biến row-first cleanup)
    expect(dbState.deletes).toEqual([{ storageKey: dbState.createdKeys[0] }]);
    expect(orderState.events).toEqual(["mkdir", "row", "write", "unlink", "delete"]);
  });
});

describe("POST /api/upload — rate limits (§7.1)", () => {
  it("per-user limit: 21st upload within 10 min → 429 (per-IP bucket không chặn trước)", { timeout: 60_000 }, async () => {
    // TRUST_PROXY_HEADERS + x-real-ip khác nhau mỗi request — nếu không mọi
    // request chung bucket IP "local" và limit IP (20) sẽ chặn trước,
    // che mất bucket per-user cần chứng minh
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const input = await tinyPng();

    let last: Response | null = null;
    for (let i = 0; i < 21; i++) {
      const file = pngFile(input);
      last = await POST(uploadRequest(file, { "x-real-ip": `10.0.${Math.floor(i / 250)}.${i % 250}` }));
    }

    expect(last!.status).toBe(429);
    const body = (await last!.json()) as { error: string };
    expect(body.error).toBe("RATE_LIMITED");
    // 20 upload đầu thành công (row + file), request 21 bị chặn TRƯỚC khi buffer
    expect(dbState.uploads.length).toBe(20);
    expect(fsState.writes.length).toBe(20);
  });
});

describe("POST /api/upload — re-encode failure fail closed", () => {
  it("re-encode failure → 400, no file written, no upload row", async () => {
    // PNG header intact (validateImage pass) nhưng thân ảnh corrupt →
    // re-encode fail — đúng lớp thứ hai sau validate
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
    const corrupt = Buffer.from(png);
    for (let i = Math.floor(png.length * 0.5); i < Math.floor(png.length * 0.5) + 40; i++) {
      corrupt[i] = 0xff;
    }

    const res = await POST(uploadRequest(pngFile(corrupt)));

    expect(res.status).toBe(400);
    expect(fsState.writes.length).toBe(0);
    expect(dbState.uploads.length).toBe(0);
    // reason có scope để truy vết — KHÔNG leak nội dung ảnh
    expect(
      obsState.errors.some((e) => e.scope === "upload" && e.message.includes("re-encode")),
    ).toBe(true);
  });
});

describe("POST /api/upload — SVG/MIME spoof (pin lại ở tầng route)", () => {
  it("SVG declared image/svg+xml → rejected by validateImage (MIME_NOT_ALLOWED)", async () => {
    const svg = new File([`<svg onload="alert(1)"><script>alert(1)</script></svg>`], "a.svg", {
      type: "image/svg+xml",
    });

    const res = await POST(uploadRequest(svg));

    expect(res.status).toBe(400);
    expect(obsState.errors.some((e) => e.message.includes("MIME_NOT_ALLOWED"))).toBe(true);
    expect(fsState.writes.length).toBe(0);
    expect(dbState.uploads.length).toBe(0);
  });

  it("SVG bytes declared image/png → MAGIC_MISMATCH", async () => {
    const svg = new File(
      [`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`],
      "a.png",
      { type: "image/png" },
    );

    const res = await POST(uploadRequest(svg));

    expect(res.status).toBe(400);
    expect(obsState.errors.some((e) => e.message.includes("MAGIC_MISMATCH"))).toBe(true);
    expect(fsState.writes.length).toBe(0);
  });
});

describe("/uploads serving headers (next.config.ts — spec §7.5)", () => {
  it("headers() emits nosniff + CSP default-src 'none'; sandbox for /uploads/:path*", async () => {
    // ĐÁNH GIÁ OUTPUT của next.config.ts headers() — KHÔNG phải string presence
    // trong file (review fix: test phải chứng minh cấu hình chạy được và ra
    // đúng header, không phải source chứa chữ).
    expect(typeof nextConfig.headers).toBe("function");
    const entries = await nextConfig.headers!();
    const uploads = entries.find((h) => h.source === "/uploads/:path*");
    expect(uploads).toBeDefined();
    expect(uploads!.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
      ]),
    );
  });
});
