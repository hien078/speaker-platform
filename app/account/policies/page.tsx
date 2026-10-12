import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { POLICIES } from "@/src/lib/policy-registry";
import {
  ACCOUNT_POLICY_KEYS,
  missingPolicyAcceptances,
} from "@/src/lib/policy-acceptance";
import { PolicyAcceptanceForm } from "@/src/components/policy-acceptance-form";
import { formatDateShort } from "@/src/lib/utils";
import { ShieldCheck, FileText } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Điều khoản & quyền riêng tư" };

/**
 * /account/policies (zero-cost launch Task D — founder decision 2026-10-12):
 * trang cho user ĐÃ ĐĂNG NHẬP xem trạng thái chấp nhận terms + privacy tại
 * version HIỆN HÀNH của registry + đồng ý những gì còn thiếu.
 *
 * - User đăng ký SAU Task D đã có đủ 2 row (ghi trong tx đăng ký) → thấy trạng
 *   thái "đã đồng ý" + ngày; form không mount.
 * - User HIỆN CÓ (đăng ký trước cơ chế) hoặc user sau version bump của
 *   founder (FD-R4 pattern) → thấy chính sách còn thiếu + form đồng ý
 *   (acceptCurrentPoliciesAction — idempotent, cơ chế Batch 2).
 * - KHÔNG backfill consent: user hiện có chấp nhận ở đây (hoặc bị guard
 *   POLICY_ACCEPTANCE_REQUIRED dẫn về đây trên hành động tạo nội dung).
 *
 * Đọc FRESH từ DB mỗi lần render (dynamic) — trạng thái luôn đúng sau
 * accept/re-accept. DRAFT-NOT-REVIEWED hiển thị trung tính theo registry
 * (FD-3): version ghi nhận là chuỗi version hiện hành ("v1") — khi founder
 * duyệt + bump, guard chặn lại và user quay lại trang này.
 */
export default async function AccountPoliciesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Trạng thái từng policy: đọc FRESH — missing theo version hiện hành.
  const missing = await missingPolicyAcceptances(user.id);
  const missingSet = new Set(missing);

  // Ngày chấp nhận (nếu có) — hiển thị per policy.
  const acceptedAt = await Promise.all(
    ACCOUNT_POLICY_KEYS.map(async (key) => {
      const row = await db.orm.public.PolicyAcceptance.first({
        userId: user.id,
        policyKey: key,
        policyVersion: POLICIES[key].version,
      });
      return row?.acceptedAt ?? null;
    }),
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <ShieldCheck className="size-6 text-[var(--accent)]" />
        Điều khoản &amp; quyền riêng tư
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Trạng thái đồng ý của tài khoản với phiên bản hiện hành của từng chính sách.
      </p>

      <div className="card mt-6 divide-y divide-[var(--line)] p-0">
        {ACCOUNT_POLICY_KEYS.map((key, i) => {
          const policy = POLICIES[key];
          const accepted = !missingSet.has(key);
          return (
            <div key={key} className="flex flex-wrap items-center justify-between gap-3 p-5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <FileText className="size-4 text-[var(--accent)]" />
                  {policy.title}
                  <span className="badge bg-[var(--paper)] text-xs font-medium text-[var(--muted)]">
                    Phiên bản {policy.version}
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  <Link
                    href={`/policies/${key}`}
                    target="_blank"
                    rel="noopener"
                    className="font-semibold text-[var(--accent)] hover:underline"
                  >
                    Đọc nội dung
                  </Link>
                  {" · "}
                  cập nhật {policy.updatedAt}
                  {policy.status === "DRAFT-NOT-REVIEWED" && (
                    <>
                      {" · "}
                      <span className="font-semibold">bản dự thảo, chưa được duyệt</span>
                    </>
                  )}
                </p>
              </div>
              {accepted ? (
                <span className="badge bg-[var(--green-soft)] text-xs font-semibold text-[var(--green)]">
                  Đã đồng ý{acceptedAt[i] != null ? ` · ${formatDateShort(acceptedAt[i]!)}` : ""}
                </span>
              ) : (
                <span className="badge bg-[var(--red-soft)] text-xs font-semibold text-[var(--red)]">
                  Chưa đồng ý ở phiên bản này
                </span>
              )}
            </div>
          );
        })}
      </div>

      {missing.length > 0 ? (
        <div className="card mt-6 p-6">
          <p className="mb-4 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Đồng ý để tiếp tục dùng các tính năng
          </p>
          <p className="mb-4 text-[13px] leading-relaxed text-[var(--muted)]">
            Bạn cần đồng ý với cả hai chính sách ở phiên bản hiện hành trước khi nhắn tin,
            tạo thỏa thuận hoặc đăng tin. Việc đồng ý được ghi nhận kèm thời điểm và phiên
            bản; khi có phiên bản mới, bạn sẽ được đề nghị đồng ý lại tại đây.
          </p>
          <PolicyAcceptanceForm />
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-[var(--green)]/35 bg-[var(--green-soft)] px-4 py-3 text-sm text-[var(--green)]">
          ✓ Bạn đã đồng ý với phiên bản hiện hành của cả hai chính sách — không cần thao tác gì thêm.
        </div>
      )}
    </main>
  );
}
