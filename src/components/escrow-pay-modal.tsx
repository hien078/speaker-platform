"use client";

import { useState } from "react";
import { useActionState } from "react";
import { payEscrowAction } from "@/src/lib/actions/orders";
import { formatVND } from "@/src/lib/utils";
import { ShieldCheck, LoaderCircle, CheckCircle2, CreditCard } from "lucide-react";

/**
 * Modal mô phỏng cổng thanh toán (VNPay/MoMo).
 * Production: thay bằng redirect sang cổng thật + webhook verify.
 */
export function EscrowPayModal({
  orderId,
  amount,
  code,
}: {
  orderId: string;
  amount: number;
  code: string;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"choose" | "processing" | "done">("choose");
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(
    async (prev, formData) => {
      try {
        await payEscrowAction(formData);
        return {};
      } catch (e) {
        if (typeof e === "object" && e !== null && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) {
          throw e;
        }
        return { error: e instanceof Error ? e.message : "Có lỗi xảy ra" };
      }
    },
    {},
  );

  function pay() {
    setStage("processing");
    // mô phỏng thời gian xử lý cổng
    setTimeout(() => {
      (document.getElementById("escrow-pay-form") as HTMLFormElement)?.requestSubmit();
      setStage("done");
    }, 1400);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-primary w-full">
        <ShieldCheck className="size-4" />
        Thanh toán {formatVND(amount)} qua escrow
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-md overflow-hidden p-0">
        {/* header cổng */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-gradient-to-r from-amber-500/15 to-transparent px-6 py-4">
          <span className="grid size-10 place-items-center rounded-xl bg-amber-500 text-zinc-950">
            <CreditCard className="size-5" />
          </span>
          <div>
            <p className="text-sm font-extrabold">Cổng thanh toán LoaViet Pay</p>
            <p className="text-xs text-zinc-500">Đơn {code} · môi trường demo</p>
          </div>
        </div>

        <div className="p-6">
          {stage === "choose" && (
            <>
              <p className="text-center text-2xl font-extrabold text-amber-400">{formatVND(amount)}</p>
              <p className="mt-1 text-center text-xs text-zinc-500">
                Tiền sẽ được nền tảng giữ đến khi bạn xác nhận đã nhận hàng
              </p>

              <div className="mt-5 space-y-2">
                {["VietQR — Ngân hàng VCB", "Ví MoMo", "Thẻ ATM/Visa (mock)"].map((m) => (
                  <div key={m} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm">
                    <span className="text-zinc-300">{m}</span>
                    <span className="badge bg-emerald-500/15 text-emerald-400">Sẵn sàng</span>
                  </div>
                ))}
              </div>

              <button onClick={pay} className="btn-primary mt-5 w-full">
                Xác nhận thanh toán
              </button>
              <button onClick={() => setOpen(false)} className="btn-ghost mt-2 w-full text-sm">
                Để sau
              </button>
            </>
          )}

          {stage === "processing" && (
            <div className="grid place-items-center gap-3 py-10 text-center">
              <LoaderCircle className="size-10 animate-spin text-amber-400" />
              <p className="text-sm font-semibold">Đang xử lý giao dịch…</p>
              <p className="text-xs text-zinc-500">Không tắt trang này</p>
            </div>
          )}

          {stage === "done" && (
            <form id="escrow-pay-form" action={formAction} className="grid place-items-center gap-3 py-10 text-center">
              <input type="hidden" name="orderId" value={orderId} />
              <CheckCircle2 className="size-12 text-emerald-400" />
              <p className="text-base font-bold">Giao dịch thành công!</p>
              <p className="text-xs text-zinc-500">Đang chuyển về trang đơn hàng…</p>
              {pending && <LoaderCircle className="size-5 animate-spin text-zinc-500" />}
              {state.error && <p className="text-sm text-red-400">{state.error}</p>}
              <button type="submit" className="btn-primary mt-2 text-sm">Hoàn tất</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
