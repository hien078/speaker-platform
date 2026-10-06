import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { formatDateShort, cn } from "@/src/lib/utils";
import {
  approveModelAction,
  mergeModelAction,
  createModelAction,
} from "@/src/lib/actions/catalog";
import { AudioLines, CheckCircle2, GitMerge, Plus } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Catalog model" };

const STATUS_BADGE: Record<string, string> = {
  approved: "bg-[var(--green-soft)] text-[var(--green)]",
  pending: "bg-[var(--accent-soft)] text-[var(--accent)]",
  merged: "bg-zinc-500/15 text-[var(--ink-2)]",
};

export default async function AdminCatalogPage() {
  // Guard server-side (spec §4.5) — listing.moderate: catalog model approval là
  // listing-quality operations (recorded mapping decision, plan Task 4).
  await requireCapability("listing.moderate");
  const [models, brands, categories] = await Promise.all([
    db.orm.public.ProductModel
      .include("brand", (b) => b.select("name"))
      .include("category", (c) => c.select("name"))
      .orderBy((m) => m.status.asc())
      .orderBy((m) => m.createdAt.desc())
      .limit(60)
      .all(),
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
    db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all(),
  ]);

  const approved = models.filter((m) => m.status === "approved");

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
        <AudioLines className="size-6 text-[var(--accent)]" />
        Catalog model sản phẩm
      </h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {approved.length} model đã duyệt · {models.length - approved.length} chờ/gộp — catalog
        chuẩn hóa dùng chung cho mọi tin đăng (§5, §68).
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* ─── Danh sách model ─── */}
        <div className="space-y-3">
          {models.map((m) => {
            const specCount = Object.keys((m.specs ?? {}) as Record<string, string>).length;
            return (
              <div key={m.id} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <p className="text-sm font-bold">
                      <span className="text-[var(--muted)]">{m.brand!.name}</span> {m.name}
                  </p>
                    <span className={cn("badge", STATUS_BADGE[m.status])}>{m.status}</span>
                    <span className="text-xs text-[var(--muted)]">{specCount} specs · {m.category!.name}</span>
                  </div>
                  <span className="text-xs text-[var(--muted)]">{formatDateShort(m.createdAt)}</span>
                </div>

                {m.status === "pending" && (
                  <form action={approveModelAction} className="mt-3">
                    <input type="hidden" name="modelId" value={m.id} />
                    <button type="submit" className="btn-primary h-8 px-3 text-xs">
                      <CheckCircle2 className="size-3.5" />
                      Duyệt vào catalog
                    </button>
                  </form>
                )}

                {m.status !== "merged" && approved.length > 1 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--ink-2)]">
                      Gộp vào model khác (trùng lặp)…
                    </summary>
                    <form action={mergeModelAction} className="mt-2 flex gap-2">
                      <input type="hidden" name="modelId" value={m.id} />
                      <select name="targetId" className="input h-8 text-xs">
                        {approved.filter((x) => x.id !== m.id).map((x) => (
                          <option key={x.id} value={x.id}>{x.brand!.name} {x.name}</option>
                        ))}
                      </select>
                      <button type="submit" className="btn-secondary h-8 shrink-0 px-3 text-xs">
                        <GitMerge className="size-3.5" />
                        Gộp
                      </button>
                    </form>
                  </details>
                )}
              </div>
            );
          })}
        </div>

        {/* ─── Tạo model mới ─── */}
        <aside className="card h-fit p-5 lg:sticky lg:top-20">
          <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Tạo model mới
          </p>
          <form action={createModelAction} className="mt-4 space-y-3">
            <div>
              <label className="label text-xs" htmlFor="m-name">Tên model</label>
              <input id="m-name" name="name" className="input text-sm" placeholder="VD: Charge 5" required />
            </div>
            <div>
              <label className="label text-xs" htmlFor="m-brand">Thương hiệu</label>
              <select id="m-brand" name="brandId" className="input text-sm" required>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label text-xs" htmlFor="m-cat">Danh mục</label>
              <select id="m-cat" name="categoryId" className="input text-sm" required>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label text-xs" htmlFor="m-year">Năm ra mắt</label>
              <input id="m-year" name="releaseYear" type="number" min={1970} max={2030} className="input text-sm" placeholder="2022" />
            </div>
            <div>
              <label className="label text-xs" htmlFor="m-desc">Mô tả</label>
              <textarea id="m-desc" name="description" rows={2} className="input resize-none text-sm" />
            </div>
            <button type="submit" className="btn-primary w-full text-sm">
              <Plus className="size-4" />
              Thêm vào catalog
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}
