/**
 * Backfill listing location — guard + CAS (Batch 5 Task 2, spec §8.6 —
 * b5-review round: T2 [CONFIRMED HIGH] + T2 [SPLIT]) — unit tests qua mock db.
 *
 * Hợp đồng guard (seed-beta-catalog posture — b4-holistic round-3/round-4):
 *  - offline script --apply vào DB production/non-local phải là hành động CÓ
 *    CHỦ ĐÍCH: guard quyết TỪ ĐÍCH (DATABASE_URL host ≠ localhost/127.0.0.1/
 *    ::1 → BACKFILL_REFUSED_NONLOCAL) + belt-and-braces NODE_ENV=production →
 *    BACKFILL_REFUSED_PRODUCTION; cờ --allow-production (options.allowProduction
 *    cho caller trực tiếp) mở cả hai;
 *  - DRY-RUN KHÔNG bị guard (chỉ đọc + in counts — compose service migrate set
 *    NODE_ENV=production nên guard chặn cả dry-run sẽ phá bước doc bắt buộc);
 *  - thiếu DATABASE_URL → từ chối (env thật, TRƯỚC khi nạp db.client).
 *
 * CAS seller_declared (b5-review T2 SPLIT): backfill quét row R với mã hợp lệ
 * "ha-noi"; MỘT writer khác (legacy edit đổi city → corrections item 3 re-resolve
 * → provinceLevelCode NULL + locationSource NULL) commit GIỮA scan và write.
 * CAS PHẢI re-check CẢ mã đã quét (where provinceLevelCode = mã scan) — không
 * thì row bị đánh seller_declared với mã NULL, rồi rơi khỏi mọi scan sau
 * (locationSource NOT NULL) và id bị ghi vào declaredIds như thể mã Batch 4 tồn
 * tại. Mock mô phỏng interleaving: concurrent edit áp dụng SAU snapshot scan,
 * TRƯỚC updateAll đầu tiên.
 *
 * Hành vi thật trên scratch DB (mapped/unresolved/rollback/idempotent) pin ở
 * tests/integration/listing-location.test.ts — file này chỉ guard + CAS race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── db.client mock — in-memory Listing + chainable where-builder ──────────────

const dbState = vi.hoisted(() => ({
  listings: [] as Array<Record<string, unknown>>,
  /**
   * Writer khác commit GIỮA scan và CAS write: áp cho row trong dbState SAU
   * khi `.all()` đã snapshot (backfill đọc trạng thái TRƯỚC edit), TRƯỚC khi
   * `updateAll` đánh giá predicate (CAS thấy trạng thái SAU edit) — đúng
   * interleaving của race mà review mô tả. Tự reset sau lần áp dụng đầu.
   */
  concurrentEdit: null as null | ((row: Record<string, unknown>) => void),
}));

/** Field-proxy cho predicate lambda (.isNull/.isNotNull/.in/.eq — như ORM). */
const fieldProxy = (row: Record<string, unknown>) =>
  new Proxy(row, {
    get: (target: Record<string, unknown>, prop: string) => {
      const value = target[prop];
      return {
        eq: (v: unknown) => value === v,
        neq: (v: unknown) => value !== v,
        in: (arr: readonly unknown[]) => arr.includes(value),
        isNull: () => value === null,
        isNotNull: () => value !== null,
      };
    },
  });

/** where-builder: hỗ trợ cả predicate object lẫn expression fn. */
const matchRow = (row: Record<string, unknown>, pred: unknown): boolean => {
  if (typeof pred === "function") {
    return Boolean((pred as (r: unknown) => unknown)(fieldProxy(row)));
  }
  return Object.entries(pred as Record<string, unknown>).every(([k, v]) => row[k] === v);
};

vi.mock("@/src/prisma/db.client", () => {
  type Pred = unknown;
  const makeListing = (preds: Pred[]) => ({
    where: (pred: Pred) => makeListing([...preds, pred]),
    select: (..._cols: string[]) => ({
      all: async () => {
        const snapshot = dbState.listings
          .filter((r) => preds.every((p) => matchRow(r, p)))
          .map((r) => ({ ...r }));
        // Interleaving race: writer khác commit SAU snapshot, TRƯỚC CAS write.
        if (dbState.concurrentEdit) {
          for (const r of dbState.listings) {
            (dbState.concurrentEdit as (row: Record<string, unknown>) => void)(r);
          }
          dbState.concurrentEdit = null;
        }
        return snapshot;
      },
    }),
    aggregate: async (fn: (a: { count: () => number }) => unknown) =>
      fn({
        count: () => dbState.listings.filter((r) => preds.every((p) => matchRow(r, p))).length,
      }),
    updateAll: async (data: Record<string, unknown>) => {
      const updated: Array<Record<string, unknown>> = [];
      for (const r of dbState.listings) {
        if (!preds.every((p) => matchRow(r, p))) continue;
        Object.assign(r, data);
        updated.push({ ...r });
      }
      return updated;
    },
  });
  const orm = { public: { Listing: makeListing([]) } };
  return { db: { orm } };
});

import { backfillListingLocation } from "../../scripts/backfill-listing-location";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;

/** Listing pre-backfill — mặc định legacy (mã null, source null). */
const mkListing = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: `L${++seq}`,
  city: "Hà Nội",
  provinceLevelCode: null,
  locationSource: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbState.listings.length = 0;
  dbState.concurrentEdit = null;
  // Mặc định: đích local (dev/test scratch) — guard đích không chặn.
  vi.stubEnv("DATABASE_URL", "postgresql://speaker:pw@127.0.0.1:5435/speaker_platform");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Guard: --apply từ đích + NODE_ENV (b5-review T2 HIGH) ─────────────────────

describe("backfillListingLocation — guard --apply (seed-beta-catalog posture)", () => {
  it("thiếu DATABASE_URL → từ chối (env thật — TRƯỚC khi nạp db.client)", async () => {
    vi.stubEnv("DATABASE_URL", "");
    dbState.listings.push(mkListing({ provinceLevelCode: "ha-noi" }));

    await expect(backfillListingLocation(true)).rejects.toThrow(/DATABASE_URL/);
    expect(dbState.listings[0]!.locationSource).toBeNull();
  });

  it("--apply vào DB NON-LOCAL (không --allow-production) → BACKFILL_REFUSED_NONLOCAL, KHÔNG ghi gì", async () => {
    // Compose migrate → db:5432 (host "db") — guard quyết TỪ ĐÍCH, không phải NODE_ENV
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
    dbState.listings.push(mkListing({ provinceLevelCode: "ha-noi" }));

    await expect(backfillListingLocation(true)).rejects.toThrow(/BACKFILL_REFUSED_NONLOCAL/);
    expect(dbState.listings[0]!.locationSource).toBeNull(); // KHÔNG chạm db
    expect(dbState.listings[0]!.provinceLevelCode).toBe("ha-noi"); // mã nguyên vẹn
  });

  it("--apply khi NODE_ENV=production (DB local-looking 127.0.0.1) → BACKFILL_REFUSED_PRODUCTION (belt-and-braces)", async () => {
    // Container sidecar/pgbouncer trên 127.0.0.1 với NODE_ENV=production —
    // guard đích không cháy (host local), chỉ guard NÀY chặn.
    vi.stubEnv("NODE_ENV", "production");
    dbState.listings.push(mkListing({ provinceLevelCode: "ha-noi" }));

    await expect(backfillListingLocation(true)).rejects.toThrow(/BACKFILL_REFUSED_PRODUCTION/);
    expect(dbState.listings[0]!.locationSource).toBeNull();
  });

  it("dry-run KHÔNG bị guard (NODE_ENV=production + đích non-local → vẫn chỉ đọc)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
    dbState.listings.push(mkListing({ provinceLevelCode: "ha-noi" }));

    const report = await backfillListingLocation(false);

    expect(report.mode).toBe("dry-run");
    expect(report.declaredBackfilled).toBe(1); // would-be count
    expect(report.declaredIds).toEqual([]); // dry-run KHÔNG đánh dấu gì
    expect(dbState.listings[0]!.locationSource).toBeNull(); // KHÔNG ghi
  });

  it("--allow-production → --apply chạy thật cả khi NODE_ENV=production + đích non-local (hành động có chủ đích)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
    dbState.listings.push(mkListing({ provinceLevelCode: "ha-noi" }));

    const report = await backfillListingLocation(true, { allowProduction: true });

    expect(report.mode).toBe("apply");
    expect(report.declaredBackfilled).toBe(1);
    expect(report.declaredIds).toEqual([dbState.listings[0]!.id]);
    expect(dbState.listings[0]!.locationSource).toBe("seller_declared");
  });
});

// ─── CAS seller_declared re-check mã đã quét (b5-review T2 SPLIT) ─────────────

describe("backfillListingLocation — CAS seller_declared re-check mã đã quét", () => {
  it("KHÔNG race → claimed + declaredIds (rollback input B3), mã KHÔNG bị đụng", async () => {
    dbState.listings.push(mkListing({ provinceLevelCode: "ha-noi" }));

    const report = await backfillListingLocation(true);

    expect(report.declaredBackfilled).toBe(1);
    expect(report.declaredIds).toEqual([dbState.listings[0]!.id]);
    expect(dbState.listings[0]!.locationSource).toBe("seller_declared");
    expect(dbState.listings[0]!.provinceLevelCode).toBe("ha-noi"); // mã Batch 4 nguyên vẹn
  });

  it("legacy edit concurrent (giữa scan và write) null mã → CAS thua → alreadyDone, KHÔNG seller_declared với mã NULL", async () => {
    // Row R quét với mã hợp lệ "ha-noi" (ứng viên seller_declared). Writer khác
    // (legacy edit đổi city "Hà Nội"→"Khác" — corrections item 3: re-resolve →
    // không map → provinceLevelCode NULL + locationSource NULL) commit SAU scan,
    // TRƯỚC CAS. CAS phải re-check mã ĐÃ QUÉT ("ha-noi") — row giờ mang NULL
    // → 0 rows → alreadyDone; row GIỮ locationSource NULL (scan sau gặp lại,
    // KHÔNG rơi khỏi predicate) và KHÔNG vào declaredIds.
    dbState.listings.push(mkListing({ id: "R1", provinceLevelCode: "ha-noi" }));
    dbState.concurrentEdit = (row) => {
      if (row.id === "R1") {
        row.provinceLevelCode = null;
        row.city = "Khác";
        row.locationSource = null;
      }
    };

    const report = await backfillListingLocation(true);

    expect(report.declaredBackfilled).toBe(0);
    expect(report.declaredIds).toEqual([]); // KHÔNG ghi nhận id như thể mã Batch 4 tồn tại
    expect(report.alreadyDone).toBe(1); // thua CAS race → đếm alreadyDone
    const row = dbState.listings.find((r) => r.id === "R1")!;
    expect(row.locationSource).toBeNull(); // KHÔNG bị đánh seller_declared với mã NULL
    expect(row.provinceLevelCode).toBeNull(); // legacy edit đã null — backfill KHÔNG đè
    expect(row.city).toBe("Khác"); // legacy text của writer khác — byte nguyên vẹn
  });
});
