import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { ListingCard, getListingCards } from "@/src/components/listing-card";
import { FeaturedSpeakersSection } from "@/src/components/featured-speakers";
import { SecondhandModelsSection } from "@/src/components/secondhand-models";
import { Search, ArrowRight, MessageCircle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [categories, newest, exchangeable, popular, stats] = await Promise.all([
    db.orm.public.Category
      .where({ isActive: true })
      .orderBy((c) => c.sortOrder.asc())
      .all(),
    getListingCards({ status: "approved" }, { limit: 12, sort: "newest" }),
    getListingCards({ status: "approved", acceptExchange: true }, { limit: 4, sort: "newest" }),
    getListingCards({ status: "approved" }, { limit: 4, sort: "popular" }),
    db.orm.public.Listing
      .where({ status: "approved" })
      .aggregate((a) => ({ count: a.count() })),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-4 lg:px-6">
      {/* ═══ Hero — nói thẳng, không phô trương ═══ */}
      <section className="border-b border-[var(--line)] py-12 sm:py-16">
        <div className="max-w-2xl">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
            Chợ loa secondhand &amp; mới
          </p>
          <h1 className="mt-3 text-[34px] font-extrabold leading-[1.12] tracking-tight text-[var(--ink)] sm:text-[42px]">
            Loa xịn, giá thật,<br />
            thỏa thuận trực tiếp.
          </h1>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-[var(--ink-2)]">
            Loa thùng, loa kéo, bookshelf, ampli — từ người bán đã xác minh.
            Nhắn người bán để hỏi giá, xem tình trạng thật và hẹn gặp kiểm tra loa
            trực tiếp.
          </p>

          {/* Tìm kiếm */}
          <form action="/listings" className="relative mt-7 max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
            <input
              name="q"
              placeholder="VD: JBL EON, loa kéo Yamaha, sub BMB…"
              className="input h-11 rounded-full pl-10 pr-24 text-sm"
              autoComplete="off"
            />
            <button type="submit" className="btn-primary absolute right-1.5 top-1/2 h-8 -translate-y-1/2 rounded-full px-4 text-[13px]">
              Tìm
            </button>
          </form>

          <p className="mt-3 text-[12px] text-[var(--muted)]">
            {stats.count} tin đang bán · đăng tin miễn phí trong private beta
          </p>
        </div>
      </section>

      {/* ═══ Danh mục — dải chữ gọn ═══ */}
      <section className="border-b border-[var(--line)] py-6">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          <span className="mr-2 text-[12px] font-bold uppercase tracking-wider text-[var(--muted)]">
            Dòng loa:
          </span>
          {categories.slice(0, 14).map((c) => (
            <Link
              key={c.id}
              href={`/listings?category=${c.slug}`}
              className="rounded-full border border-[var(--line-2)] bg-white px-3 py-1 text-[12.5px] font-medium text-[var(--ink-2)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)]"
            >
              {c.name}
            </Link>
          ))}
          <Link href="/listings" className="px-2 text-[12.5px] font-semibold text-[var(--accent)] hover:underline">
            tất cả →
          </Link>
        </div>
      </section>

      {/* ═══ Gợi ý mẫu loa secondhand — ảnh tham khảo, không phải tin bán ═══ */}
      <SecondhandModelsSection />

      {/* ═══ Mẫu loa nổi bật — ảnh AI, thông số tham khảo ═══ */}
      <FeaturedSpeakersSection />

      {/* ═══ Vừa lên kệ ═══ */}
      <section className="py-10">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-[17px] font-extrabold tracking-tight">Vừa lên kệ</h2>
          <Link href="/listings" className="text-[13px] font-semibold text-[var(--accent)] hover:underline">
            xem tất cả
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {newest.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
      </section>

      {/* ═══ Trao đổi ═══ */}
      {exchangeable.length > 0 && (
        <section className="border-t border-[var(--line)] py-10">
          <div className="mb-4 flex items-baseline justify-between">
            <div>
              <h2 className="text-[17px] font-extrabold tracking-tight">Nhận đổi loa lấy loa</h2>
              <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                Đổi chéo sản phẩm — hai bên tự thỏa thuận qua chat
              </p>
            </div>
            <Link href="/listings?exchange=1" className="text-[13px] font-semibold text-[var(--accent)] hover:underline">
              xem tất cả
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {exchangeable.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        </section>
      )}

      {/* ═══ Xem nhiều ═══ */}
      {popular.length > 0 && (
        <section className="border-t border-[var(--line)] py-10">
          <h2 className="mb-4 text-[17px] font-extrabold tracking-tight">Xem nhiều tuần này</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {popular.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        </section>
      )}

      {/* ═══ Vòng lặp beta: tìm → chat → gặp & thỏa thuận ═══ */}
      <section className="my-10 rounded-lg border border-[var(--line)] bg-white p-6 sm:p-8">
        <p className="section-label">Giao dịch trên LoaViet</p>
        <div className="mt-6 grid gap-8 sm:grid-cols-3">
          {[
            {
              n: "1",
              title: "Tìm loa phù hợp",
              desc: "Tìm kiếm, lọc theo dòng loa, hãng, giá và khu vực; so sánh giá tham chiếu từ catalog model.",
            },
            {
              n: "2",
              title: "Nhắn người bán",
              desc: "Hỏi giá, tình trạng thật, phụ kiện đi kèm. Người bán đã xác minh và phản hồi qua chat trên nền tảng.",
            },
            {
              n: "3",
              title: "Gặp và thỏa thuận",
              desc: "Hẹn xem và test loa trực tiếp. Thanh toán và giao nhận hàng do hai bên tự thỏa thuận, diễn ra độc lập ngoài LoaViet — nền tảng không giữ tiền.",
            },
          ].map((s) => (
            <div key={s.n}>
              <div className="flex items-center gap-2.5">
                <span className="grid size-7 place-items-center rounded-full bg-[var(--ink)] text-[12px] font-bold text-white">
                  {s.n}
                </span>
                <h3 className="text-[14px] font-bold">{s.title}</h3>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-2)]">{s.desc}</p>
            </div>
          ))}
        </div>

        <div className="rule-double mt-8" />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <p className="flex items-center gap-2 text-[13px] text-[var(--ink-2)]">
            <MessageCircle className="size-4 text-[var(--accent)]" />
            Mọi thỏa thuận bắt đầu từ chat — LoaViet không giữ tiền và không bảo đảm giao dịch
          </p>
          <div className="flex gap-2">
            <Link href="/sell/new" className="btn-primary h-9 px-5 text-[13px]">
              Đăng bán loa
              <ArrowRight className="size-3.5" />
            </Link>
            <Link href="/listings" className="btn-secondary h-9 px-5 text-[13px]">
              Đi xem chợ
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
