/**
 * Admin access review (Batch 8 Task 7) — unit test.
 *
 * Spec §5.4.2 "All admin accounts require MFA enrollment" (ADMIN_WITHOUT_MFA là
 * tín hiệu fail-closed), §7.6 admin security (session inventory + revocation),
 * §9 Batch 8 gate "admin MFA operational / RBAC operational", §4.8 KHÔNG PII
 * trong ops output (Review Focus 3: id nội bộ + role + states/count — KHÔNG
 * email thô, KHÔNG giá trị mã khôi phục, KHÔNG secret TOTP, KHÔNG token).
 *
 * Pure `evaluateAdminAccess`/`toAdminAccessRow` over fixture rows — KHÔNG db
 * (đường ORM/psql của script chạy thật ở dev run + production pre-launch,
 * ghi vào docs/operations/admin-access-review.md). Source-contract assertions
 * đọc file as-text (pattern tests/unit/finance-public-surface.test.ts):
 *  - drift: ADMIN_SESSION_TTL_HOURS bản địa của script === src/lib/session.ts
 *    (session.ts có "server-only" — script tsx KHÔNG import được → duplicate
 *    cục bộ + drift test, cùng quy ước Global Constraints Batch 8);
 *  - script KHÔNG import module server-only (tsx không nạp được);
 *  - script READ-ONLY (không có create/updateAll/delete/upsert — §5.1.1).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADMIN_SESSION_TTL_HOURS,
  evaluateAdminAccess,
  toAdminAccessRow,
  type AdminAccessRow,
  type AdminFacts,
} from "../../scripts/admin-access-review";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── Fixture ─────────────────────────────────────────────────────────────────

/** Row mặc định "khỏe" — override từng trường per case. */
const row = (over: Partial<AdminAccessRow>): AdminAccessRow => ({
  userId: "11111111-2222-4333-8444-555555555555",
  adminRole: "operations_admin",
  mfaEnrolled: true,
  unusedRecoveryCodes: 10,
  activeSessions: 1,
  staleSessions: 0,
  lastAdminAuditAction: "admin.role_set (3 ngày trước)",
  accountAgeDays: 245,
  ...over,
});

// ─── Findings (Review Focus 3 + §5.4.2) ──────────────────────────────────────

describe("evaluateAdminAccess — findings typed theo từng trạng thái", () => {
  it("admin KHÔNG enroll MFA → finding ADMIN_WITHOUT_MFA (§5.4.2 fail-closed)", () => {
    const r = row({ mfaEnrolled: false });
    const { findings } = evaluateAdminAccess([r]);
    expect(findings).toContain(`ADMIN_WITHOUT_MFA:${r.userId}`);
  });

  it("admin KHÔNG enroll MFA thì KHÔNG kèm NO_UNUSED_RECOVERY_CODES (không có MFA → không có mã là hệ quả, một tín hiệu là đủ)", () => {
    // Quyết định ghi nhận: NO_UNUSED_RECOVERY_CODES chỉ dành cho admin ĐÃ enroll
    // mà hết mã chưa dùng (nguy cơ lockout — runbook §2B); admin chưa enroll đã
    // được ADMIN_WITHOUT_MFA phủ.
    const r = row({ mfaEnrolled: false, unusedRecoveryCodes: 0 });
    const { findings } = evaluateAdminAccess([r]);
    expect(findings).toContain(`ADMIN_WITHOUT_MFA:${r.userId}`);
    expect(findings).not.toContain(`NO_UNUSED_RECOVERY_CODES:${r.userId}`);
  });

  it("admin đã enroll nhưng 0 mã khôi phục chưa dùng → finding NO_UNUSED_RECOVERY_CODES (warn)", () => {
    const r = row({ unusedRecoveryCodes: 0 });
    const { findings } = evaluateAdminAccess([r]);
    expect(findings).toContain(`NO_UNUSED_RECOVERY_CODES:${r.userId}`);
  });

  it("admin giữ session active cũ hơn TTL admin → finding STALE_SESSIONS (info)", () => {
    const r = row({ staleSessions: 2 });
    const { findings } = evaluateAdminAccess([r]);
    expect(findings).toContain(`STALE_SESSIONS:${r.userId}`);
  });

  it("đúng MỘT super_admin → finding LAST_SUPER_ADMIN (tiếng vang operational của last-super-admin guard)", () => {
    const solo = row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000001" });
    const { findings } = evaluateAdminAccess([solo]);
    expect(findings).toContain("LAST_SUPER_ADMIN");
  });

  it("HAI super_admin → KHÔNG có LAST_SUPER_ADMIN", () => {
    const two = [
      row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000001" }),
      row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000002" }),
    ];
    const { findings } = evaluateAdminAccess(two);
    expect(findings).not.toContain("LAST_SUPER_ADMIN");
  });

  it("KHÔNG có admin nào → finding NO_ADMINS (info — cần bootstrap)", () => {
    const { findings, tableMarkdown } = evaluateAdminAccess([]);
    expect(findings).toEqual(["NO_ADMINS"]);
    // Bảng rỗng vẫn render được (header) — không throw.
    expect(tableMarkdown).toContain("|");
  });

  it("fleet khỏe (đủ MFA, còn mã, không session quá TTL, ≥2 super_admin) → KHÔNG finding nào", () => {
    const healthy = [
      row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000001" }),
      row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000002" }),
      row({ adminRole: "moderator", userId: "aaaa1111-0000-4000-8000-000000000003" }),
    ];
    const { findings } = evaluateAdminAccess(healthy);
    expect(findings).toEqual([]);
  });

  it("findings per-row đi theo thứ tự row, LAST_SUPER_ADMIN đứng sau (deterministic)", () => {
    const rows = [
      row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000001" }),
      row({ mfaEnrolled: false, userId: "aaaa1111-0000-4000-8000-000000000002" }),
    ];
    const { findings } = evaluateAdminAccess(rows);
    expect(findings).toEqual([
      `ADMIN_WITHOUT_MFA:${rows[1]!.userId}`,
      "LAST_SUPER_ADMIN",
    ]);
  });
});

// ─── Bảng markdown — chỉ id/role/count/state (Review Focus 3) ─────────────────

describe("evaluateAdminAccess — bảng markdown KHÔNG PII (spec §4.8)", () => {
  const mixed = [
    row({ adminRole: "super_admin", userId: "aaaa1111-0000-4000-8000-000000000001" }),
    row({
      adminRole: "support",
      userId: "aaaa1111-0000-4000-8000-000000000002",
      mfaEnrolled: false,
      unusedRecoveryCodes: 0,
      activeSessions: 0,
      staleSessions: 0,
      lastAdminAuditAction: null,
      accountAgeDays: 12,
    }),
  ];

  it("chứa id nội bộ + role + count/state — KHÔNG email, KHÔNG hình mã 6 chữ số, KHÔNG 'secret'", () => {
    const { tableMarkdown } = evaluateAdminAccess(mixed);
    // id + role + counts có mặt (operator correlate id qua /admin/users).
    for (const r of mixed) {
      expect(tableMarkdown).toContain(r.userId);
      expect(tableMarkdown).toContain(r.adminRole);
    }
    expect(tableMarkdown).toContain("10"); // unusedRecoveryCodes count — KHÔNG bao giờ giá trị mã

    // KHÔNG hình email (§4.8 raw email).
    expect(tableMarkdown).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    // KHÔNG hình mã OTP 6 chữ số đứng riêng (§4.8 OTP).
    expect(tableMarkdown).not.toMatch(/\b\d{6}\b/);
    // KHÔNG chữ "secret" (TOTP secret / token).
    expect(tableMarkdown).not.toMatch(/secret/i);
  });

  it("MFA hiển thị dạng trạng thái, hành động admin gần nhất null → '—'", () => {
    const { tableMarkdown } = evaluateAdminAccess(mixed);
    expect(tableMarkdown).toContain("Đã enroll");
    expect(tableMarkdown).toContain("CHƯA enroll");
    expect(tableMarkdown).toMatch(/—/);
  });
});

// ─── Facts → row (mapping thuần — cùng luật hai transport ORM/psql) ───────────

describe("toAdminAccessRow — map facts thô → row review", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");

  it("mfaEnrolled = totpConfirmedAt != null; accountAgeDays làm tròn xuống", () => {
    const enrolled = toAdminAccessRow(
      {
        userId: "u1",
        adminRole: "super_admin",
        accountCreatedAt: "2026-01-01T00:00:00.000Z",
        mfaConfirmedAt: "2026-02-01T00:00:00.000Z",
        unusedRecoveryCodes: 10,
        activeSessions: 1,
        staleSessions: 0,
        lastAuditAction: "admin.role_set",
        lastAuditAt: "2026-10-03T12:00:00.000Z",
      } satisfies AdminFacts,
      now,
    );
    expect(enrolled.mfaEnrolled).toBe(true);
    // 2026-01-01T00:00 → 2026-10-06T12:00 = 278 ngày 12 giờ (floor).
    expect(enrolled.accountAgeDays).toBe(278);

    const notEnrolled = toAdminAccessRow(
      {
        userId: "u2",
        adminRole: "support",
        accountCreatedAt: "2026-09-30T00:00:00.000Z",
        mfaConfirmedAt: null,
        unusedRecoveryCodes: 0,
        activeSessions: 0,
        staleSessions: 0,
        lastAuditAction: null,
        lastAuditAt: null,
      } satisfies AdminFacts,
      now,
    );
    expect(notEnrolled.mfaEnrolled).toBe(false);
    expect(notEnrolled.lastAdminAuditAction).toBeNull();
  });

  it("lastAdminAuditAction = tên action + tuổi tương đối; chưa có audit → null", () => {
    const base = {
      userId: "u3",
      adminRole: "moderator",
      accountCreatedAt: "2026-09-01T00:00:00.000Z",
      mfaConfirmedAt: "2026-09-01T00:00:00.000Z",
      unusedRecoveryCodes: 10,
      activeSessions: 0,
      staleSessions: 0,
    } satisfies Omit<AdminFacts, "lastAuditAction" | "lastAuditAt">;

    expect(toAdminAccessRow({ ...base, lastAuditAction: "admin.step_up", lastAuditAt: "2026-10-06T11:30:00.000Z" }, now).lastAdminAuditAction).toBe("admin.step_up (30 phút trước)");
    expect(toAdminAccessRow({ ...base, lastAuditAction: "admin.role_set", lastAuditAt: "2026-10-06T09:00:00.000Z" }, now).lastAdminAuditAction).toBe("admin.role_set (3 giờ trước)");
    expect(toAdminAccessRow({ ...base, lastAuditAction: "admin.mfa_reset", lastAuditAt: "2026-10-03T12:00:00.000Z" }, now).lastAdminAuditAction).toBe("admin.mfa_reset (3 ngày trước)");
    expect(toAdminAccessRow({ ...base, lastAuditAction: null, lastAuditAt: null }, now).lastAdminAuditAction).toBeNull();
  });
});

// ─── Source contract — drift + import + read-only (Global Constraints Batch 8) ─

describe("scripts/admin-access-review.ts — hợp đồng nguồn", () => {
  const script = read("scripts/admin-access-review.ts");

  it("ADMIN_SESSION_TTL_HOURS bản địa KHÔNG drift khỏi src/lib/session.ts (server-only — script không import được)", () => {
    const sessionSrc = read("src/lib/session.ts");
    const sessionMatch = sessionSrc.match(/ADMIN_SESSION_TTL_HOURS\s*=\s*(\d+)/);
    expect(sessionMatch, "src/lib/session.ts phải còn khai báo ADMIN_SESSION_TTL_HOURS").toBeTruthy();
    expect(ADMIN_SESSION_TTL_HOURS).toBe(Number(sessionMatch![1]));
  });

  it("KHÔNG import module server-only (tsx không nạp được — otp/env/observability/financial-features/session)", () => {
    // Global Constraints Batch 8: script offline import ĐƯỢC plain module
    // (admin-roles) nhưng KHÔNG được import các module có "server-only".
    const forbidden = [
      "src/lib/otp",
      "src/lib/env",
      "src/lib/observability",
      "src/lib/financial-features",
      "src/lib/session",
      "src/lib/rbac",
      "src/lib/audit-event",
    ];
    for (const mod of forbidden) {
      expect(script, `script không được import ${mod}`).not.toMatch(
        new RegExp(`from\\s+["'][^"']*${mod.replace(/\//g, "\\/")}["']`),
      );
    }
  });

  it("READ-ONLY — không có mutation ORM nào trong script (§5.1.1: review không mutate)", () => {
    expect(script).not.toMatch(/\.(updateAll|upsert)\(/);
    expect(script).not.toMatch(/\.\s*create\(/);
    expect(script).not.toMatch(/\.\s*delete\(/);
    expect(script).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  });

  it("import được plain module chia sẻ (admin-roles) — role list là nguồn duy nhất", () => {
    expect(script).toMatch(/admin-roles/);
  });
});
