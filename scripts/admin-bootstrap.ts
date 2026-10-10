/**
 * Admin bootstrap + MFA recovery — offline maintenance command (Batch 2 Task 11
 * — spec §5.4.2 "Bootstrap and recovery procedures must be documented and tested
 * to avoid permanent administrator lockout", §5.1.1 posture: KHÔNG bao giờ
 * expose qua HTTP/admin UI; chạy từ terminal của operator có quyền DB).
 *
 * Ba subcommand (dry-run mặc định — mọi mutation cần --apply --confirm-db <dbname>):
 *   npx tsx scripts/admin-bootstrap.ts promote    --email <e> --role <super_admin|operations_admin|moderator|support|analyst|none> [--apply] [--confirm-db <dbname>]
 *   npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <e> [--apply] [--confirm-db <dbname>]
 *   npx tsx scripts/admin-bootstrap.ts mfa-reset  --email <e> [--apply] [--confirm-db <dbname>]
 *
 * Hành vi (đúng runbook docs/operations/admin-bootstrap-recovery-runbook.md —
 * integration test tests/integration/admin-bootstrap.test.ts đi THEO TỪNG bước):
 *  - promote: đặt User.adminRole cho user theo email (`--role none` = GỠ quyền
 *    quản trị — review fix D6). Cùng MỘT transaction: last-super-admin guard
 *    RACE-SAFE (D2 — helper chia sẻ assertNotLastSuperAdminTx: no-op update
 *    LOCK mọi row super_admin, đếm từ kết quả đã lock — hai tx demote chéo
 *    song song thì đúng MỘT thắng), compare-and-set trên adminRole trước đó
 *    (request khác đổi giữa chừng → conflict typed, không ghi đè), thu hồi
 *    MỌI session của đích (reason "admin_role_changed" — buộc login lại qua
 *    MFA, Task 8 review), audit "admin.bootstrap.promote" (actor null).
 *    User.role (display-only — D6): grant KHÔNG đè "seller"; buyer → "admin";
 *    GỠ restore từ "admin" theo marker (SellerVerification row HOẶC listing
 *    → "seller", else "buyer"). Idempotent: role đã đúng → no-op.
 *  - mfa-enroll: enrollAdminMfaTx (Task 8) + audit "admin.bootstrap.mfa_enrolled"
 *    trong CÙNG MỘT transaction (D5 — không bao giờ "đã enroll mà không có
 *    audit"); refuse user KHÔNG có adminRole (D5) và user đã enroll (trả null).
 *    In secret base32 + otpauth:// URI + 10 mã khôi phục ra TERMINAL MỘT LẦN —
 *    không bao giờ ghi log file/audit detail/telemetry (spec §4.8).
 *  - mfa-reset: MỘT transaction xoá AdminMfa (cascade mã khôi phục) + thu hồi
 *    MỌI session (reason "admin_mfa_reset") + audit. Sau đó mfa-enroll lại được.
 *
 * Mọi lệnh ghi AuditEvent actor=null ("admin.bootstrap.*" — system/offline
 * script; ipHash/sessionId null).
 *
 * Review fix D4 (cùng pattern scripts/backfill-seller-verification.ts):
 *  - DATABASE_URL phải có trong MÔI TRƯỜNG THẬT (process.env) TRƯỚC khi
 *    db.client/dotenv được nạp — dynamic import, KHÔNG top-level import nào
 *    chạm db.client (dotenv chỉ được phép BỔ SUNG config, không là nguồn ngầm
 *    định đích).
 *  - In ĐÍCH redacted (host:port/dbname — KHÔNG password) trước khi chạy.
 *  - --apply bắt buộc kèm --confirm-db <dbname> khớp dbname trong DATABASE_URL
 *    (xác nhận đích tường minh hai lần — chống chạy nhầm DB).
 *
 * Review fix D1: chuỗi import của script dùng ĐƯỜNG DẪN TUYỆT ĐỐI (không alias
 * `@/`) — Dockerfile stage migrate KHÔNG copy tsconfig.json → alias không
 * resolve trong container production.
 *
 * Production: DB container KHÔNG publish port — chạy qua compose network, xem
 * runbook §0.
 */
// Top-level: CHỈ hằng số thuần (admin-roles không import gì) — mọi module chạm
// db.client (kèm dotenv) nạp DYNAMIC sau khi đích đã xác nhận (D4).
import { ADMIN_ROLES, type AdminRole } from "../src/lib/admin-roles";

// ─── D4: đích tường minh — env thật + redacted target + --confirm-db ──────────

/**
 * D4: db.client (kèm dotenv) chỉ nạp SAU khi đích đã có trong process.env THẬT.
 * Fail closed khi thiếu — kể cả khi gọi trực tiếp từ test (cùng pattern Task 10).
 */
async function loadDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL chưa đặt trong MÔI TRƯỜNG THẬT — script offline cần DB rõ ràng " +
        "(từ chối chạy mù; .env không được tự động dùng làm đích — export DATABASE_URL " +
        "hoặc chạy qua compose như runbook §0).",
    );
  }
  const { db } = await import("../src/prisma/db.client");
  return db;
}

/** Đích hiển thị an toàn: host[:port]/db — KHÔNG bao giờ in password. */
function describeTarget(dbUrl: string): string {
  try {
    const url = new URL(dbUrl);
    const port = url.port ? `:${url.port}` : "";
    const db = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.hostname}${port}/${db}`;
  } catch {
    return "(DATABASE_URL không phân tích được — KHÔNG in nguyên giá trị)";
  }
}

/** Dbname trong DATABASE_URL — để đối chiếu --confirm-db (KHÔNG in password). */
function dbNameFromUrl(dbUrl: string): string | null {
  try {
    return new URL(dbUrl).pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

// ─── Audit (offline — actor null, cùng shape auditEvent ghi) ──────────────────

/** Db instance từ loadDb — để derive TxContext (D4: dynamic import). */
type Db = Awaited<ReturnType<typeof loadDb>>;
/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    detail: input.detail, // CHỈ count/typed value — KHÔNG PII thô/mã thô/secret (spec §4.8)
    ipHash: null, // offline — không có request context
  });
}

// ─── Tra user theo email (chuẩn hóa như loginAction) ──────────────────────────

async function findUserByEmail(db: Db, email: string) {
  return db.orm.public.User.first({ email: email.trim().toLowerCase() });
}

// ─── 1. promote — cấp/đổi/gỡ adminRole ─────────────────────────────────────────

/** Kết quả promote — CLI in, integration test assert. */
export type PromoteReport = {
  mode: "dry-run" | "apply";
  userId: string;
  /** Role trước khi chạy (baseline compare-and-set). */
  priorAdminRole: AdminRole | null;
  /** Role yêu cầu — null = GỠ quyền quản trị (D6). */
  newRole: AdminRole | null;
  /** apply: có thay đổi thật không (idempotent → false); dry-run: luôn false. */
  changed: boolean;
  /** Số session đã thu hồi (chỉ khi changed). */
  sessionsRevoked: number;
};

/**
 * Cấp/đổi/GỠ adminRole cho user theo email (`role === "none"` → adminRole null
 * — D6). `isApply=false` → dry-run (chỉ báo cáo, KHÔNG mutate); `isApply=true`
 * → MỘT transaction: last-super-admin guard (D2, row-lock) → compare-and-set →
 * thu hồi mọi session → audit. Idempotent: role đã đúng → no-op.
 *
 * Throw-out rule: KHÔNG catch bên trong db.transaction (Postgres abort tx khi
 * constraint violation — COMMIT thành ROLLBACK im lặng); mọi lỗi ném ra
 * ngoài để classify (LAST_SUPER_ADMIN / ADMIN_ROLE_CONFLICT / USER_NOT_FOUND).
 */
export async function promoteUser(
  email: string,
  role: AdminRole | "none",
  isApply: boolean,
): Promise<PromoteReport> {
  const db = await loadDb();
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new Error("USER_NOT_FOUND: không có user nào với email đã cho (promote từ chối chạy mù)");
  }
  const priorAdminRole = (user.adminRole as AdminRole | null) ?? null;
  const newRole = role === "none" ? null : role;
  const isRemoval = newRole === null;

  if (!isApply) {
    return { mode: "dry-run", userId: user.id, priorAdminRole, newRole, changed: false, sessionsRevoked: 0 };
  }

  // Idempotent: role đã đúng → no-op (không thu hồi session ai, không audit ồn).
  if (priorAdminRole === newRole) {
    return { mode: "apply", userId: user.id, priorAdminRole, newRole, changed: false, sessionsRevoked: 0 };
  }

  // D4: dynamic import SAU khi đích đã xác nhận — D2/D6 helper chia sẻ với action.
  const { assertNotLastSuperAdminTx, resolveNonAdminRoleTx } = await import("../src/lib/admin-role-ops");
  const { revokeAllUserSessionsTx } = await import("../src/lib/session-revoke");

  let sessionsRevoked = 0;
  await db.transaction(async (tx) => {
    // Last-super-admin guard (D2 — row-lock, chia sẻ với setAdminRoleAction):
    // demote/gỡ super_admin khi không còn super_admin nào khác → typed error.
    if (priorAdminRole === "super_admin" && newRole !== "super_admin") {
      await assertNotLastSuperAdminTx(tx, user.id);
    }

    // Compare-and-set trên adminRole trước đó — 0 row = request khác đã đổi
    // giữa chừng → conflict typed, KHÔNG ghi đè.
    let claim = tx.orm.public.User.where({ id: user.id });
    claim =
      priorAdminRole === null
        ? claim.where((u) => u.adminRole.isNull())
        : claim.where({ adminRole: priorAdminRole });
    // D6 — role display: grant KHÔNG đè "seller" (seller visibility); buyer →
    // "admin"; GỠ restore từ "admin" theo marker (verification row / listing).
    const displayRole = isRemoval
      ? user.role === "admin"
        ? await resolveNonAdminRoleTx(tx, user.id)
        : user.role
      : user.role === "buyer"
        ? "admin"
        : user.role;
    const claimed = await claim.updateAll({ adminRole: newRole, role: displayRole });
    if (claimed.length === 0) {
      throw new Error("ADMIN_ROLE_CONFLICT: adminRole đã bị đổi bởi request khác giữa chừng — chạy lại");
    }

    // MỌI session của đích bị thu hồi CÙNG tx — buộc login lại qua MFA
    // (Task 8 review; session cũ không mang quyền role mới).
    sessionsRevoked = await revokeAllUserSessionsTx(tx, user.id, "admin_role_changed");

    await auditEventTxOffline(tx, {
      subjectId: user.id,
      action: "admin.bootstrap.promote",
      reason: "bootstrap_role_set",
      detail: `from=${priorAdminRole ?? "none"} to=${newRole ?? "none"};sessionsRevoked=${sessionsRevoked}`, // role không phải PII (spec §4.8)
    });
  });

  return { mode: "apply", userId: user.id, priorAdminRole, newRole, changed: true, sessionsRevoked };
}

// ─── 2. mfa-enroll — enroll MFA + audit trong MỘT tx, in secret MỘT LẦN ────────

/**
 * Enroll MFA cho admin theo email. `isApply=false` → dry-run (KHÔNG mutate,
 * KHÔNG trả secret). `isApply=true` → MỘT transaction: enrollAdminMfaTx (Task 8
 * — secret mã hóa + 10 hash mã khôi phục) + audit "admin.bootstrap.mfa_enrolled"
 * (D5 — sống chết cùng enrollment, không bao giờ "đã enroll mà không có audit").
 *
 * Refuse (D5): user KHÔNG có adminRole → typed NOT_AN_ADMIN (mfa-enroll chỉ dành
 * cho tài khoản quản trị — promote trước); đã enroll → null (reset trước).
 *
 * Trả về `{ secretBase32, uri, recoveryCodes }` — GIÁ TRỊ THÔ chỉ tồn tại ở đây:
 * CLI in ra terminal MỘT LẦN cho operator quét vào authenticator + lưu mã
 * khôi phục vào password manager; KHÔNG bao giờ ghi log/audit/telemetry
 * (spec §4.8).
 */
export async function enrollMfa(
  email: string,
  isApply: boolean,
): Promise<{ secretBase32: string; uri: string; recoveryCodes: string[] } | null> {
  const db = await loadDb();
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new Error("USER_NOT_FOUND: không có user nào với email đã cho (mfa-enroll từ chối chạy mù)");
  }
  if (user.adminRole == null) {
    // D5 — enrollment chỉ dành cho tài khoản quản trị (login admin bắt buộc MFA;
    // enroll cho user thường là thao tác vô nghĩa che khuất sai lầm vận hành).
    throw new Error(
      "NOT_AN_ADMIN: user chưa có adminRole — chạy promote trước (mfa-enroll chỉ dành cho tài khoản quản trị)",
    );
  }

  if (!isApply) {
    return null; // dry-run: KHÔNG mutate, KHÔNG trả secret — CLI in trạng thái qua printEnrollDryRun
  }

  // D4: dynamic import SAU khi đích đã xác nhận.
  const { enrollAdminMfaTx } = await import("../src/lib/admin-mfa");

  // D5: enrollment + audit trong CÙNG MỘT transaction.
  return db.transaction(async (tx) => {
    const enrolled = await enrollAdminMfaTx(tx, user.id);
    if (enrolled === null) return null; // đã enroll — reset qua mfa-reset trước (refuse)
    await auditEventTxOffline(tx, {
      subjectId: user.id,
      action: "admin.bootstrap.mfa_enrolled",
      reason: "bootstrap_mfa_enroll",
      detail: "recoveryCodes=10", // CHỈ count — KHÔNG bao giờ mã thô (spec §4.8)
    });
    return enrolled;
  });
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
  const db = await loadDb();
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new Error("USER_NOT_FOUND: không có user nào với email đã cho (mfa-reset từ chối chạy mù)");
  }

  if (!isApply) {
    return { mode: "dry-run", userId: user.id, reset: false, sessionsRevoked: 0 };
  }

  // D4: dynamic import SAU khi đích đã xác nhận.
  const { revokeAllUserSessionsTx } = await import("../src/lib/session-revoke");

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
  const db = await loadDb();
  const user = await findUserByEmail(db, email);
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
  // D4: đích phải có trong MÔI TRƯỜNG THẬT trước khi db.client/dotenv nạp —
  // KHÔNG top-level import nào chạm db.client (dotenv không được là nguồn ngầm).
  requireEnv(
    "DATABASE_URL",
    "script offline cần DB rõ ràng trong môi trường thật (trên server: compose network — xem runbook §0; .env không được tự động dùng làm đích).",
  );
  requireEnv(
    "ADMIN_MFA_ENCRYPTION_KEY",
    "key mã hóa TOTP secret (base64 của đúng 32 byte: openssl rand -base64 32) — PHẢI là key production khi chạy trên server, nếu không secret mã hóa không đọc được.",
  );
  requireEnv(
    "AUTH_SECRET",
    "hash mã khôi phục derive HKDF từ AUTH_SECRET — PHẢI là giá trị production khi chạy trên server.",
  );

  const [subcommand, ...rest] = process.argv.slice(2);
  const args = new Map<string, string>();
  let isApply = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--apply") {
      isApply = true;
      continue;
    }
    if (rest[i] === "--email" || rest[i] === "--role" || rest[i] === "--confirm-db") {
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

  // D4: --apply bắt buộc kèm --confirm-db <dbname> khớp dbname trong DATABASE_URL —
  // xác nhận đích tường minh HAI LẦN (chống chạy nhầm DB).
  if (isApply) {
    const confirmDb = args.get("--confirm-db");
    const actualDb = dbNameFromUrl(process.env.DATABASE_URL!);
    if (!confirmDb) {
      console.error('✗ --apply cần --confirm-db <dbname> — tên DB trong DATABASE_URL (xác nhận đích, xem trong dòng "── ĐÍCH:" dưới).');
      process.exit(1);
    }
    if (confirmDb !== actualDb) {
      console.error(`✗ --confirm-db "${confirmDb}" ≠ dbname trong DATABASE_URL ("${actualDb}") — đối chiếu lại đích.`);
      process.exit(1);
    }
  }

  // D4: in ĐÍCH redacted (host:port/db — KHÔNG password) TRƯỚC khi chạy.
  console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL!)} (không in password)`);
  if (!isApply) {
    console.log("── dry-run (mặc định) — truyền --apply --confirm-db <dbname> để chạy thật");
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

  const db = await loadDb(); // instance đã nạp — chỉ để đóng pool
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
      const isRemoval = roleRaw === "none"; // D6 — gỡ quyền quản trị
      if (!role && !isRemoval) {
        console.error(`✗ --role phải là một trong: ${ADMIN_ROLES.join(" | ")} | none (gỡ quyền quản trị)`);
        process.exit(1);
      }
      const report = await promoteUser(email, isRemoval ? "none" : role!, isApply);
      console.log(`── chế độ: ${report.mode}`);
      console.log(`── user: ${report.userId}`);
      console.log(`── role hiện tại: ${report.priorAdminRole ?? "(không có)"} → yêu cầu: ${report.newRole ?? "(gỡ quyền quản trị)"}`);
      if (report.mode === "apply") {
        if (report.changed) {
          console.log(
            report.newRole === null
              ? `── ĐÃ GỠ quyền quản trị (adminRole=null, User.role restore theo marker seller) + thu hồi ${report.sessionsRevoked} session`
              : `── ĐÃ ĐẶT adminRole=${report.newRole} + thu hồi ${report.sessionsRevoked} session của user (buộc login lại qua MFA)`,
          );
          console.log("── audit: admin.bootstrap.promote (actor=null)");
        } else {
          console.log(`── IDEMPOTENT: user đã ở trạng thái này — không thay đổi gì`);
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
        const db = await loadDb();
        const user = await findUserByEmail(db, email);
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
      console.error("  npx tsx scripts/admin-bootstrap.ts promote    --email <e> --role <super_admin|operations_admin|moderator|support|analyst|none> [--apply --confirm-db <dbname>]");
      console.error("  npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <e> [--apply --confirm-db <dbname>]");
      console.error("  npx tsx scripts/admin-bootstrap.ts mfa-reset  --email <e> [--apply --confirm-db <dbname>]");
      process.exit(1);
    }
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("admin-bootstrap.ts");
if (invokedDirectly) {
  await main();
}
