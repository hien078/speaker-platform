"use client";

import { useState } from "react";
import { formatVND } from "@/src/lib/utils";
import { Banknote, LoaderCircle, ExternalLink } from "lucide-react";

/**
 * Nút nạp tiền bù trao đổi qua escrow.
 * MoMo cấu hình → redirect cổng thật; lỗi → fallback server action (mock).
 */
export function ExchangeTopupButton({
  offerId,
  amount,
  momoEnabled,
}: {
  offerId: string;
  amount: number;
  momoEnabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/momo/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchangeOfferId: offerId }),
      });
      const json = (await res.json()) as { payUrl?: string; error?: string };
      if (json.payUrl) {
        window.location.href = json.payUrl;
        return;
      }
      setError(json.error ?? "Không tạo được thanh toán MoMo");
    } catch {
      setError("Lỗi kết nối cổng MoMo");
    }
    setBusy(false);
  }

  return (
    <div className="w-full">
      {error && (
        <p className="mb-2 rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--accent)]">
          {error} — dùng nút mock bên dưới để tiếp tục thử nghiệm.
        </p>
      )}
      {momoEnabled ? (
        <button
          onClick={pay}
          disabled={busy}
          className="btn-primary w-full bg-gradient-to-b from-[var(--violet)] to-[var(--violet)] text-white "
        >
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
          Nạp {formatVND(amount)} tiền bù qua MoMo
        </button>
      ) : null}
    </div>
  );
}
