import Link from "next/link";

/**
 * PolicyAcceptanceNotice — thông báo trung tính khi guard từ chối hành động
 * (POLICY_ACCEPTANCE_REQUIRED — zero-cost launch Task D, founder decision
 * 2026-10-12). Dùng chung bởi MỌI form/banner bị gate (DealCreateForm,
 * ChatWindow, PortableListingForm, ListingForm, banner ?error= /sell/my +
 * /sell/[id]/edit) — một nguồn copy, KHÔNG 500 (action phân loại typed error
 * sang surface riêng, form map code → notice này).
 *
 * Plain component (KHÔNG "use client", KHÔNG hook) — render được ở cả server
 * component (banner trang) lẫn client component (form useActionState).
 * Copy mechanics-only: nói NGUYÊN NHÂN (chưa đồng ý) + ĐƯỜNG LÀM (link) —
 * không hứa hẹn, không đổ lỗi.
 */
export function PolicyAcceptanceNotice() {
  return (
    <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--red)]">
      Bạn cần đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư của LoaViet
      trước khi thực hiện thao tác này.{" "}
      <Link
        href="/account/policies"
        className="font-semibold text-[var(--red)] underline underline-offset-2 hover:opacity-80"
      >
        Xem và đồng ý tại trang tài khoản
      </Link>
      .
    </p>
  );
}
