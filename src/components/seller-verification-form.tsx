"use client";

import { useActionState } from "react";
import {
  declareSellerProfileAction,
  submitSellerVerificationAction,
  type SellerVerificationFormState,
} from "@/src/lib/actions/seller-verification";
import { PROVINCES } from "@/src/lib/provinces";
import { LoaderCircle, CheckCircle2, MapPin, UserRound } from "lucide-react";

/**
 * Form xác minh người bán (plan Task 10 — spec §5.3.2/§5.3.3/§6.2) — client
 * component với hai form useActionState:
 *
 *  1. Khai báo hồ sơ: loại người bán (cá nhân/doanh nghiệp) + khu vực hoạt
 *     động (select 34 tỉnh/thành — FD-1, src/lib/provinces.ts plain module).
 *     KHÔNG thu thập giấy tờ danh tính (spec §5.3.2).
 *  2. Gửi hồ sơ: tick đồng ý Quy tắc người bán v1 (cơ chế ghi nhận — văn bản
 *     pháp lý đầy đủ thuộc Batch 8 review; FD-3: placeholder trung tính,
 *     KHÔNG bịa nội dung pháp lý, KHÔNG ngôn ngữ bảo đảm).
 *
 * Copy §6.2: đúng câu trung tính "Đã xác minh thông tin người bán theo yêu
 * cầu hiện tại của LoaViet." — tránh mọi câu "bảo đảm/đảm bảo/chứng nhận".
 */

function FormMessage({ state }: { state: SellerVerificationFormState }) {
  if (state.error) {
    return (
      <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2.5 text-sm text-[var(--green)]">
        <CheckCircle2 className="size-4 shrink-0" />
        {state.success}
      </p>
    );
  }
  return null;
}

type FormProps = {
  sellerType: "individual" | "business" | null;
  operatingProvinceCode: string | null;
};

export function SellerVerificationForm({ sellerType, operatingProvinceCode }: FormProps) {
  const [declareState, declareAction, declarePending] = useActionState(
    declareSellerProfileAction,
    {},
  );
  const [submitState, submitAction, submitPending] = useActionState(
    submitSellerVerificationAction,
    {},
  );

  return (
    <div className="space-y-6">
      {/* ─── 1. Khai báo hồ sơ ─── */}
      <form action={declareAction} className="space-y-3">
        <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          <UserRound className="size-4" />
          Khai báo hồ sơ người bán
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--muted)]">Loại người bán</span>
            <select name="sellerType" defaultValue={sellerType ?? ""} className="input" required>
              <option value="" disabled>— Chọn —</option>
              <option value="individual">Cá nhân</option>
              <option value="business">Doanh nghiệp</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--muted)]">Khu vực hoạt động</span>
            <select
              name="operatingProvinceCode"
              defaultValue={operatingProvinceCode ?? ""}
              className="input"
              required
            >
              <option value="" disabled>— Chọn tỉnh/thành —</option>
              {PROVINCES.map((p) => (
                // displayName đã mang tiền tố chính thức ("TP. Hồ Chí Minh") —
                // KHÔNG thêm "TP." nữa (review fix L4: tránh "TP. TP. Hồ Chí Minh").
                <option key={p.code} value={p.code}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" disabled={declarePending} className="btn-secondary text-sm">
          {declarePending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          <MapPin className="size-4" />
          Lưu khai báo
        </button>
        <FormMessage state={declareState} />
      </form>

      {/* ─── 2. Gửi hồ sơ xác minh ─── */}
      <form action={submitAction} className="space-y-3 border-t border-[var(--line)] pt-5">
        <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Gửi hồ sơ xác minh
        </p>
        <p className="text-xs leading-relaxed text-[var(--muted)]">
          Xác minh người bán là một kiểm soát mức truy cập của nền tảng —{" "}
          <b className="text-[var(--ink-2)]">không</b> phải bảo đảm sản phẩm hay chứng nhận giao
          dịch. Khi được duyệt, hồ sơ của bạn hiển thị:{" "}
          <i>Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.</i>
        </p>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper)]/40 px-3.5 py-3 text-sm">
          <input
            type="checkbox"
            name="acceptSellerRules"
            className="mt-0.5 size-4 accent-[var(--accent)]"
          />
          <span>
            Tôi đã đọc và đồng ý với <b>Quy tắc người bán LoaViet (phiên bản v1)</b> — bản tóm tắt
            trung tính hiện đang áp dụng; văn bản đầy đủ sẽ được rà soát pháp lý trước khi mời
            chính thức (ghi nhận đồng ý của bạn theo phiên bản v1).
          </span>
        </label>
        <button type="submit" disabled={submitPending} className="btn-primary text-sm">
          {submitPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Gửi hồ sơ để operations review
        </button>
        <FormMessage state={submitState} />
      </form>
    </div>
  );
}
