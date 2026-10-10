import Link from "next/link";
import { RecoveryForm } from "@/src/components/recovery-form";

export const metadata = { title: "Đặt lại mật khẩu" };

/**
 * Trang đặt lại mật khẩu (plan Task 7) — pre-auth, không cần session.
 * Phản hồi của mọi bước luôn trung tính (chống enumeration, spec §7.7);
 * completion thu hồi MỌI phiên → đăng nhập lại bằng mật khẩu mới.
 */
export default function RecoverPage({}: PageProps<"/recover">) {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-sm flex-col justify-center px-4 py-16">
      <div className="mb-7">
        <p className="text-[19px] font-extrabold tracking-tight">
          loa<span className="text-[var(--accent)]">viet</span>
        </p>
        <h1 className="mt-3 text-[22px] font-extrabold tracking-tight">Đặt lại mật khẩu</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          Nhập email hoặc số điện thoại đã xác minh của tài khoản — mã đặt lại được gửi tới kênh đó.
        </p>
      </div>

      <div className="card p-5">
        <RecoveryForm />
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--ink-2)]">
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Quay lại đăng nhập
        </Link>
      </p>
    </main>
  );
}
