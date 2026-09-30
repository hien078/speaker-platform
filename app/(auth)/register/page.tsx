import Link from "next/link";
import { AuthForm } from "@/src/components/auth-form";

export const metadata = { title: "Đăng ký" };

export default function RegisterPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-sm flex-col justify-center px-4 py-16">
      <div className="mb-7">
        <p className="text-[19px] font-extrabold tracking-tight">
          loa<span className="text-[var(--accent)]">viet</span>
        </p>
        <h1 className="mt-3 text-[22px] font-extrabold tracking-tight">Tạo tài khoản</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">Đăng tin miễn phí, chỉ mất phí khi bán được.</p>
      </div>

      <div className="card p-5">
        <AuthForm mode="register" />
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--ink-2)]">
        Đã có tài khoản?{" "}
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Đăng nhập
        </Link>
      </p>
    </main>
  );
}
