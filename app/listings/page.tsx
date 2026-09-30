import Link from "next/link";
import { db } from "@/src/prisma/db";
import { ListingCard, getListingCards, type ListingSort } from "@/src/components/listing-card";
import { CITIES, CONDITION_LABELS } from "@/src/lib/constants";
import { websearchToTsquery } from "@prisma/orm-postgres/target/full-text";
import { Search, SlidersHorizontal, Handshake } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chợ loa" };

type SearchParams = {
  q?: string;
  category?: string;
  brand?: string;
  condition?: string;
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
  const exchangeOnly = sp.exchange === "1";

  const [categories, brands] = await Promise.all([
    db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all(),
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
  ]);

  const category = categories.find((c) => c.slug === sp.category);
  const brand = brands.find((b) => b.slug === sp.brand);

  // ─── Query ───
  let listQuery = db.orm.public.Listing
    .select(
      "id", "title", "slug", "price", "condition", "city", "status",
      "viewCount", "acceptExchange", "negotiable",
    )
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
    .include("category", (c) => c.select("name"))
    .include("brand", (b) => b.select("name"))
    .where({ status: "approved" });

  if (category) listQuery = listQuery.where({ categoryId: category.id });
  if (brand) listQuery = listQuery.where({ brandId: brand.id });
  if (sp.condition && ["new", "open_box", "like_new", "excellent", "good", "fair", "refurbished", "for_parts"].includes(sp.condition)) {
    listQuery = listQuery.where({ condition: sp.condition as "good" });
  }
  if (sp.city) listQuery = listQuery.where({ city: sp.city });
  if (exchangeOnly) listQuery = listQuery.where({ acceptExchange: true });
  if (sp.min && Number(sp.min) > 0) listQuery = listQuery.where((l) => l.price.gte(Number(sp.min)));
  if (sp.max && Number(sp.max) > 0) listQuery = listQuery.where((l) => l.price.lte(Number(sp.max)));
  if (q) {
    const tsq = websearchToTsquery(q);
    listQuery = listQuery.where((l) => l.title.fullTextMatches(tsq));
  }

  const sort = (["newest", "price_asc", "price_desc", "popular"] as const).includes(sp.sort as ListingSort)
    ? (sp.sort as ListingSort) : "newest";
  switch (sort) {
    case "price_asc": listQuery = listQuery.orderBy((l) => l.price.asc()); break;
    case "price_desc": listQuery = listQuery.orderBy((l) => l.price.desc()); break;
    case "popular": listQuery = listQuery.orderBy((l) => l.viewCount.desc()); break;
    default: listQuery = listQuery.orderBy((l) => l.createdAt.desc());
  }

  const listings = await listQuery.limit(60).all();

  const hasFilters = q || sp.category || sp.brand || sp.condition || sp.city || sp.min || sp.max || exchangeOnly;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            {exchangeOnly ? "Loa sẵn sàng trao đổi" : category ? category.name : "Chợ loa"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {listings.length} tin đăng{q && <> khớp “{q}”</>}
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
            <SlidersHorizontal className="size-4 text-amber-400" />
            Bộ lọc
          </p>
          <form className="space-y-4" action="/listings">
            {exchangeOnly && <input type="hidden" name="exchange" value="1" />}

            <div>
              <label className="label">Từ khóa</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
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

            <div>
              <label className="label">Khu vực</label>
              <select name="city" defaultValue={sp.city ?? ""} className="input text-sm">
                <option value="">Tất cả</option>
                {CITIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Giá (₫)</label>
              <div className="flex items-center gap-2">
                <input name="min" type="number" min={0} defaultValue={sp.min ?? ""} className="input text-sm" placeholder="Từ" />
                <span className="text-zinc-600">–</span>
                <input name="max" type="number" min={0} defaultValue={sp.max ?? ""} className="input text-sm" placeholder="Đến" />
              </div>
            </div>

            <div>
              <label className="label">Sắp xếp</label>
              <select name="sort" defaultValue={sort} className="input text-sm">
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
          {listings.length === 0 ? (
            <div className="card grid place-items-center gap-3 p-16 text-center">
              <span className="text-5xl">🔇</span>
              <p className="text-lg font-bold">Không tìm thấy tin đăng nào</p>
              <p className="max-w-sm text-sm text-zinc-500">
                Thử bỏ một vài bộ lọc, hoặc quay lại sau — mỗi ngày đều có tin mới được duyệt.
              </p>
              <Link href="/listings" className="btn-secondary mt-2 text-sm">Xóa bộ lọc</Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {listings.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
