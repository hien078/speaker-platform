import Link from "next/link";
import { AudioLines, ShieldCheck, Handshake, Banknote } from "lucide-react";

export function Footer() {
  return (
    <footer className="relative mt-20 border-t border-white/[.06] bg-[#0a0a12]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/20 to-transparent" />

      <div className="mx-auto max-w-7xl px-4 py-14 lg:px-8">
        <div className="grid gap-10 md:grid-cols-4">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5">
              <span className="relative grid size-9 place-items-center rounded-xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-zinc-950 shadow-[0_4px_20px_-4px_rgba(251,146,60,.6)]">
                <AudioLines className="size-4.5" strokeWidth={2.6} />
              </span>
              <span className="font-[family-name:var(--font-space-grotesk)] text-lg font-bold tracking-tight">
                Loa<span className="text-spotlight">Viet</span>
              </span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-zinc-500">
              Chợ trung gian mua bán &amp; trao đổi loa và thiết bị âm thanh. Người bán trưng bày
              sản phẩm, người mua an tâm giao dịch qua cơ chế giữ tiền escrow.
            </p>
            <div className="mt-6 flex flex-wrap gap-4 text-xs text-zinc-600">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-emerald-500/80" />
                Escrow bảo vệ 2 bên
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Handshake className="size-4 text-violet-400/80" />
                Trao đổi + tiền bù
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Banknote className="size-4 text-amber-400/80" />
                Hoa hồng minh bạch
              </span>
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold text-zinc-300">Mua sắm</p>
            <ul className="mt-3.5 space-y-2.5 text-sm text-zinc-500">
              <li><Link className="transition hover:text-amber-300" href="/listings">Tất cả tin đăng</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/listings?exchange=1">Danh sách trao đổi</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/cart">Giỏ hàng</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/wishlist">Tin đã lưu</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/orders">Đơn hàng của tôi</Link></li>
            </ul>
          </div>

          <div>
            <p className="text-sm font-semibold text-zinc-300">Bán hàng</p>
            <ul className="mt-3.5 space-y-2.5 text-sm text-zinc-500">
              <li><Link className="transition hover:text-amber-300" href="/sell/new">Đăng tin bán loa</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/sell/my">Quản lý tin đăng</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/orders/sales">Đơn bán được</Link></li>
              <li><Link className="transition hover:text-amber-300" href="/chat">Tin nhắn</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/[.05] pt-6 text-xs text-zinc-600 sm:flex-row">
          <p>© {new Date().getFullYear()} LoaViet — nền tảng trung gian mua bán loa.</p>
          <p>Giao dịch được bảo vệ bởi cơ chế escrow của nền tảng.</p>
        </div>
      </div>
    </footer>
  );
}
