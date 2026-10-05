import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { assertFinancialFeaturesEnabled } from "@/src/lib/financial-features";

/**
 * MoMo Payment Gateway v2 (developers.momo.vn)
 * - Credentials đọc từ env (MOMO_PARTNER_CODE / MOMO_ACCESS_KEY / MOMO_SECRET_KEY)
 *   — KHÔNG có fallback hardcode: thiếu là fail loud (MOMO_NOT_CONFIGURED).
 * - Dev: credentials test của MoMo từ business.momo.vn, MOMO_ENDPOINT=test-payment.momo.vn
 * - Production: credentials thật + MOMO_ENDPOINT=https://payment.momo.vn
 */

export function momoConfig() {
  const partnerCode = process.env.MOMO_PARTNER_CODE;
  const accessKey = process.env.MOMO_ACCESS_KEY;
  const secretKey = process.env.MOMO_SECRET_KEY;
  const endpoint = process.env.MOMO_ENDPOINT ?? "https://test-payment.momo.vn";
  return { partnerCode, accessKey, secretKey, endpoint };
}

export function isMomoConfigured(): boolean {
  return Boolean(process.env.MOMO_PARTNER_CODE && process.env.MOMO_ACCESS_KEY && process.env.MOMO_SECRET_KEY);
}

function sign(raw: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(raw).digest("hex");
}

export type CreatePaymentInput = {
  orderId: string; // mã duy nhất phía mình (ORDER-<uuid> hoặc EXOFFER-<uuid>)
  amount: number;
  orderInfo: string;
  redirectUrl: string;
  ipnUrl: string;
};

export type CreatePaymentResult = {
  payUrl: string;
  requestId: string;
  qrPayUrl?: string;
};

/** Tạo thanh toán MoMo → trả payUrl để redirect người mua */
export async function createMomoPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  // Defense-in-depth: route đã guard, nhưng provider request creation là mutation
  // tài chính reusable — caller tương lai không bypass được (plan Task 3, spec §4.1)
  assertFinancialFeaturesEnabled();
  const { partnerCode, accessKey, secretKey, endpoint } = momoConfig();
  if (!partnerCode || !accessKey || !secretKey) {
    // Fail loud — không bao giờ ký bằng credential fallback: thiếu env là lỗi cấu hình
    throw new Error(
      "MOMO_NOT_CONFIGURED: set MOMO_PARTNER_CODE, MOMO_ACCESS_KEY, MOMO_SECRET_KEY " +
        "(production thêm MOMO_ENDPOINT=https://payment.momo.vn) trong .env",
    );
  }
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const extraData = "";

  // rawSignature theo tài liệu MoMo v2 /v2/gateway/api/create — giá trị THÔ, không URL-encode
  const raw =
    `accessKey=${accessKey}` +
    `&amount=${input.amount}` +
    `&extraData=${extraData}` +
    `&ipnUrl=${input.ipnUrl}` +
    `&orderId=${input.orderId}` +
    `&orderInfo=${input.orderInfo}` +
    `&partnerCode=${partnerCode}` +
    `&redirectUrl=${input.redirectUrl}` +
    `&requestId=${requestId}` +
    `&requestType=captureWallet`;

  const body = {
    partnerCode,
    accessKey,
    requestId,
    amount: input.amount,
    orderId: input.orderId,
    orderInfo: input.orderInfo,
    redirectUrl: input.redirectUrl,
    ipnUrl: input.ipnUrl,
    extraData,
    requestType: "captureWallet",
    lang: "vi",
    signature: sign(raw, secretKey),
  };

  const res = await fetch(`${endpoint}/v2/gateway/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as {
    resultCode?: number;
    message?: string;
    payUrl?: string;
    qrPayUrl?: string;
    requestId?: string;
  };

  if (json.resultCode !== 0 || !json.payUrl) {
    throw new Error(`MOMO_CREATE_FAILED: ${json.resultCode} ${json.message ?? "no payUrl"}`);
  }

  return {
    payUrl: json.payUrl,
    requestId: json.requestId ?? requestId,
    qrPayUrl: json.qrPayUrl,
  };
}

/** Body MoMo gửi về (IPN webhook + return redirect) */
export type MomoCallbackBody = {
  partnerCode?: string;
  orderId?: string;
  requestId?: string;
  amount?: number;
  transId?: number | string;
  resultCode?: number;
  message?: string;
  payType?: string;
  responseTime?: number;
  extraData?: string;
  orderInfo?: string;
  signature?: string;
};

/** rawSignature verify cho IPN/return — đúng thứ tự field tài liệu MoMo v2 */
export function buildCallbackRawSignature(b: MomoCallbackBody, accessKey: string): string {
  return (
    `accessKey=${accessKey}` +
    `&amount=${b.amount ?? ""}` +
    `&extraData=${b.extraData ?? ""}` +
    `&message=${b.message ?? ""}` +
    `&orderId=${b.orderId ?? ""}` +
    `&orderInfo=${b.orderInfo ?? ""}` +
    `&partnerCode=${b.partnerCode ?? ""}` +
    `&payType=${b.payType ?? ""}` +
    `&requestId=${b.requestId ?? ""}` +
    `&responseTime=${b.responseTime ?? ""}` +
    `&resultCode=${b.resultCode ?? ""}` +
    `&transId=${b.transId ?? ""}`
  );
}

/** Verify chữ ký callback — chống giả mạo webhook.
 * So sánh timing-safe (HMAC hex 64 bytes) — không rò thông qua thời gian phản hồi. */
export function verifyMomoCallback(b: MomoCallbackBody): boolean {
  const { accessKey, secretKey } = momoConfig();
  if (!accessKey || !secretKey) return false; // chưa cấu hình → không verify được gì
  if (!b || typeof b.signature !== "string") return false;
  const raw = buildCallbackRawSignature(b, accessKey);
  const expected = Buffer.from(sign(raw, secretKey), "hex");
  const got = Buffer.from(b.signature, "hex");
  // Buffer.from(hex) với chuỗi rác → buffer rỗng/lệch độ dài → false, không throw
  return expected.length === got.length && timingSafeEqual(expected, got);
}
