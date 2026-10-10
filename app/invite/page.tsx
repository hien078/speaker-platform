import Link from "next/link";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/src/lib/auth";
import { BETA_INVITE_COOKIE, findActiveInviteToken } from "@/src/lib/founding-sellers";
import { InviteAcceptForm } from "@/src/components/invite-accept-form";

/**
 * /invite — TOKENLESS invitation page (Batch 7 Task 3 — S1; spec §9 Batch 7,
 * §2.1; corrections 2026-10-08 items 7/35).
 *
 * Token sống trong cookie HttpOnly sp_invite (do route handler
 * /invite/[token] set) — URL này KHÔNG mang token, KHÔNG next param, KHÔNG
 * query. Cookie thiếu/hết hạn/token không còn hợp lệ → thông báo CHUNG
 * "Lời mời không còn hiệu lực" (enumeration-safe — không phân biệt lý do).
 *
 * Copy TRUNG TÍNH (§4.2/§4.11 — PROVISIONAL, founder review qua Batch 8
 * register): mô tả cơ chế nhận lời mời, KHÔNG incentive/reward, KHÔNG cam kết
 * kết quả, KHÔNG legal text mới (Batch 8 owns policy text). KHÔNG render
 * contact reference (§4.8) hay token.
 *
 * Chưa đăng nhập → CTA /login?next=/invite (TOKENLESS). Trang đăng ký
 * KHÔNG mang next (corrections #35) — copy hướng dẫn invitee mới: đăng ký,
 * xác minh email/số điện thoại mà lời mời được gửi tới, rồi MỞ LẠI link
 * lời mời gốc (GET re-set cookie khi token chưa consume).
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Lời mời founding seller", robots: { index: false } };

export default async function InvitePage() {
  const token = (await cookies()).get(BETA_INVITE_COOKIE)?.value ?? null;
  const row = token !== null ? await findActiveInviteToken(token) : null;
  const user = await getCurrentUser();

  if (row === null) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-md flex-col justify-center px-4 py-16">
        <div className="card p-6">
          <h1 className="text-[20px] font-extrabold tracking-tight">Lời mời không còn hiệu lực</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Lời mời này đã hết hạn, đã được sử dụng hoặc đã bị thu hồi. Nếu bạn vừa nhận link, hãy
            liên hệ lại người mời bạn để nhận link mới.
          </p>
          <p className="mt-4 text-[13px] text-[var(--ink-2)]">
            <Link href="/" className="font-semibold text-[var(--accent)] hover:underline">
              Về trang chủ
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-20rem)] max-w-md flex-col justify-center px-4 py-16">
      <div className="card p-6">
        <p className="text-[19px] font-extrabold tracking-tight">
          loa<span className="text-[var(--accent)]">viet</span>
        </p>
        <h1 className="mt-3 text-[22px] font-extrabold tracking-tight">Lời mời founding seller</h1>

        <div className="mt-4 space-y-3 text-sm text-[var(--ink-2)]">
          <p>
            Bạn được mời tham gia nhóm người bán đầu tiên của LoaViet trong giai đoạn beta riêng.
          </p>
          <p>
            Khi nhận lời mời, tài khoản của bạn được ghi nhận tư cách thành viên founding seller.
            Việc đăng tin vẫn tuân theo quy trình xác minh người bán hiện hành của LoaViet.
          </p>
        </div>

        {user !== null ? (
          <div className="mt-6">
            <InviteAcceptForm />
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <Link
              href="/login?next=/invite"
              className="btn-primary block w-full text-center text-sm"
            >
              Đăng nhập để nhận lời mời
            </Link>
            <p className="text-[12px] text-[var(--muted)]">
              Chưa có tài khoản? Hãy đăng ký, xác minh email hoặc số điện thoại mà lời mời được
              gửi tới, rồi mở lại link lời mời gốc để tiếp tục.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
