/**
 * Admin bootstrap + MFA recovery — offline maintenance command (Batch 2 Task 11
 * — spec §5.4.2 "Bootstrap and recovery procedures must be documented and
 * tested to avoid permanent administrator lockout", §5.1.1 posture: KHÔNG bao
 * giờ expose qua HTTP/admin UI; chạy từ terminal của operator có quyền DB).
 *
 * Ba subcommand (dry-run mặc định — mọi mutation cần --apply):
 *   npx tsx scripts/admin-bootstrap.ts promote    --email <e> --role <super_admin|operations_admin|moderator|support|analyst> [--apply]
 *   npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <e> [--apply]
 *   npx tsx scripts/admin-bootstrap.ts mfa-reset  --email <e> [--apply]
 *
 * Hành vi (đúng runbook docs/operations/admin-bootstrap-recovery-runbook.md —
 * integration test tests/integration/admin-bootstrap.test.ts đi THEO TỪNG bước):
 *  - promote: đặt User.adminRole (+ User.role="admin" display) cho user theo
 *    email. Cùng MỘT transaction: last-super-admin guard (không bao giờ để về
 *    0 super_admin — kể cả tự hạ), compare-and-set trên adminRole trước đó
 *    (request khác đổi giữa chừng → conflict typed, không ghi đè), thu hồi
 *    MỌI session của đích (reason "admin_role_changed" — buộc login lại qua
 *    MFA, Task 8 review), audit "admin.bootstrap.promote" (actor null).
 *    Idempotent: role đã đúng → no-op, không thu hồi, không audit.
 *  - mfa-enroll: enrollAdminMfa (Task 8) — secret TOTP mã hóa AES-256-GCM bằng
 *    ADMIN_MFA_ENCRYPTION_KEY (envelope v1:<keyId>:…), 10 mã khôi phục CHỈ lưu
 *    hash. In secret base32 + otpauth:// URI + 10 mã khôi phục ra TERMINAL
 *    MỘT LẦN — không bao giờ ghi log file/audit detail/telemetry (spec §4.8).
 *    Đã enroll → trả null (refuse — reset trước).
 *  - mfa-reset: xoá AdminMfa (cascade mã khôi phục) + thu hồi MỌI session
 *    (reason "admin_mfa_reset") + audit — cùng MỘT transaction. Sau đó
 *    mfa-enroll lại được (vòng lặp lockout → recovery đóng).
 *
 * Mọi lệnh ghi AuditEvent actor=null ("admin.bootstrap.*" — system/offline
 * script; ipHash/sessionId null). Script từ chối chạy khi thiếu DATABASE_URL /
 * ADMIN_MFA_ENCRYPTION_KEY / AUTH_SECRET (hash mã khôi phục derive HKDF từ
 * AUTH_SECRET — src/lib/hkdf.ts).
 *
 * Import CHỈ plain module (KHÔNG server-only/"use server"): db từ
 * src/prisma/db.client, enrollAdminMfa từ src/lib/admin-mfa (chuỗi import đã
 * được Task 11 tách sang plain: hkdf.ts, observability-core.ts), thu hồi session
 * qua src/lib/session-revoke.ts (tách từ session.ts), AuditEvent ghi TRỰC TIẾP
 * qua db.orm với cùng shape auditEvent dùng (precedent
 * scripts/backfill-seller-verification.ts — audit-event.ts là server-only).
 *
 * Production: DB container KHÔNG publish port — chạy qua compose network, xem
 * runbook §"Chạy trên server production".
 */
import { db } from "../src/prisma/db.client";
import { enrollAdminMfa } from "../src/lib/admin-mfa";
import { revokeAllUserSessionsTx } from "../src/lib/session-revoke";
import { ADMIN_ROLES, type AdminRole } from "../src/lib/admin-roles";

// ─── Audit (offline — actor null, cùng shape auditEvent ghi) ──────────────────

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ghi AuditEvent BÊN TRONG transaction — sống chết cùng mutation (spec §4.6;
 * actor null = system/offline script, ipHash/sessionId null — offline).
 * detail CHỈ count/typed value — KHÔNG PII thô/mã thô/secret (spec §4.8).
 */
async function auditEventTxOffline(
  tx: TxContext,
  input: {
    subjectId: string;
    action: "admin.bootstrap.promote" | "admin.bootstrap.mfa_enrolled" | "admin.bootstrap.mfa_reset";
    reason: string;
    detail: string;
  },
): Promise<void> {
  await tx.orm.public.AuditEvent.create({
    actorId: null, // system/offline script — operator xác nhận ngoài band
    subjectId: input.subjectId,
    action: input.action,
    resourceType: "User",
    resourceId: input.subjectId,
    reason: input.reason,
    policyVersion: null,
    sessionId: null,
    detail: input.detail,
    ipHash: null, // offline — không có request context
  });
}

// ─── Tra user theo email (chuẩn hóa như loginAction) ──────────────────────────

async function findUserByEmail(email: string) {
  return db.orm.public.User.first({ email: email.trim().toLowerCase() });
}

// ─── 1. promote — cấp/đổi adminRole ───────────────────────────────────────────

/** Kết quả promote — CLI in, integration test assert. */
export type PromoteReport = {
  mode: "dry-run" | "apply";
  userId: string;
  /** Role trước khi chạy (baseline compare-and-set). */
  priorAdminRole: AdminRole | null;
  /** Role yêu cầu. */
  newRole: AdminRole;
  /** apply: có thay đổi thật không (idempotent → false); dry-run: luôn false. */
  changed: boolean;
  /** Số session đã thu hồi (chỉ khi changed). */
  sessionsRevoked: number;
};

/**
 * Cấp/đổi adminRole cho user theo email. `isApply=false` → dry-run (chỉ báo
 * cáo kế hoạch, KHÔNG mutate); `isApply=true` → MỘT transaction:
 * last-super-admin guard → compare-and-set → thu hồi mọi session → audit.
 * Idempotent: role đã đúng → no-op (không thu hồi, không audit).
 *
 * Throw-out rule: KHÔNG catch bên trong db.transaction (Postgres abort tx khi
 * constraint violation — COMMIT thành ROLLBACK im lặng); mọi lỗi ném ra
 * ngoài để classify (LAST_SUPER_ADMIN / ADMIN_ROLE_CONFLICT / USER_NOT_FOUND).
 */
export async function promoteUser(
  email: string,
  role: AdminRole,
  isApply: boolean,
): Promise<PromoteReport> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error(`USER_NOT_FOUND: không có user nào với email đã cho (promote từ chối chạy mù)`);
  }
  const priorAdminRole = (user.adminRole as AdminRole | null) ?? null;

  if (!isApply) {
    return { mode: "dry-run", userId: user.id, priorAdminRole, newRole: role, changed: false, sessionsRevoked: 0 };
  }

  // Idempotent: role đã đúng → no-op (không thu hồi session ai, không audit ồn).
  if (priorAdminRole === role) {
    return { mode: "apply", userId: user.id, priorAdminRole, newRole: role, changed: false, sessionsRevoked: 0 };
  }

  let sessionsRevoked = 0;
  await db.transaction(async (tx) => {
    // Last-super-admin guard (spec §5.4.2 — tránh khóa admin vĩnh viễn): hạ
    // super_admin cuối cùng → typed error → rollback toàn bộ.
    if (priorAdminRole === "super_admin" && role !== "super_admin") {
      const others = await tx.orm.public.User
        .where({ adminRole: "super_admin" })
        .where((u) => u.id.neq(user.id))
        .all();
      if (others.length === 0) throw new Error("LAST_SUPER_ADMIN: không thể hạ super_admin cuối cùng — promote một super_admin thứ hai trước (runbook §4)");
    }

    // Compare-and-set trên adminRole trước đó — 0 row = request khác đã đổi
    // giữa chừng → conflict typed, KHÔNG ghi đè.
    let claim = tx.orm.public.User.where({ id: user.id });
    claim =
      priorAdminRole === null
        ? claim.where((u) => u.adminRole.isNull())
        : claim.where({ adminRole: priorAdminRole });
    const claimed = await claim.updateAll({ adminRole: role, role: "admin" });
    if (claimed.length === 0) throw new Error("ADMIN_ROLE_CONFLICT: adminRole đã bị đổi bởi request khác giữa chừng — chạy lại");

    // MỌI session của đích bị thu hồi CÙNG tx — buộc login lại qua MFA
    // (Task 8 review; session cũ không mang quyền role mới).
    sessionsRevoked = await revokeAllUserSessionsTx(tx, user.id, "admin_role_changed");

    await auditEventTxOffline(tx, {
      subjectId: user.id,
      action: "admin.bootstrap.promote",
      reason: "bootstrap_role_set",
      detail: `from=${priorAdminRole ?? "none"} to=${role};sessionsRevoked=${sessionsRevoked}`, // role không phải PII (spec §4.8)
    });
  });

  return { mode: "apply", userId: user.id, priorAdminRole, newRole: role, changed: true, sessionsRevoked };
}

// ─── 2. mfa-enroll — enroll MFA, in secret MỘT LẦN ─────────────────────────────

/**
 * Enroll MFA cho admin theo email. `isApply=false` → dry-run (báo cáo trạng
 * thái, KHÔNG mutate). `isApply=true` → enrollAdminMfa (Task 8): secret mã hóa
 * + 10 hash mã khôi phục trong MỘT tx của riêng module; audit
 * "admin.bootstrap.mfa_enrolled" (actor null) ghi SAU enrollment.
 *
 * Trả về `{ secretBase32, uri, recoveryCodes }` — GIÁ TRỊ THÔ chỉ tồn tại ở
 * đây: CLI in ra terminal MỘT LẦN cho operator quét vào authenticator + lưu
 * mã khôi phục vào password manager; KHÔNG bao giờ ghi log/audit/telemetry
 * (spec §4.8). Đã enroll (không reset trước) → null (refuse).
 */
export async function enrollMfa(
  email: string,
  isApply: boolean,
): Promise<{ secretBase32: string; uri: string; recoveryCodes: string[] } | null> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error(`USER_NOT_FOUND: không có user nào với email đã cho (mfa-enroll từ chối chạy mù)`);
  }

  if (!isApply) {
    return null; // dry-run: KHÔNG mutate, KHÔNG trả secret — CLI in trạng thái qua printEnrollDryRun
  }

  const enrolled = await enrollAdminMfa(user.id);
  if (enrolled === null) return null; // đã enroll — reset qua mfa-reset trước (refuse)

  await db.orm.public.AuditEvent.create({
    actorId: null,
    subjectId: user.id,
    action: "admin.bootstrap.mfa_enrolled",
    resourceType: "AdminMfa",
    resourceId: user.id,
    reason: "bootstrap_mfa_enroll",
    policyVersion: null,
    sessionId: null,
    detail: "recoveryCodes=10", // CHỈ count — KHÔNG bao giờ mã thô (spec §4.8)
    ipHash: null,
  });

  return enrolled;
}

// ─── 3. mfa-reset — xoá MFA + thu hồi mọi session (lockout recovery) ──────────

/** Kết quả mfa-reset — CLI in, integration test assert. */
export type ResetMfaReport = {
  mode: "dry-run" | "apply";
  userId: string;
  /** apply: có xoá thật không; dry-run: luôn false. */
  reset: boolean;
  /** Số session đã thu hồi (chỉ khi reset). */
  sessionsRevoked: number;
};

/**
 * Xoá MFA của admin theo email (lockout recovery): MỘT transaction xoá AdminMfa
 * (cascade 10 mã khôi phục) + thu hồi MỌI session (reason "admin_mfa_reset" —
 * session MFA cũ không còn factor để xác thực lại) + audit. Sau đó admin
 * login lại bằng mật khẩu → bị chặn MFA_ENROLLMENT_REQUIRED → chạy mfa-enroll
 * → login bằng TOTP (vòng lặp lockout → recovery đóng, spec §5.4.2).
 *
 * Chưa enroll → typed MFA_NOT_ENROLLED (fail closed — operator cần biết trạng
 * thái không đổi, không im lặng "thành công").
 */
export async function resetMfa(email: string, isApply: boolean): Promise<ResetMfaReport> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error(`USER_NOT_FOUND: không có user nào với email đã cho (mfa-reset từ chối chạy mù)`);
  }

  if (!isApply) {
    return { mode: "dry-run", userId: user.id, reset: false, sessionsRevoked: 0 };
  }

  let sessionsRevoked = 0;
  await db.transaction(async (tx) => {
    const mfa = await tx.orm.public.AdminMfa.first({ userId: user.id });
    if (!mfa) {
      throw new Error("MFA_NOT_ENROLLED: tài khoản này chưa có MFA để reset — chạy mfa-enroll thay vì reset");
    }
    // Cascade xoá 10 mã khôi phục (onDelete: Cascade — contract Task 1)
    await tx.orm.public.AdminMfa.where({ id: mfa.id }).delete();
    sessionsRevoked = await revokeAllUserSessionsTx(tx, user.id, "admin_mfa_reset");
    await auditEventTxOffline(tx, {
      subjectId: user.id,
      action: "admin.bootstrap.mfa_reset",
      reason: "bootstrap_mfa_reset",
      detail: `sessionsRevoked=${sessionsRevoked}`, // CHỈ count (spec §4.8)
    });
  });

  return { mode: "apply", userId: user.id, reset: true, sessionsRevoked };
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — integration test import hàm) ──────

/** In kế hoạch dry-run của mfa-enroll (không đụng secret — chỉ trạng thái). */
async function printEnrollDryRun(email: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error("USER_NOT_FOUND: không có user nào với email đã cho");
  const existing = await db.orm.public.AdminMfa.first({ userId: user.id });
  console.log(`── user: ${user.id}`);
  console.log(`── adminRole: ${user.adminRole ?? "(không có — promote trước khi enroll)"}`);
  console.log(`── MFA: ${existing ? "ĐÃ enroll — cần mfa-reset trước khi enroll lại" : "chưa enroll — có thể enroll"}`);
}

function requireEnv(key: string, hint: string): void {
  if (!process.env[key]) {
    console.error(`✗ Thiếu ${key} — ${hint}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Offline script cần DB + key mã hóa MFA + AUTH_SECRET (hash mã khôi phục
  // derive HKDF từ AUTH_SECRET — src/lib/hkdf.ts). Từ chối chạy mù.
  requireEnv("DATABASE_URL", "script offline cần DB rõ ràng (trên server: compose network — xem runbook).");
  requireEnv(
    "ADMIN_MFA_ENCRYPTION_KEY",
    "key mã hóa TOTP secret (base64 của đúng 32 byte: openssl rand -base64 32) — PHẢI là key production khi chạy trên server, nếu không secret mã hóa không đọc được.",
  );
  requireEnv("AUTH_SECRET", "hash mã khôi phục derive HKDF từ AUTH_SECRET — PHẢI là giá trị production khi chạy trên server.");

  const [subcommand, ...rest] = process.argv.slice(2);
  const args = new Map<string, string>();
  let isApply = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--apply") {
      isApply = true;
      continue;
    }
    if (rest[i] === "--email" || rest[i] === "--role") {
      const key = rest[i]!;
      const value = rest[i + 1];
      if (!value) {
        console.error(`✗ Thiếu giá trị cho ${key}`);
        process.exit(1);
      }
      args.set(key, value);
      i++;
      continue;
    }
    console.error(`✗ Tham số lạ: ${rest[i]}`);
    process.exit(1);
  }

  const email = args.get("--email") ?? "";
  if (!email) {
    console.error("✗ Thiếu --email <email admin>");
    process.exit(1);
  }

  if (!isApply) {
    console.log("── dry-run (mặc định) — truyền --apply để chạy thật");
  }

  // Throw-out rule: mọi lỗi từ tx/db ném RA NGOÀI (KHÔNG catch bên trong
  // db.transaction — Postgres đã abort tx, COMMIT thành ROLLBACK im lặng);
  // CLI classify TẠI ĐÂY: in message typed (không stack), exit 1.
  try {
    await dispatch(subcommand, args, email, isApply);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  await db.close();
}

/** Phân phát subcommand — tách khỏi main để try/catch bên ngoài bắt lỗi typed. */
async function dispatch(
  subcommand: string | undefined,
  args: Map<string, string>,
  email: string,
  isApply: boolean,
): Promise<void> {
  switch (subcommand) {
    case "promote": {
      const roleRaw = args.get("--role") ?? "";
      const role = ADMIN_ROLES.find((r) => r === roleRaw);
      if (!role) {
        console.error(`✗ --role phải là một trong: ${ADMIN_ROLES.join(" | ")}`);
        process.exit(1);
      }
      const report = await promoteUser(email, role, isApply);
      console.log(`── chế độ: ${report.mode}`);
      console.log(`── user: ${report.userId}`);
      console.log(`── role hiện tại: ${report.priorAdminRole ?? "(không có)"} → yêu cầu: ${report.newRole}`);
      if (report.mode === "apply") {
        if (report.changed) {
          console.log(`── ĐÃ ĐẶT adminRole=${report.newRole} + User.role="admin"`);
          console.log(`── đã thu hồi ${report.sessionsRevoked} session của user (buộc login lại qua MFA)`);
          console.log(`── audit: admin.bootstrap.promote (actor=null)`);
        } else {
          console.log(`── IDEMPOTENT: user đã giữ role ${report.newRole} — không thay đổi gì`);
        }
      }
      break;
    }

    case "mfa-enroll": {
      if (!isApply) {
        await printEnrollDryRun(email);
        break;
      }
      const enrolled = await enrollMfa(email, true);
      if (enrolled === null) {
        console.error("✗ User này ĐÃ enroll MFA — chạy mfa-reset --apply trước, rồi enroll lại (refuse enroll đè).");
        process.exit(1);
      }
      // ── In MỘT LẦN ra terminal của operator — KHÔNG ghi file/audit/telemetry ──
      console.log("\n════════════════════════════════════════════════════════════════");
      console.log("  MFA ENROLLED — THÔNG TIN NÀY CHỈ HIỆN MỘT LẦN, LƯU NGAY:");
      console.log("════════════════════════════════════════════════════════════════");
      console.log("  1) Quét URI này vào authenticator (Google Authenticator/1Password/…):");
      console.log(`     ${enrolled.uri}`);
      console.log("  2) Hoặc nhập thủ công secret base32:");
      console.log(`     ${enrolled.secretBase32}`);
      console.log("  3) Lưu 10 mã khôi phục vào password manager (mỗi mã dùng MỘT lần):");
      for (const code of enrolled.recoveryCodes) {
        console.log(`     · ${code}`);
      }
      console.log("════════════════════════════════════════════════════════════════");
      console.log("  Đăng nhập lại bằng mật khẩu + mã TOTP để kiểm tra.");
      console.log("  (DB chỉ lưu secret đã mã hóa + hash mã khôi phục — không đọc lại được.)");
      console.log("════════════════════════════════════════════════════════════════\n");
      console.log("── audit: admin.bootstrap.mfa_enrolled (actor=null, detail chỉ count)");
      break;
    }

    case "mfa-reset": {
      if (!isApply) {
        const user = await findUserByEmail(email);
        if (!user) throw new Error("USER_NOT_FOUND: không có user nào với email đã cho");
        const existing = await db.orm.public.AdminMfa.first({ userId: user.id });
        const activeSessions = await db.orm.public.UserSession
          .where({ userId: user.id })
          .where((s) => s.revokedAt.isNull())
          .all();
        console.log(`── user: ${user.id}`);
        console.log(`── MFA: ${existing ? "đang enroll — sẽ XOÁ" : "chưa enroll (không có gì để reset)"}`);
        console.log(`── session active sẽ bị thu hồi: ${activeSessions.length}`);
        break;
      }
      const report = await resetMfa(email, true);
      console.log(`── chế độ: ${report.mode}`);
      console.log(`── ĐÃ XOÁ AdminMfa (kèm 10 hash mã khôi phục) của user ${report.userId}`);
      console.log(`── đã thu hồi ${report.sessionsRevoked} session (reason admin_mfa_reset)`);
      console.log("── audit: admin.bootstrap.mfa_reset (actor=null)");
      console.log("── BƯỚC KẾ: chạy mfa-enroll --apply lại cho user này, rồi user login bằng TOTP mới.");
      break;
    }

    default: {
      console.error("Usage:");
      console.error("  npx tsx scripts/admin-bootstrap.ts promote    --email <e> --role <super_admin|operations_admin|moderator|support|analyst> [--apply]");
      console.error("  npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <e> [--apply]");
      console.error("  npx tsx scripts/admin-bootstrap.ts mfa-reset  --email <e> [--apply]");
      process.exit(1);
    }
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("admin-bootstrap.ts");
if (invokedDirectly) {
  await main();
}
