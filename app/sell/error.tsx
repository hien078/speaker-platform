"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Error boundary cho phân khúc /sell (b4-holistic round-3 LOW — typed errors
 * thrown to missing error boundaries).
 *
 * Trước fix: KHÔNG có error.tsx nào dưới app/ — server action throw (vd lỗi
 * infra, sentinel chưa classify) → Next thay THẾ cả trang bằng generic
 * "Application error" (production sanitizes error.message). Các action seller
 * giờ trả typed form error / redirect typed code (xem listings.ts), nhưng
 * boundary này là DEFENSE-IN-DEPTH cho mọi thứ còn lọt (lỗi infra, action
 * mới tương lai) — seller thấy tiếng Việt + nút thử lại thay vì trang trắng.
 *
 * b4-holistic round-4 SPLIT (finding THẬT — đã check docs Next 16.3):
 * "Thử lại" gọi retry (stable v16.3 — error.md: "try to RE-FETCH and
 * RE-RENDER the error boundary's children"), KHÔNG còn prop reset — reset
 * chỉ clear error state + re-render children KHÔNG re-fetch (docs: "In most
 * cases, you should use retry instead") → lỗi SERVER-RENDER (lỗi infra DB
 * khi render /sell/my, /sell/[id]/edit — Server Component) render lại từ
 * payload ĐÃ LỖI, nút không làm gì; retry mới fetch RSC payload mới.
 *
 * KHÔNG echo error.message (production đã sanitize; message có thể chứa SQL
 * text từ lỗi DB — không phản chiếu ra UI). KHÔNG log thêm (captureError đã
 * chạy ở seam observability của action).
 */
export default function SellErrorBoundary({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  void error; // KHÔNG hiển thị message — chỉ digest (id để truy vết log)
  return (
    <main className="mx-auto grid max-w-lg place-items-center px-4 py-24 text-center lg:px-8">
      <div className="card w-full p-8">
        <AlertTriangle className="mx-auto size-10 text-[var(--red)]" />
        <h1 className="mt-4 text-lg font-extrabold">Không tải được trang tin đăng</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Đã có lỗi xảy ra khi xử lý tin đăng của bạn. Nội dung bạn đã nhập có thể
          chưa được lưu — vui lòng kiểm tra lại trong <b>Tin đăng của tôi</b>.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={() => retry()} className="btn-primary h-10 px-4 text-sm">
            <RotateCcw className="size-4" />
            Thử lại
          </button>
          <a href="/sell/my" className="btn-secondary h-10 px-4 text-sm">
            Về tin đăng của tôi
          </a>
        </div>
      </div>
    </main>
  );
}
