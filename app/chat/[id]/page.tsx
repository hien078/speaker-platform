import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { ChatWindow } from "@/src/components/chat-window";
import { formatVND } from "@/src/lib/utils";
import { ArrowLeft, Handshake } from "lucide-react";

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
          {listing && (
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
        </div>

        {/* CTA trao đổi */}
        {listing && listing.acceptExchange && convo.buyerId === user.id && listing.status === "approved" && (
          <div className="border-b border-[var(--line)] bg-[#2563a8]/5 px-4 py-2.5">
            <Link
              href={`/listings/${listing.slug}/exchange`}
              className="flex items-center gap-2 text-xs font-semibold text-[#2563a8] hover:text-sky-200"
            >
              <Handshake className="size-3.5" />
              Tin này nhận trao đổi — gửi đề nghị đổi loa + tiền bù
            </Link>
          </div>
        )}

        {/* Cửa sổ chat */}
        <ChatWindow conversationId={convo.id} myUserId={user.id} />
      </div>
    </main>
  );
}
