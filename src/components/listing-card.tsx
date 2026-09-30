import Link from "next/link";
import { db } from "@/src/prisma/db";
import { formatVND, cn } from "@/src/lib/utils";
import { CONDITION_LABELS, LISTING_STATUS_BADGE, LISTING_STATUS_LABELS } from "@/src/lib/constants";
import { Handshake, Eye, MapPin } from "lucide-react";

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
        "card card-hover group relative flex flex-col overflow-hidden",
        isSold && "opacity-55",
        className,
      )}
    >
      {/* Ảnh */}
      <div className="img-frame relative aspect-[4/3]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={listing.title}
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
            loading="lazy"
          />
        ) : (
          <div className="grid size-full place-items-center text-4xl text-zinc-700">🔇</div>
        )}

        {/* badge */}
        <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">
          {listing.status !== "approved" && (
            <span className={cn("badge bg-black/50", LISTING_STATUS_BADGE[listing.status])}>
              {LISTING_STATUS_LABELS[listing.status]}
            </span>
          )}
          {listing.acceptExchange && (
            <span className="badge border-violet-400/30 bg-violet-500/25 text-violet-200">
              <Handshake className="size-3" />
              Trao đổi
            </span>
          )}
        </div>

        {isSold && (
          <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[1px]">
            <span className="rotate-[-7deg] rounded-lg border-2 border-rose-400 px-4 py-1.5 font-[family-name:var(--font-space-grotesk)] text-base font-bold uppercase tracking-widest text-rose-400">
              Đã bán
            </span>
          </div>
        )}
      </div>

      {/* Nội dung */}
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
          {listing.brand && <span className="text-zinc-400">{listing.brand.name}</span>}
          {listing.category && <span>· {listing.category.name}</span>}
        </div>

        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-100 transition group-hover:text-amber-200">
          {listing.title}
        </h3>

        <div className="mt-auto space-y-2 pt-2">
          <p className="font-[family-name:var(--font-space-grotesk)] text-lg font-bold tracking-tight">
            <span className="text-spotlight">{formatVND(listing.price)}</span>
            {listing.negotiable && (
              <span className="ml-1.5 align-middle text-[11px] font-medium text-zinc-500">mặc cả</span>
            )}
          </p>
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{listing.city}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Eye className="size-3" />
              {listing.viewCount}
            </span>
          </div>
          <p className="text-[11px] text-zinc-600">{CONDITION_LABELS[listing.condition]}</p>
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
