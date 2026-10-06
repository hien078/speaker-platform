import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { requireCapability, capabilitiesOf } from "@/src/lib/rbac";
import { formatDateShort, cn } from "@/src/lib/utils";
import { ROLE_LABELS } from "@/src/lib/constants";
import { setBetaMembershipAction } from "@/src/lib/actions/beta-cohort";
import { revokeAllUserSessionsAction } from "@/src/lib/actions/admin-identity";
import { Users, BadgeCheck, Search, History } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Người dùng" };

/**
 * Batch 2 Task 10 (spec §8.2/§2.1/§8.4): cột "Xác minh" giờ là hiển thị
 * LEGACY (User.isVerifiedSeller — badge "legacy", KHÔNG còn nút mutate; workflow
 * SellerVerification là canonical). Thao tác trên từng user:
 *  - founding_seller membership grant/suspend (setBetaMembershipAction —
 *    beta_cohort.manage; nút lọc theo capability là CONVENIENCE, action tự guard);
 *  - link sang hàng đợi review /admin/seller-verification?q=<userId>;
 *  - thu hồi phiên (Task 9).
 */
export default async function AdminUsersPage({
  searchParams,
}: PageProps<"/admin/users">) {
  // Guard server-side (spec §4.5) — user.view_basic: super/ops (ma trận §5.4.1).
  const admin = await requireCapability("user.view_basic");
  // Nút lọc theo capability — CONVENIENCE (spec §4.5); action tự requireCapability.
  const canRevokeSessions = capabilitiesOf(admin.user.adminRole).includes("session.revoke");
  const canManageCohort = capabilitiesOf(admin.user.adminRole).includes("beta_cohort.manage");
  const sp = (await searchParams) as { q?: string; role?: string };
  const q = sp.q?.trim() ?? "";
  type UserRole = "buyer" | "seller" | "admin";
  const role = sp.role && ROLE_LABELS[sp.role] ? (sp.role as UserRole) : undefined;

  let query = db.orm.public.User
    .select("id", "name", "email", "phone", "role", "city", "isVerifiedSeller", "createdAt")
    .orderBy((u) => u.createdAt.desc())
    .limit(100);

  if (role) query = query.where({ role });
  if (q) {
    // tìm theo tên hoặc email
    const like = `%${q}%`;
    query = query.where((u) => u.email.ilike(like));
    // tên riêng query thứ hai bên dưới
  }

  let users = await query.all();
  if (q) {
    const like = `%${q}%`;
    const byName = await db.orm.public.User
      .where((u) => u.name.ilike(like))
      .select("id", "name", "email", "phone", "role", "city", "isVerifiedSeller", "createdAt")
      .all();
    const seen = new Set(users.map((u) => u.id));
    users = [...users, ...byName.filter((u) => !seen.has(u.id))];
  }

  // đếm listing & đơn + founding_seller membership của từng user (hiển thị nhanh)
  const enriched = await Promise.all(
    users.map(async (u) => {
      const [listings, orders, founding] = await Promise.all([
        db.orm.public.Listing.where({ sellerId: u.id }).aggregate((a) => ({ c: a.count() })),
        db.orm.public.Order
          .where({ sellerId: u.id })
          .where({ status: "completed" })
          .aggregate((a) => ({ c: a.count() })),
        db.orm.public.BetaCohortMembership.first({ userId: u.id, cohort: "founding_seller" }),
      ]);
      return {
        ...u,
        listingCount: listings.c,
        completedSales: orders.c,
        foundingStatus: founding?.status ?? null,
      };
    }),
  );

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Users className="size-6 text-[var(--accent)]" />
        Người dùng
      </h1>

      {/* Bộ lọc */}
      <form action="/admin/users" className="mt-5 flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
          <input name="q" defaultValue={q} className="input pl-9 text-sm" placeholder="Tên hoặc email…" />
        </div>
        <select name="role" defaultValue={role ?? ""} className="input w-40 text-sm">
          <option value="">Tất cả vai trò</option>
          {Object.entries(ROLE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <button type="submit" className="btn-secondary px-4 text-sm">Lọc</button>
      </form>

      <div className="table-wrap mt-5">
        <table className="table-base">
          <thead>
            <tr>
              <th>Người dùng</th>
              <th>Vai trò</th>
              <th>Khu vực</th>
              <th>Tin đăng</th>
              <th>Đã bán</th>
              <th>Xác minh (legacy)</th>
              <th>founding_seller</th>
              <th>Tham gia</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-[var(--muted)]">Không tìm thấy người dùng</td>
              </tr>
            ) : (
              enriched.map((u) => (
                <tr key={u.id}>
                  <td>
                    <p className="text-sm font-semibold">{u.name}</p>
                    <p className="text-xs text-[var(--muted)]">{u.email}{u.phone ? ` · ${u.phone}` : ""}</p>
                  </td>
                  <td>
                    <span className={cn(
                      "badge",
                      u.role === "admin" ? "bg-[var(--red-soft)] text-[var(--red)]" :
                      u.role === "seller" ? "bg-[var(--accent-soft)] text-[var(--accent)]" :
                      "bg-[#eaf2fb] text-[#2563a8]",
                    )}>
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td className="text-xs text-[var(--ink-2)]">{u.city ?? "—"}</td>
                  <td className="text-sm">{u.listingCount}</td>
                  <td className="text-sm">{u.completedSales}</td>
                  <td>
                    {u.isVerifiedSeller ? (
                      <span className="badge bg-[var(--green-soft)] text-[var(--green)]">
                        <BadgeCheck className="size-3" />
                        Đã xác minh
                        <span className="ml-1 rounded bg-black/10 px-1 text-[9px] uppercase">legacy</span>
                      </span>
                    ) : (
                      <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">Chưa</span>
                    )}
                  </td>
                  <td>
                    <span className={cn(
                      "badge",
                      u.foundingStatus === "active" ? "bg-[var(--green-soft)] text-[var(--green)]" :
                      u.foundingStatus ? "bg-amber-500/15 text-amber-600" :
                      "bg-[var(--paper-deep)] text-[var(--ink-2)]",
                    )}>
                      {u.foundingStatus ?? "—"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDateShort(u.createdAt)}</td>
                  <td>
                    <div className="flex flex-col gap-1.5">
                      <Link
                        href={`/admin/seller-verification?q=${u.id}`}
                        className="btn-secondary flex h-8 items-center gap-1 px-3 text-xs"
                        title="Xem hồ sơ SellerVerification của người dùng này"
                      >
                        <History className="size-3.5" />
                        Hồ sơ xác minh
                      </Link>
                      {canManageCohort && (
                        <>
                          {u.foundingStatus !== "active" ? (
                            <form action={setBetaMembershipAction}>
                              <input type="hidden" name="userId" value={u.id} />
                              <input type="hidden" name="cohort" value="founding_seller" />
                              <input type="hidden" name="status" value="active" />
                              <button
                                type="submit"
                                className="btn h-8 bg-[var(--green)] px-3 text-xs text-white hover:opacity-90"
                                title="Cấp founding_seller active — điều kiện publication (spec §2.1)"
                              >
                                Cấp founding_seller
                              </button>
                            </form>
                          ) : (
                            <form action={setBetaMembershipAction}>
                              <input type="hidden" name="userId" value={u.id} />
                              <input type="hidden" name="cohort" value="founding_seller" />
                              <input type="hidden" name="status" value="suspended" />
                              <button
                                type="submit"
                                className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
                                title="Tạm dừng founding_seller — chặn publication NGAY (gate đọc FRESH)"
                              >
                                Tạm dừng
                              </button>
                            </form>
                          )}
                        </>
                      )}
                      {canRevokeSessions && (
                        <form action={revokeAllUserSessionsAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <button
                            type="submit"
                            className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
                            title="Đăng xuất mọi thiết bị của người dùng này (audit session.revoked_all)"
                          >
                            Thu hồi phiên
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
