import 'dotenv/config';
import postgres from '@prisma/orm-postgres/runtime';
import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

/**
 * Prisma 8 (rc.13) runtime — module-level singleton, sống suốt process
 * (server pattern — xem .agents/skills/prisma-8/references/runtime.md).
 * KHÔNG gọi db.close() trong request loop; KHÔNG `await using` trong handler.
 *
 * File này là bản hardening của `./db.ts` scaffold: `prisma contract emit`
 * (chạy trong prebuild trước MỌI `npm run build`) ghi đè `db.ts` về scaffold
 * mặc định — đã chứng minh bằng thực nghiệm — nên mọi tuỳ biến phải nằm ở
 * file emit không quản. Toàn app import từ đây, KHÔNG import `./db`.
 *
 * - poolOptions: connection/idle timeout — API có thật của rc.13
 *   (postgres-*.d.mts: poolOptions.connectionTimeoutMillis / idleTimeoutMillis).
 *   max connections KHÔNG được expose bởi façade — không bịa thêm.
 * - middleware: slow-query observability qua afterQuery (SqlMiddleware) —
 *   API có thật của rc.13 (AfterQueryResult.latencyMs / rowCount).
 *   KHÔNG import observability.ts (server-only) vào đây: seed.ts (tsx)
 *   cũng import db — server-only throw ngoài React server bundle.
 */

/** Ngưỡng slow query (ms) — cấu hình qua SLOW_QUERY_MS, mặc định 500 */
const SLOW_QUERY_MS = Number(process.env['SLOW_QUERY_MS'] ?? 500);

const slowQueryLog: SqlMiddleware = {
  name: 'slow-query-log',
  familyId: 'sql',
  async afterQuery(_plan, result) {
    if (result.latencyMs < SLOW_QUERY_MS) return;
    // KHÔNG log SQL/params (chứa dữ liệu người dùng) — chỉ số liệu
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        scope: 'db:slow-query',
        latencyMs: result.latencyMs,
        rowCount: result.rowCount,
        source: result.source,
      }),
    );
  },
};

function createDb() {
  return postgres<Contract>({
    contractJson,
    url: process.env['DATABASE_URL'],
    poolOptions: {
      // connect quá 10s = DB/network có vấn đề — fail nhanh thay vì treo request
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    },
    middleware: [slowQueryLog],
  });
}

// Singleton per process. Next dev (HMR) re-eval module có thể tạo pool mới
// mỗi lần — giữ pool trong globalThis để tái dùng, tránh TCP-connect storm.
const g = globalThis as typeof globalThis & { __speakerPlatformDb?: ReturnType<typeof createDb> };
export const db = (g.__speakerPlatformDb ??= createDb());
