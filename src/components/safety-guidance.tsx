/**
 * §6.4 Independent Transaction Safety Guidance — hướng dẫn an toàn cho giao
 * dịch tự thỏa thuận (Batch 6 Task 6a — spec §6.4 + §5.2).
 *
 * Plain component — render thuần, KHÔNG directive client, KHÔNG import
 * db/server; mount được từ server lẫn client. Trang hội thoại mount MỘT LẦN,
 * sau DealPanel (Task 6b); panel KHÔNG tự render component này (tránh render đôi).
 *
 * Copy = bản dịch tiếng Việt 6 điểm §6.4 + dòng §5.2 ("The UI must state") +
 * dòng trung tính Batch 1 — product copy, KHÔNG phải văn bản pháp lý
 * (§4.2/§4.11 — Batch 8 duyệt bản cuối; A9/FD-3, PROVISIONAL).
 */
import { ShieldCheck } from "lucide-react";

/** Sáu điểm §6.4 — byte-identical plan Task 6 (copy-safety SAFETY_64_POINTS). */
const SAFETY_POINTS = [
  "Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.",
  "Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.",
  "Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.",
  "Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.",
  "Cẩn trọng với các đường link thanh toán đáng ngờ.",
  "Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.",
] as const;

/** Dòng §5.2 — bắt buộc trong UI (copy-safety SAFETY_52_LINE). */
const INDEPENDENT_TRANSACTION_LINE =
  "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.";

/** Dòng trung tính Batch 1 — negation duy nhất được allowlist (copy-safety). */
const NEUTRAL_LINE = "LoaViet không giữ tiền và không bảo đảm giao dịch.";

export function SafetyGuidance({ className }: { className?: string }) {
  return (
    <section
      aria-label="Hướng dẫn an toàn giao dịch"
      className={className ?? "card p-4 text-sm text-[var(--ink-2)]"}
    >
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
        <ShieldCheck className="size-4 text-[var(--accent)]" />
        Lưu ý an toàn giao dịch
      </p>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 leading-relaxed">
        {SAFETY_POINTS.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <div className="mt-3 space-y-1.5 border-t border-[var(--line)] pt-3 text-xs leading-relaxed text-[var(--muted)]">
        <p>{INDEPENDENT_TRANSACTION_LINE}</p>
        <p>{NEUTRAL_LINE}</p>
      </div>
    </section>
  );
}
