import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db";
import { ListingCard } from "@/src/components/listing-card";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import {
  AudioLines,
  TrendingUp,
  Package,
  Scale,
  ArrowLeft,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ModelPage({
  params,
}: PageProps<"/models/[slug]">) {
  const { slug } = await params;

  const model = await db.orm.public.ProductModel
    .where({ slug })
    .include("brand", (b) => b.select("name", "slug"))
    .include("category", (c) => c.select("name", "slug", "icon"))
    .first();
  if (!model || model.status === "merged") notFound();

  // listings của model này
  const listings = await db.orm.public.Listing
    .where({ productModelId: model.id, status: "approved" })
    .select(
      "id", "title", "slug", "price", "condition", "city", "status",
      "viewCount", "acceptExchange", "negotiable",
    )
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name"))
    .include("brand", (b) => b.select("name"))
    .orderBy((l) => l.price.asc())
    .all();

  // ─── Price Intelligence (§12) ───
  const history = await db.orm.public.PriceHistory
    .where({ modelId: model.id })
    .orderBy((h) => h.createdAt.desc())
    .limit(100)
    .all();

  const soldPrices = history.filter((h) => h.kind === "sold").map((h) => h.price);
  const listedPrices = history.filter((h) => h.kind !== "sold").map((h) => h.price);
  const sample = [...soldPrices, ...listedPrices];
  const stats = (() => {
    if (sample.length === 0) return null;
    const sorted = [...sample].sort((a, b) => a - b);
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]!
      : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);
    return {
      median,
      low: sorted[0]!,
      high: sorted[sorted.length - 1]!,
      count: sample.length,
      soldCount: soldPrices.length,
    };
  })();

  const specs = (model.specs ?? {}) as Record<string, string>;
  const specEntries = Object.entries(specs);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 lg:px-8">
      <Link href="/listings" className="btn-ghost mb-5 h-9 px-3 text-sm">
        <ArrowLeft className="size-4" />
        Về chợ loa
      </Link>

      {/* ═══ Header model ═══ */}
      <div className="card p-6 sm:p-8">
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <span>{model.category!.icon}</span>
              <Link href={`/listings?category=${model.category!.slug}`} className="hover:text-[var(--accent)]">
                {model.category!.name}
              </Link>
              <span>·</span>
              <span className="font-semibold text-[var(--ink-2)]">{model.brand!.name}</span>
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">
              {model.brand!.name} <span className="price">{model.name}</span>
            </h1>
            {model.releaseYear && (
              <p className="mt-1 text-sm text-[var(--muted)]">Ra mắt {model.releaseYear}</p>
            )}
            {model.description && (
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--ink-2)]">{model.description}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Link
              href={`/compare?add=${model.id}`}
              className="btn-secondary text-sm"
            >
              <Scale className="size-4" />
              So sánh model này
            </Link>
            <Link href={`/listings?q=${encodeURIComponent(model.name)}`} className="btn-ghost text-sm">
              <Package className="size-4" />
              Tìm tin liên quan
            </Link>
          </div>
        </div>

        {/* ═══ Price Intelligence ═══ */}
        {stats && (
          <div className="relative mt-6 grid gap-3 sm:grid-cols-4">
            <div className="card p-4">
              <p className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <TrendingUp className="size-3.5 text-[var(--accent)]" />
                Giá tham chiếu (median)
              </p>
              <p className="mt-1.5 text-xl font-bold price">
                {formatVND(stats.median)}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-[var(--muted)]">Khoảng giá thị trường</p>
              <p className="mt-1.5 text-sm font-semibold text-[var(--ink)]">
                {formatVND(stats.low)} — {formatVND(stats.high)}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-[var(--muted)]">Mẫu giá thu thập</p>
              <p className="mt-1.5 text-sm font-semibold text-[var(--ink)]">
                {stats.count} điểm giá · {stats.soldCount} đã bán
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-[var(--muted)]">Đang bán</p>
              <p className="mt-1.5 text-sm font-semibold text-[var(--green)]">{listings.length} tin</p>
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[320px_1fr]">
        {/* ═══ Specs ═══ */}
        <aside className="card h-fit p-5 lg:sticky lg:top-20">
          <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            <AudioLines className="size-4 text-[var(--accent)]" />
            Thông số kỹ thuật
          </p>
          {specEntries.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">Chưa có specs chuẩn hóa cho model này.</p>
          ) : (
            <dl className="mt-4 space-y-2.5">
              {specEntries.map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3 text-sm">
                  <dt className="shrink-0 text-[var(--muted)]">{k}</dt>
                  <dd className="text-right font-medium text-[var(--ink)]">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-4 border-t border-[var(--line)] pt-3 text-[11px] leading-relaxed text-[var(--muted)]">
            Specs chuẩn hóa từ catalog LoaViet — mọi tin đăng link model này dùng chung dữ liệu.
          </p>
        </aside>

        {/* ═══ Listings ═══ */}
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            Đang bán — {model.brand!.name} {model.name}
          </h2>
          {listings.length === 0 ? (
            <div className="card mt-5 grid place-items-center gap-2 p-14 text-center">
              <span className="text-4xl">📭</span>
              <p className="font-bold">Chưa có tin nào đang bán model này</p>
              <p className="text-sm text-[var(--muted)]">Quay lại sau — hoặc xem các tin liên quan.</p>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {listings.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
          )}

          {/* lịch sử giá */}
          {history.length > 0 && (
            <section className="card mt-8 p-5">
              <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
                Lịch sử giá thu thập
              </p>
              <div className="mt-4 space-y-1.5">
                {history.slice(0, 12).map((h) => (
                  <div key={h.id} className="flex items-center justify-between gap-3 text-sm">
                    <span
                      className={cn(
                        "badge",
                        h.kind === "sold" ? "bg-[var(--green-soft)] text-[var(--green)]" :
                        h.kind === "reprice" ? "bg-[var(--violet-soft)] text-[var(--violet)]" :
                        "bg-[var(--accent-soft)] text-[var(--accent)]",
                      )}
                    >
                      {h.kind === "sold" ? "Đã bán" : h.kind === "reprice" ? "Đổi giá" : "Niêm yết"}
                    </span>
                    <span className="flex-1 truncate text-xs text-[var(--muted)]">
                      {formatDate(h.createdAt)}
                    </span>
                    <span className="font-semibold">{formatVND(h.price)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
