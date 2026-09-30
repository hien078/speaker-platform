import { redirect } from "next/navigation";
import { getCurrentUser } from "@/src/lib/auth";
import { cn } from "@/src/lib/utils";
import Link from "next/link";
import {
  LayoutDashboard,
  FileSearch,
  Package,
  AlertTriangle,
  Users,
  Settings,
  AudioLines,
  Banknote,
} from "lucide-react";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/admin", label: "Tổng quan", icon: LayoutDashboard },
  { href: "/admin/listings", label: "Duyệt tin đăng", icon: FileSearch },
  { href: "/admin/catalog", label: "Catalog model", icon: AudioLines },
  { href: "/admin/orders", label: "Đơn hàng", icon: Package },
  { href: "/admin/disputes", label: "Khiếu nại", icon: AlertTriangle },
  { href: "/admin/withdraws", label: "Rút tiền", icon: Banknote },
  { href: "/admin/users", label: "Người dùng", icon: Users },
  { href: "/admin/settings", label: "Hoa hồng & cấu hình", icon: Settings },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-8 lg:px-8">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="card sticky top-20 p-3">
          <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-3 pb-3 pt-1">
            <span className="grid size-8 place-items-center rounded-lg bg-amber-500 text-zinc-950">
              <AudioLines className="size-4" strokeWidth={2.5} />
            </span>
            <div>
              <p className="text-sm font-extrabold">LoaViet</p>
              <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400">
                Quản trị
              </p>
            </div>
          </div>
          <nav className="mt-2 space-y-0.5">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-zinc-300 transition hover:bg-zinc-800/70 hover:text-white"
              >
                <item.icon className="size-4 text-zinc-500" />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </aside>

      {/* Mobile nav */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-[var(--border)] bg-[var(--surface)]/95 p-1.5 backdrop-blur lg:hidden">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] text-zinc-400"
          >
            <item.icon className="size-4" />
            {item.label.split(" ")[0]}
          </Link>
        ))}
      </div>

      <div className="min-w-0 flex-1 pb-20 lg:pb-0">{children}</div>
    </div>
  );
}
