import { db } from "../prisma/db.client";

/**
 * Admin role invariants dùng chung action + script (Batch 2 Task 11 review fix
 * D2/D6) — plain module, import RELATIVE (KHÔNG alias `@/`): chuỗi import của
 * scripts/admin-bootstrap.ts phải chạy được dưới tsx TRONG container migrate
 * (Dockerfile stage migrate KHÔNG copy tsconfig.json → alias không resolve —
 * review fix D1).
 *
 *  - assertNotLastSuperAdminTx (D2): guard last-super-admin RACE-SAFE — lock
 *    mọi row super_admin bằng no-op update (row locks) rồi đếm từ KẾT QUẢ đã
 *    lock, loại đích. Hai tx demote chéo 2 super_admin cuối cùng: tx sau khi
 *    được unblock thấy row của tx trước ĐÃ demote → Postgres re-evaluate WHERE
 *    (READ COMMITTED) → row đó không còn khớp → count 0 → LAST_SUPER_ADMIN →
 *    đúng MỘT tx thắng (spec §5.4.2 tránh khóa admin vĩnh viễn).
 *  - resolveNonAdminRoleTx (D6): role display sau khi GỠ quyền quản trị —
 *    "seller" nếu có SellerVerification row HOẶC listing, else "buyer"
 *    (spec §8.5: adminRole là nguồn quyền; role chỉ còn display).
 */

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * D2 — throw LAST_SUPER_ADMIN khi `targetUserId` là super_admin cuối cùng
 * (đếm những super_admin KHÁC đích). Phải gọi BÊN TRONG transaction, TRƯỚC
 * compare-and-set: no-op update dưới lấy row locks trên mọi row super_admin —
 * tx demote chéo song song block ở đây, và khi được unblock, WHERE được đánh
 * giá LẠI trên giá trị MỚI NHẤT đã commit (row đã demote không còn khớp).
 *
 * No-op update ghi ĐÚNG giá trị đang có (adminRole="super_admin" WHERE
 * adminRole="super_admin") — không đổi dữ liệu, chỉ lấy locks.
 */
export async function assertNotLastSuperAdminTx(
  tx: TxContext,
  targetUserId: string,
): Promise<void> {
  // Row locks trên mọi super_admin (Postgres re-eval WHERE sau khi tx chặn commit)
  const locked = await tx.orm.public.User
    .where({ adminRole: "super_admin" })
    .updateAll({ adminRole: "super_admin" }); // no-op giá trị — chỉ locks
  const others = locked.filter((u) => u.id !== targetUserId);
  if (others.length === 0) {
    throw new Error(
      "LAST_SUPER_ADMIN: không thể hạ/gỡ super_admin cuối cùng — cấp super_admin thứ hai trước (runbook §4)",
    );
  }
}

/**
 * D6 — role display của user sau khi gỡ quyền quản trị: "seller" nếu có
 * SellerVerification row HOẶC listing (dấu vết người bán), else "buyer".
 * Caller chỉ áp dụng khi User.role === "admin" (cần restore); role
 * "seller"/"buyer" hiện tại giữ nguyên — không đè.
 */
export async function resolveNonAdminRoleTx(
  tx: TxContext,
  userId: string,
): Promise<"seller" | "buyer"> {
  const verification = await tx.orm.public.SellerVerification.first({ userId });
  if (verification !== null) return "seller";
  const listing = await tx.orm.public.Listing.where({ sellerId: userId }).first();
  if (listing !== null) return "seller";
  return "buyer";
}
