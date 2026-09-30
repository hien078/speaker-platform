import Link from "next/link";
import { AuthForm } from "@/src/components/auth-form";

export const metadata = { title: "Đăng nhập" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-sm flex-col justify-center px-4 py-16">
      <div className="mb-7">
        <p className="text-[19px] font-extrabold tracking-tight">
          loa<span className="text-[var(--accent)]">viet</span>
        </p>
        <h1 className="mt-3 text-[22px] font-extrabold tracking-tight">Đăng nhập</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">Đơn hàng và tin nhắn của bạn đang chờ.</p>
      </div>

      <div className="card p-5">
        <AuthForm mode="login" />
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--ink-2)]">
        Chưa có tài khoản?{" "}
        <Link href="/register" className="font-semibold text-[var(--accent)] hover:underline">
          Đăng ký
        </Link>
      </p>
    </main>
  );
}
