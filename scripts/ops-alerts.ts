/**
 * Monitoring + ops alerts — offline maintenance command (Batch 8 Task 5 —
 * spec §9 Batch 8 "monitoring exists", §12 "monitoring exists"; §5.1.1 posture:
 * KHÔNG expose qua HTTP/admin UI — cron chạy trên server; §4.8 KHÔNG PII).
 *
 * Cách chạy:
 *   npx tsx scripts/ops-alerts.ts            # auto: có DATABASE_URL (env thật) → dev (ORM);
 *                                            # không → docker (cron trên server production)
 *   OPS_ALERTS_MODE=docker|dev              # ép mode rõ ràng
 *
 * Output: các dòng JSON alert (captureEvent-shape — src/lib/observability-core.ts)
 * ra stdout; exit code 0 = không có CRITICAL, 1 = có ít nhất 1 CRITICAL.
 * Kênh phân phát (FD-R37): log lines + exit code — email/Telegram là tích hợp
 * deploy-time qua seam observability, KHÔNG nằm ở đây.
 *
 * DB REACH (production): container db KHÔNG publish port (docker-compose.prod.yml)
 * → mọi query đi qua `docker exec loaviet-db psql -U loaviet -d loaviet -tAc "<SQL>"`
 * (read-only; pattern ops/runtime-readiness de0240f — thứ nặng hơn dùng
 * scripts/db-ops.sh container-on-network). KHÔNG host pg tools, KHÔNG direct
 * connection. FINANCIAL_FEATURES_ENABLED đọc từ CONTAINER APP đang chạy
 * (`docker exec loaviet-app printenv FINANCIAL_FEATURES_ENABLED`) — cấu hình đã
 * deploy, KHÔNG phải env host (env host có thể lệch stack thật).
 *
 * HOST KHÔNG CÓ NODE (docker-only): scripts/ops-alerts-cron.sh — wrapper POSIX
 * chạy 2 tín hiệu cần docker CLI (docker logs / printenv) trên host, phần logic +
 * query DB chạy trong image `migrate` của repo (node:22-alpine + node_modules có
 * tsx — KHÔNG npx fetch runtime) qua compose network, DATABASE_URL có sẵn trong
 * environment service migrate (pattern runbook §0
 * docs/operations/admin-bootstrap-recovery-runbook.md). Xem monitoring-signals.md §0.
 *
 * Dev (không có stack production): cùng bộ SQL fixed chạy qua raw lane của ORM
 * (`db.raw.sql` + `db.runtime().query` — @prisma/orm-postgres) với DATABASE_URL
 * từ MÔI TRƯỜNG THẬT (pattern D4 scripts/admin-bootstrap.ts: yêu cầu DATABASE_URL
 * trong process.env TRƯỚC khi nạp db.client — dotenv chỉ được BỔ SUNG config).
 * IO là MỘT seam (OpsIo) — decision logic pure chạy như nhau ở mọi mode.
 *
 * KHÔNG PII (spec §4.8 + §7.6 — Review Focus 3): alert chỉ mang count/scope/
 * typed-code — KHÔNG user id, email, phone, IP, mã OTP, token, nội dung tin nhắn.
 * Chi tiết tín hiệu + ngưỡng: docs/operations/monitoring-signals.md.
 *
 * Scripts import plain modules ONLY (Global Constraints): KHÔNG import
 * server-only modules (otp.ts / financial-features.ts / env.ts /
 * observability.ts — tsx không nạp được). OTP_MAX_ATTEMPTS là hằng số DUPLICATE
 * CỤC BỘ với drift test (tests/unit/ops-alerts.test.ts assert khớp
 * src/lib/otp.ts). Danh sách table finance được PHÂN LOẠI THEO WRITER THẬT
 * (grep từng bảng — xem FINANCE_ONLY_TABLES/CASCADE_AFFECTED_TABLES/
 * NON_FINANCE_TABLES) và drift test assert MỌI model contract được phân loại.
 *
 * GHI NHẬN MÙ (monitoring-signals.md + security review):
 * - `admin.mfa_failed` (Batch 2 review fix Task 8) CÓ AuditEvent — script theo
 *   dõi được. Login thường bằng mật khẩu SAI KHÔNG có AuditEvent (Batch 2 chỉ
 *   audit hành động thành công) → tín hiệu auth-abuse là best-available từ
 *   AuditEvent + OtpCode; thêm audit failed-login là finding trong security
 *   review (code change ngoài perimeter G3 → plan mới).
 * - Bucket rate-limit in-memory KHÔNG query được cross-process (RR-1).
 * - submitReviewAction (src/lib/actions/reviews.ts) ghi Review cho đơn completed
 *   KHÔNG finance guard — finding cho security review Task 8 (Review classified
 *   non-finance — không monitored).
 *
 * Ngưỡng: DEFAULT_THRESHOLDS — PROPOSED DEFAULTS, founder chỉnh (FD-R35; spec
 * không định mức). Sửa ngưỡng = đổi hằng số, KHÔNG đổi logic (A2).
 *
 * Write duy nhất: backups/.ops-alerts-state.json (watermark pg_stat + row count
 * — gitignored, backups/ đã chặn) — KHÔNG mutation dữ liệu nào, KHÔNG cần --apply.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

// ─── Phân loại table theo writer THẬT (grep-verified — review fix) ────────────

/**
 * FINANCE-ONLY — MỌI writer đều sau assertFinancialFeaturesEnabled() → khi
 * FINANCIAL_FEATURES_ENABLED=false, BẤT KỲ ins/upd/del nào là vi phạm ranh giới
 * Batch 1 (spec §4.1/§4.10) → CRITICAL. Delete chỉ xảy ra qua FK cascade từ
 * xoá Order — không có app flow nào xoá Order.
 *
 * Writer evidence (file:line — xem monitoring-signals.md §2):
 * - Order: orders.ts:24/158/200/237/283/340, offers.ts:21/61, escrow.ts:28,
 *   helpers.ts:67 (processAutoReleases), admin.ts:107 (resolveDispute)
 * - OrderItem: orders.ts:24 (createOrderAction), offers.ts:61 (respondOffer)
 * - Payment: orders.ts:159 (payEscrow), escrow.ts:28, offers.ts:61, admin.ts:107
 * - Payout: orders.ts:284 (confirmReceipt), exchange.ts:150, admin.ts:107
 * - WithdrawRequest: withdraw.ts:25/71
 * - LedgerEntry: ledger.ts:36 (recordLedgerTx — guard ở THÂN thư viện)
 * - Dispute: orders.ts:385 (openDispute), admin.ts:107 (resolveDispute)
 * - OrderStatusHistory: escrow.ts:28 (markEscrowPaid :57),
 *   helpers.ts:36 recordStatusChange (mọi caller: orders/offers/admin — đã guard)
 * - PlatformSetting: admin.ts:204 (updateSettingAction) + seed.ts (dev/test —
 *   seed.ts:16 từ chối chạy ở NODE_ENV=production)
 */
export const FINANCE_ONLY_TABLES = [
  "Order",
  "OrderItem",
  "Payment",
  "Payout",
  "WithdrawRequest",
  "LedgerEntry",
  "Dispute",
  "OrderStatusHistory",
  "PlatformSetting",
] as const;

/**
 * CASCADE-AFFECTED — ins/upd của writer đã finance-guard (CRITICAL khi disabled),
 * NHƯNG delete đến từ luồng xoá listing bình thường (KHÔNG finance guard):
 * deleteListingAction xoá CartItem trực tiếp (listings.ts:294) + FK
 * `onDelete: Cascade` từ Listing (Offer/ExchangeOffer/CartItem — contract) →
 * n_tup_del trên các bảng này là ĐỢI MONG → WARN, không CRITICAL (alert fatigue).
 */
export const CASCADE_AFFECTED_TABLES = ["CartItem", "Offer", "ExchangeOffer"] as const;

/**
 * NON-FINANCE — có writer KHÔNG finance guard (hoặc domain phi tài chính) →
 * KHÔNG monitored (không trong FINANCE_TABLES). Bằng chứng writer chính:
 * - PriceHistory: createListingAction listings.ts:118, updateListingAction
 *   reprice listings.ts:267, mergeModelAction catalog.ts:39 — luồng listing/
 *   catalog bình thường (review fix 1: CRITICAL mỗi lần đăng tin = alert fatigue)
 * - Cart: registerAction auth.ts:122, finishLogin auth.ts:139 — luồng auth
 * - Review: submitReviewAction reviews.ts:21 — KHÔNG finance guard (finding
 *   security review Task 8)
 * - các bảng còn lại: domain identity/catalog/moderation/audit (Batch 2) —
 *   không phải ranh giới tài chính.
 * Drift test assert MỌI model contract nằm đúng một lớp — model mới không thể
 * bị bỏ sót silently.
 */
export const NON_FINANCE_TABLES = [
  "User",
  "Category",
  "Brand",
  "Listing",
  "ListingImage",
  "Cart",
  "Conversation",
  "Message",
  "Review",
  "AdminAuditLog",
  "WishlistItem",
  "ProductModel",
  "PriceHistory",
  "Notification",
  "UserSession",
  "OtpCode",
  "SellerVerification",
  "BetaCohortMembership",
  "PolicyAcceptance",
  "AdminMfa",
  "AdminRecoveryCode",
  "AuditEvent",
  // Batch 3 trust & safety + Batch 4 upload ownership — không FK tới bảng finance
  "AbuseReport",
  "ModerationCase",
  "ModerationEvidence",
  "ModerationAction",
  "UserBlock",
  "UserSuspension",
  "Appeal",
  "ListingImageUpload",
] as const;

/** Monitored set = finance-only ∪ cascade-affected (12 bảng — SQL + watermark). */
export const FINANCE_TABLES = [...FINANCE_ONLY_TABLES, ...CASCADE_AFFECTED_TABLES] as const;

/** Số lần thử OTP tối đa — duplicate src/lib/otp.ts (server-only); drift test pin. */
export const OTP_MAX_ATTEMPTS = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Alert = {
  severity: "CRITICAL" | "WARN" | "INFO";
  signal: string;
  /** CHỈ count/scope/typed-code — KHÔNG PII (spec §4.8). */
  detail: Record<string, number | string>;
};

/** pg_stat_user_tables counters của 1 table (n_tup_ins / n_tup_upd / n_tup_del). */
export type TableCounters = { inserts: number; updates: number; deletes: number };
export type FinanceCounters = Record<string, TableCounters>;

/** AuditEvent + OtpCode counts trong window — best-available (xem mù ở header). */
export type AuthAbuseCounts = {
  /** AuditEvent user.recovery_requested trong window. */
  recoveryRequested: number;
  /** AuditEvent admin.mfa_recovery_code_used trong window. */
  mfaRecoveryCodeUsed: number;
  /** AuditEvent admin.mfa_failed trong window (login/step-up sai mã). */
  mfaFailed: number;
  /** OtpCode rows attempts >= OTP_MAX_ATTEMPTS tạo trong window. */
  otpMaxAttempts: number;
};

export type AuthAbuseThresholds = {
  recoveryRequestedMax: number;
  mfaRecoveryCodeUsedMax: number;
  mfaFailedMax: number;
  otpMaxAttemptsRowsMax: number;
};

export type OpsAlertsThresholds = AuthAbuseThresholds & {
  /** Cửa sổ truy vấn log/audit (phút). */
  windowMinutes: number;
  /** captureError lines tối đa trong window → WARN. */
  errorLinesMax: number;
  /** Tuổi backup tối đa (giờ) → CRITICAL. */
  backupMaxAgeHours: number;
  /** Tuổi heartbeat cron tối đa (giờ) → WARN. */
  cronLogMaxAgeHours: number;
};

/** Marker proposed-defaults — mọi ngưỡng là founder-tunable (FD-R35). */
export const THRESHOLDS_PROPOSED_MARKER =
  "PROPOSED DEFAULTS — FD-R35 (founder chỉnh; spec §9/§12 không định mức)" as const;

export const DEFAULT_THRESHOLDS: OpsAlertsThresholds & {
  proposed: typeof THRESHOLDS_PROPOSED_MARKER;
} = {
  windowMinutes: 15,
  errorLinesMax: 20,
  recoveryRequestedMax: 10,
  mfaRecoveryCodeUsedMax: 2,
  mfaFailedMax: 5,
  otpMaxAttemptsRowsMax: 5,
  backupMaxAgeHours: 26,
  cronLogMaxAgeHours: 1,
  proposed: THRESHOLDS_PROPOSED_MARKER,
};

/** Watermark state — backups/.ops-alerts-state.json (gitignored). v2: + rowCounts. */
export type OpsAlertsState = {
  version: 2;
  savedAt: string;
  financeCounters: FinanceCounters;
  /** Row count mỗi monitored table lần chạy trước — bắt TRUNCATE (vô hình với n_tup_*). */
  rowCounts: Record<string, number>;
};

// ─── Pure decision functions (unit-test trực tiếp — fixture vào, Alert[] ra) ──

/**
 * /api/health — null = không gọi được ở tầng network (CRITICAL reason
 * "unreachable"); endpoint trả lời nhưng ok:false (vd 503 + db down) → CRITICAL
 * kèm httpStatus (phân biệt với unreachable); ok → INFO (dòng evidence mỗi run).
 */
export function evaluateHealth(
  healthJson: { ok: boolean; db?: string; httpStatus?: number } | null,
): Alert[] {
  if (healthJson === null) {
    return [{ severity: "CRITICAL", signal: "health", detail: { reason: "unreachable" } }];
  }
  if (!healthJson.ok || healthJson.db === "down") {
    return [
      {
        severity: "CRITICAL",
        signal: "health",
        detail: {
          db: healthJson.db ?? "unknown",
          ...(healthJson.httpStatus !== undefined ? { httpStatus: healthJson.httpStatus } : {}),
        },
      },
    ];
  }
  return [{ severity: "INFO", signal: "health", detail: { db: healthJson.db ?? "up" } }];
}

/** captureError lines trong window quá ngưỡng → WARN (ngưỡng là hằng số FD-R35). */
export function evaluateErrorRate(
  errorLineCount: number,
  windowMinutes: number,
  threshold: number,
): Alert[] {
  if (errorLineCount > threshold) {
    return [
      {
        severity: "WARN",
        signal: "error-rate",
        detail: { count: errorLineCount, windowMinutes, threshold },
      },
    ];
  }
  return [];
}

/**
 * Auth abuse — best-available từ AuditEvent + OtpCode (xem mù ở header).
 * Mỗi count vượt ngưỡng → WARN; mã khôi phục MFA được dùng > 0 (dưới ngưỡng)
 * → INFO — mỗi lần dùng đều đáng chú ý (FD-R58: 1 mã lộ có thể sinh lại 10 mã).
 */
export function evaluateAuthAbuse(
  counts: AuthAbuseCounts,
  thresholds: AuthAbuseThresholds,
): Alert[] {
  const alerts: Alert[] = [];
  if (counts.recoveryRequested > thresholds.recoveryRequestedMax) {
    alerts.push({
      severity: "WARN",
      signal: "auth-abuse-recovery-requests",
      detail: { count: counts.recoveryRequested, threshold: thresholds.recoveryRequestedMax },
    });
  }
  if (counts.mfaRecoveryCodeUsed > thresholds.mfaRecoveryCodeUsedMax) {
    alerts.push({
      severity: "WARN",
      signal: "auth-abuse-mfa-recovery-code",
      detail: { count: counts.mfaRecoveryCodeUsed, threshold: thresholds.mfaRecoveryCodeUsedMax },
    });
  } else if (counts.mfaRecoveryCodeUsed > 0) {
    alerts.push({
      severity: "INFO",
      signal: "auth-abuse-mfa-recovery-code",
      detail: { count: counts.mfaRecoveryCodeUsed },
    });
  }
  if (counts.mfaFailed > thresholds.mfaFailedMax) {
    alerts.push({
      severity: "WARN",
      signal: "auth-abuse-mfa-failed",
      detail: { count: counts.mfaFailed, threshold: thresholds.mfaFailedMax },
    });
  }
  if (counts.otpMaxAttempts > thresholds.otpMaxAttemptsRowsMax) {
    alerts.push({
      severity: "WARN",
      signal: "auth-abuse-otp-max-attempts",
      detail: { count: counts.otpMaxAttempts, threshold: thresholds.otpMaxAttemptsRowsMax },
    });
  }
  return alerts;
}

const COUNTER_KEYS = ["inserts", "updates", "deletes"] as const;
const isCascadeAffected = (table: string): boolean =>
  (CASCADE_AFFECTED_TABLES as readonly string[]).includes(table);

/**
 * Finance boundary (Review Focus 4) — phân loại theo writer THẬT của từng table:
 *
 * - FINANCE-ONLY (mọi writer đã guard): BẤT KỲ ins/upd/del > 0 khi
 *   FINANCIAL_FEATURES_ENABLED=false → CRITICAL (vi phạm ranh giới Batch 1).
 * - CASCADE-AFFECTED (CartItem/Offer/ExchangeOffer): ins/upd > 0 → CRITICAL
 *   (writer finance-only); delete → WARN — xoá listing bình thường cascade
 *   (deleteListingAction listings.ts:294 + FK Cascade), không CRITICAL giả.
 *
 * TẠI SAO pg_stat_user_tables chứ không phải watermark createdAt/updatedAt (S3):
 * Payment/Payout không có updatedAt (status UPDATE vô hình), CartItem/OrderItem
 * không có timestamp nào, DELETE xoá sạch dấu vết, raw SQL bypass ORM timestamps.
 * pg_stat đếm physical row ins/upd/del BẤT KỂ write path nào — không cần schema
 * change (G2). HAI lỗ hổng còn lại của counters:
 * - TRUNCATE KHÔNG tăng n_tup_* → so thêm ROW COUNT với lần chạy trước (state
 *   file v2) — đổi khi delta = 0 = operation vô hình với counters → CRITICAL
 *   (finance-only) / WARN (cascade).
 * - Counters reset (stats_reset / PG restart) → delta âm → re-baseline WARN
 *   (KHÔNG CRITICAL giả), state file hỏng ở lần KHÔNG phải đầu → WARN tương tự.
 *
 * Finance đang BẬT (sau này, qua reviewed product decision): delta là hoạt động
 * hợp lệ → INFO, không CRITICAL — alert này là beta-specific.
 */
export function evaluateFinanceBoundary(finance: {
  tableDeltas: FinanceCounters;
  rowCounts: Record<string, number>;
  /** Counters lần chạy trước — null = không có baseline hợp lệ để so. */
  watermark: FinanceCounters | null;
  /** Row count lần chạy trước (cùng state file với watermark) — null = lần đầu. */
  previousRowCounts: Record<string, number> | null;
  /** true = file state TỒN TẠI nhưng parse fail (lần không phải đầu) → WARN. */
  watermarkCorrupt: boolean;
  financialFeaturesEnabled: boolean;
}): Alert[] {
  // Không có baseline hợp lệ: lần đầu → INFO baseline; state hỏng → WARN re-baseline
  // (main() truyền delta 0 — guard ở đây để pure function không bao giờ CRITICAL
  // khi không có gì để so).
  if (finance.watermark === null) {
    return [
      finance.watermarkCorrupt
        ? {
            severity: "WARN",
            signal: "finance-boundary-rebaseline",
            detail: { reason: "state-file-corrupt" },
          }
        : {
            severity: "INFO",
            signal: "finance-boundary-baseline",
            detail: { tables: FINANCE_TABLES.length, note: "baseline" },
          },
    ];
  }
  const alerts: Alert[] = [];
  for (const table of FINANCE_TABLES) {
    const delta = finance.tableDeltas[table] ?? { inserts: 0, updates: 0, deletes: 0 };
    const decreased = COUNTER_KEYS.filter((k) => delta[k] < 0);
    const increased = COUNTER_KEYS.filter((k) => delta[k] > 0);

    if (decreased.length > 0) {
      // Counter GIẢM = stats_reset / PG restart → so watermark vô nghĩa → re-baseline
      // WARN (review fix 6 — không phải INFO: monitoring continuity bị đứt).
      alerts.push({
        severity: "WARN",
        signal: "finance-boundary-rebaseline",
        detail: { table, counters: decreased.join(","), reason: "stats-reset-or-pg-restart" },
      });
    }
    if (increased.length > 0) {
      if (finance.financialFeaturesEnabled) {
        // Finance đang BẬT = hoạt động hợp lệ — INFO, KHÔNG CRITICAL (beta-specific).
        alerts.push({
          severity: "INFO",
          signal: "finance-boundary-activity",
          detail: {
            table,
            inserts: delta.inserts,
            updates: delta.updates,
            deletes: delta.deletes,
            rowCount: finance.rowCounts[table] ?? 0,
            note: "finance-enabled",
          },
        });
      } else if (isCascadeAffected(table) && delta.inserts === 0 && delta.updates === 0) {
        // Cascade-affected: CHỈ deletes tăng → xoá listing cascade (deleteListingAction
        // + FK) — đợi mong ở private beta → WARN, không CRITICAL (alert fatigue).
        alerts.push({
          severity: "WARN",
          signal: "finance-boundary-cascade-delete",
          detail: {
            table,
            deletes: delta.deletes,
            rowCount: finance.rowCounts[table] ?? 0,
            reason: "listing-delete-cascade-expected",
          },
        });
      } else {
        // Finance-only (ins/upd/del bất kỳ) hoặc cascade-affected với ins/upd:
        // writer duy nhất là finance flow đã guard → vi phạm ranh giới Batch 1.
        alerts.push({
          severity: "CRITICAL",
          signal: "finance-boundary-violation",
          detail: {
            table,
            inserts: delta.inserts,
            updates: delta.updates,
            deletes: delta.deletes,
            rowCount: finance.rowCounts[table] ?? 0,
          },
        });
      }
      continue;
    }
    // Counters đứng yên — row count catch-all (TRUNCATE + stats lag vô hình với
    // n_tup_*): đổi row count khi delta = 0 = operation counters không thấy.
    if (
      !finance.financialFeaturesEnabled &&
      finance.previousRowCounts !== null &&
      table in finance.previousRowCounts &&
      (finance.rowCounts[table] ?? 0) !== finance.previousRowCounts[table]!
    ) {
      alerts.push(
        isCascadeAffected(table)
          ? {
              severity: "WARN",
              signal: "finance-boundary-cascade-delete",
              detail: {
                table,
                reason: "row-count-change",
                rowCount: finance.rowCounts[table] ?? 0,
                previousRowCount: finance.previousRowCounts[table]!,
              },
            }
          : {
              severity: "CRITICAL",
              signal: "finance-boundary-violation",
              detail: {
                table,
                reason: "row-count-change",
                rowCount: finance.rowCounts[table] ?? 0,
                previousRowCount: finance.previousRowCounts[table]!,
              },
            },
      );
    }
  }
  return alerts;
}

/**
 * Delta counters so watermark — current TRỪ watermark (đảo chiều là bug:
 * Review Focus 4 "comparison inverted"). Table không có trong watermark
 * (finance model mới thêm sau lần chạy trước) → delta 0 — baseline lại ở
 * lần chạy này, không CRITICAL giả.
 */
export function computeTableDeltas(
  current: FinanceCounters,
  watermark: FinanceCounters | null,
): FinanceCounters {
  const deltas: FinanceCounters = {};
  for (const [table, counters] of Object.entries(current)) {
    const prev = watermark?.[table];
    deltas[table] =
      prev === undefined
        ? { inserts: 0, updates: 0, deletes: 0 }
        : {
            inserts: counters.inserts - prev.inserts,
            updates: counters.updates - prev.updates,
            deletes: counters.deletes - prev.deletes,
          };
  }
  return deltas;
}

/** Backup freshness — không có backup nào → CRITICAL; cũ hơn maxAge → CRITICAL. */
export function evaluateBackupFreshness(
  newestBackupAgeHours: number | null,
  maxAgeHours: number,
): Alert[] {
  if (newestBackupAgeHours === null) {
    return [{ severity: "CRITICAL", signal: "backup-freshness", detail: { backups: 0 } }];
  }
  if (newestBackupAgeHours > maxAgeHours) {
    return [
      {
        severity: "CRITICAL",
        signal: "backup-freshness",
        detail: { ageHours: newestBackupAgeHours, maxAgeHours },
      },
    ];
  }
  return [];
}

/**
 * Cron liveness — heartbeat (file do crontab/wrapper `touch` TRƯỚC mỗi lần chạy)
 * không tươi → WARN. Heartbeat chứng minh CRON ĐANG CHẠY (cron entry còn + daemon
 * sống), KHÔNG chứng minh script thành công — crash của script thấy qua thiếu
 * dòng `ops-alerts-run` + stderr trong log (giới hạn ghi nhận monitoring-signals.md).
 */
export function evaluateCron(
  lastCronLogAgeHours: number | null,
  maxAgeHours: number,
): Alert[] {
  if (lastCronLogAgeHours === null) {
    return [{ severity: "WARN", signal: "cron-liveness", detail: { heartbeat: "missing" } }];
  }
  if (lastCronLogAgeHours > maxAgeHours) {
    return [
      {
        severity: "WARN",
        signal: "cron-liveness",
        detail: { ageHours: lastCronLogAgeHours, maxAgeHours },
      },
    ];
  }
  return [];
}

/** Alert → 1 dòng JSON captureEvent-shape (ts/level/scope/event) — qua PII shape scan. */
export function formatAlertLine(alert: Alert): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level:
      alert.severity === "CRITICAL" ? "error" : alert.severity === "WARN" ? "warn" : "info",
    scope: "ops-alerts",
    event: alert.signal,
    severity: alert.severity,
    detail: alert.detail,
  });
}

// ─── Watermark state file — encode/decode pure (round-trip test) ──────────────

export function encodeState(state: OpsAlertsState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Parse state file → null khi: chưa có file (lần đầu → baseline), file rác,
 * sai shape/version (kể cả legacy v1 — thiếu rowCounts) → re-baseline WARN,
 * KHÔNG CRITICAL giả từ state hỏng.
 */
export function decodeState(raw: string | null): OpsAlertsState | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OpsAlertsState;
    if (parsed?.version !== 2) return null;
    if (typeof parsed?.savedAt !== "string") return null;
    if (parsed?.financeCounters === null || typeof parsed?.financeCounters !== "object") {
      return null;
    }
    if (parsed?.rowCounts === null || typeof parsed?.rowCounts !== "object") {
      return null;
    }
    for (const counters of Object.values(parsed.financeCounters)) {
      if (
        counters === null ||
        typeof counters !== "object" ||
        !Number.isInteger(counters.inserts) ||
        !Number.isInteger(counters.updates) ||
        !Number.isInteger(counters.deletes) ||
        counters.inserts < 0 ||
        counters.updates < 0 ||
        counters.deletes < 0
      ) {
        return null;
      }
    }
    for (const count of Object.values(parsed.rowCounts)) {
      if (!Number.isInteger(count) || count < 0) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─── SQL fixed (docker + dev dùng chung — KHÔNG interpolation input người dùng) ─

const quotedMonitoredNames = FINANCE_TABLES.map((t) => `'${t}'`).join(", ");

const SQL_PG_STAT = `SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname IN (${quotedMonitoredNames})`;

const SQL_FINANCE_ROW_COUNTS = FINANCE_TABLES.map(
  (t, i) => `${i === 0 ? "" : " UNION ALL "}SELECT '${t}' AS t, count(*) AS c FROM "${t}"`,
).join("");

/** windowMinutes là HẰNG SỐ ngưỡng (validated integer) — không phải input người dùng. */
function sqlInterval(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`OPS_ALERTS_INVALID_WINDOW: windowMinutes phải là số nguyên > 0 (nhận ${minutes})`);
  }
  return `interval '${minutes} minutes'`;
}

const SQL_AUTH_ABUSE = (windowMinutes: number) =>
  `SELECT action, count(*) AS c FROM "AuditEvent" WHERE action IN ('user.recovery_requested','admin.mfa_recovery_code_used','admin.mfa_failed') AND "createdAt" >= now() - ${sqlInterval(windowMinutes)} GROUP BY action`;

const SQL_OTP_MAX_ATTEMPTS = (windowMinutes: number) =>
  `SELECT count(*) AS c FROM "OtpCode" WHERE attempts >= ${OTP_MAX_ATTEMPTS} AND "createdAt" >= now() - ${sqlInterval(windowMinutes)}`;

// ─── Parse kết quả query (dùng chung 2 mode — psql string[][] / ORM typed rows) ─

function parsePgStat(rows: string[][]): FinanceCounters {
  const counters: FinanceCounters = {};
  for (const table of FINANCE_TABLES) counters[table] = { inserts: 0, updates: 0, deletes: 0 };
  for (const [relname, ins, upd, del] of rows) {
    if (relname && relname in counters) {
      counters[relname] = { inserts: Number(ins), updates: Number(upd), deletes: Number(del) };
    }
  }
  return counters;
}

function parseRowCounts(rows: string[][]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of FINANCE_TABLES) counts[table] = 0;
  for (const [t, c] of rows) {
    if (t && t in counts) counts[t] = Number(c);
  }
  return counts;
}

function parseAuthAbuse(rows: string[][]): AuthAbuseCounts {
  const counts: AuthAbuseCounts = {
    recoveryRequested: 0,
    mfaRecoveryCodeUsed: 0,
    mfaFailed: 0,
    otpMaxAttempts: 0,
  };
  for (const [action, c] of rows) {
    if (action === "user.recovery_requested") counts.recoveryRequested = Number(c);
    else if (action === "admin.mfa_recovery_code_used") counts.mfaRecoveryCodeUsed = Number(c);
    else if (action === "admin.mfa_failed") counts.mfaFailed = Number(c);
  }
  return counts;
}

/** Query count(*) đơn giá — dòng đầu, cột đầu (0 khi không có dòng). */
function parseSingleCount(rows: string[][]): number {
  return Number(rows[0]?.[0] ?? 0);
}

// ─── IO seam — MỘT interface, 2 triển khai (docker production / dev ORM) ──────

type HealthJson = { ok: boolean; db?: string; httpStatus?: number } | null;

type OpsIo = {
  mode: "docker" | "dev";
  /** /api/health — null = không gọi được ở tầng network; httpStatus phân biệt 503. */
  readHealth(): Promise<HealthJson>;
  /** captureError JSON lines trong window (docker logs app / env wrapper inject). */
  readErrorLineCount(windowMinutes: number): Promise<number>;
  readAuthAbuseCounts(windowMinutes: number): Promise<AuthAbuseCounts>;
  readFinanceCounters(): Promise<FinanceCounters>;
  readFinanceRowCounts(): Promise<Record<string, number>>;
  /** Từ cấu hình ĐÃ DEPLOY (docker mode: printenv container app; dev: env thật). */
  readFinancialFeaturesEnabled(): Promise<boolean>;
};

/** Chạy lệnh, bắt cả stdout+stderr (docker logs tách stream), throw khi exit ≠ 0. */
function runCapture(command: string, args: string[]): { stdout: string; stderr: string } {
  // maxBuffer 16MB + --tail (caller) — docker logs 15 phút của app bận có thể
  // vượt 1MB mặc định → ENOBUFS giết lệnh → WARN io-failed giả (review fix 7).
  const res = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `OPS_ALERTS_IO: ${command} ${args[0] ?? ""}… thoát ${res.status}: ${String(res.stderr).slice(0, 200)}`,
    );
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** psql -tAc → rows pipe-separated (count luôn là số; relname là tên table fixed). */
function psqlRows(out: string): string[][] {
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("|"));
}

async function fetchHealth(url: string): Promise<HealthJson> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    // Endpoint trả lời (kể cả 503) ≠ unreachable — parse body JSON, giữ httpStatus.
    let body: { ok?: unknown; db?: unknown } = {};
    try {
      body = (await res.json()) as { ok?: unknown; db?: unknown };
    } catch {
      // body không phải JSON (proxy error page…) — vẫn phân biệt qua httpStatus
    }
    if (typeof body.ok !== "boolean") {
      return { ok: false, db: undefined, httpStatus: res.status };
    }
    return {
      ok: body.ok,
      db: typeof body.db === "string" ? body.db : undefined,
      httpStatus: res.status,
    };
  } catch {
    return null; // network/DNS/timeout — không gọi được gì cả
  }
}

// ─── Env-injected overrides (containerised runner — xem ops-alerts-cron.sh) ────

/**
 * Wrapper host-side (scripts/ops-alerts-cron.sh) precompute 2 tín hiệu cần
 * docker CLI (container migrate KHÔNG có docker CLI) rồi inject qua env.
 * Chỉ nhận giá trị đã validate; sai format → bỏ qua → IO nội bộ (fail-closed).
 */
function envInjectedCount(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function envInjectedFlag(name: string): boolean | null {
  const raw = process.env[name];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

// ─── Docker mode (production — db KHÔNG publish port) ─────────────────────────

function makeDockerIo(): OpsIo {
  const dbContainer = process.env.OPS_DB_CONTAINER ?? "loaviet-db";
  const dbUser = process.env.OPS_DB_USER ?? "loaviet";
  const dbName = process.env.OPS_DB_NAME ?? "loaviet";
  const appContainer = process.env.OPS_APP_CONTAINER ?? "loaviet-app";
  const healthUrl = process.env.OPS_ALERTS_HEALTH_URL ?? "http://127.0.0.1:3000/api/health";

  const psql = (sql: string): string[][] =>
    psqlRows(runCapture("docker", ["exec", dbContainer, "psql", "-U", dbUser, "-d", dbName, "-tAc", sql]).stdout);

  return {
    mode: "docker",
    readHealth: () => fetchHealth(healthUrl),
    readErrorLineCount: (windowMinutes) => {
      // captureError ghi stderr của container app → docker logs tách 2 stream — ghép lại.
      // --tail cap output (maxBuffer 16MB ở runCapture — review fix 7).
      const { stdout, stderr } = runCapture("docker", [
        "logs",
        appContainer,
        "--since",
        `${windowMinutes}m`,
        "--tail",
        "50000",
      ]);
      const text = `${stdout}\n${stderr}`;
      return Promise.resolve(text.split("\n").filter((l) => l.includes('"level":"error"')).length);
    },
    readAuthAbuseCounts: (windowMinutes) => {
      // AuditEvent GROUP BY (3 action) + OtpCode count riêng — gộp vào AuthAbuseCounts.
      const counts = parseAuthAbuse(psql(SQL_AUTH_ABUSE(windowMinutes)));
      counts.otpMaxAttempts = parseSingleCount(psql(SQL_OTP_MAX_ATTEMPTS(windowMinutes)));
      return Promise.resolve(counts);
    },
    readFinanceCounters: () => Promise.resolve(parsePgStat(psql(SQL_PG_STAT))),
    readFinanceRowCounts: () => Promise.resolve(parseRowCounts(psql(SQL_FINANCE_ROW_COUNTS))),
    readFinancialFeaturesEnabled: () => {
      // Ưu tiên wrapper inject (containerised runner); không có → đọc từ container app.
      // Strict: chỉ literal "true" mới bật (src/lib/financial-features.ts); đọc
      // không được (container down) → false — fail-closed: boundary check armed.
      const injected = envInjectedFlag("OPS_ALERTS_FINANCIAL_FEATURES_ENABLED");
      if (injected !== null) return Promise.resolve(injected);
      try {
        const { stdout } = runCapture("docker", [
          "exec",
          appContainer,
          "printenv",
          "FINANCIAL_FEATURES_ENABLED",
        ]);
        return Promise.resolve(stdout.trim() === "true");
      } catch {
        return Promise.resolve(false);
      }
    },
  };
}

// ─── Dev mode (ORM raw lane — cùng SQL fixed, DATABASE_URL từ env thật) ────────

/** D4: DATABASE_URL phải có trong env THẬT TRƯỚC khi nạp db.client (dotenv chỉ bổ sung). */
async function loadDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL chưa đặt trong MÔI TRƯỜNG THẬT — chế độ dev cần DB rõ ràng " +
        "(pattern D4 scripts/admin-bootstrap.ts; production chạy docker mode qua docker exec).",
    );
  }
  const { db } = await import("../src/prisma/db.client");
  return db;
}
type Db = Awaited<ReturnType<typeof loadDb>>;
/** Row spec của raw lane — derive từ type thật của db (codec id phải thuộc contract). */
type RawRowSpec = Parameters<ReturnType<Db["raw"]["sql"]>["returnsRow"]>[0];

async function makeDevIo(): Promise<OpsIo> {
  const db = await loadDb();
  const healthUrl = process.env.OPS_ALERTS_HEALTH_URL ?? "http://127.0.0.1:3000/api/health";

  /** SQL fixed → raw lane ORM (db.raw.sql là tag template; SQL là chuỗi fixed không
   *  interpolation nên dựng TemplateStringsArray 1 phần tử — KHÔNG phải input người dùng). */
  const query = async (sql: string, spec: RawRowSpec): Promise<Record<string, unknown>[]> => {
    const plan = db.raw
      .sql({ 0: sql, length: 1, raw: [sql] } as unknown as TemplateStringsArray)
      .returnsRow(spec)
      .build();
    const rows = (await db.runtime().query(plan)) as unknown as Record<string, unknown>[];
    return rows;
  };
  /** int8 decode ra BigInt → Number; text giữ nguyên string. */
  const toRows = (rows: Record<string, unknown>[]): string[][] =>
    rows.map((row) => Object.values(row).map((v) => String(v)));

  return {
    mode: "dev",
    readHealth: () => fetchHealth(healthUrl),
    // Dev/containerised: docker logs không đọc được từ trong container — wrapper
    // host-side đếm rồi inject qua OPS_ALERTS_ERROR_LINES (ops-alerts-cron.sh);
    // không có env (dev thuần) → 0 (tín hiệu production-only, documented).
    readErrorLineCount: () => {
      const injected = envInjectedCount("OPS_ALERTS_ERROR_LINES");
      return Promise.resolve(injected ?? 0);
    },
    readAuthAbuseCounts: async (windowMinutes) => {
      const counts = parseAuthAbuse(
        toRows(await query(SQL_AUTH_ABUSE(windowMinutes), { action: "pg/text@1", c: "pg/int8@1" })),
      );
      counts.otpMaxAttempts = parseSingleCount(
        toRows(await query(SQL_OTP_MAX_ATTEMPTS(windowMinutes), { c: "pg/int8@1" })),
      );
      return counts;
    },
    readFinanceCounters: async () =>
      parsePgStat(
        toRows(
          await query(SQL_PG_STAT, {
            relname: "pg/text@1",
            n_tup_ins: "pg/int8@1",
            n_tup_upd: "pg/int8@1",
            n_tup_del: "pg/int8@1",
          }),
        ),
      ),
    readFinanceRowCounts: async () =>
      parseRowCounts(toRows(await query(SQL_FINANCE_ROW_COUNTS, { t: "pg/text@1", c: "pg/int8@1" }))),
    // Dev: env thật của process (wrapper inject hoặc strict literal "true" —
    // cùng parse financial-features.ts).
    readFinancialFeaturesEnabled: () => {
      const injected = envInjectedFlag("OPS_ALERTS_FINANCIAL_FEATURES_ENABLED");
      return Promise.resolve(injected ?? process.env.FINANCIAL_FEATURES_ENABLED === "true");
    },
  };
}

// ─── Host-side reads (backups/ + heartbeat — như nhau mọi mode) ────────────────

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function stateFilePath(): string {
  return path.join(repoRoot(), "backups", ".ops-alerts-state.json");
}

function readStateFile(): { raw: string | null; existed: boolean } {
  try {
    return { raw: readFileSync(stateFilePath(), "utf8"), existed: true };
  } catch {
    return { raw: null, existed: false }; // chưa có file — lần đầu → baseline
  }
}

function writeStateFile(raw: string): void {
  mkdirSync(path.dirname(stateFilePath()), { recursive: true });
  writeFileSync(stateFilePath(), raw, "utf8");
}

/** Tuổi (giờ) của backup mới nhất backups/db-*.dump — null khi không có bản nào. */
function readNewestBackupAgeHours(): number | null {
  const dir = path.join(repoRoot(), "backups");
  let newestMtime: number | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    // backup-db.sh chỉ đổi tên .partial → .dump khi dump + TOC check xong — .dump là bản tốt.
    if (!/^db-.*\.dump$/.test(name)) continue;
    const mtime = statSync(path.join(dir, name)).mtimeMs;
    if (newestMtime === null || mtime > newestMtime) newestMtime = mtime;
  }
  if (newestMtime === null) return null;
  return (Date.now() - newestMtime) / 3_600_000;
}

/**
 * Tuổi (giờ) của heartbeat cron — file do crontab/wrapper `touch` TRƯỚC mỗi lần
 * chạy (xem monitoring-signals.md §crontab). null khi chưa có (chưa cài cron).
 * Heartbeat = "cron đang chạy" (không phải "script thành công" — xem evaluateCron).
 */
function readHeartbeatAgeHours(): number | null {
  const heartbeatPath =
    process.env.OPS_ALERTS_CRON_HEARTBEAT ?? path.join(repoRoot(), "backups", ".ops-alerts-heartbeat");
  try {
    const mtime = statSync(heartbeatPath).mtimeMs;
    return (Date.now() - mtime) / 3_600_000;
  } catch {
    return null;
  }
}

// ─── main — wiring IO → pure evaluators → alert lines → exit code ─────────────

function resolveMode(): "docker" | "dev" {
  const explicit = process.env.OPS_ALERTS_MODE;
  if (explicit === "docker" || explicit === "dev") return explicit;
  // Auto: env thật có DATABASE_URL → dev (ORM); không → docker (cron trên server).
  return process.env.DATABASE_URL ? "dev" : "docker";
}

/** IO của một tín hiệu lỗi → alert degradation (fail-closed với tín hiệu trọng yếu);
 *  message đầy đủ in ra stderr cho cron log — KHÔNG vào alert line (không PII). */
function ioFail(alerts: Alert[], signal: string, severity: Alert["severity"], e: unknown): void {
  console.error(
    `ops-alerts: IO lỗi ở tín hiệu ${signal}: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`,
  );
  alerts.push({ severity, signal: `${signal}-io`, detail: { io: "failed" } });
}

async function main(): Promise<void> {
  const thresholds = DEFAULT_THRESHOLDS;
  const mode = resolveMode();
  const io = mode === "dev" ? await makeDevIo() : makeDockerIo();
  const alerts: Alert[] = [];

  // 1) Health — fail-closed.
  try {
    alerts.push(...evaluateHealth(await io.readHealth()));
  } catch (e) {
    ioFail(alerts, "health", "CRITICAL", e);
  }

  // 2) Error rate.
  try {
    alerts.push(
      ...evaluateErrorRate(
        await io.readErrorLineCount(thresholds.windowMinutes),
        thresholds.windowMinutes,
        thresholds.errorLinesMax,
      ),
    );
  } catch (e) {
    ioFail(alerts, "error-rate", "WARN", e);
  }

  // 3) Auth abuse.
  try {
    alerts.push(...evaluateAuthAbuse(await io.readAuthAbuseCounts(thresholds.windowMinutes), thresholds));
  } catch (e) {
    ioFail(alerts, "auth-abuse", "WARN", e);
  }

  // 4) Finance boundary — fail-closed: đọc không được = mù ranh giới = CRITICAL.
  try {
    const counters = await io.readFinanceCounters();
    const rowCounts = await io.readFinanceRowCounts();
    const financialFeaturesEnabled = await io.readFinancialFeaturesEnabled();
    const stateFile = readStateFile();
    const state = decodeState(stateFile.raw);
    const watermark = state?.financeCounters ?? null;
    const previousRowCounts = state?.rowCounts ?? null;
    // File TỒN TẠI nhưng parse fail (kể cả legacy v1) → corrupt (lần không phải
    // đầu) → WARN re-baseline, không CRITICAL giả.
    const watermarkCorrupt = state === null && stateFile.existed;
    const tableDeltas = computeTableDeltas(counters, watermark);
    alerts.push(
      ...evaluateFinanceBoundary({
        tableDeltas,
        rowCounts,
        watermark,
        previousRowCounts,
        watermarkCorrupt,
        financialFeaturesEnabled,
      }),
    );
    // Watermark + row count tiến lên KỂ CẢ khi không có alert (state file round-trip —
    // Review Focus 4: watermark KHÔNG persist = mọi lần chạy đều "lần đầu" = nuốt hết vi phạm).
    writeStateFile(
      encodeState({
        version: 2,
        savedAt: new Date().toISOString(),
        financeCounters: counters,
        rowCounts,
      }),
    );
  } catch (e) {
    ioFail(alerts, "finance-boundary", "CRITICAL", e);
  }

  // 5) Backup freshness — fail-closed.
  try {
    alerts.push(...evaluateBackupFreshness(readNewestBackupAgeHours(), thresholds.backupMaxAgeHours));
  } catch (e) {
    ioFail(alerts, "backup-freshness", "CRITICAL", e);
  }

  // 6) Cron liveness (heartbeat).
  try {
    alerts.push(...evaluateCron(readHeartbeatAgeHours(), thresholds.cronLogMaxAgeHours));
  } catch (e) {
    ioFail(alerts, "cron-liveness", "WARN", e);
  }

  // In + exit: 0 = mọi tín hiệu OK, 1 = có CRITICAL (FD-R37: exit code là kênh signal).
  const critical = alerts.filter((a) => a.severity === "CRITICAL").length;
  const warn = alerts.filter((a) => a.severity === "WARN").length;
  const info = alerts.filter((a) => a.severity === "INFO").length;
  alerts.push({
    severity: "INFO",
    signal: "ops-alerts-run",
    detail: { critical, warn, info, mode: io.mode },
  });
  for (const alert of alerts) {
    console.log(formatAlertLine(alert));
  }
  process.exit(critical > 0 ? 1 : 0);
}

// Chỉ chạy khi gọi trực tiếp (npx tsx scripts/ops-alerts.ts) — test import hàm thuần.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("ops-alerts.ts");
if (invokedDirectly) {
  await main().catch((e) => {
    console.error(`ops-alerts: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
