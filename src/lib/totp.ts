/**
 * TOTP/HOTP — wrapper MỎNG quanh otpauth@9.5.2 (exact-pinned, Global Constraints:
 * thư viện duy nhất được thêm trong Batch 2; MIT, RFC 4226/6238, base32 +
 * otpauth:// URI, SLSA provenance + registry signatures; transitive duy nhất
 * @noble/hashes 2.4.0 exact-pinned).
 *
 * Pure module — KHÔNG "use server", KHÔNG "server-only": import được từ server
 * action, offline bootstrap script (Task 11) và test. KHÔNG hand-roll HMAC hay
 * base32 ở đây — mọi thuật toán nằm trong otpauth (đó là lý do thư viện tồn tại).
 *
 * Ghi chú API otpauth 9.5.2 (khác các bản cũ trong comment plan):
 * - TOTP instance: `validate({ token, timestamp?, window? }) → number | null`
 *   (delta nếu khớp, null nếu không) — KHÔNG có `verify().match` như v7/v8.
 * - URI: `toString()` — KHÔNG có getter `.uri`.
 * - `timestamp` mặc định Date.now() — atMs chỉ dùng trong test (mock thời gian).
 */
import { HOTP, TOTP, Secret } from "otpauth";

/** Tham số TOTP chuẩn (Google Authenticator-compatible): SHA1, 6 chữ số, 30s. */
const TOTP_PARAMS = {
  algorithm: "SHA1",
  digits: 6,
  period: 30,
} as const;

/** Window mặc định ±1 (chấp nhận mã của cửa sổ kề — đồng hồ lệch nhẹ). */
export const TOTP_DEFAULT_WINDOW = 1;

/**
 * Sinh secret TOTP mới — base32 của 20 byte random (160 bit entropy, chuẩn
 * RFC 4226/6238). Secret này được mã hóa AES-256-GCM trước khi lưu DB
 * (src/lib/admin-mfa.ts) — KHÔNG bao giờ lưu thô (spec §4.8).
 */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/**
 * URI otpauth://totp/ cho authenticator (Google Authenticator, 1Password, ...).
 * `account` thường là email admin; `issuer` là tên nền tảng ("LoaViet").
 */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  return new TOTP({
    issuer,
    label: account,
    ...TOTP_PARAMS,
    secret: Secret.fromBase32(secretBase32),
  }).toString();
}

/**
 * Xác thực mã TOTP — true khi mã khớp trong window (mặc định ±1 cửa sổ 30s).
 * `atMs` chỉ dùng trong test (mock Date.now); bỏ qua → Date.now() thật.
 *
 * Fail closed: secret rác (base32 hỏng do DB tam sửa) → false, KHÔNG throw —
 * caller (verifyAdminMfaCode) dựa vào đó để fall through sang mã khôi phục.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs?: number,
  window?: number,
): boolean {
  return verifyTotpStep(secretBase32, code, atMs, window) !== null;
}

/**
 * Xác thực mã TOTP và trả về TIME-STEP (counter) đã khớp — null khi không khớp.
 * Cần cho replay protection (RFC 6238 §5.2 — review fix #4): caller ghi nhận
 * step này là ĐÃ DÙNG, mã của step đó không được chấp nhận lần hai.
 */
export function verifyTotpStep(
  secretBase32: string,
  code: string,
  atMs?: number,
  window?: number,
): number | null {
  let secret: Secret;
  try {
    secret = Secret.fromBase32(secretBase32);
  } catch {
    return null; // secret hỏng — không có mã nào có thể hợp lệ
  }
  const totp = new TOTP({ issuer: "", label: "", ...TOTP_PARAMS, secret });
  const delta = totp.validate({
    token: code,
    timestamp: atMs,
    window: window ?? TOTP_DEFAULT_WINDOW,
  });
  if (delta === null) return null;
  // counter đã khớp = counter hiện tại + delta (delta ∈ [-window, +window]);
  // period 30 GIÂY = 30_000 ms — atMs/Date.now() tính bằng ms.
  return Math.floor((atMs ?? Date.now()) / (TOTP_PARAMS.period * 1_000)) + delta;
}

/**
 * Mã HOTP tại counter — tồn tại để test vector RFC 4226 Appendix D qua chính
 * thư viện (tests/unit/totp.test.ts) và để sinh mã TOTP tại counter cho trước
 * (TOTP = HOTP với counter = floor(ts/period)).
 */
export function hotpCode(secretBase32: string, counter: number): string {
  const hotp = new HOTP({
    issuer: "",
    label: "",
    algorithm: TOTP_PARAMS.algorithm,
    digits: TOTP_PARAMS.digits,
    secret: Secret.fromBase32(secretBase32),
  });
  return hotp.generate({ counter });
}
