import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/src/prisma/db.client";
import { ListingCard } from "@/src/components/listing-card";
import { CONDITION_LABELS } from "@/src/lib/constants";
import { PROVINCES } from "@/src/lib/provinces";
import {
  BETA_PRIMARY_MARKET_PROVINCE,
  BETA_SECONDARY_MARKET_PROVINCE,
  betaMarketLabel,
} from "@/src/lib/location";
import { getCurrentUser } from "@/src/lib/auth";
import { clientIpFromHeaders } from "@/src/lib/rate-limit";
import { isMalformedQuery } from "@/src/lib/search-normalize";
import { resolveSearchQuery, type SearchResolution } from "@/src/lib/search-resolve";
import { runSearchWithTelemetry } from "@/src/lib/search-telemetry";
import { BETA_SPEAKER_CATEGORY_SLUG } from "@/src/lib/search-query";
import { Search, SlidersHorizontal, Handshake, MapPin } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chợ loa" };

type SearchParams = {
  q?: string;
  category?: string;
  brand?: string;
  condition?: string;
  province?: string;
  city?: string;
  min?: string;
  max?: string;
  exchange?: string;
  sort?: string;
};

export default async function ListingsPage({
  searchParams,
}: PageProps<"/listings">) {
  const sp = (await searchParams) as SearchParams;
  const q = sp.q?.trim() ?? "";

  const [categories, brands] = await Promise.all([
    db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all(),
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
  ]);

  // Một session read — SessionUser mang id + sessionId THÔ (corrections #15 —
  // KHÔNG lookup session lần hai; emit core tự HMAC, b5-review T6).
  const user = await getCurrentUser();

  // Prefetch (S-8): header next-router-prefetch BỊ PROXY STRIP (Next 16 proxy.md
  // ~L474 — corrections #14) → guard deterministic là prefetch={false} trên link
  // kết quả (listing-card.tsx); header check dưới đây là best-effort thêm.
  const h = await headers();
  const isPrefetch = h.get("next-router-prefetch") === "1";
  const ip = clientIpFromHeaders(h);

  // Resolution (query text → structured ids — Task 5): chỉ khi query hợp lệ;
  // browsing → resolution rỗng (KHÔNG đụng db).
  const resolution: SearchResolution = isMalformedQuery(q)
    ? { textVariants: [], brandIds: [], productModelIds: [] }
    : await resolveSearchQuery(q);

  // Toàn bộ rate-limit/emit/query sống ở runSearchWithTelemetry (S-7) — page
  // là thin shell: load categories/brands, resolve session, gọi, render.
  const run = await runSearchWithTelemetry({
    user: { id: user?.id ?? null, sessionId: user?.sessionId ?? null },
    isPrefetch,
    ip,
    resolution,
    params: sp,
    loadedCategories: categories.map((c) => ({ slug: c.slug })),
    loadedBrands: brands.map((b) => ({ slug: b.slug })),
  });

  const { plan, listings, resultCount, searchSessionId, throttled, eventsEmitted } = run;
  const exchangeOnly = plan.exchangeOnly;

  // Zero-result recovery (spec §5.7.1): có query/filters mới là "không tìm thấy"
  // cần recovery — browsing trống là danh mục chưa có tin.
  const hasAnyFilter =
    plan.hasQuery ||
    plan.categorySlug !== null ||
    plan.brandSlug !== null ||
    plan.provinceFilter !== null ||
    plan.condition !== null ||
    plan.minPrice !== null ||
    plan.maxPrice !== null ||
    plan.exchangeOnly;

  // "Xem loa {brand}" — chỉ khi resolution tìm ĐÚNG một brand (Task 5) và brand
  // đó có trong catalog đã load (link theo slug).
  const resolvedBrand =
    resolution.brandIds.length === 1
      ? (brands.find((b) => b.id === resolution.brandIds[0]) ?? null)
      : null;

  // S8: link recovery category beta — CHỈ render khi Category row tồn tại
  // (corrections #14 — seed chưa chạy thì link chết không render).
  const betaCategory = categories.find((c) => c.slug === BETA_SPEAKER_CATEGORY_SLUG) ?? null;

  // Quick-filter chips primary/secondary market (spec §5.9.1) — nhãn
  // operational/acquisition ONLY (betaMarketLabel — spec §4.7: location
  // KHÔNG phải tín hiệu tin cậy, KHÔNG dùng từ ngữ tin cậy/bảo chứng). KHÔNG
  // relevance effect ngoài filter tường minh.
  const marketChips = [
    { code: BETA_PRIMARY_MARKET_PROVINCE, name: PROVINCES.find((p) => p.code === BETA_PRIMARY_MARKET_PROVINCE)?.displayName ?? "" },
    { code: BETA_SECONDARY_MARKET_PROVINCE, name: PROVINCES.find((p) => p.code === BETA_SECONDARY_MARKET_PROVINCE)?.displayName ?? "" },
  ];
  const chipHref = (code: string): string =>
    `/listings?province=${code}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            {exchangeOnly
              ? "Loa sẵn sàng trao đổi"
              : (categories.find((c) => c.slug === plan.categorySlug)?.name ?? "Chợ loa")}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {throttled ? (
              "Bạn đang tìm nhanh quá — thử lại sau ít phút."
            ) : (
              <>
                {resultCount} tin đăng{plan.hasQuery && q ? <> khớp “{q}”</> : null}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={exchangeOnly ? "/listings" : "/listings?exchange=1"}
            className={`btn h-9 text-sm ${exchangeOnly ? "btn-primary" : "btn-secondary"}`}
          >
            <Handshake className="size-4" />
            {exchangeOnly ? "Đang lọc: trao đổi" : "Loa nhận trao đổi"}
          </Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        {/* ═══ Sidebar lọc ═══ */}
        <aside className="card h-fit p-4 lg:sticky lg:top-20">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold">
            <SlidersHorizontal className="size-4 text-[var(--accent)]" />
            Bộ lọc
          </p>
          <form className="space-y-4" action="/listings">
            {exchangeOnly && <input type="hidden" name="exchange" value="1" />}

            <div>
              <label className="label">Từ khóa</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--muted)]" />
                <input name="q" defaultValue={q} className="input pl-9 text-sm" placeholder="Tên loa…" />
              </div>
            </div>

            <div>
              <label className="label">Danh mục</label>
              <select name="category" defaultValue={sp.category ?? ""} className="input text-sm">
                <option value="">Tất cả</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.slug}>{c.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Thương hiệu</label>
              <select name="brand" defaultValue={sp.brand ?? ""} className="input text-sm">
                <option value="">Tất cả</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.slug}>{b.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Tình trạng</label>
              <select name="condition" defaultValue={sp.condition ?? ""} className="input text-sm">
                <option value="">Tất cả</option>
                {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            {/* Khu vực — select tỉnh canonical (registry FD-1, value = code);
                link legacy ?city= vẫn lọc qua FD-1 rule trong describeSearchQuery */}
            <div>
              <label className="label">Khu vực</label>
              <select name="province" defaultValue={plan.provinceFilter ?? ""} className="input text-sm">
                <option value="">Tất cả</option>
                {PROVINCES.map((p) => (
                  <option key={p.code} value={p.code}>{p.displayName}</option>
                ))}
              </select>
            </div>

            {/* Cold-start shortcuts (spec §5.9.1) — nhãn betaMarketLabel,
                operational/acquisition ONLY (spec §4.7: location KHÔNG bao giờ
                là tín hiệu tin cậy — KHÔNG dùng từ ngữ tin cậy/bảo chứng) */}
            <div>
              <p className="label flex items-center gap-1">
                <MapPin className="size-3" />
                {betaMarketLabel()}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {marketChips.map((chip) => (
                  <Link
                    key={chip.code}
                    href={chipHref(chip.code)}
                    className={`badge border px-2 py-1 text-[11px] ${plan.provinceFilter === chip.code ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" : "border-[var(--line)] text-[var(--muted)]"}`}
                  >
                    {chip.name}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <label className="label">Giá (₫)</label>
              <div className="flex items-center gap-2">
                <input name="min" type="number" min={0} defaultValue={sp.min ?? ""} className="input text-sm" placeholder="Từ" />
                <span className="text-[var(--muted)]">–</span>
                <input name="max" type="number" min={0} defaultValue={sp.max ?? ""} className="input text-sm" placeholder="Đến" />
              </div>
            </div>

            <div>
              <label className="label">Sắp xếp</label>
              {/* 4 sort hiện có (plan); "relevance" là mặc định ranking khi có query
                  (describeSearchQuery) — select không có option đó, fallback hiển thị
                  "newest"; user submit thì sort gửi đi là một trong 4 giá trị này */}
              <select name="sort" defaultValue={plan.sort === "relevance" ? "newest" : plan.sort} className="input text-sm">
                <option value="newest">Mới nhất</option>
                <option value="price_asc">Giá tăng dần</option>
                <option value="price_desc">Giá giảm dần</option>
                <option value="popular">Xem nhiều nhất</option>
              </select>
            </div>

            <div className="flex gap-2 pt-1">
              <button type="submit" className="btn-primary flex-1 text-sm">Áp dụng</button>
              <Link href="/listings" className="btn-secondary px-3 text-sm">Xóa</Link>
            </div>
          </form>
        </aside>

        {/* ═══ Lưới sản phẩm ═══ */}
        <div>
          {throttled ? (
            <div className="card grid place-items-center gap-3 p-16 text-center">
              <span className="text-5xl">⏳</span>
              <p className="text-lg font-bold">Bạn đang tìm nhanh quá</p>
              <p className="max-w-sm text-sm text-[var(--muted)]">
                Thử lại sau ít phút — kết quả tìm kiếm không bị mất, chỉ cần chờ một nhịp.
              </p>
            </div>
          ) : listings.length === 0 ? (
            <div className="card grid place-items-center gap-3 p-16 text-center">
              <span className="text-5xl">🔇</span>
              <p className="text-lg font-bold">Không tìm thấy tin đăng nào</p>
              <p className="max-w-sm text-sm text-[var(--muted)]">
                Thử bỏ một vài bộ lọc, hoặc quay lại sau — mỗi ngày đều có tin mới được duyệt.
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <Link href="/listings" className="btn-secondary text-sm">Xóa bộ lọc</Link>
                {hasAnyFilter && resolvedBrand && (
                  <Link href={`/listings?brand=${resolvedBrand.slug}`} className="btn-secondary text-sm">
                    Xem loa {resolvedBrand.name}
                  </Link>
                )}
                {hasAnyFilter && betaCategory && (
                  <Link href={`/listings?category=${BETA_SPEAKER_CATEGORY_SLUG}`} className="btn-secondary text-sm">
                    Xem loa di động
                  </Link>
                )}
              </div>
              {/* S-6 (§4.2 no-misleading-promise): chỉ render khi event THẬT SỰ
                  được ghi (eventsEmitted.zeroResult — đọc lại row, không phải
                  "đã gọi emit") */}
              {eventsEmitted.zeroResult && (
                <p className="text-xs text-[var(--muted)]">
                  Chúng tôi đã ghi nhận nhu cầu này để bổ sung danh mục phù hợp.
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {listings.map((l) => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  searchSessionId={searchSessionId ?? undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
