"use client";

import { CheckCircle2 } from "lucide-react";
import { confirmReceiptAction } from "@/src/lib/actions/orders";

/** Nút xác nhận nhận hàng — có hộp thoại confirm (tránh bấm nhầm giải ngân escrow) */
export function ConfirmReceiptButton({ orderId }: { orderId: string }) {
  return (
    <form action={confirmReceiptAction}>
      <input type="hidden" name="orderId" value={orderId} />
      <button
        type="submit"
        className="btn-primary w-full"
        onClick={(e) => {
          if (
            !confirm(
              "Bạn đã nhận hàng và kiểm tra đúng mô tả?\n\nTiền escrow sẽ giải ngân cho người bán ngay sau bước này.",
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <CheckCircle2 className="size-4" />
        Đã nhận hàng — giải ngân cho seller
      </button>
    </form>
  );
}
