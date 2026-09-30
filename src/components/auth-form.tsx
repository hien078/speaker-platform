"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction, registerAction, type AuthFormState } from "@/src/lib/actions/auth";
import { LoaderCircle } from "lucide-react";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const action = mode === "login" ? loginAction : registerAction;
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-4">
      {mode === "register" && (
        <>
          <div>
            <label className="label" htmlFor="name">Họ và tên</label>
            <input id="name" name="name" className="input" placeholder="Nguyễn Văn A" required />
          </div>
          <div>
            <label className="label" htmlFor="phone">Số điện thoại</label>
            <input id="phone" name="phone" className="input" placeholder="090xxxxxxx" />
          </div>
          <div>
            <label className="label">Bạn muốn</label>
            <div className="grid grid-cols-2 gap-2">
              <label className="group cursor-pointer">
                <input type="radio" name="role" value="buyer" defaultChecked className="peer sr-only" />
                <span className="block rounded-lg border border-[var(--line)] px-3 py-2.5 text-center text-sm text-[var(--ink-2)] transition peer-checked:border-[var(--accent)]/65 peer-checked:bg-[var(--accent-soft)] peer-checked:text-[var(--accent)]">
                  Mua loa
                </span>
              </label>
              <label className="group cursor-pointer">
                <input type="radio" name="role" value="seller" className="peer sr-only" />
                <span className="block rounded-lg border border-[var(--line)] px-3 py-2.5 text-center text-sm text-[var(--ink-2)] transition peer-checked:border-[var(--accent)]/65 peer-checked:bg-[var(--accent-soft)] peer-checked:text-[var(--accent)]">
                  Bán loa
                </span>
              </label>
            </div>
          </div>
        </>
      )}

      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" placeholder="ban@example.com" required />
      </div>

      <div>
        <label className="label" htmlFor="password">Mật khẩu</label>
        <input id="password" name="password" type="password" className="input" placeholder="••••••••" required />
      </div>

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
      </button>

      {mode === "login" && (
        <p className="text-center text-xs text-[var(--muted)]">
          <Link href="/register" className="hover:text-[var(--accent)]">Chưa có tài khoản? Đăng ký</Link>
        </p>
      )}
    </form>
  );
}
