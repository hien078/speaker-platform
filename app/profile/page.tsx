import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { listUserSessions } from "@/src/lib/session";
import {
  SELLER_VERIFIED_BADGE_LABEL,
  isVerifiedSellerStatus,
} from "@/src/lib/seller-verification-status";
import { ProfileForm } from "@/src/components/profile-form";
import { VerificationPanel } from "@/src/components/verification-panel";
import { unblockUserAction } from "@/src/lib/actions/blocks";
import { formatDateShort } from "@/src/lib/utils";
import { ROLE_LABELS } from "@/src/lib/constants";
import { UserRound, BadgeCheck, Ban } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hồ sơ của tôi" };

export default async function ProfilePage() {
  const session = await getCurrentUser();
  if (!session) redirect("/login");

  const user = await db.orm.public.User.first({ id: session.id });
  if (!user) redirect("/login");

  // Badge "đã xác minh" đọc WORKFLOW (SellerVerification.status — spec §8.2),
  // không còn boolean legacy isVerifiedSeller (đã đóng băng từ Task 10).
  const verification = await db.orm.public.SellerVerification.first({ userId: user.id });

  // Inventory phiên active của chính mình (Task 9 — spec §5.4.2): user xem và
  // tự thu hồi MỌI session KHÁC (revokeMyOtherSessionsAction — verification.ts).
  const sessions = await listUserSessions(user.id);

  // Danh sách chặn (Batch 3 Task 3 — spec §5.5): row UserBlock do CHÍNH MÌNH
  // tạo (blockerId) — không thể bỏ chặn block của người khác.
  const blocks = await db.orm.public.UserBlock
    .where({ blockerId: user.id })
    .include("blocked", (b) => b.select("id", "name"))
    .orderBy((blk) => blk.createdAt.desc())
    .all();

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
            {isVerifiedSellerStatus(verification?.status) && (
              <span className="badge bg-[var(--green-soft)] text-[var(--green)]">
                <BadgeCheck className="size-3" />
                {SELLER_VERIFIED_BADGE_LABEL}
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

      {/* Xác minh danh tính + bảo mật (Batch 2 Task 6 — spec §5.3/§5.3.1) */}
      <VerificationPanel
        email={user.email}
        emailVerified={user.emailVerifiedAt !== null}
        phone={user.phone}
        phoneVerified={user.phoneVerifiedAt !== null}
        sessions={sessions}
        currentSessionId={session.sessionId}
      />

      {/* Danh sách chặn (Batch 3 Task 3 — spec §5.5) */}
      <div className="card mt-6 p-6">
        <p className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          <Ban className="size-4 text-[var(--red)]" />
          Danh sách chặn
        </p>
        {blocks.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Bạn chưa chặn ai</p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {blocks.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{b.blocked!.name}</p>
                  <p className="text-[11px] text-[var(--muted)]">
                    Chặn từ {formatDateShort(b.createdAt)}
                  </p>
                </div>
                <form action={unblockUserAction} className="shrink-0">
                  <input type="hidden" name="userId" value={b.blockedId} />
                  <button
                    type="submit"
                    className="btn-secondary h-8 px-3 text-xs"
                    title="Bỏ chặn — mở lại hội thoại/tin nhắn mới với người này"
                  >
                    Bỏ chặn
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
          Người bị chặn không bắt đầu hội thoại hoặc gửi tin nhắn mới cho bạn (và ngược lại) —
          lịch sử chat cũ vẫn đọc được.
        </p>
      </div>
    </main>
  );
}
