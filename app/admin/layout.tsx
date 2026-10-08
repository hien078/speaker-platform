import Link from "next/link";
import type { ComponentType } from "react";
import { requireAdminUser, capabilitiesOf, type Capability } from "@/src/lib/rbac";
import {
  LayoutDashboard,
  FileSearch,
  Package,
  Flag,
  AlertTriangle,
  Users,
  UsersRound,
  Settings,
  AudioLines,
  Banknote,
  ShieldCheck,
  BadgeCheck,
  ScrollText,
  ChartColumn,
} from "lucide-react";

export const dynamic = "force-dynamic";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** View tài chính lịch sử — chỉ đọc khi FINANCIAL_FEATURES_ENABLED=false (plan Task 5). */
  dormant?: boolean;
  /**
   * Capability trang đích cần — nav lọc theo capabilitiesOf (Task 9). CONVENIENCE
   * ONLY (spec §4.5: hidden nav không phải authorization): mỗi trang/action vẫn
   * TỰ guard server-side; role thiếu quyền vẫn bị chặn khi POST/GET trực tiếp.
   * Không có capability = mọi adminRole đều thấy (dormant finance, /admin/security).
   */
  capability?: Capability;
};

const NAV: NavItem[] = [
  { href: "/admin", label: "Tổng quan", icon: LayoutDashboard, capability: "analytics.read" },
  { href: "/admin/listings", label: "Duyệt tin đăng", icon: FileSearch, capability: "listing.moderate" },
  { href: "/admin/catalog", label: "Catalog model", icon: AudioLines, capability: "listing.moderate" },
  // Batch 3 Task 6 (spec §5.5) — moderation case queue; report.resolve ✓ cells
  // (super/ops/moderator — analyst/support fail closed A1). CONVENIENCE ONLY:
  // trang/action tự requireCapability (spec §4.5).
  { href: "/admin/moderation", label: "Báo cáo & kiểm duyệt", icon: Flag, capability: "report.resolve" },
  { href: "/admin/orders", label: "Đơn hàng", icon: Package, dormant: true },
  { href: "/admin/disputes", label: "Khiếu nại", icon: AlertTriangle, dormant: true },
  { href: "/admin/withdraws", label: "Rút tiền", icon: Banknote, dormant: true },
  { href: "/admin/users", label: "Người dùng", icon: Users, capability: "user.view_basic" },
  // Batch 7 Task 5 (spec §5.10/§5.10.1) — founding seller console + concierge
  // tracking. Gated beta_cohort.manage (super/ops — ma trận §5.4.1;
  // moderator/support/analyst fail closed A2), lọc qua capabilitiesOf như mọi
  // entry (CONVENIENCE ONLY — spec §4.5: trang tự requireCapability là ranh
  // giới thật).
  { href: "/admin/beta-cohort", label: "Beta cohort", icon: UsersRound, capability: "beta_cohort.manage" },
  // Task 10 — workflow SellerVerification (spec §5.3.2/§8.2) + audit view (§4.6).
  { href: "/admin/seller-verification", label: "Xác minh người bán", icon: BadgeCheck, capability: "seller.verify" },
  { href: "/admin/audit", label: "Nhật ký audit", icon: ScrollText, capability: "audit.read" },
  // Batch 5 Task 10 (spec §5.8.2) — private-beta analytics dashboard. Gated
  // analytics.read (super/ops/analyst — moderator/support fail closed A2),
  // lọc qua capabilitiesOf như mọi entry (CONVENIENCE ONLY — spec §4.5: trang
  // tự requireCapability là ranh giới thật).
  { href: "/admin/analytics", label: "Phân tích beta", icon: ChartColumn, capability: "analytics.read" },
  { href: "/admin/settings", label: "Hoa hồng & cấu hình", icon: Settings, dormant: true },
  // Task 9 — mọi admin (tự phục vụ MFA/phiên của chính mình, spec §5.4.2).
  { href: "/admin/security", label: "Bảo mật & phiên", icon: ShieldCheck },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  // Cổng vào /admin — requireAdminUser đọc User.adminRole (nguồn quyền duy nhất,
  // spec §8.5): chưa đăng nhập → /login; không adminRole → / (redirect, không
  // còn check user.role rộng — Batch 2 Task 4).
  const admin = await requireAdminUser();

  // Nav lọc theo capability — CONVENIENCE (spec §4.5): moderator/support không
  // thấy link tới trang mình không có quyền, nhưng URL trực tiếp vẫn bị guard
  // trang chặn (mỗi page tự requireCapability/requireAdminUser — Task 4).
  const caps = capabilitiesOf(admin.user.adminRole);
  const visibleNav = NAV.filter((item) => !item.capability || caps.includes(item.capability));

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
            {visibleNav.map((item) => (
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
        {visibleNav.map((item) => (
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
