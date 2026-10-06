/**
 * Monitoring + ops alerts — hợp đồng decision logic của scripts/ops-alerts.ts
 * (Batch 8 Task 5 — spec §9 Batch 8 "monitoring exists", §12 "monitoring exists";
 * §4.8 KHÔNG PII trong alert; §5.1.1 posture offline maintenance command).
 *
 * Toàn bộ hàm evaluate* là PURE (fixture vào → Alert[] ra) — không db mock.
 * Các case pin theo plan Task 5 Step 1 + Review Focus 3 (no PII) + Review
 * Focus 4 (finance-boundary watermark) + Global Constraints (drift test
 * FINANCE_TABLES ⊆ contract, OTP_MAX_ATTEMPTS duplicate có drift test).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_THRESHOLDS,
  FINANCE_TABLES,
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
  it("không gọi được health (null) → CRITICAL", () => {
    const alerts = evaluateHealth(null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("health");
  });

  it("ok: false (db down) → CRITICAL", () => {
    const alerts = evaluateHealth({ ok: false, db: "down" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("health");
  });

  it("ok: true → INFO (dòng evidence mỗi lần chạy)", () => {
    const alerts = evaluateHealth({ ok: true, db: "up" });
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

// ─── 4. Finance boundary — pg_stat_user_tables watermark (Review Focus 4) ────

const zero = { inserts: 0, updates: 0, deletes: 0 };

describe("evaluateFinanceBoundary — tuple-counter delta khi FINANCIAL_FEATURES_ENABLED=false", () => {
  it("BẤT KỲ delta > 0 trên BẤT KỲ finance table nào khi disabled → CRITICAL kèm tên table", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 2, updates: 0, deletes: 0 }, Payment: zero },
      rowCounts: { Order: 5, Payment: 0 },
      watermark: { Order: zero, Payment: zero },
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
    expect(alerts[0]!.signal).toBe("finance-boundary-violation");
    expect(alerts[0]!.detail.table).toBe("Order");
    expect(alerts[0]!.detail).toMatchObject({ inserts: 2, rowCount: 5 });
  });

  it("delta = 0 trên mọi table → không alert", () => {
    expect(
      evaluateFinanceBoundary({
        tableDeltas: { Order: zero, Payment: zero },
        rowCounts: { Order: 0, Payment: 0 },
        watermark: { Order: zero, Payment: zero },
        financialFeaturesEnabled: false,
      }),
    ).toEqual([]);
  });

  it("lần đầu (watermark null) → baseline INFO, KHÔNG CRITICAL dù có delta", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 99, updates: 0, deletes: 0 } },
      rowCounts: { Order: 99 },
      watermark: null,
      financialFeaturesEnabled: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("INFO");
    expect(alerts[0]!.signal).toBe("finance-boundary-baseline");
    expect(alerts.some((a) => a.severity === "CRITICAL")).toBe(false);
  });

  it("counter GIẢM (stats_reset / PG restart) → re-baseline INFO, không CRITICAL giả", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: -50, updates: 0, deletes: 0 }, Payment: zero },
      rowCounts: { Order: 0, Payment: 0 },
      watermark: { Order: { inserts: 50, updates: 0, deletes: 0 }, Payment: zero },
      financialFeaturesEnabled: false,
    });
    expect(alerts.some((a) => a.severity === "CRITICAL")).toBe(false);
    const rebaseline = alerts.find((a) => a.signal === "finance-boundary-rebaseline");
    expect(rebaseline).toBeDefined();
    expect(rebaseline!.severity).toBe("INFO");
    expect(rebaseline!.detail.table).toBe("Order");
  });

  it("enabled === true → INFO (hoạt động hợp lệ), KHÔNG CRITICAL — alert là beta-specific", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 3, updates: 1, deletes: 0 } },
      rowCounts: { Order: 3 },
      watermark: { Order: zero },
      financialFeaturesEnabled: true,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("INFO");
    expect(alerts[0]!.signal).toBe("finance-boundary-activity");
  });

  it("nhiều table vi phạm → một CRITICAL cho từng table (mỗi dòng nêu đúng tên)", () => {
    const alerts = evaluateFinanceBoundary({
      tableDeltas: {
        Order: { inserts: 1, updates: 0, deletes: 0 },
        LedgerEntry: { inserts: 0, updates: 0, deletes: 1 },
      },
      rowCounts: { Order: 1, LedgerEntry: 4 },
      watermark: { Order: zero, LedgerEntry: zero },
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

// ─── 5. Backup freshness + cron liveness ──────────────────────────────────────

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

describe("evaluateCron — cron log freshness", () => {
  it("không có dòng log nào (chưa cài cron) → WARN", () => {
    const alerts = evaluateCron(null, 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.signal).toBe("cron-liveness");
  });

  it("log cũ hơn maxAge → WARN", () => {
    const alerts = evaluateCron(2, 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("WARN");
    expect(alerts[0]!.detail).toMatchObject({ ageHours: 2, maxAgeHours: 1 });
  });

  it("log tươi → không alert", () => {
    expect(evaluateCron(0.2, 1)).toEqual([]);
  });
});

// ─── 6. formatAlertLine — JSON 1 dòng, captureEvent-shape, KHÔNG PII ──────────

describe("formatAlertLine — JSON 1 dòng qua PII shape scan (Review Focus 3)", () => {
  /** Bộ alert đại diện mọi signal + severity — quét shape PII trên từng dòng. */
  const fixtureAlerts: Alert[] = [
    ...evaluateHealth(null),
    ...evaluateHealth({ ok: true, db: "up" }),
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
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: -5, updates: 0, deletes: 0 } },
      rowCounts: { Order: 0 },
      watermark: { Order: { inserts: 5, updates: 0, deletes: 0 } },
      financialFeaturesEnabled: false,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: { Order: { inserts: 1, updates: 0, deletes: 0 } },
      rowCounts: { Order: 1 },
      watermark: { Order: zero },
      financialFeaturesEnabled: true,
    }),
    ...evaluateFinanceBoundary({
      tableDeltas: {},
      rowCounts: {},
      watermark: null,
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

  it("monitoring-signals.md ghi FD-R35 cho ngưỡng + tín hiệu finance-boundary", () => {
    const doc = read("docs/operations/monitoring-signals.md");
    expect(doc).toContain("FD-R35");
    expect(doc).toContain("finance-boundary");
    expect(doc).toContain("pg_stat_user_tables");
  });
});

// ─── 8. Drift test — FINANCE_TABLES ⊆ contract + OTP_MAX_ATTEMPTS ─────────────

describe("drift test — hằng số duplicate khớp contract/otp.ts (Global Constraints)", () => {
  it("FINANCE_TABLES ⊆ model trong src/prisma/contract.prisma", () => {
    const contract = read("src/prisma/contract.prisma");
    const models = new Set([...contract.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
    for (const table of FINANCE_TABLES) {
      expect(models.has(table), `FINANCE_TABLES có "${table}" nhưng contract không có model đó`).toBe(true);
    }
  });

  it("các finance model chủ chốt đều trong FINANCE_TABLES (list không bị cắt lén)", () => {
    const keyFinanceModels = [
      "Order", "OrderItem", "Payment", "Payout", "WithdrawRequest", "LedgerEntry",
      "Dispute", "CartItem", "Offer", "ExchangeOffer", "PlatformSetting", "PriceHistory",
    ];
    for (const model of keyFinanceModels) {
      expect(FINANCE_TABLES).toContain(model);
    }
  });

  it("OTP_MAX_ATTEMPTS khớp src/lib/otp.ts (server-only — tsx không import được)", () => {
    const otpSrc = read("src/lib/otp.ts");
    const match = otpSrc.match(/export const OTP_MAX_ATTEMPTS = (\d+)/);
    expect(match).not.toBeNull();
    expect(OTP_MAX_ATTEMPTS).toBe(Number(match![1]));
  });
});

// ─── 9. Watermark state file round-trips (Review Focus 4) ─────────────────────

describe("state file backups/.ops-alerts-state.json — encode/decode round-trip", () => {
  const state: OpsAlertsState = {
    version: 1,
    savedAt: "2026-10-06T00:00:00.000Z",
    financeCounters: {
      Order: { inserts: 12, updates: 3, deletes: 1 },
      Payment: { inserts: 0, updates: 0, deletes: 0 },
    },
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

  it("file rác / sai shape → null (re-baseline, không CRITICAL giả)", () => {
    expect(decodeState("not json at all")).toBeNull();
    expect(decodeState("{}")).toBeNull();
    expect(decodeState(JSON.stringify({ version: 2, savedAt: "x", financeCounters: {} }))).toBeNull();
    expect(
      decodeState(
        JSON.stringify({
          version: 1,
          savedAt: "2026-10-06T00:00:00.000Z",
          financeCounters: { Order: { inserts: "not-a-number", updates: 0, deletes: 0 } },
        }),
      ),
    ).toBeNull();
  });
});
