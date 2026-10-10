import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { formatVND, cn } from "@/src/lib/utils";
import { CONDITION_LABELS, LISTING_STATUS_BADGE, LISTING_STATUS_LABELS } from "@/src/lib/constants";
import { Handshake } from "lucide-react";

export type ListingCardData = {
  id: string;
  title: string;
  slug: string;
  price: number;
  condition: string;
  city: string;
  status: string;
  viewCount: number;
  acceptExchange: boolean;
  negotiable: boolean;
  images: { url: string }[];
  category?: { name: string } | null;
  brand?: { name: string } | null;
};

export function ListingCard({ listing, className }: { listing: ListingCardData; className?: string }) {
  const image = listing.images[0]?.url;
  const isSold = listing.status === "sold";

  return (
    <Link
      href={`/listings/${listing.slug}`}
      className={cn(
        "card card-hover group flex flex-col overflow-hidden",
        isSold && "opacity-70",
        className,
      )}
    >
      {/* Ảnh — tỉ lệ chuẩn tin đăng */}
      <div className="relative aspect-[4/3] bg-[var(--paper-deep)]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={listing.title}
            className="size-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="grid size-full place-items-center text-[var(--muted)]">
            <span className="text-xs">chưa có ảnh</span>
          </div>
        )}

        {/* góc: nhãn trạng thái */}
        <div className="absolute left-1.5 top-1.5 flex gap-1">
          {listing.status !== "approved" && (
            <span className={cn("badge bg-white backdrop-blur", LISTING_STATUS_BADGE[listing.status])}>
              {LISTING_STATUS_LABELS[listing.status]}
            </span>
          )}
          {listing.acceptExchange && (
            <span className="badge bg-white text-[var(--violet)] backdrop-blur">
              <Handshake className="size-3" />
              đổi được
            </span>
          )}
        </div>

        {isSold && (
          <div className="absolute inset-0 grid place-items-center bg-white/70">
            <span className="rounded-sm border border-[var(--red)] bg-white px-3 py-1 text-xs font-bold uppercase tracking-widest text-[var(--red)]">
              đã bán
            </span>
          </div>
        )}
      </div>

      {/* Nội dung — dày, thực dụng */}
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--ink)] transition-colors group-hover:text-[var(--accent)]">
          {listing.title}
        </h3>

        <div className="mt-auto space-y-1 pt-1.5">
          <p className="price text-[17px] leading-none">
            {formatVND(listing.price)}
            {listing.negotiable && (
              <span className="ml-1 text-[11px] font-medium text-[var(--muted)]">mặc cả</span>
            )}
          </p>
          <div className="flex items-center justify-between text-[11px] text-[var(--muted)]">
            <span className="truncate">{CONDITION_LABELS[listing.condition]}</span>
            <span className="shrink-0 truncate">{listing.city}</span>
          </div>
          {(listing.brand || listing.category) && (
            <p className="truncate text-[11px] text-[var(--muted)]">
              {listing.brand?.name}
              {listing.brand && listing.category ? " · " : ""}
              {listing.category?.name}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

export type ListingFilters = {
  status?: "draft" | "pending" | "approved" | "rejected" | "hidden" | "sold";
  categoryId?: string;
  brandId?: string;
  sellerId?: string;
  acceptExchange?: boolean;
  minPrice?: number;
  maxPrice?: number;
  city?: string;
};

export type ListingSort = "newest" | "price_asc" | "price_desc" | "popular";

/** Query dùng chung: listing + ảnh đầu + danh mục + hãng */
export async function getListingCards(
  filters: ListingFilters = {},
  opts: { limit?: number; sort?: ListingSort; offset?: number } = {},
) {
  let q = db.orm.public.Listing
    .select(
      "id", "title", "slug", "price", "condition", "city", "status",
      "viewCount", "acceptExchange", "negotiable",
    )
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name"))
    .include("brand", (b) => b.select("name"));

  if (filters.status !== undefined) q = q.where({ status: filters.status });
  if (filters.categoryId) q = q.where({ categoryId: filters.categoryId });
  if (filters.brandId) q = q.where({ brandId: filters.brandId });
  if (filters.sellerId) q = q.where({ sellerId: filters.sellerId });
  if (filters.city) q = q.where({ city: filters.city });
  if (filters.acceptExchange !== undefined) q = q.where({ acceptExchange: filters.acceptExchange });
  if (filters.minPrice !== undefined) q = q.where((l) => l.price.gte(filters.minPrice!));
  if (filters.maxPrice !== undefined) q = q.where((l) => l.price.lte(filters.maxPrice!));

  switch (opts.sort) {
    case "price_asc": q = q.orderBy((l) => l.price.asc()); break;
    case "price_desc": q = q.orderBy((l) => l.price.desc()); break;
    case "popular": q = q.orderBy((l) => l.viewCount.desc()); break;
    default: q = q.orderBy((l) => l.createdAt.desc());
  }
  if (opts.offset) q = q.offset(opts.offset);
  if (opts.limit) q = q.limit(opts.limit);

  return q.all();
}
