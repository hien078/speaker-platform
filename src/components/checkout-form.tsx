"use client";

import { useActionState, useState } from "react";
import { createOrderAction } from "@/src/lib/actions/orders";
import { cn } from "@/src/lib/utils";
import { formatVND } from "@/src/lib/utils";
import {
  ShieldCheck,
  Banknote,
  Truck,
  LoaderCircle,
  Lock,
} from "lucide-react";

const METHODS = [
  {
    value: "escrow",
    title: "Thanh toán qua nền tảng (escrow)",
    desc: "Thẻ / QR ngân hàng / Ví MoMo — nền tảng giữ tiền đến khi bạn nhận loa",
    icon: <ShieldCheck className="size-5 text-emerald-400" />,
    recommended: true,
  },
  {
    value: "direct",
    title: "Chuyển khoản trực tiếp cho người bán",
    desc: "Bạn tự chuyển khoản cho seller — nền tảng ghi nhận và thu hoa hồng khi hoàn tất",
    icon: <Banknote className="size-5 text-amber-400" />,
  },
  {
    value: "cod",
    title: "COD — trả tiền khi nhận hàng",
    desc: "Kiểm tra loa rồi mới trả tiền cho người chuyển giao",
    icon: <Truck className="size-5 text-sky-400" />,
  },
] as const;

export function CheckoutForm({
  total,
  directListingId,
  defaultPhone,
  defaultAddress,
}: {
  total: number;
  directListingId: string | null;
  defaultPhone: string;
  defaultAddress: string;
}) {
  const [method, setMethod] = useState<"escrow" | "direct" | "cod">("escrow");
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(
    async (prev, formData) => {
      try {
        await createOrderAction(formData);
        return {};
      } catch (e) {
        // redirect() throw — bỏ qua lỗi NEXT_REDIRECT
        if (typeof e === "object" && e !== null && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) {
          throw e;
        }
        return { error: e instanceof Error ? e.message : "Có lỗi xảy ra" };
      }
    },
    {},
  );

  return (
    <form action={formAction} className="card space-y-6 p-6">
      {directListingId && <input type="hidden" name="listingId" value={directListingId} />}

      {/* ─── Thông tin giao hàng ─── */}
      <section>
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Thông tin nhận hàng
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="shippingPhone">Số điện thoại</label>
            <input
              id="shippingPhone"
              name="shippingPhone"
              className="input"
              placeholder="0901234567"
              defaultValue={defaultPhone}
              required
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="shippingAddress">Địa chỉ nhận hàng</label>
            <textarea
              id="shippingAddress"
              name="shippingAddress"
              rows={2}
              className="input resize-none"
              placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành…"
              defaultValue={defaultAddress}
              required
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="note">Ghi chú cho người bán (tùy chọn)</label>
            <textarea
              id="note"
              name="note"
              rows={2}
              className="input resize-none"
              placeholder="VD: cho mình xem thử loa trước khi giao…"
            />
          </div>
        </div>
      </section>

      {/* ─── Phương thức thanh toán ─── */}
      <section>
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Phương thức thanh toán
        </h2>
        <input type="hidden" name="paymentMethod" value={method} />
        <div className="mt-4 space-y-2.5">
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMethod(m.value)}
              className={cn(
                "flex w-full items-start gap-3.5 rounded-xl border p-4 text-left transition",
                method === m.value
                  ? "border-amber-500/60 bg-amber-500/10"
                  : "border-[var(--border)] bg-[var(--surface-2)] hover:border-zinc-600",
              )}
            >
              <span className="mt-0.5 shrink-0">{m.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-bold">
                  {m.title}
                  {"recommended" in m && m.recommended && (
                    <span className="badge bg-emerald-500/15 text-emerald-400">Khuyên dùng</span>
                  )}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-zinc-400">{m.desc}</span>
              </span>
              <span
                className={cn(
                  "mt-1 grid size-4.5 shrink-0 place-items-center rounded-full border-2 transition",
                  method === m.value ? "border-amber-500 bg-amber-500" : "border-zinc-600",
                )}
              >
                {method === m.value && <span className="size-1.5 rounded-full bg-zinc-950" />}
              </span>
            </button>
          ))}
        </div>
      </section>

      {state.error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-400">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full py-3 text-base">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Lock className="size-4" />
        )}
        {method === "escrow" ? `Thanh toán ${formatVND(total)} qua escrow` : `Đặt đơn (${formatVND(total)})`}
      </button>
    </form>
  );
}
