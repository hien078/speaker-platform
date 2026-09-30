import Link from "next/link";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import {
  respondOfferAction,
  acceptCounterAction,
  cancelOfferAction,
} from "@/src/lib/actions/offers";
import { HandCoins, ArrowLeftRight, CheckCircle2, XCircle, Ban } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  proposed: "Đang chờ seller phản hồi",
  countered: "Seller phản đề nghị",
  accepted: "Đã thỏa thuận — đơn đã tạo",
  rejected: "Bị từ chối",
  cancelled: "Đã rút đề nghị",
  expired: "Quá hạn",
};

const STATUS_BADGE: Record<string, string> = {
  proposed: "bg-[var(--accent-soft)] text-[var(--accent)]",
  countered: "bg-[var(--violet-soft)] text-[var(--violet)]",
  accepted: "bg-[var(--green-soft)] text-[var(--green)]",
  rejected: "bg-[var(--red-soft)] text-[var(--red)]",
  cancelled: "bg-zinc-500/15 text-[var(--ink-2)]",
  expired: "bg-zinc-500/15 text-[var(--ink-2)]",
};

export type OfferWithListing = {
  id: string;
  amount: number;
  counterAmount: number | null;
  message: string | null;
  status: string;
  orderId: string | null;
  expiresAt: string;
  createdAt: string;
  listing: {
    id: string;
    title: string;
    slug: string;
    price: number;
    status: string;
    seller: { name: string };
    images: { url: string }[];
  };
  buyer: { name: string };
};

export function OfferCard({
  offer,
  role,
}: {
  offer: OfferWithListing;
  role: "sent" | "received";
}) {
  const listing = offer.listing;
  const isSeller = role === "received";
  const discount = Math.round(((listing.price - offer.amount) / listing.price) * 100);

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="text-lg font-bold price">
            {formatVND(offer.amount)}
          </p>
          <span className="badge bg-zinc-500/15 text-[var(--ink-2)]">
            −{discount}% so với {formatVND(listing.price)}
          </span>
          <span className={cn("badge", STATUS_BADGE[offer.status])}>
            {STATUS_LABELS[offer.status]}
          </span>
        </div>
        <span className="text-xs text-[var(--muted)]">{formatDate(offer.createdAt)}</span>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Link href={`/listings/${listing.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
          <div className="size-11 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
            {listing.images[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={listing.images[0].url} alt="" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-[var(--muted)]">🔇</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="line-clamp-1 text-sm font-medium hover:text-amber-200">{listing.title}</p>
            <p className="text-xs text-[var(--muted)]">
              {isSeller ? `Đề nghị từ ${offer.buyer.name}` : `Tin của ${listing.seller.name}`}
              {" · hạn phản hồi " + formatDate(offer.expiresAt).split(" ")[0]}
            </p>
          </div>
        </Link>
      </div>

      {offer.message && (
        <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-2 text-xs leading-relaxed text-[var(--ink-2)]">
          “{offer.message}”
        </p>
      )}

      {offer.counterAmount && (
        <p className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--violet)]/30 bg-[var(--violet-soft)] px-3.5 py-2.5 text-sm">
          <ArrowLeftRight className="size-4 text-[var(--violet)]" />
          Seller phản đề nghị:{" "}
          <b className="text-[var(--violet)]">{formatVND(offer.counterAmount)}</b>
        </p>
      )}

      {/* Hành động */}
      <div className="mt-4 space-y-2.5 border-t border-[var(--line)] pt-4">
        {isSeller && offer.status === "proposed" && (
          <>
            <form action={respondOfferAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="offerId" value={offer.id} />
              <button type="submit" name="response" value="accept" className="btn-primary h-9 flex-1 text-sm">
                <CheckCircle2 className="size-4" />
                Chấp nhận {formatVND(offer.amount)}
              </button>
              <button
                type="submit"
                name="response"
                value="reject"
                className="btn h-9 flex-1 border border-[var(--red)]/35 bg-[var(--red-soft)] text-sm text-[var(--red)] transition hover:bg-[var(--red-soft)]"
              >
                <XCircle className="size-4" />
                Từ chối
              </button>
            </form>
            <form action={respondOfferAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="offerId" value={offer.id} />
              <input
                name="counterAmount"
                type="number"
                min={offer.amount + 10000}
                max={listing.price - 10000}
                step={50000}
                defaultValue={Math.round((offer.amount + listing.price) / 2 / 10000) * 10000}
                className="input h-9 w-40 text-sm"
                placeholder="Phản đề nghị (₫)"
              />
              <button type="submit" name="response" value="counter" className="btn-secondary h-9 flex-1 text-sm">
                <HandCoins className="size-4" />
                Phản đề nghị giá khác
              </button>
            </form>
          </>
        )}

        {!isSeller && offer.status === "countered" && offer.counterAmount && (
          <form action={acceptCounterAction}>
            <input type="hidden" name="offerId" value={offer.id} />
            <button type="submit" className="btn-primary w-full">
              <CheckCircle2 className="size-4" />
              Chấp nhận {formatVND(offer.counterAmount)} — tạo đơn escrow
            </button>
          </form>
        )}

        {!isSeller && ["proposed", "countered"].includes(offer.status) && (
          <form action={cancelOfferAction}>
            <input type="hidden" name="offerId" value={offer.id} />
            <button type="submit" className="btn-ghost w-full text-sm text-[var(--ink-2)] hover:text-[var(--red)]">
              <Ban className="size-4" />
              Rút đề nghị
            </button>
          </form>
        )}

        {offer.status === "accepted" && offer.orderId && (
          <Link href={`/orders/${offer.orderId}`} className="btn-secondary w-full text-sm">
            Xem đơn hàng đã tạo
          </Link>
        )}
      </div>
    </div>
  );
}
