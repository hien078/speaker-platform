"use client";

import { useActionState, useState } from "react";
import { createExchangeOfferAction, type ExchangeFormState } from "@/src/lib/actions/exchange";
import { formatVND, cn } from "@/src/lib/utils";
import { LoaderCircle, Handshake, PackagePlus } from "lucide-react";

export function ExchangeOfferForm({
  listingId,
  myListings,
}: {
  listingId: string;
  myListings: { id: string; title: string; price: number; images: { url: string }[] }[];
}) {
  const [state, formAction, pending] = useActionState<ExchangeFormState, FormData>(
    createExchangeOfferAction,
    {},
  );
  const [mode, setMode] = useState<"pick" | "describe">(myListings.length > 0 ? "pick" : "describe");
  const [myListingId, setMyListingId] = useState(myListings[0]?.id ?? "");
  const [cashTopup, setCashTopup] = useState(0);

  const selected = myListings.find((l) => l.id === myListingId);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="listingId" value={listingId} />

      {/* Cách chọn sản phẩm của mình */}
      <div>
        <p className="label">Sản phẩm bạn đưa ra trao đổi</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode("pick")}
            disabled={myListings.length === 0}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-sm transition disabled:opacity-40",
              mode === "pick"
                ? "border-[var(--accent)]/65 bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)]",
            )}
          >
            <PackagePlus className="mr-1.5 inline size-4" />
            Chọn tin của tôi
          </button>
          <button
            type="button"
            onClick={() => setMode("describe")}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-sm transition",
              mode === "describe"
                ? "border-[var(--accent)]/65 bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)]",
            )}
          >
            ✍️ Mô tả sản phẩm
          </button>
        </div>
      </div>

      {mode === "pick" ? (
        <div>
          <label className="label" htmlFor="myListingId">Chọn từ tin đăng của bạn</label>
          <select
            id="myListingId"
            name="myListingId"
            className="input"
            value={myListingId}
            onChange={(e) => setMyListingId(e.target.value)}
          >
            {myListings.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title} — {formatVND(l.price)}
              </option>
            ))}
          </select>
          {selected && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              Giá trị tin của bạn: <b className="text-[var(--ink-2)]">{formatVND(selected.price)}</b>
            </p>
          )}
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="myItemDescription">Mô tả sản phẩm của bạn</label>
          <textarea
            id="myItemDescription"
            name="myItemDescription"
            rows={4}
            className="input resize-none"
            placeholder="VD: Loa Marshall Acton II mua 2024, còn mới 95%, full box…"
          />
        </div>
      )}

      {/* Tiền bù */}
      <div>
        <label className="label" htmlFor="cashTopup">Tiền bù thêm (₫) — để 0 nếu không bù</label>
        <input
          id="cashTopup"
          name="cashTopup"
          type="number"
          min={0}
          step={50000}
          className="input"
          value={cashTopup === 0 ? "" : cashTopup}
          onChange={(e) => setCashTopup(Math.max(0, Number(e.target.value)))}
          placeholder="VD: 2000000"
        />
        {cashTopup > 0 && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            {formatVND(cashTopup)} sẽ được giữ qua escrow — seller nhận sau khi bạn xác nhận trao đổi xong.
          </p>
        )}
      </div>

      {/* Lời nhắn */}
      <div>
        <label className="label" htmlFor="message">Lời nhắn cho người bán</label>
        <textarea
          id="message"
          name="message"
          rows={3}
          className="input resize-none"
          placeholder="Chào anh, em có con XX muốn đổi lấy anh con này, bù thêm 2 triệu…"
        />
      </div>

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full py-3 text-base">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Handshake className="size-4" />
        )}
        Gửi đề nghị trao đổi
      </button>
    </form>
  );
}
