import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { formatDateShort, cn } from "@/src/lib/utils";
import { ROLE_LABELS } from "@/src/lib/constants";
import { toggleSellerVerificationAction } from "@/src/lib/actions/admin";
import { Users, BadgeCheck, Search } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Người dùng" };

export default async function AdminUsersPage({
  searchParams,
}: PageProps<"/admin/users">) {
  // Guard server-side (spec §4.5) — user.view_basic: super/ops (ma trận §5.4.1).
  await requireCapability("user.view_basic");
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

  // đếm listing & đơn của từng user (hiển thị nhanh)
  const enriched = await Promise.all(
    users.map(async (u) => {
      const [listings, orders] = await Promise.all([
        db.orm.public.Listing.where({ sellerId: u.id }).aggregate((a) => ({ c: a.count() })),
        db.orm.public.Order
          .where({ sellerId: u.id })
          .where({ status: "completed" })
          .aggregate((a) => ({ c: a.count() })),
      ]);
      return { ...u, listingCount: listings.c, completedSales: orders.c };
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
              <th>Xác minh</th>
              <th>Tham gia</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-[var(--muted)]">Không tìm thấy người dùng</td>
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
                      </span>
                    ) : (
                      <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">Chưa</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDateShort(u.createdAt)}</td>
                  <td>
                    {u.role !== "admin" && (
                      <form action={toggleSellerVerificationAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <button
                          type="submit"
                          className={cn(
                            "btn h-8 px-3 text-xs",
                            u.isVerifiedSeller
                              ? "bg-[var(--paper-deep)] text-[var(--ink-2)] hover:bg-zinc-600"
                              : "bg-[var(--green)] text-white hover:opacity-90",
                          )}
                        >
                          {u.isVerifiedSeller ? "Bỏ xác minh" : "Xác minh seller"}
                        </button>
                      </form>
                    )}
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
