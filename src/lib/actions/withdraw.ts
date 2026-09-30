"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db";
import { requireUser, requireAdmin } from "@/src/lib/auth";
import { getWalletSummary } from "@/src/lib/wallet";
import { audit } from "@/src/lib/actions/helpers";
import { recordLedgerTx, withdrawPaid } from "@/src/lib/ledger";
import { notify } from "@/src/lib/notify";

export type WithdrawFormState = { error?: string };

const BANKS = [
  "Vietcombank", "Techcombank", "BIDV", "VietinBank", "MB Bank",
  "ACB", "VPBank", "Agribank", "TPBank", "Sacombank", "SHB", "Eximbank",
];

/** Seller gửi yêu cầu rút tiền */
export async function createWithdrawRequestAction(
  _prev: WithdrawFormState,
  formData: FormData,
): Promise<WithdrawFormState> {
  const user = await requireUser();

  const amount = Math.round(Number(formData.get("amount") ?? 0));
  const bankName = String(formData.get("bankName") ?? "").trim();
  const bankAccount = String(formData.get("bankAccount") ?? "").trim();
  const accountHolder = String(formData.get("accountHolder") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!BANKS.includes(bankName)) return { error: "Chọn ngân hàng hợp lệ" };
  if (!/^\d{6,19}$/.test(bankAccount)) return { error: "Số tài khoản không hợp lệ (6–19 chữ số)" };
  if (accountHolder.length < 3) return { error: "Nhập tên chủ tài khoản" };
  if (!Number.isFinite(amount) || amount < 100_000) {
    return { error: "Số tiền rút tối thiểu 100.000₫" };
  }

  const wallet = await getWalletSummary(user.id);
  if (amount > wallet.available) {
    return { error: `Số dư khả dụng chỉ ${wallet.available.toLocaleString("vi-VN")}₫` };
  }

  // không cho gửi nhiều yêu cầu chồng chờ
  const pending = await db.orm.public.WithdrawRequest
    .where({ sellerId: user.id, status: "requested" })
    .first();
  if (pending) {
    return { error: "Bạn đã có một yêu cầu rút đang chờ xử lý" };
  }

  await db.orm.public.WithdrawRequest.create({
    sellerId: user.id,
    amount,
    bankName,
    bankAccount,
    accountHolder,
    note,
    status: "requested",
  });

  revalidatePath("/wallet");
  revalidatePath("/admin/withdraws");
  return {};
}

/** Admin xử lý: chuyển sang processing / paid / rejected */
export async function processWithdrawAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const withdrawId = String(formData.get("withdrawId") ?? "");
  const action = String(formData.get("action") ?? "");
  const adminNote = String(formData.get("adminNote") ?? "").trim() || null;

  const request = await db.orm.public.WithdrawRequest.first({ id: withdrawId });
  if (!request || !["requested", "processing"].includes(request.status)) return;

  const statusMap: Record<string, "processing" | "paid" | "rejected"> = {
    processing: "processing",
    paid: "paid",
    reject: "rejected",
  };
  const next = statusMap[action];
  if (!next) return;

  await db.orm.public.WithdrawRequest
    .where({ id: withdrawId })
    .update({
      status: next,
      adminNote,
      processedById: admin.id,
      processedAt: new Date().toISOString(),
    });

  if (next === "paid") {
    // kiểm số dư thật lần cuối — chặn rút tiền seller chưa kiếm được
    const { getWalletSummary } = await import("@/src/lib/wallet");
    const wallet = await getWalletSummary(request.sellerId);
    if (request.amount > wallet.available + request.amount) {
      // available đã trừ request này (requested/processing) — cộng lại để so đúng
      // nếu vẫn vượt tổng thu nhập thực → chặn
    }
    const earned = wallet.totalEarned - wallet.totalWithdrawn;
    if (request.amount > earned) {
      throw new Error(`VÍ KHÔNG ĐỦ: seller chỉ kiếm được ${earned.toLocaleString("vi-VN")}₫, yêu cầu rút ${request.amount.toLocaleString("vi-VN")}₫`);
    }
    await recordLedgerTx(
      db,
      "withdraw",
      withdrawId,
      withdrawPaid(request.sellerId, request.amount, `Rút tiền ${request.bankAccount} (${request.bankName})`),
    );
  }
  await audit(
    admin.id,
    `withdraw_${action}`,
    "WithdrawRequest",
    withdrawId,
    `${request.amount.toLocaleString("vi-VN")}₫ → ${request.bankAccount} (${request.bankName})`,
  );
  if (next === "paid") {
    await notify(request.sellerId, "withdraw", `Đã rút ${request.amount.toLocaleString("vi-VN")}₫`, `Chuyển khoản tới ${request.bankAccount} (${request.bankName})`, "/wallet");
  } else if (next === "rejected") {
    await notify(request.sellerId, "withdraw", `Yêu cầu rút bị từ chối`, adminNote ?? undefined, "/wallet");
  }

  revalidatePath("/admin/withdraws");
  revalidatePath("/wallet");
}
