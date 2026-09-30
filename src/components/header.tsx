import Link from "next/link";
import { getCurrentUser } from "@/src/lib/auth";
import { db } from "@/src/prisma/db";
import {
  Search,
  ShoppingCart,
  AudioLines,
  LogIn,
  UserRound,
  MessageCircle,
} from "lucide-react";
import { HeaderUserMenu } from "@/src/components/header-user-menu";

export async function Header() {
  const user = await getCurrentUser();

  let cartCount = 0;
  let unreadChat = 0;
  if (user) {
    const cart = await db.orm.public.Cart.first({ userId: user.id });
    if (cart) {
      const items = await db.orm.public.CartItem.where({ cartId: cart.id }).all();
      cartCount = items.length;
    }
    const unread = await db.orm.public.Message
      .where((m) => m.readAt.isNull())
      .include("sender", (s) => s.select("id"))
      .all();
    unreadChat = unread.filter((m) => m.sender!.id !== user.id).length;
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/[.06] bg-[#07070e]/80 backdrop-blur-xl">
      {/* viền sáng mảnh dưới header */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-amber-400/25 to-transparent" />

      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:gap-5 lg:px-8">
        {/* Logo */}
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <span className="relative grid size-9 place-items-center rounded-xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-zinc-950 shadow-[0_4px_20px_-4px_rgba(251,146,60,.7)] transition-transform duration-300 group-hover:scale-105">
            <AudioLines className="size-5" strokeWidth={2.6} />
            <span className="absolute inset-0 rounded-xl bg-gradient-to-t from-white/25 to-transparent opacity-60" />
          </span>
          <span className="hidden font-[family-name:var(--font-space-grotesk)] text-lg font-bold tracking-tight sm:block">
            Loa<span className="text-spotlight">Viet</span>
          </span>
        </Link>

        {/* Search */}
        <form action="/listings" className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            name="q"
            placeholder="Tìm loa thùng, loa kéo, sub, ampli…"
            className="input h-10 rounded-full border-white/[.07] bg-white/[.04] pl-11 pr-4 text-sm backdrop-blur transition focus:border-amber-400/40 focus:bg-white/[.06]"
            autoComplete="off"
          />
        </form>

        {/* Nav */}
        <nav className="hidden items-center gap-1 md:flex">
          <Link
            href="/listings"
            className="rounded-full px-3.5 py-2 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white"
          >
            Chợ loa
          </Link>
          <Link
            href="/listings?exchange=1"
            className="rounded-full px-3.5 py-2 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white"
          >
            Trao đổi
          </Link>
        </nav>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {user ? (
            <>
              <Link
                href="/chat"
                className="relative grid size-10 place-items-center rounded-full text-zinc-400 transition hover:bg-white/5 hover:text-white"
                title="Tin nhắn"
              >
                <MessageCircle className="size-5" />
                {unreadChat > 0 && (
                  <span className="absolute right-1 top-1 size-2.5 animate-pulse rounded-full bg-rose-500 ring-2 ring-[#07070e]" />
                )}
              </Link>
              <Link
                href="/cart"
                className="relative grid size-10 place-items-center rounded-full text-zinc-400 transition hover:bg-white/5 hover:text-white"
                title="Giỏ hàng"
              >
                <ShoppingCart className="size-5" />
                {cartCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-gradient-to-b from-amber-300 to-orange-500 px-1 text-[11px] font-bold text-zinc-950 shadow-[0_2px_10px_rgba(251,146,60,.6)] ring-2 ring-[#07070e]">
                    {cartCount}
                  </span>
                )}
              </Link>
              <HeaderUserMenu user={user} />
            </>
          ) : (
            <>
              <Link href="/login" className="btn-ghost h-9 px-3 text-sm">
                <LogIn className="size-4" />
                Đăng nhập
              </Link>
              <Link href="/register" className="btn-primary h-9 px-4 text-sm">
                <UserRound className="size-4" />
                Đăng ký
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
