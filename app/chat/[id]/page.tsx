import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { getBlockState, isUserSuspended } from "@/src/lib/moderation";
import { unblockUserAction } from "@/src/lib/actions/blocks";
import { ReportDialog } from "@/src/components/report-dialog";
import { ChatWindow } from "@/src/components/chat-window";
import { DealPanel } from "@/src/components/deal-panel";
import { SafetyGuidance } from "@/src/components/safety-guidance";
import { formatVND } from "@/src/lib/utils";
import { ArrowLeft, Ban, ShieldX } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: PageProps<"/chat/[id]">) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const convo = await db.orm.public.Conversation
    .where({ id })
    .include("buyer", (b) => b.select("id", "name"))
    .include("seller", (s) => s.select("id", "name"))
    .include("listing", (l) =>
      l.select("id", "title", "slug", "price", "status", "acceptExchange")
        .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)),
    )
    .first();

  if (!convo) notFound();
  if (convo.buyerId !== user.id && convo.sellerId !== user.id) notFound();

  const other = (convo.buyerId === user.id ? convo.seller : convo.buyer)!;
  const listing = convo.listing;

  // b4-holistic round-3 (LOW — chat leak): listing KHÔNG còn công khai
  // (pending/rejected/removed/draft) → buyer KHÔNG được thấy title/ảnh/giá
  // MỚI (seller edit in-place content chưa duyệt — trang detail đã 404, chat
  // là nơi duy nhất còn lộ). Viewer là SELLER của tin (convo.sellerId) hoặc
  // status ∈ {approved, hidden, sold} → hiển thị đầy đủ; ngược lại placeholder
  // trung tính KHÔNG ảnh KHÔNG link. Lịch sử chat vẫn đọc được.
  const listingVisible =
    listing != null &&
    (convo.sellerId === user.id ||
      listing.status === "approved" ||
      listing.status === "hidden" ||
      listing.status === "sold");

  // Batch 3 Task 3 (spec §5.5/§7.8) — banner direction-aware + composer
  // disabled. UI CONVENIENCE: route POST là boundary (403 CHAT_BLOCKED /
  // ACCOUNT_SUSPENDED kể cả khi composer bị bypass); lịch sử vẫn đọc được.
  // Viewer bị đình chỉ đọc FRESH từ DB mỗi render (P1: không cache theo session).
  const [blockState, viewerSuspended] = await Promise.all([
    getBlockState(user.id, other.id),
    isUserSuspended(user.id),
  ]);
  const composerDisabled = blockState !== "none" || viewerSuspended;

  // Batch 6 Task 6b (S11 — spec §5.2): deal của hội thoại tra THEO
  // conversationId (Deal.conversationId không FK — deal sống qua listing
  // deletion), KHÔNG theo (listingId, buyerId). Deal MỚI NHẤT của hội thoại —
  // deal terminal không chặn buyer tạo deal mới (D4; panel tự render form
  // tạo mới ở dưới trạng thái cuối).
  const deal = await db.orm.public.Deal
    .where({ conversationId: convo.id })
    .orderBy((d) => d.createdAt.desc())
    .first();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 lg:px-8">
      <Link href="/chat" className="btn-ghost mb-4 h-9 px-3 text-sm">
        <ArrowLeft className="size-4" />
        Tất cả hội thoại
      </Link>

      <div className="card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] p-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs font-bold text-white">
              {other.name.split(" ").map((w) => w[0]).slice(-2).join("").toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{other.name}</p>
              <p className="text-[11px] text-[var(--muted)]">
                {convo.buyerId === user.id ? "Người bán" : "Người mua"} · phản hồi thường trong vài giờ
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Bỏ chặn — CHỈ khi viewer là người chặn (direction-aware, spec §5.5) */}
            {blockState === "viewer_blocked" && (
              <form action={unblockUserAction}>
                <input type="hidden" name="userId" value={other.id} />
                <button
                  type="submit"
                  className="btn-secondary h-8 px-3 text-xs"
                  title="Bỏ chặn để gửi tin nhắn lại được"
                >
                  <Ban className="size-3.5" />
                  Bỏ chặn
                </button>
              </form>
            )}
            {/* Báo cáo người đối thoại (Batch 3 Task 4 — spec §5.5) — UI
                convenience; action tự enforce auth + self-report server-side. */}
            {other.id !== user.id && (
              <ReportDialog
                targetType="user"
                targetId={other.id}
                triggerLabel="Báo cáo"
                className="btn-secondary h-8 px-3 text-xs text-[var(--red)] hover:border-[var(--red)]/40 hover:bg-[var(--red-soft)]"
              />
            )}
            {listing && listingVisible && (
              <Link
                href={`/listings/${listing.slug}`}
                className="hidden min-w-0 items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2 transition hover:border-[var(--accent)]/45 sm:flex"
              >
                <div className="size-9 shrink-0 overflow-hidden rounded-md bg-[var(--paper-deep)]">
                  {listing.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={listing.images[0].url} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-[var(--muted)]">🔇</span>
                  )}
                </div>
                <div className="min-w-0 max-w-44">
                  <p className="truncate text-xs font-medium">{listing.title}</p>
                  <p className="text-xs font-bold text-[var(--accent)]">{formatVND(listing.price)}</p>
                </div>
              </Link>
            )}
            {listing && !listingVisible && (
              /* b4-holistic round-3: placeholder trung tính — KHÔNG title/ảnh/
                  giá/link của content chưa duyệt đã bị gỡ */
              <span className="hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2 text-xs text-[var(--muted)] sm:block">
                Tin đăng không còn hiển thị
              </span>
            )}
          </div>
        </div>

        {/* Banner direction-aware (Batch 3 Task 3) — composer tắt theo cùng điều kiện */}
        {composerDisabled && (
          <div
            className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-xs leading-relaxed text-[var(--ink-2)]"
            role="status"
          >
            <ShieldX className="size-4 shrink-0 text-[var(--red)]" />
            {viewerSuspended ? (
              <span>
                <strong className="font-semibold">Tài khoản đang bị đình chỉ.</strong> Bạn không thể
                gửi tin nhắn cho đến khi đình chỉ được gỡ.
              </span>
            ) : blockState === "viewer_blocked" ? (
              <span>
                <strong className="font-semibold">Bạn đã chặn người này.</strong> Bỏ chặn để gửi tin
                nhắn tiếp — lịch sử cũ vẫn đọc được.
              </span>
            ) : (
              <span>
                <strong className="font-semibold">Người này đã chặn bạn.</strong> Bạn không thể gửi
                tin nhắn trong hội thoại này — lịch sử cũ vẫn đọc được.
              </span>
            )}
          </div>
        )}

        {/* Cửa sổ chat */}
        <ChatWindow
          conversationId={convo.id}
          myUserId={user.id}
          disabled={composerDisabled}
        />
      </div>

      {/* Thỏa thuận §5.2 (Batch 6 Task 6b) — panel nhận deal đã load theo
          conversationId ở trên + listing theo redaction listingVisible
          (corrections #15 — viewer không được thấy content của tin đã gỡ);
          viewerRole từ convo (buyer/seller của hội thoại). */}
      <DealPanel
        deal={deal}
        listing={
          listing && listingVisible
            ? { id: listing.id, title: listing.title, status: listing.status }
            : null
        }
        viewerRole={user.id === convo.buyerId ? "buyer" : "seller"}
      />

      {/* §6.4 — hướng dẫn an toàn giao dịch, MỘT LẦN, sau panel (Task 6a
          component; panel KHÔNG tự render — tránh render đôi). */}
      <SafetyGuidance className="card mt-4 p-4 text-sm text-[var(--ink-2)]" />
    </main>
  );
}
