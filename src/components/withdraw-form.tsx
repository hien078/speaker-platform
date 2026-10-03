"use client";

import { useActionState } from "react";
import { createWithdrawRequestAction, type WithdrawFormState } from "@/src/lib/actions/withdraw";
import { formatVND, cn } from "@/src/lib/utils";
import { LoaderCircle, Banknote } from "lucide-react";

const BANKS = [
  "Vietcombank", "Techcombank", "BIDV", "VietinBank", "MB Bank",
  "ACB", "VPBank", "Agribank", "TPBank", "Sacombank", "SHB", "Eximbank",
];

export function WithdrawForm({ available }: { available: number }) {
  const [state, formAction, pending] = useActionState<WithdrawFormState, FormData>(
    createWithdrawRequestAction,
    {},
  );
  const canWithdraw = available >= 100_000;

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="amount">Số tiền muốn rút (₫)</label>
        <div className="relative">
          <Banknote className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
          <input
            id="amount"
            name="amount"
            type="number"
            min={100000}
            step={50000}
            max={available}
            className="input pl-10"
            placeholder="VD: 3500000"
            required
          />
        </div>
        <p className="mt-1.5 text-xs text-[var(--muted)]">
          Khả dụng: <b className="text-[var(--green)]">{formatVND(available)}</b> · tối thiểu 100.000₫
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="bankName">Ngân hàng</label>
          <select id="bankName" name="bankName" className="input" required>
            {BANKS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="bankAccount">Số tài khoản</label>
          <input
            id="bankAccount"
            name="bankAccount"
            className="input"
            placeholder="1028xxxxxx"
            inputMode="numeric"
            required
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="accountHolder">Tên chủ tài khoản</label>
        <input
          id="accountHolder"
          name="accountHolder"
          className="input"
          placeholder="NGUYEN VAN A"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="note">Ghi chú (tùy chọn)</label>
        <input id="note" name="note" className="input" placeholder="Rút tiền mua loa mới…" />
      </div>

      {state.error && (
        <p className="rounded-xl border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}
      {!state.error && !pending && Object.keys(state).length === 0 && canWithdraw && null}

      <button
        type="submit"
        disabled={pending || !canWithdraw}
        className={cn("btn-primary w-full py-3", !canWithdraw && "opacity-40")}
      >
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Banknote className="size-4" />}
        {canWithdraw ? "Gửi yêu cầu rút tiền" : "Chưa đủ số dư để rút"}
      </button>

      <p className="text-center text-xs leading-relaxed text-[var(--muted)]">
        Yêu cầu sẽ được quản trị kiểm tra và chuyển khoản trong 1–2 ngày làm việc.
        Tiền chỉ tính là đã rút khi chuyển khoản thành công.
      </p>
    </form>
  );
}
