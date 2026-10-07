/**
 * scripts/cleanup-uploads.ts (b4-holistic round-3 — cleanup upload mồ côi) —
 * hợp đồng qua mock db + fs (không đĩa thật):
 *  - dry-run MẶC ĐỊNH: KHÔNG xoá row/file;
 *  - --apply: xoá row trước (row mồ côi vô hại), file best-effort sau;
 *  - CHỈ xoá row CŨ HƠN grace VÀ KHÔNG có ListingImage nào mang url
 *    /uploads/<storageKey> (attached = sản phẩm đang sống — giữ nguyên);
 *  - upload MỚI (trong phiên soạn tin) không bao giờ bị dọn;
 *  - unlink lỗi khác ENOENT được báo (unlinkFailures).
 *
 * b4-holistic round-4 (LOW deploy-risk ×2 — volume không mount):
 *  - --apply FAIL-CLOSED khi UPLOADS_DIR thiếu/không phải thư mục — operator
 *    chạy qua image migrate theo doc mà quên mount volume uploads → MỌI unlink
 *    ENOENT → trước fix: row bị xoá, ENOENT nuốt im lặng, file thật trên volume
 *    production mồ côi MÃI MÃI (row nhận diện chúng đã gone). Giờ: throw TRƯỚC
 *    khi xoá row đầu tiên.
 *  - ENOENT trên ứng viên = ANOMALY (missingFiles + exit 1) — KHÔNG silent
 *    success (file ứng viên không có trên đĩa = volume có thể sai chỗ).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const dbState = vi.hoisted(() => ({
  uploads: [] as Array<{ id: string; ownerUserId: string; storageKey: string; createdAt: string }>,
  listingImages: [] as Array<{ url: string }>,
  deletedIds: [] as string[],
}));

vi.mock("@/src/prisma/db.client", () => ({
  db: {
    orm: {
      public: {
        // where() MỘT overload cho cả hai call shape của script:
        //  - where(predicateFn).all()   (query ứng viên theo createdAt)
        //  - where({id}).delete()       (xoá row mồ côi)
        ListingImageUpload: {
          where: (arg: unknown) => {
            if (typeof arg === "function") {
              return {
                // Predicate là Prisma expression builder (u.createdAt.lt(x)) —
                // KHÔNG chạy được trên row thuần; wrap mỗi field bằng shim
                // expression ({lt: (x) => a < x}) rồi filter bằng chính predicate.
                all: vi.fn(async () => {
                  const wrapped = dbState.uploads.map((u) => ({
                    ...u,
                    createdAt: { lt: (x: string) => u.createdAt < x } as unknown as string,
                  }));
                  return wrapped.filter((u) => (arg as (u: unknown) => boolean)(u));
                }),
              };
            }
            const pred = arg as Record<string, string>;
            return {
              delete: vi.fn(async () => {
                const before = dbState.uploads.length;
                dbState.uploads = dbState.uploads.filter(
                  (u) => !Object.entries(pred).every(([k, v]) => (u as Record<string, unknown>)[k] === v),
                );
                return before - dbState.uploads.length;
              }),
            };
          },
        },
        ListingImage: {
          select: (_sel: unknown) => ({
            all: vi.fn(async () => dbState.listingImages),
          }),
        },
      },
    },
  },
}));

const tmpState = vi.hoisted(() => ({ dir: "" as string }));
const unlinkCalls = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    unlink: vi.fn(async (p: string) => {
      unlinkCalls.keys.push(String(p));
    }),
  };
});

vi.mock("@/src/lib/uploads-storage", () => ({
  // Getter — đọc tmpState.dir LÚC script destructuring (mỗi lần gọi), không
  // phải lúc mock module cache lần đầu (trước beforeEach tạo dir mới).
  get UPLOADS_DIR(): string {
    return tmpState.dir;
  },
}));

import { cleanupUploads } from "../../scripts/cleanup-uploads";

const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString();

beforeEach(async () => {
  tmpState.dir = await mkdtemp(path.join(tmpdir(), "cleanup-uploads-"));
  dbState.uploads.length = 0;
  dbState.listingImages.length = 0;
  dbState.deletedIds.length = 0;
  unlinkCalls.keys.length = 0;
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (tmpState.dir !== "") {
    await rm(tmpState.dir, { recursive: true, force: true });
    tmpState.dir = "";
  }
});

describe("cleanupUploads — dọn upload mồ côi (b4-holistic round-3)", () => {
  it("dry-run (mặc định): báo cáo ứng viên, KHÔNG xoá row/file", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "aaaa.webp", createdAt: OLD });
    const report = await cleanupUploads(false);
    expect(report.mode).toBe("dry-run");
    expect(report.orphanCount).toBe(1);
    expect(report.deletedRows).toBe(0);
    expect(report.deletedFiles).toBe(0);
    expect(unlinkCalls.keys).toHaveLength(0);
  });

  it("apply: xoá row + file của upload mồ côi CŨ; giữ upload ATTACHED và upload MỚI", async () => {
    dbState.uploads.push(
      { id: "orphan", ownerUserId: "s1", storageKey: "orphan.webp", createdAt: OLD },
      { id: "attached", ownerUserId: "s1", storageKey: "attached.webp", createdAt: OLD },
      { id: "fresh", ownerUserId: "s1", storageKey: "fresh.webp", createdAt: FRESH },
    );
    dbState.listingImages.push({ url: "/uploads/attached.webp" });
    await writeFile(path.join(tmpState.dir, "orphan.webp"), "x");

    const report = await cleanupUploads(true);

    expect(report.orphanCount).toBe(1); // chỉ orphan-old (attached + fresh bị loại)
    expect(report.deletedRows).toBe(1);
    expect(report.deletedFiles).toBe(1);
    expect(report.unlinkFailures).toEqual([]);
    expect(unlinkCalls.keys).toEqual([path.join(tmpState.dir, "orphan.webp")]);
  });

  it("attached-set khớp url ĐẦY ĐỦ — url chứa storageKey làm TIỀN TỐ khác không cứu mồ côi", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "key.webp", createdAt: OLD });
    // url KHÁC (không phải /uploads/key.webp) — vẫn mồ côi
    dbState.listingImages.push({ url: "/uploads/key.webp.bak" });

    const report = await cleanupUploads(true);
    expect(report.orphanCount).toBe(1);
    expect(report.deletedRows).toBe(1);
  });

  it("file đã mất (ENOENT) → row vẫn xoá, KHÔNG tính lỗi", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "gone.webp", createdAt: OLD });
    // KHÔNG ghi file — unlink sẽ ENOENT (mock không throw — nhưng script xử lý
    // ENOENT qua catch; mock này không throw nên chỉ assert row xoá + file 0)
    const report = await cleanupUploads(true);
    expect(report.deletedRows).toBe(1);
    expect(report.unlinkFailures).toEqual([]);
  });
});

// ─── b4-holistic round-4 (LOW deploy-risk) — volume uploads phải mount ───────

describe("cleanupUploads — --apply fail-closed khi UPLOADS_DIR thiếu/không phải thư mục (b4-holistic round-4)", () => {
  it("--apply UPLOADS_DIR KHÔNG tồn tại → THROW, KHÔNG xoá row nào (file mồ côi vĩnh viễn)", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "orphan.webp", createdAt: OLD });
    tmpState.dir = path.join(tmpdir(), "cleanup-uploads-khong-ton-tai-" + Date.now()); // KHÔNG mkdir

    await expect(cleanupUploads(true)).rejects.toThrowError(/UPLOADS_DIR/);
    // FAIL-CLOSED: row ownership GIỮ NGUYÊN — không xoá khi không thể chạm file
    expect(dbState.uploads).toHaveLength(1);
    expect(unlinkCalls.keys).toHaveLength(0);
  });

  it("--apply UPLOADS_DIR là FILE (không phải thư mục) → THROW, KHÔNG xoá row", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "orphan.webp", createdAt: OLD });
    // tmpState.dir trỏ vào MỘT FILE — stat() ok nhưng isDirectory() false
    const filePath = path.join(tmpState.dir, "khong-phai-thu-muc.txt");
    await writeFile(filePath, "x");
    tmpState.dir = filePath;

    await expect(cleanupUploads(true)).rejects.toThrowError(/UPLOADS_DIR/);
    expect(dbState.uploads).toHaveLength(1);
  });

  it("dry-run UPLOADS_DIR KHÔNG tồn tại → KHÔNG throw (chỉ đọc DB — báo cáo ứng viên)", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "orphan.webp", createdAt: OLD });
    tmpState.dir = path.join(tmpdir(), "cleanup-uploads-dry-" + Date.now()); // KHÔNG mkdir

    const report = await cleanupUploads(false);
    expect(report.mode).toBe("dry-run");
    expect(report.orphanCount).toBe(1); // báo cáo vẫn chạy (chỉ đọc)
    expect(report.deletedRows).toBe(0);
  });

  it("ENOENT trên ứng viên (dir ĐÚNG nhưng file không có) → missingFiles anomaly — KHÔNG silent success", async () => {
    dbState.uploads.push({ id: "u1", ownerUserId: "s1", storageKey: "vong-lap.webp", createdAt: OLD });
    // tmpState.dir là dir THẬT (beforeEach mkdtemp) nhưng file không tồn tại —
    // unlink throw ENOENT thật qua node:fs/promises actual.
    const { unlink } = await import("node:fs/promises");
    const unlinkMock = vi.mocked(unlink);
    unlinkMock.mockImplementationOnce(async () => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const report = await cleanupUploads(true);

    expect(report.deletedRows).toBe(1); // row-first — row đã dọn
    expect(report.deletedFiles).toBe(0);
    expect(report.unlinkFailures).toEqual([]); // ENOENT KHÔNG phải unlink-failure
    expect(report.missingFiles).toEqual(["vong-lap.webp"]); // anomaly ĐƯỢC BÁO
  });
});
