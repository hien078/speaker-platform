import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import {
  checkSellerPublicationRequirements,
  type SellerPublicationRequirement,
} from "@/src/lib/seller-verification-policy";
import {
  SELLER_VERIFICATION_STATUS_LABELS,
  SELLER_VERIFICATION_REASON_LABELS,
  type SellerVerificationStatus,
} from "@/src/lib/seller-verification-policy";
import { PROVINCE_CODES } from "@/src/lib/provinces";
import { SellerVerificationForm } from "@/src/components/seller-verification-form";
import { formatDateShort } from "@/src/lib/utils";
import { BadgeCheck, ShieldCheck, CheckCircle2, Circle, Clock } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Xác minh người bán" };

/**
 * /sell/verification (plan Task 10 — spec §5.3.2/§5.3.3) — quy trình xác minh
 * người bán thay cho boolean legacy: khai báo (seller type + mã tỉnh canonical
 * 34 đơn vị — FD-1) → đồng ý Quy tắc người bán v1 → gửi hồ sơ → operations
 * review (quyết định + reason code typed + policy version).
 *
 * KHÔNG thu thập giấy tờ danh tính ở bất kỳ đâu (spec §5.3.2). Copy §6.2 trung
 * tính — không ngôn ngữ bảo đảm/đảm bảo/chứng nhận.
 *
 * Yêu cầu publication (7) hiển thị dạng checklist — trạng thái derive từ
 * checkSellerPublicationRequirements (đọc FRESH từ DB).
 */

const REQUIREMENT_CHECKLIST: ReadonlyArray<{ key: SellerPublicationRequirement; label: string }> = [
  { key: "email_verified", label: "Xác minh email" },
  { key: "phone_verified", label: "Xác minh số điện thoại" },
  { key: "seller_type_declared", label: "Khai báo loại người bán" },
  { key: "operating_location_declared", label: "Khai báo khu vực hoạt động" },
  { key: "seller_rules_accepted", label: "Đồng ý Quy tắc người bán (v1)" },
  { key: "founding_seller_membership_active", label: "Thành viên founding_seller còn hoạt động" },
  { key: "operations_review_verified", label: "Operations review xác minh" },
] as const;

export default async function SellVerificationPage() {
  const session = await getCurrentUser();
  if (!session) redirect("/login");

  const user = await db.orm.public.User.first({ id: session.id });
  if (!user) redirect("/login");

  const [verification, check] = await Promise.all([
    db.orm.public.SellerVerification.first({ userId: user.id }),
    checkSellerPublicationRequirements(user.id),
  ]);

  const status: SellerVerificationStatus = verification?.status ?? "not_started";
  const missing = new Set(check.missing);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <BadgeCheck className="size-6 text-[var(--accent)]" />
        Xác minh người bán
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Tin đăng chỉ được đưa vào hàng duyệt và hiển thị trên chợ khi hồ sơ người bán thỏa yêu
        cầu hiện hành của LoaViet.
      </p>

      {/* ─── Trạng thái hiện tại ─── */}
      <div className="card mt-6 p-6">
        <p className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Trạng thái hồ sơ
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={
              status === "verified"
                ? "badge bg-[var(--green-soft)] text-[var(--green)]"
                : status === "pending"
                  ? "badge bg-amber-500/15 text-amber-600"
                  : status === "revoked"
                    ? "badge bg-[var(--red-soft)] text-[var(--red)]"
                    : "badge bg-[var(--paper-deep)] text-[var(--ink-2)]"
            }
          >
            {status === "verified" ? <ShieldCheck className="size-3" /> : null}
            {SELLER_VERIFICATION_STATUS_LABELS[status]}
          </span>
          {status === "verified" && (
            <span className="text-xs text-[var(--muted)]">
              Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.
            </span>
          )}
        </div>
        {verification?.reasonCode && status !== "verified" && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Lý do gần nhất: {SELLER_VERIFICATION_REASON_LABELS[verification.reasonCode as keyof typeof SELLER_VERIFICATION_REASON_LABELS] ?? verification.reasonCode}
          </p>
        )}
        {verification?.submittedAt && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            Gửi hồ sơ lúc {formatDateShort(verification.submittedAt)}
            {verification.reviewedAt ? ` · review lúc ${formatDateShort(verification.reviewedAt)}` : ""}
            {` · chính sách ${verification.policyVersion}`}
          </p>
        )}

        {/* Checklist 7 yêu cầu (derive từ check FRESH) */}
        <ul className="mt-4 space-y-1.5">
          {REQUIREMENT_CHECKLIST.map((req) => {
            const ok = !missing.has(req.key);
            return (
              <li key={req.key} className="flex items-center gap-2 text-sm">
                {ok ? (
                  <CheckCircle2 className="size-4 shrink-0 text-[var(--green)]" />
                ) : (
                  <Circle className="size-4 shrink-0 text-[var(--muted)]" />
                )}
                <span className={ok ? "text-[var(--ink-2)]" : "text-[var(--muted)]"}>{req.label}</span>
              </li>
            );
          })}
        </ul>
        {status === "pending" && (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--paper)]/60 px-3 py-2 text-xs text-[var(--muted)]">
            <Clock className="size-3.5" />
            Hồ sơ đang trong hàng đợi operations review — không cần gửi lại.
          </p>
        )}
      </div>

      {/* ─── Form: khai báo + gửi hồ sơ ─── */}
      <div className="card mt-6 p-6">
        <SellerVerificationForm
          sellerType={user.sellerType}
          operatingProvinceCode={user.sellerOperatingProvinceCode}
        />
      </div>

      {user.sellerOperatingProvinceCode && PROVINCE_CODES[user.sellerOperatingProvinceCode] && (
        <p className="mt-4 text-center text-xs text-[var(--muted)]">
          Khu vực hoạt động đã khai báo: {PROVINCE_CODES[user.sellerOperatingProvinceCode]}
        </p>
      )}
    </main>
  );
}
