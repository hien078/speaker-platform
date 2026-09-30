import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { ListingCard } from "@/src/components/listing-card";
import { Heart } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tin đã lưu" };

export default async function WishlistPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const items = await db.orm.public.WishlistItem
    .where({ userId: user.id })
    .include("listing", (l) =>
      l.select(
        "id", "title", "slug", "price", "condition", "city", "status",
        "viewCount", "acceptExchange", "negotiable",
      )
        .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
        .include("category", (c) => c.select("name"))
        .include("brand", (b) => b.select("name")),
    )
    .orderBy((w) => w.createdAt.desc())
    .all();

  const listings = items.map((w) => w.listing!).filter(Boolean);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Heart className="size-6 fill-red-500 text-red-500" />
        Tin đã lưu
      </h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Theo dõi giá và tình trạng những chiếc loa bạn để mắt tới.
      </p>

      {listings.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">🤍</span>
          <p className="text-lg font-bold">Chưa lưu tin nào</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">
            Bấm vào biểu tượng ❤️ ở trang chi tiết tin đăng để lưu sản phẩm vào đây.
          </p>
          <Link href="/listings" className="btn-primary mt-2 text-sm">Đi đến chợ loa</Link>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {listings.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
      )}
    </main>
  );
}
