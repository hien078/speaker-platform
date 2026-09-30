import Link from "next/link";
import { db } from "@/src/prisma/db";
import { formatVND, cn } from "@/src/lib/utils";
import { tsquery } from "@prisma/orm-postgres/target/full-text";
import { Scale, X, Plus } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "So sánh loa" };

export default async function ComparePage({
  searchParams,
}: PageProps<"/compare">) {
  const sp = (await searchParams) as { models?: string; add?: string; q?: string };

  // ─── quản lý danh sách model so sánh (query param) ───
  let ids = (sp.models ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (sp.add && !ids.includes(sp.add) && ids.length < 4) {
    ids = [...ids, sp.add];
  }

  // fetch đầy đủ brand + category
  type ModelRow = {
    id: string;
    name: string;
    slug: string;
    releaseYear: number | null;
    specs: unknown;
    brand: { name: string };
    category: { name: string; icon: string | null };
  };
  const fetched: ModelRow[] = [];
  for (const id of ids) {
    const m = await db.orm.public.ProductModel
      .where({ id })
      .include("brand", (b) => b.select("name"))
      .include("category", (c) => c.select("name", "icon"))
      .first();
    if (m) fetched.push(m as unknown as ModelRow);
  }

  // ─── tìm kiếm model để thêm ───
  const q = sp.q?.trim() ?? "";
  let searchResults: ModelRow[] = [];
  if (q) {
    const tsq = tsquery`${q}:*`;
    const rows = await db.orm.public.ProductModel
      .where({ status: "approved" })
      .where((m) => m.name.fullTextMatches(tsq))
      .include("brand", (b) => b.select("name"))
      .include("category", (c) => c.select("name", "icon"))
      .limit(8)
      .all();
    searchResults = rows as unknown as ModelRow[];
  }

  // gộp specs của các model — union keys
  const specKeys = [...new Set(fetched.flatMap((m) => Object.keys((m.specs ?? {}) as Record<string, string>)))];
  const priceStats = await Promise.all(
    fetched.map(async (m) => {
      const agg = await db.orm.public.PriceHistory
        .where({ modelId: m.id })
        .aggregate((a) => ({ avg: a.avg("price"), c: a.count() }));
      return { modelId: m.id, avg: agg.avg, count: agg.c };
    }),
  );
  const activeCounts = await Promise.all(
    fetched.map(async (m) => {
      const agg = await db.orm.public.Listing
        .where({ productModelId: m.id, status: "approved" })
        .aggregate((a) => ({ c: a.count() }));
      return { modelId: m.id, c: agg.c };
    }),
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
        <Scale className="size-6 text-[var(--violet)]" />
        So sánh loa cạnh nhau
      </h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Chọn tối đa 4 model — specs và giá tham chiếu từ catalog chuẩn hóa.
      </p>

      {/* ═══ Bảng so sánh ═══ */}
      {fetched.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">⚖️</span>
          <p className="text-lg font-bold">Chưa chọn model nào</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">
            Tìm model theo tên (vd: &quot;EON&quot;, &quot;Charge&quot;, &quot;Stagepas&quot;) rồi thêm vào so sánh.
          </p>
        </div>
      ) : (
        <div className="table-wrap mt-8">
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-36">Thông số</th>
                {fetched.map((m) => {
                  const rest = ids.filter((x) => x !== m.id).join(",");
                  return (
                    <th key={m.id}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-[var(--muted)]">{m.brand!.name}</p>
                          <Link href={`/models/${m.slug}`} className="block truncate text-sm font-bold text-[var(--accent)] hover:text-amber-200">
                            {m.name}
                          </Link>
                          <p className="mt-0.5 text-[11px] text-[var(--muted)]">{m.category!.name}</p>
                        </div>
                        <Link
                          href={`/compare${rest ? `?models=${rest}` : ""}`}
                          className="grid size-6 shrink-0 place-items-center rounded-full text-[var(--muted)] transition hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
                          title="Xóa khỏi so sánh"
                        >
                          <X className="size-3.5" />
                        </Link>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-xs font-semibold text-[var(--muted)]">Giá tham chiếu</td>
                {fetched.map((m) => {
                  const st = priceStats.find((x) => x.modelId === m.id);
                  return (
                    <td key={m.id} className="font-bold price">
                      {st?.avg ? formatVND(Math.round(st.avg)) : "—"}
                      <span className="ml-1.5 text-[10px] font-normal text-[var(--muted)]">({st?.count ?? 0} mẫu)</span>
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="text-xs font-semibold text-[var(--muted)]">Đang bán</td>
                {fetched.map((m) => {
                  const ac = activeCounts.find((x) => x.modelId === m.id);
                  return <td key={m.id} className="text-sm text-[var(--green)]">{ac?.c ?? 0} tin</td>;
                })}
              </tr>
              {specKeys.map((key) => (
                <tr key={key}>
                  <td className="text-xs font-semibold text-[var(--muted)]">{key}</td>
                  {fetched.map((m) => {
                    const v = ((m.specs ?? {}) as Record<string, string>)[key];
                    return (
                      <td key={m.id} className={cn("text-sm", !v && "text-[var(--muted)]")}>
                        {v ?? "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td className="text-xs font-semibold text-[var(--muted)]">Ra mắt</td>
                {fetched.map((m) => (
                  <td key={m.id} className="text-sm">{m.releaseYear ?? "—"}</td>
                ))}
              </tr>
              <tr>
                <td />
                {fetched.map((m) => (
                  <td key={m.id}>
                    <Link href={`/listings?q=${encodeURIComponent(m.name)}`} className="btn-secondary h-8 w-full text-xs">
                      Xem tin đang bán
                    </Link>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ═══ Tìm & thêm model ═══ */}
      <section className="card mt-8 p-5">
        <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Thêm model vào so sánh
        </p>
        <form action="/compare" className="mt-3 flex gap-2">
          {ids.length > 0 && <input type="hidden" name="models" value={ids.join(",")} />}
          <input
            name="q"
            defaultValue={q}
            className="input text-sm"
            placeholder="Tên model — vd: EON, Charge 5, Stanmore…"
          />
          <button type="submit" className="btn-secondary shrink-0 px-5 text-sm">Tìm</button>
        </form>

        {q && (
          <div className="mt-4 space-y-2">
            {searchResults.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Không tìm thấy model nào khớp &quot;{q}&quot;.</p>
            ) : (
              searchResults.map((m) => {
                const inList = ids.includes(m.id);
                return (
                  <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        <span className="text-[var(--muted)]">{m.brand!.name}</span> {m.name}
                      </p>
                      <p className="text-xs text-[var(--muted)]">{m.category!.icon} {m.category!.name}</p>
                    </div>
                    {inList ? (
                      <span className="badge bg-[var(--green-soft)] text-[var(--green)]">Đang so sánh</span>
                    ) : (
                      <Link
                        href={`/compare?models=${[...ids, m.id].join(",")}`}
                        className="btn-primary h-8 shrink-0 px-3 text-xs"
                      >
                        <Plus className="size-3.5" />
                        Thêm
                      </Link>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>
    </main>
  );
}
