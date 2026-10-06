/**
 * Audit event foundation — unit tests (plan Task 5, spec §4.6 + §4.8).
 *
 * Hợp đồng (plan Task 5 Step 1):
 *  1. auditEvent ghi actor/subject/action/reason/policyVersion/sessionId +
 *     ipHash — ipHash là HMAC-SHA256 hex (hkdfKey "ip-hash"), KHÔNG BAO GIỜ
 *     IP thô (spec §4.8) — đọc từ headers() khi có request context.
 *  2. auditEventTx ghi BÊN TRONG transaction được truyền vào.
 *  3. detail lưu VERBATIM (caller chịu trách nhiệm PII — spec §4.8) nhưng
 *     helper redactDetail(value) tồn tại và mask mọi chuỗi hình email/số
 *     phone/OTP 6 chữ số — belt-and-braces cho caller.
 *
 * Cơ chế mock: `server-only` + `next/headers` (headers điều khiển được —
 * cả path offline script throw) + `@/src/prisma/db.client` (AuditEvent.create
 * spy). hkdfKey GIỮ BẢN THẬT từ src/lib/otp.ts (Task 3) — test tự tính HMAC
 * kỳ vọng cùng công thức.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

// ─── headers() điều khiển được — ipHash đọc IP client qua seam này ────────────

const headerState = vi.hoisted(() => ({
  headers: null as Headers | null, // null = không có request context (offline)
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => {
    if (headerState.headers === null) {
      throw new Error("headers() ngoài request context (offline script)");
    }
    return headerState.headers;
  }),
}));

// ─── db.client mock — AuditEvent.create spy ───────────────────────────────────

const dbState = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>, // rows auditEvent ghi (ngoài tx)
}));

vi.mock("@/src/prisma/db.client", () => ({
  db: {
    orm: {
      public: {
        AuditEvent: {
          create: vi.fn(async (data: Record<string, unknown>) => {
            dbState.created.push(data);
            return data;
          }),
        },
      },
    },
    // transaction chỉ dùng cho TYPE TxContext trong audit-event.ts —
    // không gọi runtime ở đây; auditEventTx nhận tx từ caller.
    transaction: vi.fn(),
  },
}));

import { db } from "@/src/prisma/db.client";
import { hkdfKey } from "@/src/lib/otp";
import {
  auditEvent,
  auditEventTx,
  redactDetail,
  type AuditEventInput,
} from "@/src/lib/audit-event";

const createMock = vi.mocked(db.orm.public.AuditEvent.create);

const INPUT: AuditEventInput = {
  actorId: "admin-1",
  subjectId: "user-2",
  action: "seller_verification.reviewed",
  resourceType: "SellerVerification",
  resourceId: "sv-1",
  reason: "policy_v1_satisfied",
  policyVersion: "v1",
  sessionId: "sess-1",
  detail: "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.",
};

const expectedIpHash = (ip: string): string =>
  createHmac("sha256", hkdfKey("ip-hash")).update(ip).digest("hex");

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.created.length = 0;
  createMock.mockClear();
  headerState.headers = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ─── 1. auditEvent — đủ trường + ipHash HMAC (spec §4.6/§4.8) ─────────────────

describe("auditEvent — ghi đủ context + ipHash (spec §4.6)", () => {
  it("ghi actor/subject/action/reason/policyVersion/sessionId/detail + ipHash HMAC của IP client", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    headerState.headers = new Headers({ "x-real-ip": "203.0.113.9" });

    await auditEvent(INPUT);

    expect(createMock).toHaveBeenCalledTimes(1);
    const row = dbState.created[0]!;
    expect(row).toMatchObject({
      actorId: "admin-1",
      subjectId: "user-2",
      action: "seller_verification.reviewed",
      resourceType: "SellerVerification",
      resourceId: "sv-1",
      reason: "policy_v1_satisfied",
      policyVersion: "v1",
      sessionId: "sess-1",
      detail: INPUT.detail, // verbatim — xem hợp đồng redactDetail bên dưới
    });
    // ipHash = HMAC-SHA256(ip, hkdfKey("ip-hash")) hex — ĐÚNG công thức plan
    expect(row.ipHash).toBe(expectedIpHash("203.0.113.9"));
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
    // KHÔNG BAO GIỜ IP thô trong row (spec §4.8)
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
  });

  it("TRUST_PROXY_HEADERS tắt (mặc định) → bucket 'local' — ipHash = HMAC('local'), vẫn không IP thô", async () => {
    headerState.headers = new Headers(); // không header proxy nào tin được

    await auditEvent({ action: "session.revoked", reason: "logout" });

    const row = dbState.created[0]!;
    expect(row.ipHash).toBe(expectedIpHash("local"));
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("offline script (headers() throw) → ipHash null, event VẪN ĐƯỢC GHI (không mất audit vì thiếu request)", async () => {
    headerState.headers = null; // headers() throw — như script chạy qua tsx

    await auditEvent({ actorId: null, action: "seller_verification.backfill" });

    const row = dbState.created[0]!;
    expect(row.ipHash).toBeNull();
    expect(row.actorId).toBeNull(); // null = system/offline script
    expect(row.action).toBe("seller_verification.backfill");
  });

  it("thiếu field tùy chọn → null rõ ràng (không undefined lọt vào row)", async () => {
    headerState.headers = null;
    await auditEvent({ action: "user.email_verified" });
    const row = dbState.created[0]!;
    expect(row).toMatchObject({
      action: "user.email_verified",
      actorId: null,
      subjectId: null,
      resourceType: null,
      resourceId: null,
      reason: null,
      policyVersion: null,
      sessionId: null,
      detail: null,
    });
  });
});

// ─── 2. auditEventTx — ghi trong transaction truyền vào ──────────────────────

describe("auditEventTx — ghi bên trong transaction (atomic với thay đổi chính)", () => {
  it("ghi qua tx.orm.public.AuditEvent.create — KHÔNG chạm db ngoài tx", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    headerState.headers = new Headers({ "x-real-ip": "198.51.100.7" });

    const txCreate = vi.fn(async (data: Record<string, unknown>) => data);
    const tx = { orm: { public: { AuditEvent: { create: txCreate } } } };

    await auditEventTx(tx as never, INPUT);

    expect(txCreate).toHaveBeenCalledTimes(1);
    const row = (txCreate.mock.calls[0]![0] as Record<string, unknown>);
    expect(row).toMatchObject({
      actorId: "admin-1",
      action: "seller_verification.reviewed",
      policyVersion: "v1",
      sessionId: "sess-1",
    });
    expect(row.ipHash).toBe(expectedIpHash("198.51.100.7"));
    // db ngoài tx KHÔNG bị chạm — event sống chết cùng transaction chính
    expect(createMock).not.toHaveBeenCalled();
    expect(dbState.created).toHaveLength(0);
  });
});

// ─── 3. redactDetail — belt-and-braces cho caller (spec §4.8) ────────────────

describe("redactDetail — mask email/phone/OTP 6 chữ số (spec §4.8)", () => {
  it("mask email thô", () => {
    const out = redactDetail("user nguyen.van@loaviet.test đã verify");
    expect(out).not.toContain("nguyen.van@loaviet.test");
    expect(out).toContain("user");
    expect(out).toContain("đã verify");
  });

  it("mask số phone VN (compact +84/0)", () => {
    expect(redactDetail("liên hệ 0901234567")).not.toContain("0901234567");
    expect(redactDetail("số cũ +84901234567")).not.toContain("84901234567");
  });

  it("mask chuỗi 6 chữ số hình OTP", () => {
    const out = redactDetail("mã 123456 đã gửi");
    expect(out).not.toContain("123456");
    expect(out).toContain("mã");
    expect(out).toContain("đã gửi");
  });

  it("giữ nguyên text không khớp pattern — không redact bừa", () => {
    const text = "Đơn SP-26-0001 hoàn 2.500.000₫ Vietcombank";
    expect(redactDetail(text)).toBe(text);
  });

  it("over-redaction là hướng an toàn: đoạn 6 chữ số khác (mã đơn) cũng bị mask", () => {
    // "260101" khớp OTP-shape — mask thừa tốt hơn lộ mã OTP thật (spec §4.8)
    const out = redactDetail("Đơn SP-260101-0001");
    expect(out).not.toContain("260101");
    expect(out).toContain("SP-");
    expect(out).toContain("-0001");
  });

  it("detail lưu VERBATIM trong auditEvent — redactDetail là trách nhiệm caller", async () => {
    headerState.headers = null;
    const detail = "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.";
    await auditEvent({ action: "seller_verification.reviewed", detail });
    expect(dbState.created[0]!.detail).toBe(detail);
  });
});
