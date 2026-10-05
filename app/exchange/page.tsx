import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { financialFeaturesEnabled } from "@/src/lib/financial-features";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { EXCHANGE_STATUS_LABELS } from "@/src/lib/constants";
import {
  respondExchangeOfferAction,
  payExchangeTopupAction,
  completeExchangeAction,
  cancelExchangeOfferAction,
} from "@/src/lib/actions/exchange";
import { ExchangeTopupButton } from "@/src/components/exchange-topup-button";
import { isMomoConfigured } from "@/src/lib/momo";
import { Handshake, ArrowLeftRight, CheckCircle2, XCircle, Ban, Banknote } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trao đổi" };

const STATUS_BADGE: Record<string, string> = {
  proposed: "bg-[var(--accent-soft)] text-[var(--accent)]",
  accepted: "bg-[#eaf2fb] text-[#2563a8]",
  paid: "bg-[var(--violet-soft)] text-[var(--violet)]",
  completed: "bg-[var(--green-soft)] text-[var(--green)]",
  rejected: "bg-[var(--red-soft)] text-[var(--red)]",
  cancelled: "bg-[var(--paper-deep)] text-[var(--ink-2)]",
};

export default async function ExchangePage({
  searchParams,
}: PageProps<"/exchange">) {
  // Private beta (Batch 0–1): tài chính tắt mặc định — finance-only page không còn
  // reachable. Kiểm tra ranh giới TRƯỚC mọi read/mutation; code bên dưới giữ
  // nguyên dormant (không xóa code/dữ liệu lịch sử).
  if (!financialFeaturesEnabled()) notFound();

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
          <span className="text-xs text-[var(--muted)]">{formatDate(offer.createdAt)}</span>
        </div>

        {/* Hai sản phẩm */}
        <div className="mt-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              {isSeller ? "Người mua đưa ra" : "Bạn đưa ra"}
            </p>
            {mine ? (
              <Link href={`/listings/${mine.slug}`} className="mt-1 flex items-center gap-2">
                <div className="size-10 shrink-0 overflow-hidden rounded-md bg-[var(--paper-deep)]">
                  {mine.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mine.images[0].url} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-[var(--muted)]">🔇</span>
                  )}
                </div>
                <p className="line-clamp-1 text-xs font-medium hover:text-[var(--accent)]">{mine.title}</p>
              </Link>
            ) : (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--ink-2)]">{offer.myItemDescription}</p>
            )}
          </div>

          <ArrowLeftRight className="size-4 shrink-0 text-[var(--accent)]" />

          <div className="min-w-0 flex-1 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Đổi lấy
            </p>
            <Link href={`/listings/${target.slug}`} className="mt-1 flex flex-row-reverse items-center gap-2">
              <div className="size-10 shrink-0 overflow-hidden rounded-md bg-[var(--paper-deep)]">
                {target.images[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={target.images[0].url} alt="" className="size-full object-cover" />
                ) : (
                  <span className="grid size-full place-items-center text-[var(--muted)]">🔇</span>
                )}
              </div>
              <p className="line-clamp-1 text-xs font-medium hover:text-[var(--accent)]">{target.title}</p>
            </Link>
          </div>
        </div>

        {/* Tiền bù */}
        <div className="mt-4 flex items-center justify-between rounded-lg bg-[var(--paper)] px-3.5 py-2.5 text-sm">
          <span className="text-[var(--ink-2)]">
            <Banknote className="mr-1.5 inline size-4 text-[var(--accent)]" />
            Tiền bù
          </span>
          <span className="font-bold text-[var(--accent)]">
            {offer.cashTopup > 0 ? `+${formatVND(offer.cashTopup)}` : "Không bù tiền"}
          </span>
        </div>

        {offer.message && (
          <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ink-2)]">
            “{offer.message}”
          </p>
        )}

        {/* Hành động */}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--line)] pt-4">
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
            <div className="w-full space-y-2">
              <ExchangeTopupButton offerId={offer.id} amount={offer.cashTopup} momoEnabled={isMomoConfigured()} />
              <form action={payExchangeTopupAction} className="w-full">
                <input type="hidden" name="offerId" value={offer.id} />
                <button type="submit" className="btn-secondary h-9 w-full text-sm">
                  <Banknote className="size-4" />
                  Nạp {formatVND(offer.cashTopup)} qua escrow (mock)
                </button>
              </form>
            </div>
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
              <button type="submit" className="btn-ghost h-9 w-full text-sm text-[var(--ink-2)] hover:text-[var(--red)]">
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
        <Handshake className="size-6 text-[#2563a8]" />
        Giao dịch trao đổi
      </h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Đổi loa lấy loa + tiền bù — phần tiền bù được bảo vệ bằng escrow.
      </p>

      {sp.sent === "1" && (
        <div className="mt-5 rounded-xl border border-[var(--green)]/35 bg-[var(--green-soft)] px-4 py-3 text-sm text-[var(--green)]">
          ✓ Đề nghị đã gửi! Người bán sẽ phản hồi qua tin nhắn.
        </div>
      )}

      {/* ─── Nhận được ─── */}
      <section className="mt-8">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Đề nghị nhận được ({received.length})
        </h2>
        <div className="mt-4 space-y-4">
          {received.length === 0 ? (
            <p className="card p-6 text-center text-sm text-[var(--muted)]">
              Chưa có ai đề nghị trao đổi tin của bạn.
            </p>
          ) : (
            received.map((o) => <OfferCard key={o.id} offer={o} role="received" />)
          )}
        </div>
      </section>

      {/* ─── Gửi đi ─── */}
      <section className="mt-10">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Đề nghị bạn đã gửi ({sent.length})
        </h2>
        <div className="mt-4 space-y-4">
          {sent.length === 0 ? (
            <p className="card p-6 text-center text-sm text-[var(--muted)]">
              Bạn chưa gửi đề nghị trao đổi nào.{" "}
              <Link href="/listings?exchange=1" className="text-[var(--accent)] hover:underline">
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
