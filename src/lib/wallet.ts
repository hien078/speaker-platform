import "server-only";
import { db } from "@/src/prisma/db.client";
import { assertFinancialFeaturesEnabled } from "@/src/lib/financial-features";

/**
 * Ví người bán — tính từ ledger thay vì lưu số dư mutable (§17, §120):
 *   số dư khả dụng = Σ payout đã giải ngân − Σ yêu cầu rút đã thanh toán
 */
export async function getWalletSummary(sellerId: string) {
  // Operational read của wallet bị deny khi tài chính tắt (spec §4.1 wallet
  // mutation; §5.1 deny trước khi đọc trạng thái vận hành) — Task 5 giữ view
  // read-only lịch sử qua admin, không qua summary ví vận hành này.
  assertFinancialFeaturesEnabled();
  const [payoutAgg, withdrawnAgg, pendingAgg, processingAgg] = await Promise.all([
    db.orm.public.Payout
      .where({ sellerId, status: "released" })
      .aggregate((a) => ({ total: a.sum("amount") })),
    db.orm.public.WithdrawRequest
      .where({ sellerId, status: "paid" })
      .aggregate((a) => ({ total: a.sum("amount") })),
    // đang chờ gồm CẢ requested + processing — chặn double-dip
    db.orm.public.WithdrawRequest
      .where({ sellerId, status: "requested" })
      .aggregate((a) => ({ total: a.sum("amount") })),
    db.orm.public.WithdrawRequest
      .where({ sellerId, status: "processing" })
      .aggregate((a) => ({ total: a.sum("amount") })),
  ]);

  const totalEarned = payoutAgg.total ?? 0;
  const totalWithdrawn = withdrawnAgg.total ?? 0;
  const pendingWithdraw = (pendingAgg.total ?? 0) + (processingAgg.total ?? 0);
  const available = totalEarned - totalWithdrawn - pendingWithdraw;

  return {
    totalEarned,      // tổng đã kiếm (sau hoa hồng)
    totalWithdrawn,   // đã rút thành công
    pendingWithdraw,  // đang chờ admin xử lý
    available,        // khả dụng để rút
  };
}
