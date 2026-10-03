import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_BADGE,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  DISPUTE_STATUS_LABELS,
} from "@/src/lib/constants";
import {
  sellerConfirmPaymentAction,
  shipOrderAction,
  cancelOrderAction,
  openDisputeAction,
} from "@/src/lib/actions/orders";
import { submitReviewAction } from "@/src/lib/actions/reviews";
import { EscrowPayModal } from "@/src/components/escrow-pay-modal";
import { ConfirmReceiptButton } from "@/src/components/confirm-receipt-button";
import { isMomoConfigured } from "@/src/lib/momo";
import {
  Truck,
  ShieldCheck,
  Banknote,
  MapPin,
  Phone,
  Clock,
  AlertTriangle,
  Star,
  CheckCircle2,
  HandCoins,
} from "lucide-react";

export const dynamic = "force-dynamic";

const STEPS = ["awaiting_payment", "paid_escrow", "shipped", "completed"] as const;

export default async function OrderDetailPage({
  params,
}: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const order = await db.orm.public.Order
    .where({ id })
    .include("items", (i) => i.select("id", "title", "price", "imageUrl", "quantity", "listingId"))
    .include("buyer", (b) => b.select("id", "name", "phone"))
    .include("seller", (s) => s.select("id", "name", "phone"))
    .include("payments", (p) => p.select("id", "method", "status", "amount", "provider", "providerTxnId", "paidAt", "releasedAt"))
    .include("payout", (p) => p.select("amount", "status", "createdAt"))
    .include("review", (r) => r.select("rating", "comment"))
    .first();

  if (!order) notFound();

  const isBuyer = order.buyer!.id === user.id;
  const isSeller = order.seller!.id === user.id;
  if (!isBuyer && !isSeller && user.role !== "admin") notFound();

  const payment = order.payments[0];
  const disputes = await db.orm.public.Dispute.where({ orderId: order.id }).all();
  const activeDispute = disputes.find((d) => d.status === "open");
  const statusHistory = await db.orm.public.OrderStatusHistory
    .where({ orderId: order.id })
    .orderBy((h) => h.createdAt.asc())
    .all();

  const stepIndex = STEPS.indexOf(order.status as (typeof STEPS)[number]);
  const showTimeline = !["cancelled", "refunded", "disputed"].includes(order.status);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      {/* ═══ Header ═══ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={isSeller ? "/orders/sales" : "/orders"} className="btn-ghost h-9 px-3 text-sm">
            ← Danh sách
          </Link>
          <h1 className="font-mono text-xl font-extrabold tracking-tight text-[var(--accent)]">{order.code}</h1>
          <span className={cn("badge", ORDER_STATUS_BADGE[order.status])}>
            {ORDER_STATUS_LABELS[order.status]}
          </span>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <Clock className="size-3.5" />
          Đặt {formatDate(order.createdAt)}
        </p>
      </div>

      {/* ═══ Timeline ═══ */}
      {showTimeline && (
        <div className="card mt-6 p-6">
          <div className="flex items-center">
            {STEPS.map((step, i) => {
              const done = stepIndex >= 0 && i <= stepIndex;
              const label =
                step === "awaiting_payment" ? "Đặt đơn" :
                step === "paid_escrow" ? "Đã thanh toán" :
                step === "shipped" ? "Đang giao" : "Hoàn tất";
              return (
                <div key={step} className="flex flex-1 items-center last:flex-none">
                  <div className="flex flex-col items-center gap-1.5">
                    <span
                      className={cn(
                        "grid size-9 place-items-center rounded-full border-2 transition",
                        done
                          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                          : "border-zinc-700 bg-[var(--paper-deep)] text-[var(--muted)]",
                      )}
                    >
                      {done ? <CheckCircle2 className="size-4.5" /> : i + 1}
                    </span>
                    <span className={cn("text-[11px] font-medium", done ? "text-[var(--accent)]" : "text-[var(--muted)]")}>
                      {label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={cn("mx-2 h-0.5 flex-1 sm:mx-3", i < stepIndex ? "bg-[var(--accent)]" : "bg-[var(--paper)]")} />
                  )}
                </div>
              );
            })}
          </div>

          {order.status === "shipped" && order.autoReleaseAt && (
            <p className="mt-5 rounded-lg bg-[var(--paper)] px-4 py-2.5 text-center text-xs text-[var(--ink-2)]">
              <ShieldCheck className="mr-1 inline size-3.5 text-[var(--green)]" />
              Nếu bạn không xác nhận, tiền sẽ tự giải ngân cho người bán sau{" "}
              <b className="text-[var(--ink)]">{formatDate(order.autoReleaseAt)}</b> (trừ khi có khiếu nại).
            </p>
          )}
        </div>
      )}

      {/* ═══ Khiếu nại ═══ */}
      {(activeDispute || order.status === "disputed") && (
        <div className="mt-6 rounded-xl border border-[var(--red)]/35 bg-[var(--red-soft)] p-5">
          <p className="flex items-center gap-2 text-sm font-bold text-[var(--red)]">
            <AlertTriangle className="size-4" />
            Đơn đang có khiếu nại — escrow tạm đóng băng
          </p>
          {disputes.map((d) => (
            <div key={d.id} className="mt-3 text-sm">
              <p className="text-[var(--ink-2)]">Lý do: {d.reason}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Mở {formatDate(d.createdAt)} · {DISPUTE_STATUS_LABELS[d.status]}
                {d.resolution && ` · Quyết định: ${d.resolution}`}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ═══ Cột trái ═══ */}
        <div className="space-y-6">
          {/* Sản phẩm */}
          <div className="card p-5">
            <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Sản phẩm</p>
            <div className="mt-4 space-y-4">
              {order.items.map((item) => (
                <div key={item.id} className="flex items-center gap-4">
                  <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                    {item.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.imageUrl} alt={item.title} className="size-full object-cover" />
                    ) : (
                      <span className="grid size-full place-items-center text-2xl text-[var(--muted)]">🔇</span>
                    )}
                    <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">
                      {item.quantity}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">{formatVND(item.price)} × {item.quantity}</p>
                  </div>
                  <p className="text-sm font-bold text-[var(--accent)]">
                    {formatVND(item.price * item.quantity)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Giao hàng */}
          <div className="card p-5">
            <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Giao đến</p>
            <div className="mt-3 space-y-2 text-sm text-[var(--ink-2)]">
              <p className="flex items-start gap-2.5">
                <MapPin className="mt-0.5 size-4 shrink-0 text-[var(--muted)]" />
                {order.shippingAddress}
              </p>
              <p className="flex items-center gap-2.5">
                <Phone className="size-4 shrink-0 text-[var(--muted)]" />
                {order.shippingPhone}
              </p>
              {order.note && (
                <p className="rounded-lg bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink-2)]">
                  Ghi chú: {order.note}
                </p>
              )}
            </div>
          </div>

          {/* Lịch sử trạng thái (§48) */}
          {statusHistory.length > 0 && (
            <div className="card p-5">
              <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
                Lịch sử đơn hàng
              </p>
              <ol className="mt-4 space-y-0">
                {statusHistory.map((h, i) => (
                  <li key={h.id} className="relative flex gap-3.5 pb-4 last:pb-0">
                    {i < statusHistory.length - 1 && (
                      <span className="absolute left-[7px] top-4 h-full w-px bg-[var(--paper)]" />
                    )}
                    <span
                      className={cn(
                        "relative z-10 mt-1 size-3.5 shrink-0 rounded-full border-2",
                        i === statusHistory.length - 1
                          ? "border-[var(--accent)] bg-[var(--accent)]"
                          : "border-zinc-600 bg-[var(--paper-deep)]",
                      )}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {ORDER_STATUS_LABELS[h.status]}
                      </p>
                      {h.note && (
                        <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-2)]">{h.note}</p>
                      )}
                      <p className="mt-0.5 text-[11px] text-[var(--muted)]">{formatDate(h.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Đánh giá */}
          {isBuyer && order.status === "completed" && !order.review && (
            <div className="card p-5">
              <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
                Đánh giá người bán
              </p>
              <form action={submitReviewAction} className="mt-4 space-y-3">
                <input type="hidden" name="orderId" value={order.id} />
                <div className="flex gap-1.5" data-rating-stars>
                  {[1, 2, 3, 4, 5].map((r) => (
                    <label key={r} className="cursor-pointer">
                      <input type="radio" name="rating" value={r} className="peer sr-only" defaultChecked={r === 5} />
                      <Star className="size-7 text-[var(--muted)] transition peer-checked:text-[var(--accent)] hover:text-[var(--accent)]" />
                    </label>
                  ))}
                </div>
                <textarea
                  name="comment"
                  rows={3}
                  className="input resize-none text-sm"
                  placeholder="Loa đúng mô tả không? Người bán giao hàng thế nào?"
                />
                <button type="submit" className="btn-primary text-sm">Gửi đánh giá</button>
              </form>
            </div>
          )}

          {order.review && (
            <div className="card p-5">
              <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Đánh giá</p>
              <div className="mt-3 flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map((r) => (
                  <Star
                    key={r}
                    className={cn("size-5", r <= order.review!.rating ? "fill-[var(--accent)] text-[var(--accent)]" : "text-[var(--muted)]")}
                  />
                ))}
              </div>
              {order.review.comment && (
                <p className="mt-2 text-sm text-[var(--ink-2)]">{order.review.comment}</p>
              )}
            </div>
          )}
        </div>

        {/* ═══ Cột phải: tiền & hành động ═══ */}
        <aside className="space-y-4">
          {/* Thanh toán */}
          <div className="card p-5">
            <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Thanh toán</p>
            <div className="mt-4 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--ink-2)]">Phương thức</span>
                <span className="text-right font-medium">{PAYMENT_METHOD_LABELS[order.paymentMethod]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--ink-2)]">Trạng thái</span>
                <span className={cn(
                  "badge",
                  payment?.status === "held" ? "bg-[var(--violet-soft)] text-[var(--violet)]" :
                  payment?.status === "released" ? "bg-[var(--green-soft)] text-[var(--green)]" :
                  payment?.status === "refunded" ? "bg-[var(--accent-soft)] text-[var(--accent)]" :
                  "bg-[var(--paper-deep)] text-[var(--ink-2)]",
                )}>
                  {payment ? PAYMENT_STATUS_LABELS[payment.status] : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--ink-2)]">Tổng tiền</span>
                <span className="font-bold">{formatVND(order.totalAmount)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[var(--muted)]">Hoa hồng nền tảng ({order.commissionRate}%)</span>
                <span className="text-[var(--ink-2)]">−{formatVND(order.commissionAmount)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[var(--muted)]">Người bán nhận</span>
                <span className="text-[var(--green)]">{formatVND(order.sellerPayout)}</span>
              </div>
              {payment?.providerTxnId && (
                <p className="border-t border-[var(--line)] pt-2.5 font-mono text-[11px] text-[var(--muted)]">
                  Mã GD: {payment.providerTxnId}
                </p>
              )}
            </div>
          </div>

          {/* Hành động */}
          <div className="card space-y-2.5 p-5">
            <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">Hành động</p>

            {/* Buyer thanh toán escrow */}
            {isBuyer && order.status === "awaiting_payment" && order.paymentMethod === "escrow" && (
              <EscrowPayModal orderId={order.id} amount={order.totalAmount} code={order.code} momoEnabled={isMomoConfigured()} />
            )}

            {/* Buyer chờ direct/cod */}
            {isBuyer && order.status === "awaiting_payment" && order.paymentMethod !== "escrow" && (
              <p className="rounded-lg bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink-2)]">
                <Banknote className="mr-1 inline size-3.5 text-[var(--accent)]" />
                Bạn chọn trả trực tiếp — liên hệ người bán qua{" "}
                <Link href="/chat" className="text-[var(--accent)] hover:underline">chat</Link> để nhận thông tin
                chuyển khoản. Seller sẽ xác nhận khi nhận được tiền.
              </p>
            )}

            {/* Seller xác nhận nhận tiền direct/cod */}
            {isSeller && order.status === "awaiting_payment" && order.paymentMethod !== "escrow" && (
              <form action={sellerConfirmPaymentAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <button type="submit" className="btn-primary w-full">
                  <HandCoins className="size-4" />
                  Xác nhận đã nhận tiền
                </button>
              </form>
            )}

            {/* Seller gửi hàng */}
            {isSeller && ["paid_escrow", "processing"].includes(order.status) && (
              <form action={shipOrderAction} className="space-y-2">
                <input type="hidden" name="orderId" value={order.id} />
                <input name="tracking" className="input text-sm" placeholder="Mã vận đơn (tùy chọn)" />
                <button type="submit" className="btn-primary w-full">
                  <Truck className="size-4" />
                  Đã gửi hàng cho người mua
                </button>
              </form>
            )}

            {/* Buyer xác nhận nhận hàng */}
            {isBuyer && ["shipped", "paid_escrow", "processing"].includes(order.status) && (
              <ConfirmReceiptButton orderId={order.id} />
            )}

            {/* Buyer mở khiếu nại */}
            {isBuyer && ["paid_escrow", "processing", "shipped"].includes(order.status) && (
              <details className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
                <summary className="cursor-pointer text-xs font-semibold text-[var(--red)]">
                  <AlertTriangle className="mr-1 inline size-3.5" />
                  Có vấn đề với đơn hàng?
                </summary>
                <form action={openDisputeAction} className="mt-3 space-y-2">
                  <input type="hidden" name="orderId" value={order.id} />
                  <textarea
                    name="reason"
                    rows={3}
                    required
                    className="input resize-none text-xs"
                    placeholder="Mô tả vấn đề: loa không đúng mô tả, không nhận được hàng…"
                  />
                  <button type="submit" className="btn-danger w-full text-xs">
                    Mở khiếu nại (đóng băng escrow)
                  </button>
                </form>
              </details>
            )}

            {/* Hủy đơn */}
            {["awaiting_payment", "paid_escrow"].includes(order.status) && (isBuyer || isSeller) && (
              <form action={cancelOrderAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <button type="submit" className="btn-secondary w-full text-sm">
                  Hủy đơn hàng
                </button>
              </form>
            )}

            {order.status === "completed" && (
              <p className="flex items-start gap-2 rounded-lg bg-[var(--green-soft)] p-3 text-xs leading-relaxed text-[var(--green)]">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                Giao dịch hoàn tất. Escrow đã giải ngân {formatVND(order.sellerPayout)} cho người bán
                {order.payout && ` (${formatDate(order.payout.createdAt)})`}.
              </p>
            )}
          </div>

          {/* Liên hệ */}
          <div className="card p-5 text-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--ink-2)]">Liên hệ</p>
            <div className="mt-3 space-y-1.5">
              <p className="text-[var(--ink-2)]">
                Người mua: <b className="text-[var(--ink)]">{order.buyer!.name}</b>
              </p>
              <p className="text-[var(--ink-2)]">
                Người bán: <b className="text-[var(--ink)]">{order.seller!.name}</b>
              </p>
              <Link href="/chat" className="btn-secondary mt-2 w-full text-sm">
                Mở hộp chat
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
