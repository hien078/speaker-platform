import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { LISTING_STATUS_LABELS, LISTING_STATUS_BADGE } from "@/src/lib/constants";
import { toggleListingVisibilityAction, deleteListingAction } from "@/src/lib/actions/listings";
import { Package, Eye, EyeOff, Trash2, Plus, Handshake, Pencil } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tin đăng của tôi" };

export default async function MyListingsPage({
  searchParams,
}: PageProps<"/sell/my">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const sp = (await searchParams) as { created?: string; updated?: string };

  const listings = await db.orm.public.Listing
    .where({ sellerId: user.id })
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name", "commissionRate"))
    .include("brand", (b) => b.select("name"))
    .include("targetOffers", (o) => o.select("id", "status"))
    .orderBy((l) => l.createdAt.desc())
    .all();

  const pendingOffers = listings.reduce(
    (s, l) => s + l.targetOffers.filter((o) => o.status === "proposed").length,
    0,
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <Package className="size-6 text-[var(--accent)]" />
          Tin đăng của tôi
        </h1>
        <Link href="/sell/new" className="btn-primary h-10 text-sm">
          <Plus className="size-4" />
          Đăng tin mới
        </Link>
      </div>

      {sp.created === "1" && (
        <div className="mt-5 rounded-xl border border-[var(--green)]/35 bg-[var(--green-soft)] px-4 py-3 text-sm text-[var(--green)]">
          ✓ Tin đã gửi thành công và đang chờ quản trị duyệt. Bạn sẽ thấy trạng thái tại đây.
        </div>
      )}
      {sp.updated === "1" && (
        <div className="mt-5 rounded-xl border border-[var(--green)]/35 bg-[var(--green-soft)] px-4 py-3 text-sm text-[var(--green)]">
          ✓ Đã lưu thay đổi. Nếu nội dung chính thay đổi, tin sẽ được duyệt lại.
        </div>
      )}

      {pendingOffers > 0 && (
        <Link
          href="/exchange"
          className="mt-5 flex items-center gap-2.5 rounded-xl border border-sky-500/30 bg-[#2563a8]/10 px-4 py-3 text-sm text-[#2563a8] transition hover:bg-[#eaf2fb]"
        >
          <Handshake className="size-4" />
          Bạn có <b>{pendingOffers}</b> đề nghị trao đổi đang chờ phản hồi →
        </Link>
      )}

      {listings.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">📦</span>
          <p className="text-lg font-bold">Bạn chưa có tin đăng nào</p>
          <p className="text-sm text-[var(--muted)]">Đăng chiếc loa không dùng đến cho ai cần nó nhé!</p>
          <Link href="/sell/new" className="btn-primary mt-2 text-sm">Đăng tin đầu tiên</Link>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {listings.map((l) => {
            const pendingOfferCount = l.targetOffers.filter((o) => o.status === "proposed").length;
            return (
              <div key={l.id} className="card flex flex-col gap-4 p-4 sm:flex-row">
                <Link href={`/listings/${l.slug}`} className="relative size-28 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                  {l.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.images[0].url} alt={l.title} className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-3xl text-[var(--muted)]">🔇</span>
                  )}
                </Link>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("badge", LISTING_STATUS_BADGE[l.status])}>
                      {LISTING_STATUS_LABELS[l.status]}
                    </span>
                    {l.acceptExchange && (
                      <span className="badge bg-[#eaf2fb] text-[#2563a8]">Trao đổi</span>
                    )}
                    {pendingOfferCount > 0 && (
                      <Link href="/exchange" className="badge bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)]/25">
                        {pendingOfferCount} đề nghị trao đổi
                      </Link>
                    )}
                  </div>
                  <Link href={`/listings/${l.slug}`} className="mt-1.5 block line-clamp-1 font-semibold hover:text-[var(--accent)]">
                    {l.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {l.category!.name}{l.brand ? ` · ${l.brand.name}` : ""} · {formatDate(l.createdAt)} · {l.viewCount} lượt xem
                  </p>
                  <p className="mt-1 text-lg font-extrabold text-[var(--accent)]">{formatVND(l.price)}</p>
                  {l.rejectionReason && (
                    <p className="mt-1 text-xs text-[var(--red)]">Lý do từ chối: {l.rejectionReason}</p>
                  )}
                </div>

                <div className="flex shrink-0 flex-row gap-2 sm:flex-col">
                  <Link href={`/sell/${l.id}/edit`} className="btn-secondary h-9 flex-1 px-3 text-xs">
                    <Pencil className="size-3.5" />
                    Sửa
                  </Link>
                  {l.status === "approved" && (
                    <form action={toggleListingVisibilityAction}>
                      <input type="hidden" name="listingId" value={l.id} />
                      <button type="submit" className="btn-secondary h-9 flex-1 px-3 text-xs" title="Ẩn tin">
                        <EyeOff className="size-3.5" />
                        Ẩn
                      </button>
                    </form>
                  )}
                  {l.status === "hidden" && (
                    <form action={toggleListingVisibilityAction}>
                      <input type="hidden" name="listingId" value={l.id} />
                      <button type="submit" className="btn-secondary h-9 flex-1 px-3 text-xs" title="Hiện lại tin">
                        <Eye className="size-3.5" />
                        Hiện
                      </button>
                    </form>
                  )}
                  {l.status !== "sold" && (
                    <form action={deleteListingAction}>
                      <input type="hidden" name="listingId" value={l.id} />
                      <button
                        type="submit"
                        className="btn h-9 flex-1 px-3 text-xs text-[var(--ink-2)] transition hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
                        title="Xóa tin"
                      >
                        <Trash2 className="size-3.5" />
                        Xóa
                      </button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
