import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { formatVND } from "@/src/lib/utils";
import { CheckoutForm } from "@/src/components/checkout-form";
import { ShieldCheck, Truck, HandCoins } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Thanh toán" };

export default async function CheckoutPage({
  searchParams,
}: PageProps<"/checkout">) {
  const session = await getCurrentUser();
  if (!session) redirect("/login");
  // lấy phone/city đầy đủ từ DB (SessionUser chỉ mang thông tin cơ bản)
  const user = await db.orm.public.User.first({ id: session.id });
  if (!user) redirect("/login");

  const sp = (await searchParams) as { listing?: string };
  const directSlug = sp.listing;

  // ─── Mua ngay 1 sản phẩm hoặc từ giỏ ───
  let lines: {
    title: string;
    slug: string;
    price: number;
    quantity: number;
    imageUrl: string | null;
    sellerName: string;
    commissionRate: number;
  }[] = [];

  if (directSlug) {
    const listing = await db.orm.public.Listing
      .where({ slug: directSlug, status: "approved" })
      .include("seller", (s) => s.select("name"))
      .include("category", (c) => c.select("commissionRate"))
      .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
      .first();
    if (listing) {
      lines = [{
        title: listing.title,
        slug: listing.slug,
        price: listing.price,
        quantity: 1,
        imageUrl: listing.images[0]?.url ?? null,
        sellerName: listing.seller!.name,
        commissionRate: listing.category!.commissionRate,
      }];
    }
  } else {
    const cart = await db.orm.public.Cart.first({ userId: user.id });
    if (cart) {
      const items = await db.orm.public.CartItem
        .where({ cartId: cart.id })
        .include("listing", (l) =>
          l.select("id", "title", "slug", "price", "status")
            .include("seller", (s) => s.select("name"))
            .include("category", (c) => c.select("commissionRate"))
            .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)),
        )
        .all();
      lines = items
        .filter((i) => i.listing!.status === "approved")
        .map((i) => ({
          title: i.listing!.title,
          slug: i.listing!.slug,
          price: i.listing!.price,
          quantity: i.quantity,
          imageUrl: i.listing!.images[0]?.url ?? null,
          sellerName: i.listing!.seller!.name,
          commissionRate: i.listing!.category!.commissionRate,
        }));
    }
  }

  if (lines.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 lg:px-8">
        <div className="card grid place-items-center gap-3 p-16 text-center">
          <span className="text-5xl">🛒</span>
          <p className="text-lg font-bold">Không có sản phẩm để thanh toán</p>
          <Link href="/listings" className="btn-primary mt-2 text-sm">Chọn loa để mua</Link>
        </div>
      </main>
    );
  }

  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const sellers = [...new Set(lines.map((l) => l.sellerName))];

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="text-2xl font-extrabold tracking-tight">Thanh toán</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {sellers.length > 1
          ? `Đơn sẽ tách thành ${sellers.length} đơn theo người bán`
          : `Bán bởi ${sellers[0]}`}
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* ─── Form ─── */}
        <CheckoutForm
          total={total}
          directListingId={directSlug ? (await db.orm.public.Listing.where({ slug: directSlug }).select("id").first())?.id ?? null : null}
          defaultPhone={user.phone ?? ""}
          defaultAddress={user.city ? `${user.city}, Việt Nam` : ""}
        />

        {/* ─── Tóm tắt ─── */}
        <aside className="card h-fit p-5 lg:sticky lg:top-20">
          <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Đơn hàng</p>
          <div className="mt-4 space-y-3">
            {lines.map((l) => (
              <div key={l.slug} className="flex gap-3">
                <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                  {l.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.imageUrl} alt={l.title} className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-xl text-[var(--muted)]">🔇</span>
                  )}
                  <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">
                    {l.quantity}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-xs font-medium leading-snug text-[var(--ink-2)]">{l.title}</p>
                  <p className="mt-0.5 text-xs font-bold text-[var(--accent)]">{formatVND(l.price * l.quantity)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--ink-2)]">Tạm tính</span>
              <span className="font-semibold">{formatVND(total)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[var(--ink-2)]">Tổng cộng</span>
              <span className="text-xl font-extrabold text-[var(--accent)]">{formatVND(total)}</span>
            </div>
          </div>

          <div className="mt-5 space-y-2.5 rounded-lg bg-[var(--paper)] p-3.5 text-xs leading-relaxed text-[var(--ink-2)]">
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--green)]" />
              Escrow: tiền được giữ đến khi bạn xác nhận nhận hàng
            </p>
            <p className="flex items-start gap-2">
              <HandCoins className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
              Hoa hồng {lines[0]?.commissionRate ?? 5}% thu từ người bán khi hoàn tất
            </p>
            <p className="flex items-start gap-2">
              <Truck className="mt-0.5 size-4 shrink-0 text-[#2563a8]" />
              Phí vận chuyển thỏa thuận trực tiếp với người bán
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
