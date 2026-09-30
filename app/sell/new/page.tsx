import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { CITIES, CONDITION_LABELS } from "@/src/lib/constants";
import { ListingForm } from "@/src/components/listing-form";
import { Package } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đăng bán loa" };

export default async function SellNewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [categories, brands, models] = await Promise.all([
    db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all(),
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
    db.orm.public.ProductModel
      .where({ status: "approved" })
      .select("id", "name", "brandId")
      .orderBy((m) => m.name.asc())
      .limit(200)
      .all(),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Package className="size-6 text-[var(--accent)]" />
        Đăng bán loa
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Tin của bạn sẽ được quản trị duyệt trước khi hiển thị — thường trong 24 giờ.
      </p>

      <div className="card mt-8 p-6">
        <ListingForm
          categories={categories.map((c) => ({ id: c.id, name: c.name, commissionRate: c.commissionRate }))}
          brands={brands.map((b) => ({ id: b.id, name: b.name }))}
          models={models.map((m) => ({ id: m.id, name: m.name, brandId: m.brandId }))}
          cities={CITIES}
          conditions={Object.entries(CONDITION_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </div>
    </main>
  );
}
