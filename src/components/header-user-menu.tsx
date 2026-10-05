"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/src/lib/auth";
import { cn } from "@/src/lib/utils";
import {
  UserRound,
  Package,
  ShoppingBag,
  MessageCircle,
  LayoutDashboard,
  LogOut,
  ChevronDown,
  Heart,
} from "lucide-react";

export function HeaderUserMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setOpen(false);
    router.refresh();
    router.push("/");
  }

  const initials = user.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition hover:bg-[var(--paper)]/70"
      >
        <span className="grid size-8 place-items-center rounded-full bg-[var(--accent)] text-xs font-bold text-white">
          {initials}
        </span>
        <ChevronDown className={cn("size-3.5 text-[var(--ink-2)] transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-60 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--card)] py-1.5 shadow-2xl shadow-black/50">
          <div className="border-b border-[var(--line)] px-4 pb-2.5 pt-1">
            <p className="truncate text-sm font-semibold">{user.name}</p>
            <p className="truncate text-xs text-[var(--muted)]">{user.email}</p>
          </div>
          <div className="p-1">
            <MenuItem href="/sell/new" icon={<Package className="size-4" />} label="Đăng bán loa" />
            <MenuItem href="/sell/my" icon={<ShoppingBag className="size-4" />} label="Tin của tôi" />
            <MenuItem href="/wishlist" icon={<Heart className="size-4" />} label="Tin đã lưu" />
            <MenuItem href="/profile" icon={<UserRound className="size-4" />} label="Hồ sơ" />
            <MenuItem href="/chat" icon={<MessageCircle className="size-4" />} label="Tin nhắn" />
            {user.role === "admin" && (
              <MenuItem href="/admin" icon={<LayoutDashboard className="size-4" />} label="Trang quản trị" />
            )}
            <div className="my-1 border-t border-[var(--line)]" />
            <button
              onClick={logout}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[var(--ink-2)] transition hover:bg-[var(--paper)]/70 hover:text-[var(--red)]"
            >
              <LogOut className="size-4" />
              Đăng xuất
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[var(--ink)] transition hover:bg-[var(--paper)]/70 hover:text-white"
    >
      {icon}
      {label}
    </Link>
  );
}
