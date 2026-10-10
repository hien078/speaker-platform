import { hkdfSync } from "node:crypto";

/**
 * HKDF helper chia sẻ (Batch 2 Task 11 tách từ src/lib/otp.ts) — key 32-byte
 * derive HKDF-SHA256 từ AUTH_SECRET, dùng chung cho OTP hash ("otp-hash"),
 * ip hash ("ip-hash" — Task 5), recovery-code hash ("recovery-code-hash" —
 * Task 8). KHÔNG dùng cho mã hóa AdminMfa — key đó là
 * ADMIN_MFA_ENCRYPTION_KEY riêng (src/lib/admin-mfa-key.ts), không bao giờ
 * derive từ AUTH_SECRET.
 *
 * Plain module (KHÔNG "server-only" — Task 11): src/lib/otp.ts giữ
 * `import "server-only"` nên offline bootstrap script (tsx — Task 11) không
 * import được; admin-mfa.ts (enrollAdminMfa/hashRecoveryCode) cần hkdfKey cho
 * hash mã khôi phục → helper thuần này là nguồn runtime duy nhất, otp.ts
 * re-export để mọi import hiện tại (`@/src/lib/otp`) không đổi. Hành vi GIỮ
 * NGUYÊN — chỉ chuyển chỗ ở của cùng một hàm.
 *
 * AUTH_SECRET do src/lib/env.ts validate fail-fast khi start (bắt buộc mọi
 * môi trường, ≥ 32 ký tự) — thiếu key là lỗi cấu hình, không phải path runtime.
 */

/** Salt HKDF cố định — domain-separate các info key của platform. */
const HKDF_SALT = "speaker-platform-otp-v1";

/**
 * Key 32-byte derive HKDF-SHA256 từ AUTH_SECRET — MỘT helper dùng chung cho OTP
 * hash ("otp-hash"), ip hash ("ip-hash" — Task 5), recovery-code hash
 * ("recovery-code-hash" — Task 8).
 */
export function hkdfKey(info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(process.env.AUTH_SECRET!, "utf8"),
      Buffer.from(HKDF_SALT, "utf8"),
      Buffer.from(info, "utf8"),
      32,
    ),
  );
}
