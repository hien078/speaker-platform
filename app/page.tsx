import Link from "next/link";
import { db } from "@/src/prisma/db";
import { ListingCard, getListingCards } from "@/src/components/listing-card";
import {
  Search,
  ShieldCheck,
  Handshake,
  Banknote,
  ArrowRight,
  Sparkles,
  AudioLines,
  Flame,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [categories, newest, popular, exchangeable, stats] = await Promise.all([
    db.orm.public.Category
      .where({ isActive: true })
      .orderBy((c) => c.sortOrder.asc())
      .all(),
    getListingCards({ status: "approved" }, { limit: 8, sort: "newest" }),
    getListingCards({ status: "approved" }, { limit: 4, sort: "popular" }),
    getListingCards({ status: "approved", acceptExchange: true }, { limit: 4, sort: "newest" }),
    db.orm.public.Listing
      .where({ status: "approved" })
      .aggregate((a) => ({ count: a.count() })),
  ]);

  return (
    <main>
      {/* ═══════════ HERO ═══════════ */}
      <section className="mesh-hero relative overflow-hidden border-b border-white/[.05]">
        {/* quầng sáng trôi */}
        <div className="orb left-[8%] top-[12%] size-72 bg-amber-500/20" aria-hidden />
        <div className="orb right-[10%] top-[30%] size-80 bg-violet-600/20 [animation-delay:-4s]" aria-hidden />
        <div className="orb bottom-[-10%] left-[45%] size-72 bg-rose-500/10 [animation-delay:-7s]" aria-hidden />

        <div className="relative mx-auto max-w-7xl px-4 pb-20 pt-20 text-center lg:px-8">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/[.07] px-4 py-1.5 text-xs font-semibold text-amber-300 backdrop-blur">
            <Sparkles className="size-3.5" />
            Chợ loa trung gian — escrow bảo vệ cả hai bên
          </p>

          <h1 className="mx-auto mt-7 max-w-3xl font-[family-name:var(--font-space-grotesk)] text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Mua bán &amp; trao đổi loa
            <span className="text-spotlight block pb-2">an toàn tuyệt đối</span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-zinc-400">
            Hàng nghìn mẫu loa thùng, loa kéo, hi-fi từ người bán đã xác minh.
            Nền tảng giữ tiền đến khi bạn nhận hàng — hoa hồng minh bạch theo %.
          </p>

          {/* Search lớn */}
          <form action="/listings" className="relative mx-auto mt-9 max-w-xl">
            <Search className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-zinc-500" />
            <input
              name="q"
              placeholder="Tìm JBL EON, loa kéo Yamaha, sub BMB…"
              className="input h-14 rounded-full border-white/10 bg-[#101019]/80 py-4 pl-13 pr-32 text-base shadow-[0_8px_40px_-8px_rgba(0,0,0,.8)] backdrop-blur-xl"
            />
            <button
              type="submit"
              className="btn-primary absolute right-2 top-1/2 h-10 -translate-y-1/2 rounded-full px-6"
            >
              Tìm kiếm
            </button>
          </form>

          {/* Số liệu tin cậy */}
          <div className="mx-auto mt-10 flex max-w-2xl flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {[
              { value: `${stats.count}`, label: "tin đang bán" },
              { value: "escrow", label: "giữ tiền đến khi nhận hàng" },
              { value: "7 ngày", label: "thời gian khiếu nại" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="font-[family-name:var(--font-space-grotesk)] text-xl font-bold text-white">
                  {s.value}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-500">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════ Danh mục ═══════════ */}
      <section className="mx-auto max-w-7xl px-4 pt-14 lg:px-8">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="font-[family-name:var(--font-space-grotesk)] text-2xl font-bold tracking-tight">
              Khám phá theo dòng loa
            </h2>
            <p className="mt-1 text-sm text-zinc-500">Chọn đúng phân khúc bạn cần</p>
          </div>
          <Link href="/listings" className="btn-ghost text-sm text-amber-400 hover:text-amber-300">
            Tất cả tin <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {categories.slice(0, 12).map((c, i) => (
            <Link
              key={c.id}
              href={`/listings?category=${c.slug}`}
              className="card card-hover group relative overflow-hidden p-4 text-center"
            >
              {/* ánh sáng gradient theo vị trí */}
              <div
                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background: `radial-gradient(80% 80% at 50% 100%, hsla(${(i * 47 + 25) % 360}, 90%, 60%, .12), transparent 70%)`,
                }}
              />
              <span className="relative text-2xl transition-transform duration-300 group-hover:scale-115">{c.icon}</span>
              <p className="relative mt-2 text-xs font-semibold leading-tight text-zinc-300">{c.name}</p>
              <p className="relative mt-1 text-[10px] text-zinc-600">hoa hồng {c.commissionRate}%</p>
            </Link>
          ))}
        </div>
      </section>

      {/* ═══════════ Tin mới nhất ═══════════ */}
      <section className="mx-auto max-w-7xl px-4 pt-14 lg:px-8">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="font-[family-name:var(--font-space-grotesk)] text-2xl font-bold tracking-tight">
              Vừa lên kệ
            </h2>
            <p className="mt-1 text-sm text-zinc-500">{stats.count} sản phẩm đang bán</p>
          </div>
          <Link href="/listings" className="btn-ghost text-sm text-amber-400 hover:text-amber-300">
            Xem tất cả <ArrowRight className="size-4" />
          </Link>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {newest.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
      </section>

      {/* ═══════════ Trao đổi ═══════════ */}
      {exchangeable.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 pt-14 lg:px-8">
          <div className="relative overflow-hidden rounded-3xl border border-violet-400/15 bg-gradient-to-br from-violet-500/[.08] via-transparent to-fuchsia-500/[.06] p-6 sm:p-8">
            <div className="orb right-[-5%] top-[-30%] size-64 bg-violet-500/20" aria-hidden />
            <div className="relative flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="flex items-center gap-2.5 font-[family-name:var(--font-space-grotesk)] text-2xl font-bold tracking-tight">
                  <Handshake className="size-6 text-violet-300" />
                  Sẵn sàng trao đổi
                </h2>
                <p className="mt-1.5 text-sm text-zinc-400">
                  Đổi loa lấy loa + tiền bù — phần tiền bù được escrow giữ giúp bạn
                </p>
              </div>
              <Link href="/listings?exchange=1" className="btn-secondary text-sm">
                Xem tất cả <ArrowRight className="size-4" />
              </Link>
            </div>
            <div className="relative mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {exchangeable.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ═══════════ Phổ biến ═══════════ */}
      {popular.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 pt-14 lg:px-8">
          <h2 className="flex items-center gap-2.5 font-[family-name:var(--font-space-grotesk)] text-2xl font-bold tracking-tight">
            <Flame className="size-6 text-orange-400" />
            Được săn nhiều nhất
          </h2>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {popular.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        </section>
      )}

      {/* ═══════════ Cách escrow bảo vệ ═══════════ */}
      <section className="mx-auto max-w-7xl px-4 pt-16 lg:px-8">
        <div className="ring-gradient relative overflow-hidden rounded-3xl p-8 sm:p-12">
          <div className="orb left-[-10%] top-[-20%] size-72 bg-amber-500/15" aria-hidden />
          <div className="orb right-[-8%] bottom-[-30%] size-72 bg-violet-600/15 [animation-delay:-5s]" aria-hidden />

          <div className="relative">
            <h2 className="text-center font-[family-name:var(--font-space-grotesk)] text-3xl font-bold tracking-tight">
              Giao dịch qua <span className="text-spotlight">LoaViet</span> an toàn thế nào?
            </h2>

            <div className="mt-10 grid gap-8 sm:grid-cols-3">
              {[
                {
                  step: "01",
                  icon: <Banknote className="size-5 text-amber-300" />,
                  title: "Trả tiền vào nền tảng",
                  desc: "Tiền được escrow giữ — người bán chắc chắn có tiền nếu giao hàng đúng cam kết.",
                },
                {
                  step: "02",
                  icon: <AudioLines className="size-5 text-violet-300" />,
                  title: "Người bán gửi loa",
                  desc: "Seller nhập mã vận đơn, bạn theo dõi đơn từng bước cho đến khi hàng về tay.",
                },
                {
                  step: "03",
                  icon: <ShieldCheck className="size-5 text-emerald-300" />,
                  title: "Nhận hàng → giải ngân",
                  desc: "Xác nhận đã nhận loa, nền tảng trừ hoa hồng % và chuyển tiền cho người bán. Có 7 ngày khiếu nại.",
                },
              ].map((s) => (
                <div key={s.step} className="relative">
                  <span className="pointer-events-none absolute -top-4 right-0 font-[family-name:var(--font-space-grotesk)] text-5xl font-bold text-white/[.05]">
                    {s.step}
                  </span>
                  <div className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/[.04] backdrop-blur">
                    {s.icon}
                  </div>
                  <h3 className="mt-4 font-[family-name:var(--font-space-grotesk)] text-base font-bold">
                    {s.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.desc}</p>
                </div>
              ))}
            </div>

            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Link href="/sell/new" className="btn-primary px-7 py-3 text-base">
                Đăng bán loa của bạn
              </Link>
              <Link href="/listings" className="btn-secondary px-7 py-3 text-base">
                Khám phá chợ loa
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
