import Link from "next/link";
import { cookies } from "next/headers";
// Cookie const từ VOCAB module (plain module) — file "use server" KHÔNG thể
// export const (chỉ async function + type — Global Constraints).
import { MANUAL_RECOVERY_COOKIE } from "@/src/lib/manual-account-recovery";
import { findValidManualRecoveryToken } from "@/src/lib/actions/manual-account-recovery";
import { ManualRecoveryPasswordForm } from "@/src/components/manual-recovery-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đặt lại mật khẩu (liên kết hỗ trợ)", robots: { index: false } };

/**
 * /recover/manual — TOKENLESS reset page (Task E — FD-R3 founder 2026-10-13;
 * pattern /invite Batch 7 Task 3 — corrections items 7/35).
 *
 * Token sống trong cookie HttpOnly sp_manual_recovery (do route handler
 * /recover/manual/[token] set) — URL này KHÔNG mang token, KHÔNG next param,
 * KHÔNG query. Cookie thiếu/hết hạn/token không còn hợp lệ → thông báo CHUNG
 * "Liên kết không còn hiệu lực" (enumeration-safe — không phân biệt lý do).
 *
 * Copy TRUNG TÍNH (§4.2/§4.11 — PROVISIONAL, founder review qua register):
 * mô tả cơ chế đặt lại, KHÔNG cam kết gì về danh tính hay bảo mật. KHÔNG
 * render PII (§4.8) hay token.
 *
 * User đặt mật khẩu mới → consume action (public) — mọi phiên đã bị thu hồi
 * từ lúc admin duyệt; đăng nhập lại bằng mật khẩu mới.
 */
export default async function ManualRecoveryPage({}: PageProps<"/recover/manual">) {
  const token = (await cookies()).get(MANUAL_RECOVERY_COOKIE)?.value ?? null;
  const row = token !== null ? await findValidManualRecoveryToken(token) : null;

  if (row === null) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-sm flex-col justify-center px-4 py-16">
        <div className="card p-5">
          <h1 className="text-[20px] font-extrabold tracking-tight">Liên kết không còn hiệu lực</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Liên kết đặt lại mật khẩu này đã hết hạn, đã được sử dụng hoặc không tồn tại.
            Nếu bạn vừa nhận liên kết, hãy liên hệ lại hỗ trợ để nhận liên kết mới.
          </p>
          <p className="mt-4 text-center text-[13px] text-[var(--ink-2)]">
            <Link href="/recover" className="font-semibold text-[var(--accent)] hover:underline">
              Đặt lại mật khẩu qua mã xác minh
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-sm flex-col justify-center px-4 py-16">
      <div className="mb-7">
        <p className="text-[19px] font-extrabold tracking-tight">
          loa<span className="text-[var(--accent)]">viet</span>
        </p>
        <h1 className="mt-3 text-[22px] font-extrabold tracking-tight">Đặt lại mật khẩu</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          Bạn đang đặt lại mật khẩu qua liên kết do bộ phận hỗ trợ xác nhận. Mọi phiên đăng
          nhập trước đó đã được thu hồi — sau khi đặt lại, vui lòng đăng nhập bằng mật khẩu mới.
        </p>
      </div>

      <div className="card p-5">
        <ManualRecoveryPasswordForm />
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--ink-2)]">
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Quay lại đăng nhập
        </Link>
      </p>
    </main>
  );
}
