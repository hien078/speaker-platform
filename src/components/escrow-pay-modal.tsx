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
    <div className="fixed inset-0 z-[100] grid place-items-center bg-[var(--ink)]/60 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-md overflow-hidden p-0">
        {/* header cổng */}
        <div className="flex items-center gap-3 border-b border-[var(--line)] bg-gradient-to-r from-[var(--violet)]/15 via-amber-500/10 to-transparent px-6 py-4">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-[var(--violet)] to-[var(--violet)] text-sm font-bold text-white">
            Mo
          </span>
          <div>
            <p className="text-sm font-extrabold">
              Cổng thanh toán {momoEnabled ? "MoMo" : "LoaViet Pay (mock)"}
            </p>
            <p className="text-xs text-[var(--muted)]">Đơn {code} · {momoEnabled ? "môi trường thật" : "chưa cấu hình MoMo"}</p>
          </div>
        </div>

        <div className="p-6">
          {stage === "choose" && (
            <>
              <p className="text-center text-2xl font-extrabold price">{formatVND(amount)}</p>
              <p className="mt-1 text-center text-xs text-[var(--muted)]">
                Tiền sẽ được nền tảng giữ đến khi bạn xác nhận đã nhận hàng
              </p>

              {error && (
                <p className="mt-4 rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3.5 py-2.5 text-xs text-[var(--accent)]">
                  {error}
                </p>
              )}

              <div className="mt-5 space-y-2">
                {momoEnabled ? (
                  <button onClick={payWithMomo} className="btn-primary w-full bg-gradient-to-b from-[var(--violet)] to-[var(--violet)] text-white ">
                    <ExternalLink className="size-4" />
                    Thanh toán qua ví MoMo
                  </button>
                ) : (
                  <p className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-xs leading-relaxed text-[var(--ink-2)]">
                    Chưa cấu hình MoMo (thiếu MOMO_PARTNER_CODE trong .env) — đang dùng mock.
                  </p>
                )}
                {process.env.NODE_ENV !== "production" && (
                  <button onClick={payMock} className="btn-secondary w-full">
                    <CreditCard className="size-4" />
                    Mô phỏng thanh toán (mock)
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="btn-ghost w-full text-sm">
                  Để sau
                </button>
              </div>
            </>
          )}

          {stage === "processing" && (
            <div className="grid place-items-center gap-3 py-10 text-center">
              <LoaderCircle className="size-10 animate-spin text-[var(--accent)]" />
              <p className="text-sm font-semibold">Đang xử lý giao dịch…</p>
              <p className="text-xs text-[var(--muted)]">Không tắt trang này</p>
            </div>
          )}

          {stage === "done" && (
            <form id="escrow-pay-form" action={formAction} className="grid place-items-center gap-3 py-10 text-center">
              <input type="hidden" name="orderId" value={orderId} />
              <CheckCircle2 className="size-12 text-[var(--green)]" />
              <p className="text-base font-bold">Giao dịch thành công!</p>
              <p className="text-xs text-[var(--muted)]">Đang chuyển về trang đơn hàng…</p>
              {pending && <LoaderCircle className="size-5 animate-spin text-[var(--muted)]" />}
              {state.error && <p className="text-sm text-[var(--red)]">{state.error}</p>}
              <button type="submit" className="btn-primary mt-2 text-sm">Hoàn tất</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
