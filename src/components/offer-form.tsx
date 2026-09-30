"use client";

import { useActionState, useState } from "react";
import { createOfferAction, type OfferFormState } from "@/src/lib/actions/offers";
import { formatVND, cn } from "@/src/lib/utils";
import { LoaderCircle, HandCoins } from "lucide-react";

export function OfferForm({
  listingId,
  listingPrice,
}: {
  listingId: string;
  listingPrice: number;
}) {
  const [state, formAction, pending] = useActionState<OfferFormState, FormData>(
    createOfferAction,
    {},
  );
  const [amount, setAmount] = useState(Math.round(listingPrice * 0.9));

  return (
    <details className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)]">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)]/[.08]">
        <HandCoins className="size-4" />
        Trả giá — đề nghị giá của bạn
      </summary>

      <form action={formAction} className="space-y-3 border-t border-[var(--accent)]/15 p-4">
        <input type="hidden" name="listingId" value={listingId} />

        <div>
          <label className="label text-xs" htmlFor="offer-amount">
            Giá bạn đề nghị (giá niêm yết {formatVND(listingPrice)})
          </label>
          <input
            id="offer-amount"
            name="amount"
            type="number"
            min={100000}
            max={listingPrice - 1}
            step={50000}
            className="input"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            required
          />
          <div className="mt-2 flex gap-1.5">
            {[0.85, 0.9, 0.95].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setAmount(Math.round((listingPrice * r) / 10000) * 10000)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition",
                  amount === Math.round((listingPrice * r) / 10000) * 10000
                    ? "border-[var(--accent)]/55 bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--line)] text-[var(--ink-2)] hover:border-zinc-500",
                )}
              >
                {Math.round(r * 100)}% · {formatVND(Math.round((listingPrice * r) / 10000) * 10000)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label text-xs" htmlFor="offer-message">Lời nhắn (tùy chọn)</label>
          <textarea
            id="offer-message"
            name="message"
            rows={2}
            className="input resize-none text-sm"
            placeholder="VD: Mua lấy 2 con, anh bớt giúp em…"
          />
        </div>

        {state.error && (
          <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2 text-xs text-[var(--red)]">
            {state.error}
          </p>
        )}

        <button type="submit" disabled={pending} className="btn-primary w-full text-sm">
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <HandCoins className="size-4" />}
          Gửi đề nghị {formatVND(amount)}
        </button>
        <p className="text-center text-[11px] text-[var(--muted)]">
          Seller có 3 ngày phản hồi — chấp nhận / phản đề nghị / từ chối.
        </p>
      </form>
    </details>
  );
}
