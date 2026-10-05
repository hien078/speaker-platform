import Link from "next/link";
import { getCurrentUser } from "@/src/lib/auth";
import { db } from "@/src/prisma/db.client";
import { Search, LogIn, MessageCircle, Bell } from "lucide-react";
import { HeaderUserMenu } from "@/src/components/header-user-menu";
import { unreadCount } from "@/src/lib/notify";

export async function Header() {
  const user = await getCurrentUser();

  let unreadChat = 0;
  let unreadNoti = 0;
  if (user) {
    // chỉ đếm tin chưa đọc trong hội thoại CỦA user (buyer hoặc seller)
    const asBuyer = await db.orm.public.Conversation
      .where({ buyerId: user.id })
      .select("id")
      .all();
    const asSeller = await db.orm.public.Conversation
      .where({ sellerId: user.id })
      .select("id")
      .all();
    const convos = [...asBuyer, ...asSeller];
    if (convos.length > 0) {
      const convoIds = convos.map((c) => c.id);
      const unread = await db.orm.public.Message
        .where((m) => m.readAt.isNull())
        .where((m) => m.conversationId.in(convoIds))
        .include("sender", (s) => s.select("id"))
        .all();
      unreadChat = unread.filter((m) => m.sender!.id !== user.id).length;
    }
    unreadNoti = await unreadCount(user.id);
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 lg:px-6">
        {/* Logo — chữ đậm, không icon gradient */}
        <Link href="/" className="shrink-0 text-[19px] font-extrabold tracking-tight text-[var(--ink)]">
          loa<span className="text-[var(--accent)]">viet</span>
          <span className="ml-1.5 hidden rounded-sm bg-[var(--ink)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white sm:inline">
            beta
          </span>
        </Link>

        {/* Search — thanh tìm chiếm phần lớn */}
        <form action="/listings" className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
          <input
            name="q"
            placeholder="Tìm loa, ampli, thương hiệu…"
            className="input h-9 rounded-full pl-9 text-[13px]"
            autoComplete="off"
          />
        </form>

        {/* Nav */}
        <nav className="hidden items-center gap-1 md:flex">
          <Link href="/listings" className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-deep)] hover:text-[var(--ink)]">
            Chợ loa
          </Link>
          <Link href="/sell/new" className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-deep)] hover:text-[var(--ink)]">
            Đăng bán
          </Link>
        </nav>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-0.5">
          {user ? (
            <>
              <Link
                href="/notifications"
                className="relative grid size-9 place-items-center rounded-md text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-deep)]"
                title="Thông báo"
              >
                <Bell className="size-[18px]" strokeWidth={2} />
                {unreadNoti > 0 && (
                  <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-[var(--red)] px-0.5 text-[9px] font-bold text-white">
                    {unreadNoti > 9 ? "9+" : unreadNoti}
                  </span>
                )}
              </Link>
              <Link
                href="/chat"
                className="relative grid size-9 place-items-center rounded-md text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-deep)]"
                title="Tin nhắn"
              >
                <MessageCircle className="size-[18px]" strokeWidth={2} />
                {unreadChat > 0 && (
                  <span className="absolute right-1 top-1 size-2 rounded-full bg-[var(--accent)]" />
                )}
              </Link>
              <HeaderUserMenu user={user} />
            </>
          ) : (
            <>
              <Link href="/login" className="btn-ghost h-9 px-3 text-[13px]">
                <LogIn className="size-4" strokeWidth={2} />
                Đăng nhập
              </Link>
              <Link href="/register" className="btn-primary h-8 px-3.5 text-[13px]">
                Đăng ký
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
