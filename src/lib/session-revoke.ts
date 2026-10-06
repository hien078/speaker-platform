// Review fix D1: import RELATIVE (KHÔNG alias `@/`) — chuỗi import của
// scripts/admin-bootstrap.ts phải chạy dưới tsx trong container migrate
// (Dockerfile stage migrate KHÔNG copy tsconfig.json → alias không resolve).
import { db } from "../prisma/db.client";

/**
 * Thu hồi session BÊN TRONG transaction — Batch 2 Task 11 tách từ
 * src/lib/session.ts thành plain module (session.ts có "server-only" +
 * next/headers nên offline bootstrap script tsx không import được; script
 * cần ĐÚNG helper này để promote/reset MFA thu hồi session sống chết cùng
 * mutation trong MỘT tx). session.ts re-export — mọi import hiện tại
 * (`@/src/lib/session`) không đổi, hành vi GIỮ NGUYÊN.
 *
 * MỘT updateAll với predicate loại trừ tùy chọn (AND-compose với các mệnh đề
 * trước) — idempotent với session đã revoke, không đụng user khác.
 *
 * opts.exceptSessionId: giữ session chỉ định sống — verification.ts (đổi
 * password/email/phone) truyền session hiện tại; Task 7 recovery KHÔNG truyền
 * except — thu hồi TẤT CẢ, kể cả session hiện tại; Task 11 (role change /
 * mfa-reset) KHÔNG truyền except — buộc login lại qua MFA.
 */

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Thu hồi mọi session active của user BÊN TRONG transaction truyền vào.
 * Trả về số session vừa thu hồi (chưa từng revoke trước đó).
 */
export async function revokeAllUserSessionsTx(
  tx: TxContext,
  userId: string,
  reason: string,
  opts?: { exceptSessionId?: string },
): Promise<number> {
  const data = { revokedAt: new Date().toISOString(), revokedReason: reason };
  const except = opts?.exceptSessionId;
  // MỘT updateAll — predicate loại trừ tùy chọn AND-compose với các mệnh đề trước
  let query = tx.orm.public.UserSession
    .where({ userId })
    .where((s) => s.revokedAt.isNull());
  if (except !== undefined) {
    query = query.where((s) => s.id.neq(except));
  }
  const revoked = await query.updateAll(data);
  return revoked.length;
}
