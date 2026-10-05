import { ShieldOff } from "lucide-react";

/**
 * Nhãn dormancy cho view tài chính lịch sử trong admin (plan Task 5, spec §4.3).
 *
 * Private beta: FINANCIAL_FEATURES_ENABLED=false (mặc định) — bản ghi finance
 * (Order/Payment/Payout/WithdrawRequest/Dispute/LedgerEntry…) được bảo toàn và
 * CHỈ ĐỌC. Mọi control mutation (xử lý khiếu nại, duyệt rút tiền, cấu hình hoa
 * hồng) đã bỏ khỏi UI; server action dưới đáy vẫn deny với mã
 * FINANCIAL_FEATURES_DISABLED (spec §4.1/§4.10) — admin không phải escape hatch.
 */
export function DormantFinanceNotice() {
  return (
    <p className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-xs leading-relaxed text-[var(--ink-2)]">
      <ShieldOff className="mt-0.5 size-4 shrink-0 text-[var(--muted)]" />
      <span>
        <b className="text-[var(--ink)]">Dữ liệu tài chính lịch sử — chỉ đọc (dormant).</b>{" "}
        Tính năng tài chính đang tắt trong private beta: không có thao tác hoàn tiền, giải
        ngân, rút tiền hay cấu hình hoa hồng. Mọi thay đổi bị từ chối phía server với mã{" "}
        <span className="font-mono">FINANCIAL_FEATURES_DISABLED</span>.
      </span>
    </p>
  );
}
