import Link from "next/link";
import type { ComponentType } from "react";
import { requireAdminUser } from "@/src/lib/rbac";
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

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** View tài chính lịch sử — chỉ đọc khi FINANCIAL_FEATURES_ENABLED=false (plan Task 5). */
  dormant?: boolean;
};

const NAV: NavItem[] = [
  { href: "/admin", label: "Tổng quan", icon: LayoutDashboard },
  { href: "/admin/listings", label: "Duyệt tin đăng", icon: FileSearch },
  { href: "/admin/catalog", label: "Catalog model", icon: AudioLines },
  { href: "/admin/orders", label: "Đơn hàng", icon: Package, dormant: true },
  { href: "/admin/disputes", label: "Khiếu nại", icon: AlertTriangle, dormant: true },
  { href: "/admin/withdraws", label: "Rút tiền", icon: Banknote, dormant: true },
  { href: "/admin/users", label: "Người dùng", icon: Users },
  { href: "/admin/settings", label: "Hoa hồng & cấu hình", icon: Settings, dormant: true },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  // Cổng vào /admin — requireAdminUser đọc User.adminRole (nguồn quyền duy nhất,
  // spec §8.5): chưa đăng nhập → /login; không adminRole → / (redirect, không
  // còn check user.role rộng — Batch 2 Task 4).
  await requireAdminUser();

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-8 lg:px-8">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="card sticky top-20 p-3">
          <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-3 pb-3 pt-1">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--accent)] text-white">
              <AudioLines className="size-4" strokeWidth={2.5} />
            </span>
            <div>
              <p className="text-sm font-extrabold">LoaViet</p>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]">
                Quản trị
              </p>
            </div>
          </div>
          <nav className="mt-2 space-y-0.5">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-[var(--ink-2)] transition hover:bg-[var(--paper)]/70 hover:text-white"
              >
                <item.icon className="size-4 text-[var(--muted)]" />
                {item.label}
                {item.dormant && (
                  <span className="badge ml-auto bg-[var(--paper-deep)] text-[10px] font-medium text-[var(--muted)]">
                    chỉ đọc
                  </span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      </aside>

      {/* Mobile nav */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-[var(--line)] bg-[var(--card)]/95 p-1.5 backdrop-blur lg:hidden">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] text-[var(--ink-2)]"
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
