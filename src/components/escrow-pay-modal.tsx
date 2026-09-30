"use client";

import { useState } from "react";
import { useActionState } from "react";
import { payEscrowAction } from "@/src/lib/actions/orders";
import { formatVND } from "@/src/lib/utils";
import { ShieldCheck, LoaderCircle, CheckCircle2, CreditCard, ExternalLink } from "lucide-react";

/**
 * Modal thanh toán escrow.
 * - MoMo đã cấu hình (MOMO_PARTNER_CODE…): redirect sang cổng MoMo thật.
 * - Chưa cấu hình: dùng mock gateway (mô phỏng thành công).
 */
export function EscrowPayModal({
  orderId,
  amount,
  code,
  momoEnabled,
}: {
  orderId: string;
  amount: number;
  code: string;
  momoEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"choose" | "processing" | "done">("choose");
  const [error, setError] = useState<string | null>(null);
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

  async function payWithMomo() {
    setStage("processing");
    setError(null);
    try {
      const res = await fetch("/api/payments/momo/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const json = (await res.json()) as { payUrl?: string; error?: string; message?: string };
      if (json.payUrl) {
        // redirect sang trang thanh toán MoMo thật
        window.location.href = json.payUrl;
        return;
      }
      // MoMo lỗi → fallback mock
      setError(json.message ?? json.error ?? "Không tạo được thanh toán MoMo — dùng mock");
      setStage("choose");
    } catch {
      setError("Lỗi kết nối cổng MoMo — thử lại hoặc dùng mock");
      setStage("choose");
    }
  }

  function payMock() {
    setStage("processing");
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
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-gradient-to-r from-violet-500/15 via-amber-500/10 to-transparent px-6 py-4">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-violet-400 to-fuchsia-600 text-sm font-bold text-white">
            Mo
          </span>
          <div>
            <p className="text-sm font-extrabold">
              Cổng thanh toán {momoEnabled ? "MoMo" : "LoaViet Pay (mock)"}
            </p>
            <p className="text-xs text-zinc-500">Đơn {code} · {momoEnabled ? "môi trường thật" : "chưa cấu hình MoMo"}</p>
          </div>
        </div>

        <div className="p-6">
          {stage === "choose" && (
            <>
              <p className="text-center text-2xl font-extrabold text-spotlight">{formatVND(amount)}</p>
              <p className="mt-1 text-center text-xs text-zinc-500">
                Tiền sẽ được nền tảng giữ đến khi bạn xác nhận đã nhận hàng
              </p>

              {error && (
                <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3.5 py-2.5 text-xs text-amber-300">
                  {error}
                </p>
              )}

              <div className="mt-5 space-y-2">
                {momoEnabled ? (
                  <button onClick={payWithMomo} className="btn-primary w-full bg-gradient-to-b from-violet-400 to-fuchsia-600 text-white shadow-[0_8px_30px_-8px_rgba(192,38,211,.5)]">
                    <ExternalLink className="size-4" />
                    Thanh toán qua ví MoMo
                  </button>
                ) : (
                  <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-xs leading-relaxed text-zinc-400">
                    Chưa cấu hình MoMo (thiếu MOMO_PARTNER_CODE trong .env) — đang dùng mock.
                  </p>
                )}
                <button onClick={payMock} className="btn-secondary w-full">
                  <CreditCard className="size-4" />
                  Mô phỏng thanh toán (mock)
                </button>
                <button onClick={() => setOpen(false)} className="btn-ghost w-full text-sm">
                  Để sau
                </button>
              </div>
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
