import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE } from "@/src/lib/constants";
import { DormantFinanceNotice } from "./dormant-notice";
import {
  Banknote,
  FileSearch,
  AlertTriangle,
  Package,
  TrendingUp,
  ShieldCheck,
  Users,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Tổng quan" };

export default async function AdminDashboardPage() {
  // Escrow auto-release chạy qua cron /api/cron/auto-release (CRON_SECRET) —
  // KHÔNG chạy theo page load nữa (trước đây: processAutoReleases() ở đây).

  const [
    pendingListings,
    openDisputes,
    totalUsers,
    _sellers,
    completedAgg,
    _commissionAgg,
    escrowHeldAgg,
    gmvAgg,
    recentOrders,
    pendingListingsList,
    pendingWithdraws,
  ] = await Promise.all([
    db.orm.public.Listing.where({ status: "pending" }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.Dispute.where({ status: "open" }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.User.aggregate((a) => ({ c: a.count() })),
    db.orm.public.User.where({ role: "seller" }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.Order.where({ status: "completed" }).aggregate((a) => ({ c: a.count() })),
    db.orm.public.Payout.aggregate((a) => ({ total: a.sum("amount") })),
    db.orm.public.Payment.where({ status: "held" }).aggregate((a) => ({ total: a.sum("amount") })),
    db.orm.public.Order.aggregate((a) => ({ total: a.sum("totalAmount") })),
    db.orm.public.Order
      .include("buyer", (b) => b.select("name"))
      .include("seller", (s) => s.select("name"))
      .orderBy((o) => o.createdAt.desc())
      .limit(8)
      .all(),
    db.orm.public.Listing
      .where({ status: "pending" })
      .include("seller", (s) => s.select("name"))
      .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
      .orderBy((l) => l.createdAt.asc())
      .limit(5)
      .all(),
    db.orm.public.WithdrawRequest
      .where({ status: "requested" })
      .aggregate((a) => ({ c: a.count(), total: a.sum("amount") })),
  ]);

  // tổng hoa hồng = tổng tiền đơn - tổng payout... chính xác hơn: sum commissionAmount của đơn completed
  const commissionTotal = await db.orm.public.Order
    .where({ status: "completed" })
    .aggregate((a) => ({ total: a.sum("commissionAmount") }));

  const stats = [
    {
      label: "GMV — tổng giá trị đơn",
      value: formatVND(gmvAgg.total ?? 0),
      icon: <TrendingUp className="size-5 text-[var(--accent)]" />,
    },
    {
      label: "Hoa hồng đã thu",
      value: formatVND(commissionTotal.total ?? 0),
      icon: <Banknote className="size-5 text-[var(--green)]" />,
    },
    {
      label: "Escrow đang giữ",
      value: formatVND(escrowHeldAgg.total ?? 0),
      icon: <ShieldCheck className="size-5 text-[var(--violet)]" />,
    },
    {
      label: "Đơn hoàn tất",
      value: String(completedAgg.c),
      icon: <Package className="size-5 text-[#2563a8]" />,
    },
  ];

  const queue = [
    {
      label: "Tin chờ duyệt",
      value: pendingListings.c,
      href: "/admin/listings",
      icon: <FileSearch className="size-4" />,
      urgent: pendingListings.c > 0,
    },
    {
      label: "Khiếu nại mở",
      value: openDisputes.c,
      href: "/admin/disputes",
      icon: <AlertTriangle className="size-4" />,
      urgent: openDisputes.c > 0,
    },
    {
      label: `Rút tiền chờ duyệt (${formatVND(pendingWithdraws.total ?? 0)})`,
      value: pendingWithdraws.c,
      href: "/admin/withdraws",
      icon: <Banknote className="size-4" />,
      urgent: pendingWithdraws.c > 0,
    },
    {
      label: "Người dùng",
      value: totalUsers.c,
      href: "/admin/users",
      icon: <Users className="size-4" />,
      urgent: false,
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">Tổng quan nền tảng</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Số liệu tính đến {formatDate(new Date())}
      </p>

      {/* View finance lịch sử — chỉ đọc khi tài chính tắt (plan Task 5) */}
      <DormantFinanceNotice />

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="card p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-[var(--muted)]">{s.label}</p>
              {s.icon}
            </div>
            <p className="mt-2 text-xl font-extrabold tracking-tight sm:text-2xl">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Hàng đợi */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {queue.map((q) => (
          <Link
            key={q.label}
            href={q.href}
            className={cn(
              "card flex items-center gap-3 p-4 transition hover:-translate-y-0.5",
              q.urgent && "border-[var(--accent)]/45 bg-[var(--accent-soft)]",
            )}
          >
            <span className={cn("grid size-9 place-items-center rounded-lg", q.urgent ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--paper)] text-[var(--ink-2)]")}>
              {q.icon}
            </span>
            <div>
              <p className="text-lg font-extrabold leading-none">{q.value}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{q.label}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Tin chờ duyệt */}
        <section className="card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
              Tin chờ duyệt gần đây
            </h2>
            <Link href="/admin/listings" className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent)]">
              Xem tất cả →
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {pendingListingsList.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--muted)]">Hàng đợi trống — mọi tin đã được duyệt 🎉</p>
            ) : (
              pendingListingsList.map((l) => (
                <Link key={l.id} href="/admin/listings" className="flex items-center gap-3 rounded-lg p-1.5 transition hover:bg-[var(--paper)]">
                  <div className="size-11 shrink-0 overflow-hidden rounded-md bg-[var(--paper-deep)]">
                    {l.images[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={l.images[0].url} alt="" className="size-full object-cover" />
                    ) : (
                      <span className="grid size-full place-items-center text-[var(--muted)]">🔇</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm font-medium">{l.title}</p>
                    <p className="text-xs text-[var(--muted)]">
                      {l.seller!.name} · {formatVND(l.price)} · {formatDate(l.createdAt)}
                    </p>
                  </div>
                  <span className="badge shrink-0 bg-[var(--accent-soft)] text-[var(--accent)]">Chờ duyệt</span>
                </Link>
              ))
            )}
          </div>
        </section>

        {/* Đơn gần đây */}
        <section className="card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
              Đơn hàng mới nhất
            </h2>
            <Link href="/admin/orders" className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent)]">
              Xem tất cả →
            </Link>
          </div>
          <div className="mt-4 space-y-2.5">
            {recentOrders.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--muted)]">Chưa có đơn hàng nào</p>
            ) : (
              recentOrders.map((o) => (
                // Route chi tiết đơn public đã retire (Task 4) — hiển thị mã đơn
                // dạng text, không link sang finance flow đã tắt.
                <div key={o.id} className="flex items-center gap-3 rounded-lg p-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-bold text-[var(--accent)]">{o.code}</p>
                    <p className="text-xs text-[var(--muted)]">
                      {o.buyer!.name} → {o.seller!.name} · {formatDate(o.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold">{formatVND(o.totalAmount)}</p>
                    <span className={cn("badge", ORDER_STATUS_BADGE[o.status])}>
                      {ORDER_STATUS_LABELS[o.status]}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
