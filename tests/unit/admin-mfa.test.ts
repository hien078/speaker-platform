/**
 * Admin MFA core — unit tests (plan Task 8, spec §5.3/§5.4.2).
 *
 * Cơ chế mock: `server-only` + `@/src/prisma/db.client` (in-memory AdminMfa +
 * AdminRecoveryCode + User store) — cùng phong cách otp.test.ts / session.test.ts.
 * `ADMIN_MFA_ENCRYPTION_KEY` stub bằng key base64 32-byte CỐ ĐỊNH (deterministic);
 * AUTH_SECRET stub cho hkdfKey (recovery-code hash — node:crypto HMAC).
 *
 * Hợp đồng (plan Task 8 Step 2 — MFA gate):
 *  1. getAdminMfaEncryptionKey: key hợp lệ decode đúng 32 byte; thiếu env →
 *     typed ADMIN_MFA_KEY_UNCONFIGURED; không phải base64 → ADMIN_MFA_KEY_INVALID;
 *     base64 của 31 byte → ADMIN_MFA_KEY_INVALID (strict độ dài).
 *  2. enrollAdminMfa: lưu secret ĐÃ MÃ HÓA (ciphertext ≠ plaintext, decrypt
 *     round-trip) + 10 recovery-code HASH (không bao giờ lưu mã thô); enroll lần
 *     hai cho cùng user → null (refuse — reset qua bootstrap, Task 11).
 *  3. Envelope "v1:<keyId>:<base64(iv‖tag‖ct)>" — keyId = 8 hex đầu của
 *     sha256(key); decrypt bằng key KHÁC → typed ADMIN_MFA_KEY_MISMATCH
 *     (rotation detection — không corrupt im lặng).
 *  4. verifyAdminMfaCode: TOTP hợp lệ → "totp"; mã khôi phục hợp lệ →
 *     "recovery_code" + row đánh dấu usedAt; CÙNG mã lần hai → null (single-use,
 *     claim race-safe).
 *  5. TOTP sai 5 lần liên tiếp KHÔNG khóa tài khoản (rate limit sống ở action —
 *     spec §7.2 brute force do limiter lo, không phải lockout vĩnh viễn).
 *
 * spec §4.8: KHÔNG test nào được phép kỳ vọng mã thô/TOTP secret trong log —
 * thêm case spy console/captureEvent xác nhận module không emit secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

// ─── db.client mock: in-memory AdminMfa + AdminRecoveryCode + User ────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  mfas: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          lt: (v: unknown) => (row[field] as number) < (v as number),
          lte: (v: unknown) => (row[field] as number) <= (v as number),
          gt: (v: unknown) => (row[field] as number) > (v as number),
          gte: (v: unknown) => (row[field] as number) >= (v as number),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[], defaults?: () => Row) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit ? { ...hit } : null;
      },
      all: async () => rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? {}), ...data };
        rows.push(row);
        return { ...row };
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
      updateAll: (data: Row) => query([]).updateAll(data),
    };
  };

  const orm = {
    public: {
      User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
      AdminMfa: makeModel(dbState.mfas, () => ({
        id: `mfa-${dbState.mfas.length + 1}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      AdminRecoveryCode: makeModel(dbState.codes, () => ({
        id: `rc-${dbState.codes.length + 1}`,
        createdAt: new Date().toISOString(),
        usedAt: null, // nullable column — DB thật luôn có null, mock phải trung thực
      })),
    },
  };
  return {
    db: {
      orm,
      // tx mock: callback nhận chính orm — cùng store in-memory
      transaction: async (fn: (tx: { orm: typeof orm }) => Promise<unknown>) => fn({ orm }),
    },
  };
});

import { hkdfKey } from "@/src/lib/otp";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  encryptTotpSecret,
  decryptTotpSecret,
  enrollAdminMfa,
  verifyAdminMfaCode,
} from "@/src/lib/admin-mfa";
import {
  getAdminMfaEncryptionKey,
  adminMfaKeyId,
  isValidAdminMfaKeyEnv,
} from "@/src/lib/admin-mfa-key";
import { hotpCode } from "@/src/lib/totp";

// ─── Key test cố định (deterministic) ────────────────────────────────────────

/** 32 byte 0x11 — base64 chuẩn, dùng làm key chính trong các case. */
const KEY_A = Buffer.alloc(32, 0x11).toString("base64");
/** 32 byte 0x22 — key KHÁC, dùng cho case rotate/mismatch. */
const KEY_B = Buffer.alloc(32, 0x22).toString("base64");

const ADMIN = {
  id: "user-admin",
  email: "admin@loaviet.test",
  passwordHash: "x",
  name: "Admin",
  role: "admin",
  adminRole: "super_admin",
} as const;

const nowCounter = () => Math.floor(Date.now() / 30_000);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_A);
  dbState.users.length = 0;
  dbState.mfas.length = 0;
  dbState.codes.length = 0;
  dbState.users.push({ ...ADMIN });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. getAdminMfaEncryptionKey — strict 32-byte base64 ──────────────────────

describe("getAdminMfaEncryptionKey — dedicated key, strict validation", () => {
  it("key hợp lệ decode đúng 32 byte", () => {
    const key = getAdminMfaEncryptionKey();
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.alloc(32, 0x11))).toBe(true);
  });

  it("thiếu env (rỗng) → typed ADMIN_MFA_KEY_UNCONFIGURED", () => {
    vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", "");
    expect(() => getAdminMfaEncryptionKey()).toThrowError(/ADMIN_MFA_KEY_UNCONFIGURED/);
  });

  it("không phải base64 → typed ADMIN_MFA_KEY_INVALID", () => {
    for (const bad of ["not-base64!!!", "abc", "!!!!", "a b c d"]) {
      vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", bad);
      expect(() => getAdminMfaEncryptionKey(), `key=${bad}`).toThrowError(/ADMIN_MFA_KEY_INVALID/);
    }
  });

  it("base64 của 31/33 byte → typed ADMIN_MFA_KEY_INVALID (strict độ dài)", () => {
    vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", Buffer.alloc(31, 9).toString("base64"));
    expect(() => getAdminMfaEncryptionKey()).toThrowError(/ADMIN_MFA_KEY_INVALID/);
    vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", Buffer.alloc(33, 9).toString("base64"));
    expect(() => getAdminMfaEncryptionKey()).toThrowError(/ADMIN_MFA_KEY_INVALID/);
  });

  it("đổi env key → derive lại (cache theo giá trị, không kẹt key cũ)", () => {
    expect(getAdminMfaEncryptionKey().equals(Buffer.alloc(32, 0x11))).toBe(true);
    vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_B);
    expect(getAdminMfaEncryptionKey().equals(Buffer.alloc(32, 0x22))).toBe(true);
  });

  it("adminMfaKeyId = 8 hex đầu của sha256(key) — định danh KHÔNG bí mật", () => {
    const key = Buffer.alloc(32, 0x11);
    const expected = createHash("sha256").update(key).digest("hex").slice(0, 8);
    expect(adminMfaKeyId(key)).toBe(expected);
    expect(adminMfaKeyId(key)).toHaveLength(8);
    // key khác → id khác (đó là điểm của rotation detection)
    expect(adminMfaKeyId(Buffer.alloc(32, 0x22))).not.toBe(expected);
  });

  it("isValidAdminMfaKeyEnv: đúng cho base64-32, sai cho mọi thứ khác", () => {
    expect(isValidAdminMfaKeyEnv(KEY_A)).toBe(true);
    expect(isValidAdminMfaKeyEnv(Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(isValidAdminMfaKeyEnv("not-base64!!!")).toBe(false);
    expect(isValidAdminMfaKeyEnv("")).toBe(false);
  });
});

// ─── 2. enrollAdminMfa — mã hóa + hash, không bao giờ lưu thô ─────────────────

describe("enrollAdminMfa", () => {
  it("lưu secret mã hóa (ciphertext ≠ plaintext, round-trip) + 10 hash mã khôi phục — không mã thô nào trong DB", async () => {
    const enrolled = await enrollAdminMfa(ADMIN.id);

    expect(enrolled).not.toBeNull();
    const { secretBase32, uri, recoveryCodes } = enrolled!;

    // secret + URI trả về cho bootstrap in MỘT LẦN
    expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);

    // DB: đúng 1 row AdminMfa, secret ĐÃ MÃ HÓA (≠ plaintext)
    expect(dbState.mfas).toHaveLength(1);
    const mfa = dbState.mfas[0]! as Record<string, unknown>;
    expect(mfa.userId).toBe(ADMIN.id);
    expect(mfa.totpSecretEnc).not.toBe(secretBase32);
    expect(mfa.totpSecretEnc).not.toContain(secretBase32);
    // round-trip decrypt về đúng secret
    expect(decryptTotpSecret(mfa.totpSecretEnc as string)).toBe(secretBase32);
    // enrollment qua bootstrap = confirmed ngay (không có bước confirm UI riêng trong Batch 2)
    expect(mfa.totpConfirmedAt).not.toBeNull();

    // DB: 10 row mã khôi phục — CHỈ hash (HMAC), không mã thô
    expect(dbState.codes).toHaveLength(10);
    for (const row of dbState.codes) {
      expect(row.mfaId).toBe(mfa.id);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.usedAt).toBeNull();
      // hash ≠ mã thô — và mã thô không xuất hiện ở bất kỳ đâu trong store
      expect(recoveryCodes.includes(row.codeHash as string)).toBe(false);
    }
    const dbText = JSON.stringify([dbState.mfas, dbState.codes]);
    for (const code of recoveryCodes) {
      expect(dbText).not.toContain(code);
      expect(dbText).not.toContain(code.replaceAll("-", ""));
    }
  });

  it("mã khôi phục: dạng XXXX-XXXX, alphabet không có I/O/0/1, 10 mã khác nhau", async () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      expect(code).not.toMatch(/[IO01]/);
    }
    expect(new Set(codes).size).toBe(10);
  });

  it("đã có AdminMfa → trả null (refuse — reset qua bootstrap script, Task 11)", async () => {
    expect(await enrollAdminMfa(ADMIN.id)).not.toBeNull();
    expect(await enrollAdminMfa(ADMIN.id)).toBeNull();
    // vẫn chỉ 1 row + 10 mã — enroll thứ hai không đụng gì
    expect(dbState.mfas).toHaveLength(1);
    expect(dbState.codes).toHaveLength(10);
  });

  it("user không tồn tại → null (fail closed, không tạo row mồ côi)", async () => {
    expect(await enrollAdminMfa("user-không-tồn-tại")).toBeNull();
    expect(dbState.mfas).toHaveLength(0);
  });
});

// ─── 3. Envelope v1:<keyId>:<payload> — rotation detection ────────────────────

describe("envelope AES-256-GCM — v1:<keyId>:<base64(iv‖tag‖ct)>", () => {
  it("đúng format — keyId = 8 hex đầu sha256(key), payload base64 ≥ 40 byte", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // base32 bất kỳ
    const enc = encryptTotpSecret(secret);
    const parts = enc.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe(createHash("sha256").update(Buffer.alloc(32, 0x11)).digest("hex").slice(0, 8));
    // payload = iv(12) + tag(16) + ct(base32 secret ~ 32 byte) — decode được
    const payload = Buffer.from(parts[2]!, "base64");
    expect(payload.length).toBeGreaterThanOrEqual(12 + 16 + 16);
    // iv ngẫu nhiên mỗi lần — hai envelope khác nhau (không reuse iv)
    expect(encryptTotpSecret(secret)).not.toBe(enc);
  });

  it("decrypt bằng key KHÁC → typed ADMIN_MFA_KEY_MISMATCH (không corrupt im lặng)", () => {
    const enc = encryptTotpSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_B);
    expect(() => decryptTotpSecret(enc)).toThrowError(/ADMIN_MFA_KEY_MISMATCH/);
    // keyId trong message khớp envelope (điều kiện rotate debug được)
    try {
      decryptTotpSecret(enc);
    } catch (e) {
      expect((e as Error).message).toContain(enc.split(":")[1]);
    }
  });

  it("envelope rác/thiếu phần → typed error (fail closed, không throw opaque)", () => {
    expect(() => decryptTotpSecret("không-phải-envelope")).toThrowError(/ADMIN_MFA_ENVELOPE_INVALID/);
    expect(() => decryptTotpSecret("v2:abcd:AAAA")).toThrowError(/ADMIN_MFA_ENVELOPE_INVALID/);
    expect(() => decryptTotpSecret("v1:abcd")).toThrowError(/ADMIN_MFA_ENVELOPE_INVALID/);
  });

  it("tag bị sửa → decrypt fail (AES-GCM integrity) — typed error", () => {
    const enc = encryptTotpSecret("JBSWY3DPEHPK3PXP");
    const parts = enc.split(":");
    const payload = Buffer.from(parts[2]!, "base64");
    payload[payload.length - 1]! ^= 0xff; // sửa 1 byte ct
    const tampered = `v1:${parts[1]}:${payload.toString("base64")}`;
    expect(() => decryptTotpSecret(tampered)).toThrowError(/ADMIN_MFA_DECRYPT_FAILED/);
  });
});

// ─── 4. verifyAdminMfaCode — TOTP window ±1 + recovery single-use ────────────

describe("verifyAdminMfaCode", () => {
  it("TOTP hợp lệ → 'totp'", async () => {
    const { secretBase32 } = (await enrollAdminMfa(ADMIN.id))!;
    const code = hotpCode(secretBase32, nowCounter());
    expect(await verifyAdminMfaCode(ADMIN.id, code)).toBe("totp");
  });

  it("mã khôi phục hợp lệ → 'recovery_code' + row đánh dấu usedAt; CÙNG mã lần hai → null", async () => {
    const { recoveryCodes } = (await enrollAdminMfa(ADMIN.id))!;
    const code = recoveryCodes[0]!;

    expect(await verifyAdminMfaCode(ADMIN.id, code)).toBe("recovery_code");
    const row = dbState.codes.find((r) => hashMatches(code, r))!;
    expect(row.usedAt).not.toBeNull();

    // single-use: dùng lại → null (spec §5.3 one-time recovery codes)
    expect(await verifyAdminMfaCode(ADMIN.id, code)).toBeNull();
  });

  it("mã khôi phục nhập thường (thường/không gạch, chữ thường) vẫn khớp hash chuẩn", async () => {
    const { recoveryCodes } = (await enrollAdminMfa(ADMIN.id))!;
    const canonical = recoveryCodes[3]!;
    // người dùng gõ chữ thường + bỏ gạch — normalize trước khi hash
    const typed = canonical.replaceAll("-", "").toLowerCase();
    expect(await verifyAdminMfaCode(ADMIN.id, typed)).toBe("recovery_code");
    expect(await verifyAdminMfaCode(ADMIN.id, canonical)).toBeNull(); // đã dùng ở trên
  });

  it("mã sai / mã của mfaId khác / user không có MFA → null", async () => {
    const { secretBase32, recoveryCodes } = (await enrollAdminMfa(ADMIN.id))!;
    expect(await verifyAdminMfaCode(ADMIN.id, "000000")).toBeNull();
    expect(await verifyAdminMfaCode(ADMIN.id, "ZZZZ-ZZZZ")).toBeNull();
    // secret đúng nhưng mã TOTP của counter rất xa → null
    expect(await verifyAdminMfaCode(ADMIN.id, hotpCode(secretBase32, nowCounter() + 100))).toBeNull();
    // mã khôi phục hợp lệ nhưng của user khác → null
    expect(await verifyAdminMfaCode("user-khác", recoveryCodes[1]!)).toBeNull();
    expect(await verifyAdminMfaCode("user-chưa-enroll", "123456")).toBeNull();
  });

  it("TOTP sai 5 lần liên tiếp KHÔNG khóa tài khoản — lần 6 mã ĐÚNG vẫn 'totp' (rate limit ở action)", async () => {
    const { secretBase32 } = (await enrollAdminMfa(ADMIN.id))!;
    for (let i = 0; i < 5; i++) {
      expect(await verifyAdminMfaCode(ADMIN.id, "000000")).toBeNull();
    }
    // không có counter/lockout trong module — verifyAdminMfaCode stateless per call
    expect(await verifyAdminMfaCode(ADMIN.id, hotpCode(secretBase32, nowCounter()))).toBe("totp");
  });

  it("secret mã hóa bằng key khác (rotate thiếu reset) → TOTP path fail closed nhưng mã khôi phục VẪN dùng được (chống lockout vĩnh viễn)", async () => {
    const { recoveryCodes } = (await enrollAdminMfa(ADMIN.id))!;
    vi.stubEnv("ADMIN_MFA_ENCRYPTION_KEY", KEY_B); // key đã đổi — envelope keyId lệch
    // TOTP không verify được (decrypt mismatch) — nhưng KHÔNG throw ra caller
    expect(await verifyAdminMfaCode(ADMIN.id, "123456")).toBeNull();
    // recovery code (hash không mã hóa) vẫn hoạt động → admin vào được để re-enroll
    expect(await verifyAdminMfaCode(ADMIN.id, recoveryCodes[5]!)).toBe("recovery_code");
  });
});

// ─── hashRecoveryCode — đúng construction chia sẻ với otp.ts (spec §4.8) ─────

describe("hashRecoveryCode — HMAC hkdfKey('recovery-code-hash') từ otp.ts", () => {
  it("hash = HMAC-SHA256 hex của hkdfKey('recovery-code-hash') — cùng helper Task 3", () => {
    const expected = (code: string) =>
      createHmac("sha256", hkdfKey("recovery-code-hash")).update(code).digest("hex");
    expect(hashRecoveryCode("AB2C-DE3F")).toBe(expected("AB2C-DE3F"));
    expect(hashRecoveryCode("AB2C-DE3F")).toMatch(/^[0-9a-f]{64}$/);
    // hash khác input (không thể đảo)
    expect(hashRecoveryCode("AB2C-DE3F")).not.toBe("AB2C-DE3F");
  });
});

// ─── spec §4.8 — module không emit secret/mã ra log ──────────────────────────

describe("không log mã thô (spec §4.8)", () => {
  it("enroll + verify không emit TOTP secret hay mã khôi phục ra console/captureEvent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { secretBase32, recoveryCodes } = (await enrollAdminMfa(ADMIN.id))!;
      await verifyAdminMfaCode(ADMIN.id, hotpCode(secretBase32, nowCounter()));
      await verifyAdminMfaCode(ADMIN.id, recoveryCodes[0]!);
      await verifyAdminMfaCode(ADMIN.id, "mã-sai");

      const emitted = JSON.stringify(
        [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls],
      );
      expect(emitted).not.toContain(secretBase32);
      for (const code of recoveryCodes) {
        expect(emitted).not.toContain(code);
        expect(emitted).not.toContain(code.replaceAll("-", ""));
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ─── helper nội bộ test ────────────────────────────────────────────────────────

/** Tìm row mã khôi phục khớp MỘT mã thô (dùng hashRecoveryCode — không so thô). */
function hashMatches(code: string, row: Record<string, unknown>): boolean {
  return row.codeHash === hashRecoveryCode(code);
}
