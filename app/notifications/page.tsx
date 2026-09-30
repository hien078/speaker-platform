import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { formatDate, timeAgo, cn } from "@/src/lib/utils";
import { markAllReadAction } from "@/src/lib/actions/notifications";
import { Bell, HandCoins, AlertTriangle, MessageCircle, Banknote, CheckCheck } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Thông báo" };

const KIND_ICON: Record<string, React.ReactNode> = {
  offer: <HandCoins className="size-4 text-amber-300" />,
  counter: <HandCoins className="size-4 text-violet-300" />,
  order: <Banknote className="size-4 text-emerald-300" />,
  dispute: <AlertTriangle className="size-4 text-red-300" />,
  chat: <MessageCircle className="size-4 text-sky-300" />,
  withdraw: <Banknote className="size-4 text-orange-300" />,
};

export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const notifications = await db.orm.public.Notification
    .where({ userId: user.id })
    .orderBy((n) => n.createdAt.desc())
    .limit(50)
    .all();

  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <Bell className="size-6 text-amber-400" />
          Thông báo
          {unread > 0 && (
            <span className="badge bg-amber-400/15 text-amber-300">{unread} mới</span>
          )}
        </h1>
        {unread > 0 && (
          <form action={markAllReadAction}>
            <button type="submit" className="btn-ghost text-sm text-amber-400 hover:text-amber-300">
              <CheckCheck className="size-4" />
              Đọc hết
            </button>
          </form>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-2 p-16 text-center">
          <span className="text-4xl">🔔</span>
          <p className="font-bold">Chưa có thông báo nào</p>
          <p className="text-sm text-zinc-500">
            Trả giá, đơn hàng, khiếu nại… sẽ hiện tại đây.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-2.5">
          {notifications.map((n) => {
            const content = (
              <div
                className={cn(
                  "card flex items-start gap-3.5 p-4 transition",
                  !n.readAt && "border-amber-400/25 bg-amber-400/[.04]",
                )}
              >
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-white/5 bg-white/[.04]">
                  {KIND_ICON[n.kind] ?? <Bell className="size-4 text-zinc-400" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-semibold leading-snug", !n.readAt && "text-amber-100")}>
                    {n.title}
                  </p>
                  {n.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-400">{n.body}</p>
                  )}
                  <p className="mt-1 text-[11px] text-zinc-600">{timeAgo(n.createdAt)}</p>
                </div>
                {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-400" />}
              </div>
            );
            return n.link ? (
              <Link key={n.id} href={n.link} className="block">{content}</Link>
            ) : (
              <div key={n.id}>{content}</div>
            );
          })}
        </div>
      )}
    </main>
  );
}
