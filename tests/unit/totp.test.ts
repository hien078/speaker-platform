/**
 * TOTP wrapper (otpauth@9.5.2) — unit tests (plan Task 8, spec §5.3: admin MFA
 * là TOTP + mã khôi phục dùng một lần; SMS KHÔNG bao giờ là factor admin).
 *
 * Pure module — KHÔNG mock gì cả: những test này chứng minh thư viện được nối
 * đúng hành vi RFC (không hand-roll HMAC/base32 — Global Constraints):
 *  1. hotpCode khớp CẢ 10 vector RFC 4226 Appendix D cho secret
 *     GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ (base32 của "12345678901234567890").
 *  2. verifyTotp tại timestamp cố định chấp nhận hotpCode tại floor(ts/30000)
 *     (TOTP = HOTP với counter = số period kể từ epoch — RFC 6238).
 *  3. verifyTotp window=1 chấp nhận mã của cửa sổ ±30s và từ chối ±2 cửa sổ.
 *  4. generateTotpSecret sinh base32 hợp lệ (Secret.fromBase32 chấp nhận);
 *     totpUri bắt đầu bằng otpauth://totp/.
 *
 * atMs chỉ dùng trong test (mock Date.now qua vi.useFakeTimers) — đúng chữ ký
 * plan: verifyTotp(secret, code, atMs?, window?).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateTotpSecret,
  totpUri,
  verifyTotp,
  hotpCode,
} from "@/src/lib/totp";
import { HOTP, Secret, TOTP } from "otpauth";

/** RFC 4226 Appendix D — secret chuẩn của toàn bộ test. */
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** RFC 4226 Appendix D — 10 vector cho counter 0–9. */
const RFC_VECTORS = [
  "755224", "287082", "359152", "969429", "338314",
  "254676", "287922", "162583", "399871", "520489",
] as const;

/** Timestamp cố định — chia hết đúng cho 30.000 để counter ổn định trong test. */
const FIXED_TS = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);
const FIXED_COUNTER = Math.floor(FIXED_TS / 30_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TS);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. RFC 4226 — HOTP qua thư viện (chứng minh nối đúng, không tự chế) ──────

describe("hotpCode — RFC 4226 Appendix D", () => {
  it("khớp cả 10 vector RFC 4226 cho counter 0–9", () => {
    for (let counter = 0; counter < 10; counter++) {
      expect(hotpCode(RFC_SECRET_B32, counter), `counter=${counter}`).toBe(RFC_VECTORS[counter]);
    }
  });

  it("đúng những gì chính thư viện HOTP.generate sinh ra", () => {
    const secret = Secret.fromBase32(RFC_SECRET_B32);
    const hotp = new HOTP({ secret, algorithm: "SHA1", digits: 6 });
    for (const counter of [0, 4, 9, 123, 4_567_890]) {
      expect(hotpCode(RFC_SECRET_B32, counter), `counter=${counter}`).toBe(
        hotp.generate({ counter }),
      );
    }
  });
});

// ─── 2. verifyTotp tại timestamp cố định (RFC 6238: counter = floor(ts/period)) ─

describe("verifyTotp — timestamp cố định", () => {
  it("chấp nhận hotpCode tại floor(ts/30000) (Date.now bị mock)", () => {
    const code = hotpCode(RFC_SECRET_B32, FIXED_COUNTER);
    expect(verifyTotp(RFC_SECRET_B32, code)).toBe(true);
  });

  it("từ chối mã của counter lệch 2 period khi window mặc định = 1", () => {
    // window mặc định ±1 — counter ±2 phải fail (Date.now mock ở FIXED_TS)
    expect(verifyTotp(RFC_SECRET_B32, hotpCode(RFC_SECRET_B32, FIXED_COUNTER - 2))).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, hotpCode(RFC_SECRET_B32, FIXED_COUNTER + 2))).toBe(false);
  });

  it("atMs override Date.now — cùng mã ở timestamp khác cùng counter", () => {
    // cùng counter, timestamp khác trong cùng period → vẫn hợp lệ
    const code = hotpCode(RFC_SECRET_B32, FIXED_COUNTER);
    expect(verifyTotp(RFC_SECRET_B32, code, FIXED_TS + 5_000)).toBe(true);
  });
});

// ─── 3. Window ±1 — chấp nhận cửa sổ kề, từ chối ±2 ──────────────────────────

describe("verifyTotp — window=1", () => {
  it("chấp nhận mã của cửa sổ trước/sau 30s (counter ±1)", () => {
    expect(verifyTotp(RFC_SECRET_B32, hotpCode(RFC_SECRET_B32, FIXED_COUNTER - 1), FIXED_TS)).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, hotpCode(RFC_SECRET_B32, FIXED_COUNTER + 1), FIXED_TS)).toBe(true);
  });

  it("từ chối mã của ±2 cửa sổ (ngoài window)", () => {
    expect(verifyTotp(RFC_SECRET_B32, hotpCode(RFC_SECRET_B32, FIXED_COUNTER - 2), FIXED_TS)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, hotpCode(RFC_SECRET_B32, FIXED_COUNTER + 2), FIXED_TS)).toBe(false);
  });

  it("mã rác / sai độ dài → false (không throw)", () => {
    expect(verifyTotp(RFC_SECRET_B32, "000000", FIXED_TS)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "not-a-code", FIXED_TS)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "", FIXED_TS)).toBe(false);
  });
});

// ─── 4. Sinh secret + URI (otpauth://) ───────────────────────────────────────

describe("generateTotpSecret + totpUri", () => {
  it("base32 hợp lệ — Secret.fromBase32 chấp nhận, 20 byte entropy", () => {
    const b32 = generateTotpSecret();
    expect(b32).toMatch(/^[A-Z2-7]+$/);
    // 20 byte → 32 ký tự base32 (RFC 4648, không padding)
    expect(b32).toHaveLength(32);
    expect(() => Secret.fromBase32(b32)).not.toThrow();
    expect(Secret.fromBase32(b32).bytes).toHaveLength(20);
  });

  it("hai lần sinh → secret khác nhau (CSPRNG qua thư viện)", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it("totpUri bắt đầu bằng otpauth://totp/ và mang issuer + label", () => {
    const b32 = generateTotpSecret();
    const uri = totpUri(b32, "admin@loaviet.test", "LoaViet");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("issuer=LoaViet");
    // label được encode (email chứa @)
    expect(uri).toContain("admin%40loaviet.test");
    expect(uri).toContain(`secret=${b32}`);
  });

  it("URI parse ngược bởi chính thư viện → TOTP cùng tham số", () => {
    const b32 = generateTotpSecret();
    const uri = totpUri(b32, "ops@loaviet.test", "LoaViet");
    const parsed = new URL(uri);
    expect(parsed.searchParams.get("issuer")).toBe("LoaViet");
    expect(parsed.searchParams.get("secret")).toBe(b32);
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
  });

  it("mã sinh bởi TOTP.generate của thư viện được verifyTotp chấp nhận", () => {
    const b32 = generateTotpSecret();
    const totp = new TOTP({
      issuer: "LoaViet",
      label: "t@loaviet.test",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(b32),
    });
    const code = totp.generate({ timestamp: FIXED_TS });
    expect(verifyTotp(b32, code, FIXED_TS)).toBe(true);
  });
});
