import Link from "next/link";
import { AudioLines } from "lucide-react";
import { AuthForm } from "@/src/components/auth-form";

export const metadata = { title: "Đăng ký" };

export default function RegisterPage() {
  return (
    <main className="mesh-hero relative flex min-h-[calc(100vh-16rem)] flex-col items-center justify-center px-4 py-16">
      <div className="orb left-[15%] top-[20%] size-56 bg-violet-600/15" aria-hidden />
      <div className="orb right-[18%] bottom-[25%] size-64 bg-amber-500/15 [animation-delay:-4s]" aria-hidden />

      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-zinc-950 shadow-[0_8px_32px_-6px_rgba(251,146,60,.7)]">
            <AudioLines className="size-7" strokeWidth={2.5} />
          </span>
          <h1 className="mt-5 text-2xl font-bold tracking-tight">Tạo tài khoản LoaViet</h1>
          <p className="mt-1.5 text-sm text-zinc-500">Mua bán và trao đổi loa an toàn, minh bạch.</p>
        </div>

        <div className="ring-gradient relative p-6">
          <AuthForm mode="register" />
        </div>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Đã có tài khoản?{" "}
          <Link href="/login" className="font-semibold text-amber-400 transition hover:text-amber-300">
            Đăng nhập
          </Link>
        </p>
      </div>
    </main>
  );
}
