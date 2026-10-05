import { db } from "@/src/prisma/db.client";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { LISTING_STATUS_LABELS, LISTING_STATUS_BADGE, CONDITION_LABELS } from "@/src/lib/constants";
import { approveListingAction, rejectListingAction } from "@/src/lib/actions/admin";
import { FileSearch, CheckCircle2, XCircle } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Duyệt tin" };

export default async function AdminListingsPage({
  searchParams,
}: PageProps<"/admin/listings">) {
  const sp = (await searchParams) as { tab?: string };
  const tab = sp.tab === "all" ? "all" : "pending";

  const listings = await db.orm.public.Listing
    .where(tab === "pending" ? { status: "pending" } : {})
    .include("seller", (s) => s.select("name", "email", "isVerifiedSeller"))
    .include("category", (c) => c.select("name"))
    .include("brand", (b) => b.select("name"))
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .orderBy((l) => l.createdAt.desc())
    .limit(100)
    .all();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <FileSearch className="size-6 text-[var(--accent)]" />
          Duyệt tin đăng
        </h1>
        <div className="flex gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1">
          <a
            href="/admin/listings"
            className={cn("rounded-md px-3.5 py-1.5 text-sm font-medium transition", tab === "pending" ? "bg-[var(--accent)] text-white" : "text-[var(--ink-2)] hover:text-white")}
          >
            Chờ duyệt
          </a>
          <a
            href="/admin/listings?tab=all"
            className={cn("rounded-md px-3.5 py-1.5 text-sm font-medium transition", tab === "all" ? "bg-[var(--accent)] text-white" : "text-[var(--ink-2)] hover:text-white")}
          >
            Tất cả
          </a>
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-2 p-16 text-center">
          <span className="text-4xl">🎉</span>
          <p className="font-bold">
            {tab === "pending" ? "Hàng đợi duyệt trống!" : "Chưa có tin đăng nào"}
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {listings.map((l) => (
            <div key={l.id} className="card p-5">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="relative size-28 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                  {l.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.images[0].url} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-3xl text-[var(--muted)]">🔇</span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("badge", LISTING_STATUS_BADGE[l.status])}>
                      {LISTING_STATUS_LABELS[l.status]}
                    </span>
                    <span className="text-xs text-[var(--muted)]">{formatDate(l.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-1 font-bold">{l.title}</p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {l.category!.name}{l.brand ? ` · ${l.brand.name}` : ""} · {CONDITION_LABELS[l.condition]} · {l.city}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Người bán: <b className="text-[var(--ink-2)]">{l.seller!.name}</b>
                    <span className="text-[var(--muted)]"> ({l.seller!.email})</span>
                    {l.seller!.isVerifiedSeller && <span className="ml-1 text-[var(--green)]">✓ đã xác minh</span>}
                  </p>
                  <p className="mt-1 text-base font-extrabold text-[var(--accent)]">{formatVND(l.price)}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--ink-2)]">{l.description}</p>
                </div>

                {l.status === "pending" && (
                  <div className="flex shrink-0 gap-2 sm:flex-col">
                    <form action={approveListingAction} className="flex-1">
                      <input type="hidden" name="listingId" value={l.id} />
                      <button type="submit" className="btn-primary h-10 w-full px-4 text-sm">
                        <CheckCircle2 className="size-4" />
                        Duyệt
                      </button>
                    </form>
                    <form action={rejectListingAction} className="flex-1">
                      <input type="hidden" name="listingId" value={l.id} />
                      <input type="hidden" name="reason" value="Nội dung chưa rõ ràng, vui lòng bổ sung thông tin và hình ảnh thực tế" />
                      <button type="submit" className="btn-danger h-10 w-full px-4 text-sm">
                        <XCircle className="size-4" />
                        Từ chối
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
