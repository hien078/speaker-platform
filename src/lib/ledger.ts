import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/src/prisma/db.client";

/**
 * Double-entry ledger (§17, §118) — mọi dòng tiền ghi 2 entry đối xứng,
 * tổng mỗi giao dịch luôn = 0. Immutable — chỉ ghi, không sửa/xóa.
 *
 * Tài khoản quy ước:
 *   escrow              — tiền nền tảng đang giữ hộ
 *   platform_revenue    — hoa hồng nền tảng thu
 *   seller:<userId>    — ví người bán (ghi có khi giải ngân, ghi nợ khi rút)
 *   buyer:<userId>      — tiền người mua (ghi nợ khi trả vào escrow)
 */

type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export type LedgerRef = "order" | "payment" | "payout" | "withdraw" | "exchange" | "refund";

type Entry = {
  account: string;
  amount: number; // dương = credit, âm = debit
  note?: string;
};

/** Ghi một giao dịch ledger gồm nhiều entry đối xứng (tổng phải = 0) */
export async function recordLedgerTx(
  tx: TxContext,
  refType: LedgerRef,
  refId: string | null,
  entries: Entry[],
): Promise<string> {
  const sum = entries.reduce((s, e) => s + e.amount, 0);
  if (sum !== 0) {
    throw new Error(
      `LEDGER_NOT_BALANCED: entries tổng ${sum} ≠ 0 (${entries.map((e) => `${e.account}:${e.amount}`).join(", ")})`,
    );
  }
  const txId = `TX-${randomUUID().slice(0, 12)}`;
  for (const e of entries) {
    await tx.orm.public.LedgerEntry.create({
      txId,
      account: e.account,
      amount: e.amount,
      refType,
      refId,
      note: e.note ?? null,
    });
  }
  return txId;
}

/** Buyer trả tiền vào escrow: escrow +total, buyer −total */
export function escrowIn(buyerId: string, total: number, note: string): Entry[] {
  return [
    { account: "escrow", amount: total, note },
    { account: `buyer:${buyerId}`, amount: -total, note },
  ];
}

/** Giải ngân cho seller: escrow −total, seller +payout, platform +commission */
export function escrowRelease(
  sellerId: string,
  total: number,
  commission: number,
  note: string,
): Entry[] {
  return [
    { account: "escrow", amount: -total, note },
    { account: `seller:${sellerId}`, amount: total - commission, note: `${note} (sau hoa hồng)` },
    { account: "platform_revenue", amount: commission, note: `${note} (hoa hồng)` },
  ];
}

/** Hoàn tiền escrow cho buyer: escrow −total, buyer +total */
export function escrowRefund(buyerId: string, total: number, note: string): Entry[] {
  return [
    { account: "escrow", amount: -total, note },
    { account: `buyer:${buyerId}`, amount: total, note },
  ];
}

/** Seller rút tiền thành công: seller −amount, withdraw +amount */
export function withdrawPaid(sellerId: string, amount: number, note: string): Entry[] {
  return [
    { account: `seller:${sellerId}`, amount: -amount, note },
    { account: "withdraw", amount: amount, note },
  ];
}

/** Đối chiếu (§118): tổng escrow ledger phải khớp tổng Payment đang held */
export async function reconcileEscrow(): Promise<{
  ledgerEscrow: number;
  paymentsHeld: number;
  balanced: boolean;
}> {
  const ledgerAgg = await db.orm.public.LedgerEntry
    .where({ account: "escrow" })
    .aggregate((a) => ({ total: a.sum("amount") }));
  const paymentsAgg = await db.orm.public.Payment
    .where({ status: "held" })
    .aggregate((a) => ({ total: a.sum("amount") }));
  const ledgerEscrow = ledgerAgg.total ?? 0;
  const paymentsHeld = paymentsAgg.total ?? 0;
  return {
    ledgerEscrow,
    paymentsHeld,
    balanced: ledgerEscrow === paymentsHeld,
  };
}
