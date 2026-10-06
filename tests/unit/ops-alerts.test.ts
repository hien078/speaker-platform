/**
 * Monitoring + ops alerts — hợp đồng decision logic của scripts/ops-alerts.ts
 * (Batch 8 Task 5 — spec §9 Batch 8 "monitoring exists", §12 "monitoring exists";
 * §4.8 KHÔNG PII trong alert; §5.1.1 posture offline maintenance command).
 *
 * Toàn bộ hàm evaluate* là PURE (fixture vào → Alert[] ra) — không db mock.
 * Các case pin theo plan Task 5 Step 1 + Review Focus 3 (no PII) + Review
 * Focus 4 (finance-boundary watermark) + Global Constraints (drift test
 * FINANCE_TABLES ⊆ contract, OTP_MAX_ATTEMPTS duplicate có drift test).
 *
 * Review fix (commit "fix(ops): accurate finance-boundary signals"):
 * - Phân loại table theo WRITER THẬT (grep từng bảng): finance-only (CRITICAL
 *   mọi ins/upd/del) / cascade-affected (CRITICAL ins/upd, delete WARN —
 *   deleteListingAction xoá CartItem trực tiếp + FK Cascade xoá Offer/
 *   ExchangeOffer) / non-finance (PriceHistory — createListingAction/
 *   updateListingAction/mergeModelAction KHÔNG guard; Cart — registerAction/
 *   finishLogin; Review — submitReviewAction không guard, finding cho Task 8).
 * - TRUNCATE vô hình với n_tup_* → so row count trong state file (v2).
 * - State file hỏng / counter giảm (stats reset) ở lần KHÔNG phải đầu → WARN.
 * - Health 503 phân biệt với unreachable (httpStatus trong detail).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CASCADE_AFFECTED_TABLES,
  DEFAULT_THRESHOLDS,
  FINANCE_ONLY_TABLES,
  FINANCE_TABLES,
  NON_FINANCE_TABLES,
  OTP_MAX_ATTEMPTS,
  THRESHOLDS_PROPOSED_MARKER,
  computeTableDeltas,
  decodeState,
  encodeState,
  evaluateAuthAbuse,
  evaluateBackupFreshness,
  evaluateCron,
  evaluateErrorRate,
  evaluateFinanceBoundary,
  evaluateHealth,
  formatAlertLine,
  type Alert,
  type FinanceCounters,
  type OpsAlertsState,
} from "@/scripts/ops-alerts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── 1. Health (/api/health) ─────────────────────────────────────────────────

describe("evaluateHealth — /api/health", () => {
  it("không gọi được health (null — network/unreachable) → CRITICAL reason unreachable", () => {
    const alerts = evaluateHealth(null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("health");
    expect(alerts[0]!.detail.reason).toBe("unreachable");
  });

  it("endpoint trả 503 + ok:false (db down) → CRITICAL, phân biệt httpStatus", () => {
    const alerts = evaluateHealth({ ok: false, db: "down", httpStatus: 503 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("health");
    expect(alerts[0]!.detail).toMatchObject({ db: "down", httpStatus: 503 });
  });

  it("ok: true → INFO (dòng evidence mỗi lần chạy)", () => {
    const alerts = evaluateHealth({ ok: true, db: "up", httpStatus: 200 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("INFO");
    expect(alerts[0]!.signal).toBe("health");
  });
});

// ─── 2. Error rate (captureError JSON lines trong window) ─────────────────────

describe("evaluateErrorRate — captureError lines trong window", () => {
  it("trên ngưỡng → WARN kèm count/window/threshold", () => {
    const alerts = evaluateErrorRate(25, 15, 20);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.signal).toBe("error-rate");
    expect(alerts[0]!.detail).toMatchObject({ count: 25, windowMinutes: 15, threshold: 20 });
  });

  it("đúng ngưỡng / dưới ngưỡng → không alert", () => {
    expect(evaluateErrorRate(20, 15, 20)).toEqual([]);
    expect(evaluateErrorRate(0, 15, 20)).toEqual([]);
  });
});

// ─── 3. Auth abuse (AuditEvent + OtpCode counts — best-available) ─────────────

const AUTH_THRESHOLDS = {
  recoveryRequestedMax: 10,
  mfaRecoveryCodeUsedMax: 2,
  mfaFailedMax: 5,
  otpMaxAttemptsRowsMax: 5,
} as const;

describe("evaluateAuthAbuse — AuditEvent/OtpCode counts trong window", () => {
  it("mỗi count vượt ngưỡng → WARN riêng từng signal", () => {
    expect(evaluateAuthAbuse({ recoveryRequested: 11, mfaRecoveryCodeUsed: 0, mfaFailed: 0, otpMaxAttempts: 0 }, AUTH_THRESHOLDS))
      .toEqual([expect.objectContaining({ severity: "WARN", signal: "auth-abuse-recovery-requests" })]);
    expect(evaluateAuthAbuse({ recoveryRequested: 0, mfaRecoveryCodeUsed: 3, mfaFailed: 0, otpMaxAttempts: 0 }, AUTH_THRESHOLDS))
      .toEqual([expect.objectContaining({ severity: "WARN", signal: "auth-abuse-mfa-recovery-code" })]);
    expect(evaluateAuthAbuse({ recoveryRequested: 0, mfaRecoveryCodeUsed: 0, mfaFailed: 6, otpMaxAttempts: 0 }, AUTH_THRESHOLDS))
      .toEqual([expect.objectContaining({ severity: "WARN", signal: "auth-abuse-mfa-failed" })]);
    expect(evaluateAuthAbuse({ recoveryRequested: 0, mfaRecoveryCodeUsed: 0, mfaFailed: 0, otpMaxAttempts: 6 }, AUTH_THRESHOLDS))
      .toEqual([expect.objectContaining({ severity: "WARN", signal: "auth-abuse-otp-max-attempts" })]);
  });

  it("mã khôi phục MFA được dùng > 0 (dưới ngưỡng) → INFO — mỗi lần dùng đều đáng chú ý", () => {
    const alerts = evaluateAuthAbuse({ recoveryRequested: 0, mfaRecoveryCodeUsed: 1, mfaFailed: 0, otpMaxAttempts: 0 }, AUTH_THRESHOLDS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("INFO");
    expect(alerts[0]!.signal).toBe("auth-abuse-mfa-recovery-code");
  });

  it("mọi count dưới ngưỡng, không dùng mã khôi phục → không alert", () => {
    expect(
      evaluateAuthAbuse({ recoveryRequested: 3, mfaRecoveryCodeUsed: 0, mfaFailed: 2, otpMaxAttempts: 1 }, AUTH_THRESHOLDS),
    ).toEqual([]);
  });

  it("nhiều count vượt cùng lúc → đủ WARN cho từng signal", () => {
    const alerts = evaluateAuthAbuse({ recoveryRequested: 20, mfaRecoveryCodeUsed: 9, mfaFailed: 9, otpMaxAttempts: 9 }, AUTH_THRESHOLDS);
    expect(alerts).toHaveLength(4);
    expect(alerts.every((a) => a.severity === "WARN")).toBe(true);
  });
});

// ─── 4. Finance boundary — pg_stat watermark + phân loại writer (Review Focus 4) ─

const zero = { inserts: 0, updates: 0, deletes: 0 };

describe("evaluateFinanceBoundary — phân loại theo writer THẬT của từng table", () => {
  it("finance-only table: BẤT KỲ delta > 0 khi disabled → CRITICAL kèm tên table", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 2, updates: 0, deletes: 0 }, Payment: zero },
      rowCounts: { Order: 5, Payment: 0 },
      watermark: { Order: zero, Payment: zero },
      previousRowCounts: { Order: 3, Payment: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("finance-boundary-violation");
    expect(alerts[0]!.detail.table).toBe("Order");
    expect(alerts[0]!.detail).toMatchObject({ inserts: 2, rowCount: 5 });
  });

  it("delta = 0 và row count không đổi → không alert", () => {
    expect(
      evaluateFinanceBoundary({
        tableDeltas: { Order: zero, Payment: zero },
        rowCounts: { Order: 3, Payment: 0 },
        watermark: { Order: zero, Payment: zero },
        previousRowCounts: { Order: 3, Payment: 0 },
        watermarkCorrupt: false,
        financialFeaturesEnabled: false,
      }),
    ).toEqual([]);
  });

  it("lần đầu (chưa có file state) → baseline INFO, KHÔNG CRITICAL dù có delta", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 99, updates: 0, deletes: 0 } },
      rowCounts: { Order: 99 },
      watermark: null,
      previousRowCounts: null,
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("INFO");
    expect(alerts[0]!.signal).toBe("finance-boundary-baseline");
    expect(alerts.some((a) => a.severity === "CRITICAL")).toBe(false);
  });

  it("state file TỒN TẠI nhưng hỏng (lần không phải đầu) → re-baseline WARN, không CRITICAL giả", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: {},
      rowCounts: {},
      watermark: null,
      previousRowCounts: null,
      watermarkCorrupt: true,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.signal).toBe("finance-boundary-rebaseline");
    expect(alerts[0]!.detail.reason).toBe("state-file-corrupt");
    expect(alerts.some((a) => a.severity === "CRITICAL")).toBe(false);
  });

  it("counter GIẢM (stats_reset / PG restart) → re-baseline WARN, không CRITICAL giả", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: -50, updates: 0, deletes: 0 }, Payment: zero },
      rowCounts: { Order: 0, Payment: 0 },
      watermark: { Order: { inserts: 50, updates: 0, deletes: 0 }, Payment: zero },
      previousRowCounts: { Order: 0, Payment: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts.some((a) => a.severity === "CRITICAL")).toBe(false);
    const rebaseline = alerts.find((a) => a.signal === "finance-boundary-rebaseline");
    expect(rebaseline).toBeDefined();
    expect(rebaseline!.severity).toBe("WARN");
    expect(rebaseline!.detail.table).toBe("Order");
    expect(rebaseline!.detail.reason).toBe("stats-reset-or-pg-restart");
  });

  it("enabled === true → INFO (hoạt động hợp lệ), KHÔNG CRITICAL — alert là beta-specific", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 3, updates: 1, deletes: 0 } },
      rowCounts: { Order: 3 },
      watermark: { Order: zero },
      previousRowCounts: { Order: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: true,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("INFO");
    expect(alerts[0]!.signal).toBe("finance-boundary-activity");
  });

  it("cascade-affected table (CartItem/Offer/ExchangeOffer): delete delta → WARN (xoá listing cascade), KHÔNG CRITICAL", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { CartItem: { inserts: 0, updates: 0, deletes: 4 }, Offer: zero, ExchangeOffer: zero },
      rowCounts: { CartItem: 0, Offer: 0, ExchangeOffer: 0 },
      watermark: { CartItem: zero, Offer: zero, ExchangeOffer: zero },
      previousRowCounts: { CartItem: 4, Offer: 0, ExchangeOffer: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.signal).toBe("finance-boundary-cascade-delete");
    expect(alerts[0]!.detail.table).toBe("CartItem");
    expect(alerts[0]!.detail.deletes).toBe(4);
    expect(alerts.some((a) => a.severity === "CRITICAL")).toBe(false);
  });

  it("cascade-affected table: insert/update delta khi disabled → VẪN CRITICAL (writer finance-only)", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Offer: { inserts: 1, updates: 0, deletes: 0 } },
      rowCounts: { Offer: 1 },
      watermark: { Offer: zero },
      previousRowCounts: { Offer: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("finance-boundary-violation");
    expect(alerts[0]!.detail.table).toBe("Offer");
  });

  it("TRUNCATE vô hình với n_tup_*: row count đổi + delta = 0 trên finance-only table → CRITICAL", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { LedgerEntry: zero },
      rowCounts: { LedgerEntry: 0 },
      watermark: { LedgerEntry: zero },
      previousRowCounts: { LedgerEntry: 120 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("finance-boundary-violation");
    expect(alerts[0]!.detail.table).toBe("LedgerEntry");
    expect(alerts[0]!.detail).toMatchObject({ reason: "row-count-change", rowCount: 0, previousRowCount: 120 });
  });

  it("row count đổi + delta = 0 trên CASCADE table → WARN (không escalate thành CRITICAL)", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Offer: zero },
      rowCounts: { Offer: 0 },
      watermark: { Offer: zero },
      previousRowCounts: { Offer: 9 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.detail).toMatchObject({ table: "Offer", reason: "row-count-change" });
  });

  it("row count đổi khi finance ĐANG BẬT → không alert (hoạt động hợp lệ)", () => {
    expect(
      evaluateFinanceBoundary({
        tableDeltas: { Order: zero },
        rowCounts: { Order: 10 },
        watermark: { Order: zero },
        previousRowCounts: { Order: 0 },
        watermarkCorrupt: false,
        financialFeaturesEnabled: true,
      }),
    ).toEqual([]);
  });

  it("table mới vào monitored set (chưa có previousRowCount) → bỏ qua so row count, không CRITICAL giả", () => {
    expect(
      evaluateFinanceBoundary({
        tableDeltas: { OrderStatusHistory: zero },
        rowCounts: { OrderStatusHistory: 7 },
        watermark: { OrderStatusHistory: zero },
        previousRowCounts: {},
        watermarkCorrupt: false,
        financialFeaturesEnabled: false,
      }),
    ).toEqual([]);
  });

  it("nhiều table vi phạm → một CRITICAL cho từng table (mỗi dòng nêu đúng tên)", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: {
        Order: { inserts: 1, updates: 0, deletes: 0 },
        LedgerEntry: { inserts: 0, updates: 0, deletes: 1 },
      },
      rowCounts: { Order: 1, LedgerEntry: 4 },
      watermark: { Order: zero, LedgerEntry: zero },
      previousRowCounts: { Order: 0, LedgerEntry: 5 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(2);
    expect(alerts.every((a) => a.severity === "CRITICAL")).toBe(true);
    expect(new Set(alerts.map((a) => a.detail.table))).toEqual(new Set(["Order", "LedgerEntry"]));
  });
});

describe("computeTableDeltas — so watermark KHÔNG bị đảo chiều", () => {
  it("current > watermark → delta dương (violation thấy được)", () => {
    const current: FinanceCounters = { Order: { inserts: 10, updates: 3, deletes: 1 } };
    const watermark: FinanceCounters = { Order: { inserts: 7, updates: 3, deletes: 1 } };
    expect(computeTableDeltas(current, watermark)).toEqual({ Order: { inserts: 3, updates: 0, deletes: 0 } });
  });

  it("table không có trong watermark (finance model mới) → delta 0 — baseline lại, không CRITICAL giả", () => {
    const current: FinanceCounters = { Order: { inserts: 9, updates: 0, deletes: 0 } };
    expect(computeTableDeltas(current, { Payment: zero })).toEqual({ Order: zero });
  });

  it("watermark null → mọi delta 0 (lần đầu chỉ dựng baseline)", () => {
    const current: FinanceCounters = { Order: { inserts: 9, updates: 0, deletes: 0 } };
    expect(computeTableDeltas(current, null)).toEqual({ Order: zero });
  });
});

// ─── 5. Backup freshness + cron liveness (heartbeat) ──────────────────────────

describe("evaluateBackupFreshness — backups/db-*.dump", () => {
  it("không có backup nào → CRITICAL", () => {
    const alerts = evaluateBackupFreshness(null, 26);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("backup-freshness");
  });

  it("backup cũ hơn maxAge → CRITICAL kèm tuổi", () => {
    const alerts = evaluateBackupFreshness(30, 26);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.detail).toMatchObject({ ageHours: 30, maxAgeHours: 26 });
  });

  it("backup tươi → không alert", () => {
    expect(evaluateBackupFreshness(1, 26)).toEqual([]);
  });
});

describe("evaluateCron — heartbeat cron (file do crontab/wrapper touch trước mỗi run)", () => {
  it("không có heartbeat (chưa cài cron) → WARN", () => {
    const alerts = evaluateCron(null, 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.signal).toBe("cron-liveness");
  });

  it("heartbeat cũ hơn maxAge → WARN", () => {
    const alerts = evaluateCron(2, 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.detail).toMatchObject({ ageHours: 2, maxAgeHours: 1 });
  });

  it("heartbeat tươi → không alert", () => {
    expect(evaluateCron(0.2, 1)).toEqual([]);
  });
});

// ─── 6. formatAlertLine — JSON 1 dòng, captureEvent-shape, KHÔNG PII ──────────

describe("formatAlertLine — JSON 1 dòng qua PII shape scan (Review Focus 3)", () => {
  /** Bộ alert đại diện mọi signal + severity — quét shape PII trên từng dòng. */
  const fixtureAlerts: Alert[] = [
    ...evaluateHealth(null),
    ...evaluateHealth({ ok: true, db: "up", httpStatus: 200 }),
    ...evaluateHealth({ ok: false, db: "down", httpStatus: 503 }),
    ...evaluateErrorRate(25, 15, 20),
    ...evaluateAuthAbuse(
      { recoveryRequested: 11, mfaRecoveryCodeUsed: 3, mfaFailed: 6, otpMaxAttempts: 6 },
      AUTH_THRESHOLDS,
    ),
    ...evaluateAuthAbuse({ recoveryRequested: 0, mfaRecoveryCodeUsed: 1, mfaFailed: 0, otpMaxAttempts: 0 }, AUTH_THRESHOLDS),
    ...evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 2, updates: 1, deletes: 3 }, Payment: zero },
      rowCounts: { Order: 12, Payment: 0 },
      watermark: { Order: zero, Payment: zero },
      previousRowCounts: { Order: 6, Payment: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: { CartItem: { inserts: 0, updates: 0, deletes: 2 } },
      rowCounts: { CartItem: 0 },
      watermark: { CartItem: zero },
      previousRowCounts: { CartItem: 2 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: -5, updates: 0, deletes: 0 } },
      rowCounts: { Order: 0 },
      watermark: { Order: { inserts: 5, updates: 0, deletes: 0 } },
      previousRowCounts: { Order: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: {},
      rowCounts: {},
      watermark: null,
      previousRowCounts: null,
      watermarkCorrupt: true,
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: { LedgerEntry: zero },
      rowCounts: { LedgerEntry: 0 },
      watermark: { LedgerEntry: zero },
      previousRowCounts: { LedgerEntry: 40 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 1, updates: 0, deletes: 0 } },
      rowCounts: { Order: 1 },
      watermark: { Order: zero },
      previousRowCounts: { Order: 0 },
      watermarkCorrupt: false,
      financialFeaturesEnabled: true,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: {},
      rowCounts: {},
      watermark: null,
      previousRowCounts: null,
      watermarkCorrupt: false,
      financialFeaturesEnabled: false,
    }),
    ...evaluateBackupFreshness(null, 26),
    ...evaluateBackupFreshness(30, 26),
    ...evaluateCron(null, 1),
    ...evaluateCron(2, 1),
  ];

  it("mỗi alert → 1 dòng JSON parse được, đủ shape captureEvent (ts/level/scope/event)", () => {
    for (const alert of fixtureAlerts) {
      const line = formatAlertLine(alert);
      expect(line).not.toContain("\n");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.ts).toBe("string");
      expect(parsed.scope).toBe("ops-alerts");
      expect(parsed.event).toBe(alert.signal);
      expect(parsed.severity).toBe(alert.severity);
      expect(parsed.detail).toEqual(alert.detail);
    }
  });

  it("severity → level mapping (CRITICAL→error, WARN→warn, INFO→info)", () => {
    const critical = JSON.parse(formatAlertLine({ severity: "CRITICAL", signal: "x", detail: {} })) as { level: string };
    const warn = JSON.parse(formatAlertLine({ severity: "WARN", signal: "x", detail: {} })) as { level: string };
    const info = JSON.parse(formatAlertLine({ severity: "INFO", signal: "x", detail: {} })) as { level: string };
    expect(critical.level).toBe("error");
    expect(warn.level).toBe("warn");
    expect(info.level).toBe("info");
  });

  it("KHÔNG dòng nào chứa shape PII: email / phone VN / mã OTP 6 chữ số (spec §4.8)", () => {
    // Cùng bộ shape với redactDetail (src/lib/audit-event.ts) — over-redaction
    // là hướng an toàn; detail chỉ count/scope/typed-code nên không bao giờ khớp.
    const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    const PHONE_VN_RE = /(?:\+84|0)\d{8,10}/;
    const OTP_RE = /\b\d{6}\b/;
    for (const alert of fixtureAlerts) {
      const line = formatAlertLine(alert);
      expect(EMAIL_RE.test(line), `email shape lọt vào: ${line}`).toBe(false);
      expect(PHONE_VN_RE.test(line), `phone shape lọt vào: ${line}`).toBe(false);
      expect(OTP_RE.test(line), `OTP shape lọt vào: ${line}`).toBe(false);
    }
  });
});

// ─── 7. Thresholds — proposed defaults, founder tunes (FD-R35) ─────────────────

describe("DEFAULT_THRESHOLDS — proposed defaults đánh dấu rõ (FD-R35)", () => {
  it("mang marker proposed + FD-R35", () => {
    expect(DEFAULT_THRESHOLDS.proposed).toBe(THRESHOLDS_PROPOSED_MARKER);
    expect(THRESHOLDS_PROPOSED_MARKER).toContain("PROPOSED");
    expect(THRESHOLDS_PROPOSED_MARKER).toContain("FD-R35");
  });

  it("đủ mọi ngưỡng tín hiệu (mỗi tín hiệu có ngưỡng chỉnh được)", () => {
    expect(DEFAULT_THRESHOLDS.windowMinutes).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.errorLinesMax).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.recoveryRequestedMax).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.mfaRecoveryCodeUsedMax).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.mfaFailedMax).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.otpMaxAttemptsRowsMax).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.backupMaxAgeHours).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.cronLogMaxAgeHours).toBeGreaterThan(0);
  });

  it("monitoring-signals.md ghi FD-R35 + phân loại writer + crontab containerised", () => {
    const doc = read("docs/operations/monitoring-signals.md");
    expect(doc).toContain("FD-R35");
    expect(doc).toContain("finance-boundary");
    expect(doc).toContain("pg_stat_user_tables");
    // Review fix: bảng phân loại writer + runner containerised
    expect(doc).toContain("cascade-affected");
    expect(doc).toContain("OrderStatusHistory");
    expect(doc).toContain("PriceHistory");
    expect(doc).toContain("ops-alerts-cron.sh");
  });
});

// ─── 8. Phân loại table theo writer THẬT — drift test chặn model mới lọt silently ─

describe("phân loại finance table theo writer (grep-verified) — mọi model contract phải được phân loại", () => {
  const contract = read("src/prisma/contract.prisma");
  const contractModels = [...contract.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);

  it("MỌI model trong contract được phân loại đúng MỘT lớp (không bỏ sót — model mới phải được xếp)", () => {
    expect(contractModels.length).toBeGreaterThan(0);
    const classified = new Set<string>([
      ...FINANCE_ONLY_TABLES,
      ...CASCADE_AFFECTED_TABLES,
      ...NON_FINANCE_TABLES,
    ]);
    for (const model of contractModels) {
      expect(classified.has(model), `model "${model}" chưa được phân loại (finance-only/cascade-affected/non-finance)`).toBe(true);
    }
    // ba lớp rời nhau
    for (const t of CASCADE_AFFECTED_TABLES) {
      expect(FINANCE_ONLY_TABLES).not.toContain(t);
      expect(NON_FINANCE_TABLES).not.toContain(t);
    }
    for (const t of FINANCE_ONLY_TABLES) {
      expect(NON_FINANCE_TABLES).not.toContain(t);
    }
  });

  it("FINANCE_TABLES (monitored) = finance-only ∪ cascade-affected — đủ 12 bảng đang theo dõi", () => {
    expect([...FINANCE_TABLES].sort()).toEqual(
      [...[...FINANCE_ONLY_TABLES, ...CASCADE_AFFECTED_TABLES]].sort(),
    );
    expect(FINANCE_TABLES.length).toBe(12);
  });

  it("finance-only: các bảng tiền chủ chốt đều có (writer đều sau assertFinancialFeaturesEnabled)", () => {
    for (const t of [
      "Order", "OrderItem", "Payment", "Payout", "WithdrawRequest",
      "LedgerEntry", "Dispute", "OrderStatusHistory", "PlatformSetting",
    ] as const) {
      expect(FINANCE_ONLY_TABLES).toContain(t);
    }
  });

  it("PriceHistory KHÔNG monitored — writer không guard: createListingAction/updateListingAction/mergeModelAction (review fix 1)", () => {
    // listings.ts:118 create, listings.ts:267 reprice, catalog.ts:39 merge — luồng
    // listing/catalog bình thường → CRITICAL mỗi lần đăng tin = alert fatigue.
    expect(FINANCE_TABLES).not.toContain("PriceHistory");
    expect(NON_FINANCE_TABLES).toContain("PriceHistory");
  });

  it("Cart KHÔNG monitored — writer là registerAction/finishLogin (auth.ts, không finance guard)", () => {
    expect(FINANCE_TABLES).not.toContain("Cart");
    expect(NON_FINANCE_TABLES).toContain("Cart");
  });

  it("Review KHÔNG monitored — submitReviewAction không finance guard (finding cho security review Task 8)", () => {
    expect(FINANCE_TABLES).not.toContain("Review");
    expect(NON_FINANCE_TABLES).toContain("Review");
  });

  it("cascade-affected: CartItem/Offer/ExchangeOffer — ins/upd finance-guard, delete từ deleteListingAction + FK Cascade", () => {
    expect([...CASCADE_AFFECTED_TABLES].sort()).toEqual(["CartItem", "ExchangeOffer", "Offer"]);
  });

  it("OTP_MAX_ATTEMPTS khớp src/lib/otp.ts (server-only — tsx không import được)", () => {
    const otpSrc = read("src/lib/otp.ts");
    const match = otpSrc.match(/export const OTP_MAX_ATTEMPTS = (\d+)/);
    expect(match).not.toBeNull();
    expect(OTP_MAX_ATTEMPTS).toBe(Number(match![1]));
  });
});

// ─── 9. Watermark state file round-trips (Review Focus 4) ─────────────────────

describe("state file backups/.ops-alerts-state.json — encode/decode round-trip (v2 + rowCounts)", () => {
  const state: OpsAlertsState = {
    version: 2,
    savedAt: "2026-10-06T00:00:00.000Z",
    financeCounters: {
      Order: { inserts: 12, updates: 3, deletes: 1 },
      Payment: { inserts: 0, updates: 0, deletes: 0 },
    },
    rowCounts: { Order: 12, Payment: 0 },
  };

  it("decode(encode(state)) === state", () => {
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it("encode ra JSON đọc được (operator inspect được)", () => {
    expect(() => JSON.parse(encodeState(state))).not.toThrow();
  });

  it("raw null (lần đầu — chưa có file) → null → baseline", () => {
    expect(decodeState(null)).toBeNull();
  });

  it("file rác / sai shape / legacy v1 → null (re-baseline WARN, không CRITICAL giả)", () => {
    expect(decodeState("not json at all")).toBeNull();
    expect(decodeState("{}")).toBeNull();
    // state v1 (commit trước — chưa có rowCounts) → đọc không được → re-baseline
    expect(
      decodeState(
        JSON.stringify({ version: 1, savedAt: "2026-10-06T00:00:00.000Z", financeCounters: { Order: { inserts: 1, updates: 0, deletes: 0 } } }),
      ),
    ).toBeNull();
    expect(decodeState(JSON.stringify({ version: 2, savedAt: "x", financeCounters: {} }))).toBeNull();
    expect(
      decodeState(
        JSON.stringify({
          version: 2,
          savedAt: "2026-10-06T00:00:00.000Z",
          financeCounters: { Order: { inserts: "not-a-number", updates: 0, deletes: 0 } },
          rowCounts: { Order: 1 },
        }),
      ),
    ).toBeNull();
    expect(
      decodeState(
        JSON.stringify({
          version: 2,
          savedAt: "2026-10-06T00:00:00.000Z",
          financeCounters: { Order: { inserts: 1, updates: 0, deletes: 0 } },
          rowCounts: { Order: "not-a-number" },
        }),
      ),
    ).toBeNull();
  });
});
