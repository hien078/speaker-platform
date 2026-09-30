import "server-only";
import { createHmac } from "node:crypto";

/**
 * MoMo Payment Gateway v2 (developers.momo.vn)
 * - Dev: dùng credentials test công khai của MoMo (mặc định dưới)
 * - Production: điền MOMO_PARTNER_CODE / MOMO_ACCESS_KEY / MOMO_SECRET_KEY thật
 *   vào .env + đổi MOMO_ENDPOINT sang https://payment.momo.vn
 */

export function momoConfig() {
  const partnerCode = process.env.MOMO_PARTNER_CODE ?? "MOMO";
  const accessKey = process.env.MOMO_ACCESS_KEY ?? "F8BBA842ECF85";
  const secretKey = process.env.MOMO_SECRET_KEY ?? "K951B6PE1waDMi640xX08PD3vg6EkVlz";
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
  const { partnerCode, accessKey, secretKey, endpoint } = momoConfig();
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

/** Verify chữ ký callback — chống giả mạo webhook */
export function verifyMomoCallback(b: MomoCallbackBody): boolean {
  const { accessKey, secretKey } = momoConfig();
  if (!b.signature) return false;
  const raw = buildCallbackRawSignature(b, accessKey);
  const expected = sign(raw, secretKey);
  return expected === b.signature;
}
