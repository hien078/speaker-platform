import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { EXCHANGE_STATUS_LABELS } from "@/src/lib/constants";
import {
  respondExchangeOfferAction,
  payExchangeTopupAction,
  completeExchangeAction,
  cancelExchangeOfferAction,
} from "@/src/lib/actions/exchange";
import { Handshake, ArrowLeftRight, CheckCircle2, XCircle, Ban, Banknote } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trao đổi" };

const STATUS_BADGE: Record<string, string> = {
  proposed: "bg-amber-500/15 text-amber-400",
  accepted: "bg-sky-500/15 text-sky-400",
  paid: "bg-violet-500/15 text-violet-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-red-500/15 text-red-400",
  cancelled: "bg-zinc-700/60 text-zinc-300",
};

export default async function ExchangePage({
  searchParams,
}: PageProps<"/exchange">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const sp = (await searchParams) as { sent?: string };

  // đề nghị tôi gửi đi
  const sent = await db.orm.public.ExchangeOffer
    .where({ buyerId: user.id })
    .include("listing", (l) =>
      l.select("id", "title", "slug", "price", "sellerId")
        .include("seller", (s) => s.select("name"))
        .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)),
    )
    .include("myListing", (l) => l.select("title", "slug").include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)))
    .include("payment", (p) => p.select("status"))
    .orderBy((o) => o.createdAt.desc())
    .all();

  // đề nghị nhận được (trên tin của tôi)
  const myListingIds = (await db.orm.public.Listing
    .where({ sellerId: user.id })
    .select("id")
    .all()).map((l) => l.id);

  const received: typeof sent = [];
  for (const listingId of myListingIds) {
    const offers = await db.orm.public.ExchangeOffer
      .where({ listingId })
      .include("listing", (l) =>
        l.select("id", "title", "slug", "price", "sellerId")
          .include("seller", (s) => s.select("name"))
          .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)),
      )
      .include("myListing", (l) => l.select("title", "slug").include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)))
      .include("payment", (p) => p.select("status"))
      .all();
    received.push(...offers);
  }
  received.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function OfferCard({ offer, role }: { offer: typeof sent[number]; role: "sent" | "received" }) {
    const target = offer.listing!;
    const mine = offer.myListing;
    const isSeller = role === "received";

    return (
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cn("badge", STATUS_BADGE[offer.status])}>
            {EXCHANGE_STATUS_LABELS[offer.status]}
          </span>
          <span className="text-xs text-zinc-500">{formatDate(offer.createdAt)}</span>
        </div>

        {/* Hai sản phẩm */}
        <div className="mt-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {isSeller ? "Người mua đưa ra" : "Bạn đưa ra"}
            </p>
            {mine ? (
              <Link href={`/listings/${mine.slug}`} className="mt-1 flex items-center gap-2">
                <div className="size-10 shrink-0 overflow-hidden rounded-md bg-zinc-900">
                  {mine.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mine.images[0].url} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-zinc-700">🔇</span>
                  )}
                </div>
                <p className="line-clamp-1 text-xs font-medium hover:text-amber-300">{mine.title}</p>
              </Link>
            ) : (
              <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{offer.myItemDescription}</p>
            )}
          </div>

          <ArrowLeftRight className="size-4 shrink-0 text-amber-400" />

          <div className="min-w-0 flex-1 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Đổi lấy
            </p>
            <Link href={`/listings/${target.slug}`} className="mt-1 flex flex-row-reverse items-center gap-2">
              <div className="size-10 shrink-0 overflow-hidden rounded-md bg-zinc-900">
                {target.images[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={target.images[0].url} alt="" className="size-full object-cover" />
                ) : (
                  <span className="grid size-full place-items-center text-zinc-700">🔇</span>
                )}
              </div>
              <p className="line-clamp-1 text-xs font-medium hover:text-amber-300">{target.title}</p>
            </Link>
          </div>
        </div>

        {/* Tiền bù */}
        <div className="mt-4 flex items-center justify-between rounded-lg bg-zinc-800/50 px-3.5 py-2.5 text-sm">
          <span className="text-zinc-400">
            <Banknote className="mr-1.5 inline size-4 text-amber-400" />
            Tiền bù
          </span>
          <span className="font-bold text-amber-400">
            {offer.cashTopup > 0 ? `+${formatVND(offer.cashTopup)}` : "Không bù tiền"}
          </span>
        </div>

        {offer.message && (
          <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs leading-relaxed text-zinc-300">
            “{offer.message}”
          </p>
        )}

        {/* Hành động */}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
          {isSeller && offer.status === "proposed" && (
            <>
              <form action={respondExchangeOfferAction} className="flex-1">
                <input type="hidden" name="offerId" value={offer.id} />
                <input type="hidden" name="response" value="accept" />
                <button type="submit" className="btn-primary h-9 w-full text-sm">
                  <CheckCircle2 className="size-4" />
                  Chấp nhận trao đổi
                </button>
              </form>
              <form action={respondExchangeOfferAction} className="flex-1">
                <input type="hidden" name="offerId" value={offer.id} />
                <input type="hidden" name="response" value="reject" />
                <button type="submit" className="btn-secondary h-9 w-full text-sm">
                  <XCircle className="size-4" />
                  Từ chối
                </button>
              </form>
            </>
          )}

          {!isSeller && offer.status === "accepted" && offer.cashTopup > 0 && (
            <form action={payExchangeTopupAction} className="w-full">
              <input type="hidden" name="offerId" value={offer.id} />
              <button type="submit" className="btn-primary h-9 w-full text-sm">
                <Banknote className="size-4" />
                Nạp {formatVND(offer.cashTopup)} tiền bù qua escrow
              </button>
            </form>
          )}

          {offer.status === "paid" && (
            <form action={completeExchangeAction} className="w-full">
              <input type="hidden" name="offerId" value={offer.id} />
              <button type="submit" className="btn-primary h-9 w-full text-sm">
                <CheckCircle2 className="size-4" />
                {isSeller ? "Đã trao đổi xong — nhận tiền bù" : "Xác nhận trao đổi hoàn tất"}
              </button>
            </form>
          )}

          {offer.status === "accepted" && offer.cashTopup === 0 && (
            <form action={completeExchangeAction} className="w-full">
              <input type="hidden" name="offerId" value={offer.id} />
              <button type="submit" className="btn-primary h-9 w-full text-sm">
                <CheckCircle2 className="size-4" />
                Xác nhận trao đổi hoàn tất
              </button>
            </form>
          )}

          {!isSeller && ["proposed", "accepted"].includes(offer.status) && (
            <form action={cancelExchangeOfferAction} className="w-full">
              <input type="hidden" name="offerId" value={offer.id} />
              <button type="submit" className="btn-ghost h-9 w-full text-sm text-zinc-400 hover:text-red-400">
                <Ban className="size-4" />
                Rút đề nghị
              </button>
            </form>
          )}

          <Link href="/chat" className="btn-ghost h-9 flex-1 text-sm">
            💬 Chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Handshake className="size-6 text-sky-400" />
        Giao dịch trao đổi
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Đổi loa lấy loa + tiền bù — phần tiền bù được bảo vệ bằng escrow.
      </p>

      {sp.sent === "1" && (
        <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          ✓ Đề nghị đã gửi! Người bán sẽ phản hồi qua tin nhắn.
        </div>
      )}

      {/* ─── Nhận được ─── */}
      <section className="mt-8">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Đề nghị nhận được ({received.length})
        </h2>
        <div className="mt-4 space-y-4">
          {received.length === 0 ? (
            <p className="card p-6 text-center text-sm text-zinc-500">
              Chưa có ai đề nghị trao đổi tin của bạn.
            </p>
          ) : (
            received.map((o) => <OfferCard key={o.id} offer={o} role="received" />)
          )}
        </div>
      </section>

      {/* ─── Gửi đi ─── */}
      <section className="mt-10">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Đề nghị bạn đã gửi ({sent.length})
        </h2>
        <div className="mt-4 space-y-4">
          {sent.length === 0 ? (
            <p className="card p-6 text-center text-sm text-zinc-500">
              Bạn chưa gửi đề nghị trao đổi nào.{" "}
              <Link href="/listings?exchange=1" className="text-amber-400 hover:underline">
                Xem các loa nhận trao đổi →
              </Link>
            </p>
          ) : (
            sent.map((o) => <OfferCard key={o.id} offer={o} role="sent" />)
          )}
        </div>
      </section>
    </main>
  );
}
