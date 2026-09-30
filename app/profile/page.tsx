import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { ProfileForm } from "@/src/components/profile-form";
import { formatDate, formatDateShort, formatVND } from "@/src/lib/utils";
import { ROLE_LABELS } from "@/src/lib/constants";
import { UserRound, Package, ShoppingBag, BadgeCheck } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hồ sơ của tôi" };

export default async function ProfilePage() {
  const session = await getCurrentUser();
  if (!session) redirect("/login");

  const user = await db.orm.public.User.first({ id: session.id });
  if (!user) redirect("/login");

  const [listingCount, completedSales, completedBuys, reviewAgg] = await Promise.all([
    db.orm.public.Listing.where({ sellerId: user.id }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.Order.where({ sellerId: user.id, status: "completed" }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.Order.where({ buyerId: user.id, status: "completed" }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.Review.where({ targetUserId: user.id }).aggregate((a) => ({ avg: a.avg("rating"), c: a.count() })),
  ]);

  const initials = user.name.split(" ").map((w) => w[0]).slice(-2).join("").toUpperCase();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <UserRound className="size-6 text-[var(--accent)]" />
        Hồ sơ của tôi
      </h1>

      {/* Thẻ tổng quan */}
      <div className="card mt-6 flex flex-wrap items-center gap-5 p-6">
        <span className="grid size-16 place-items-center rounded-full bg-[var(--accent)] text-lg font-bold text-white">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-lg font-extrabold">
            {user.name}
            {user.isVerifiedSeller && (
              <span className="badge bg-[var(--green-soft)] text-[var(--green)]">
                <BadgeCheck className="size-3" />
                Đã xác minh
              </span>
            )}
          </p>
          <p className="text-sm text-[var(--muted)]">
            {user.email} · {ROLE_LABELS[user.role]} · tham gia {formatDateShort(user.createdAt)}
          </p>
          {reviewAgg.c > 0 && (
            <p className="mt-1 text-sm text-[var(--accent)]">
              ⭐ {reviewAgg.avg?.toFixed(1) ?? "—"}/5 · {reviewAgg.c} đánh giá
            </p>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-xl font-extrabold">{listingCount.c}</p>
            <p className="text-[11px] text-[var(--muted)]">Tin đăng</p>
          </div>
          <div>
            <p className="text-xl font-extrabold text-[var(--green)]">{completedSales.c}</p>
            <p className="text-[11px] text-[var(--muted)]">Đã bán</p>
          </div>
          <div>
            <p className="text-xl font-extrabold text-[#2563a8]">{completedBuys.c}</p>
            <p className="text-[11px] text-[var(--muted)]">Đã mua</p>
          </div>
        </div>
      </div>

      {/* Form chỉnh sửa */}
      <div className="card mt-6 p-6">
        <p className="mb-4 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Chỉnh sửa thông tin
        </p>
        <ProfileForm
          defaults={{
            name: user.name,
            phone: user.phone ?? "",
            city: user.city ?? "",
            bio: user.bio ?? "",
          }}
        />
      </div>
    </main>
  );
}
