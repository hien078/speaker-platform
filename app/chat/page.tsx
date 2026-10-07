import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { timeAgo, cn } from "@/src/lib/utils";
import { MessageCircle, MessagesSquare } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tin nhắn" };

export default async function ChatListPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // hội thoại nơi tôi là buyer hoặc seller
  // b4-holistic round-3 (LOW — chat leak): select thêm status — listing
  // pending/rejected/removed KHÔNG hiển thị title/ảnh cho viewer không phải
  // seller (content chưa duyệt edit in-place; trang detail đã 404).
  const [asBuyer, asSeller] = await Promise.all([
    db.orm.public.Conversation
      .where({ buyerId: user.id })
      .include("seller", (s) => s.select("id", "name"))
      .include("listing", (l) => l.select("title", "slug", "status", "sellerId").include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)))
      .orderBy((c) => c.lastMessageAt.desc())
      .all(),
    db.orm.public.Conversation
      .where({ sellerId: user.id })
      .include("buyer", (b) => b.select("id", "name"))
      .include("listing", (l) => l.select("title", "slug", "status", "sellerId").include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)))
      .orderBy((c) => c.lastMessageAt.desc())
      .all(),
  ]);

  const conversations = [
    ...asBuyer.map((c) => ({ convo: c, role: "buyer" as const, other: c.seller })),
    ...asSeller.map((c) => ({ convo: c, role: "seller" as const, other: c.buyer })),
  ].sort((a, b) => (b.convo.lastMessageAt ?? b.convo.createdAt).localeCompare(a.convo.lastMessageAt ?? a.convo.createdAt));

  // b4-holistic round-3: listing công khai = approved | hidden | sold HOẶC viewer
  // là seller CỦA TIN (convo.sellerId === user.id — seller thấy tin mình mọi
  // status). Row không công khai → placeholder trung tính, KHÔNG ảnh/title.
  const listingVisible = (l: { status: string; sellerId: string } | null): boolean =>
    l != null &&
    (l.sellerId === user.id || l.status === "approved" || l.status === "hidden" || l.status === "sold");

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <MessagesSquare className="size-6 text-[var(--accent)]" />
        Tin nhắn
      </h1>

      {conversations.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">💬</span>
          <p className="text-lg font-bold">Chưa có hội thoại nào</p>
          <p className="text-sm text-[var(--muted)]">
            Vào trang tin đăng và bấm “Nhắn người bán” để bắt đầu trao đổi.
          </p>
          <Link href="/listings" className="btn-primary mt-2 text-sm">Đi đến chợ loa</Link>
        </div>
      ) : (
        <div className="mt-8 space-y-2.5">
          {conversations.map(({ convo, role, other }) => {
            const image = listingVisible(convo.listing) ? convo.listing?.images[0]?.url : undefined;
            return (
              <Link
                key={convo.id}
                href={`/chat/${convo.id}`}
                className="card flex items-center gap-4 p-4 transition hover:border-[var(--accent)]/45"
              >
                <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-xl text-[var(--muted)]">🔇</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-bold">{other!.name}</p>
                    <span className={cn("badge", role === "buyer" ? "bg-[#eaf2fb] text-[#2563a8]" : "bg-[var(--accent-soft)] text-[var(--accent)]")}>
                      {role === "buyer" ? "Bạn mua" : "Bạn bán"}
                    </span>
                  </div>
                  {/* b4-holistic round-3: title listing CHỈ hiển thị khi công khai
                      (approved/hidden/sold) hoặc viewer là seller của tin — content
                      pending/rejected/removed → placeholder trung tính. */}
                  <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                    {convo.listing != null && !listingVisible(convo.listing)
                      ? "Tin đăng không còn hiển thị"
                      : (convo.listing?.title ?? "Hội thoại")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <MessageCircle className="ml-auto size-4 text-[var(--muted)]" />
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    {timeAgo(convo.lastMessageAt ?? convo.createdAt)}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
