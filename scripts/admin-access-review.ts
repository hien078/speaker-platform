/**
 * Admin access review — offline maintenance command (Batch 8 Task 7).
 *
 * Spec §5.4.2 "All admin accounts require MFA enrollment" (ADMIN_WITHOUT_MFA là
 * tín hiệu fail-closed), §7.6 admin security (session inventory + revocation),
 * §9 Batch 8 gate "admin MFA operational / RBAC operational", §4.8 KHÔNG PII
 * trong ops output. §5.1.1 posture: KHÔNG expose qua HTTP/admin UI — chạy từ
 * terminal của operator; READ-ONLY hoàn toàn (không có --apply vì không có
 * đường mutation nào để mở).
 *
 * Liệt kê MỌI holder `User.adminRole` (nguồn quyền duy nhất — spec §8.5, KHÔNG
 * đọc `User.role`/`isVerifiedSeller` để review quyền) kèm trạng thái:
 *  - MFA enrollment (AdminMfa.totpConfirmedAt != null);
 *  - count mã khôi phục CHƯA dùng (AdminRecoveryCode.usedAt null — KHÔNG bao
 *    giờ giá trị mã, spec §4.8);
 *  - inventory session active (UserSession revokedAt null && expiresAt > now)
 *    + count session active cũ hơn TTL admin (consumer session của tài khoản
 *    admin sống 30 ngày > 12h — session không-MFA vượt TTL admin là tín hiệu
 *    thu hồi, runbook §1 quy tắc thu hồi khi đổi role);
 *  - hành động admin gần nhất từ AuditEvent (actorId = user, action + tuổi);
 *  - tuổi tài khoản (ngày).
 *
 * Output: bảng markdown ra stdout — operator paste vào
 * docs/operations/admin-access-review.md (mục dated, mỗi lần review append —
 * MỘT file template + các lần chạy; sign-off Reviewer/Date/Decision là
 * founder-only, spec §4.11).
 *
 * DB reach (db production KHÔNG publish port — docker-compose.prod.yml):
 *  - mặc định (dev): ORM qua DATABASE_URL trong MÔI TRƯỜNG THẬT (D4 — như
 *    scripts/admin-bootstrap.ts: DATABASE_URL phải có trong process.env
 *    TRƯỚC khi db.client/dotenv nạp; in ĐÍCH redacted, KHÔNG password);
 *  - `--docker` (production): `docker exec <container> psql` — cùng container
 *    pattern db-ops.sh (read-only query script; KHÔNG host pg tools, KHÔNG
 *    port). Container/user/db mặc định khớp docker-compose.prod.yml
 *    (loaviet-db/loaviet/loaviet), override qua DB_CONTAINER/DB_USER/DB_NAME.
 *
 * KHÔNG import module "server-only" (otp.ts/env.ts/observability.ts/
 * financial-features.ts/session.ts — tsx không nạp được): hằng số cần thiết
 * (ADMIN_SESSION_TTL_HOURS) duplicate cục bộ + drift test
 * (tests/unit/admin-access-review.test.ts); role list import từ plain module
 * src/lib/admin-roles.ts (nguồn duy nhất — KHÔNG duplicate).
 *
 * Exit code: 0 khi review chạy xong (findings là tín hiệu ghi vào sign-off —
 * quyết định thuộc founder, KHÔNG phải exit code); 1 khi lỗi vận hành (thiếu
 * env, DB không reachable, docker thiếu, psql lỗi).
 *
 * Production pre-launch run: bước của operator — ghi vào
 * docs/operations/admin-access-review.md (mục dated) + release checklist.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
// Plain module chia sẻ (KHÔNG "server-only") — nguồn duy nhất danh sách role
// runtime: dùng làm guard parse cho transport psql (role lạ = cột CSV lệch).
import { ADMIN_ROLES } from "../src/lib/admin-roles";

const execFile = promisify(execFileCallback);

// ─── Hằng số duplicate cục bộ (drift-tested) ──────────────────────────────────

/**
 * TTL session admin (giờ) — DUPLICATE cục bộ của src/lib/session.ts
 * `ADMIN_SESSION_TTL_HOURS` (module có "server-only" + next/headers — script
 * tsx KHÔNG import được). Drift test đọc session.ts as-text và assert bằng
 * nhau — session.ts đổi giá trị mà quên cập nhật đây → test đỏ.
 */
export const ADMIN_SESSION_TTL_HOURS = 12;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Một dòng review — CHỈ id nội bộ + role + states/count (spec §4.8). */
export type AdminAccessRow = {
  /** id nội bộ — operator correlate qua /admin/users (user.view_basic). */
  userId: string;
  adminRole: string;
  /** AdminMfa.totpConfirmedAt != null. */
  mfaEnrolled: boolean;
  /** count mã khôi phục chưa dùng — KHÔNG bao giờ giá trị mã. */
  unusedRecoveryCodes: number;
  /** revokedAt null && expiresAt > now. */
  activeSessions: number;
  /** active && createdAt cũ hơn ADMIN_SESSION_TTL_HOURS (Task 7 — thêm vào
   *  row sketch của plan: finding STALE_SESSIONS cần tín hiệu tuổi, pure
   *  evaluateAdminAccess không tự tính được từ count). */
  staleSessions: number;
  /** action name + tuổi tương đối, từ AuditEvent (actorId = user) — null khi chưa có. */
  lastAdminAuditAction: string | null;
  accountAgeDays: number;
};

/** Facts thô từ DB (hai transport ORM/psql cùng shape này — KHÔNG PII). */
export type AdminFacts = {
  userId: string;
  adminRole: string;
  /** User.createdAt ISO. */
  accountCreatedAt: string;
  /** AdminMfa.totpConfirmedAt ISO — null khi chưa enroll. */
  mfaConfirmedAt: string | null;
  unusedRecoveryCodes: number;
  activeSessions: number;
  staleSessions: number;
  /** AuditEvent.action gần nhất (actorId = user) — null khi chưa có. */
  lastAuditAction: string | null;
  /** AuditEvent.createdAt của action đó — null khi chưa có. */
  lastAuditAt: string | null;
};

// ─── Facts → row (mapping thuần — dùng chung hai transport) ───────────────────

/** Tuổi tương đối tiếng Việt: "vừa xong" / "N phút trước" / "N giờ trước" / "N ngày trước". */
function relativeAge(atMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - atMs);
  if (diff < 60_000) return "vừa xong";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút trước`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} giờ trước`;
  return `${Math.floor(diff / 86_400_000)} ngày trước`;
}

/** Facts thô → row review (mfaEnrolled, accountAgeDays, lastAdminAuditAction format). */
export function toAdminAccessRow(facts: AdminFacts, nowMs: number = Date.now()): AdminAccessRow {
  return {
    userId: facts.userId,
    adminRole: facts.adminRole,
    mfaEnrolled: facts.mfaConfirmedAt !== null,
    unusedRecoveryCodes: facts.unusedRecoveryCodes,
    activeSessions: facts.activeSessions,
    staleSessions: facts.staleSessions,
    lastAdminAuditAction:
      facts.lastAuditAction !== null && facts.lastAuditAt !== null
        ? `${facts.lastAuditAction} (${relativeAge(Date.parse(facts.lastAuditAt), nowMs)})`
        : null,
    accountAgeDays: Math.max(0, Math.floor((nowMs - Date.parse(facts.accountCreatedAt)) / 86_400_000)),
  };
}

// ─── Evaluate — pure, fixture-testable (Review Focus 3) ───────────────────────

/** Cell "—" cho giá trị null trong bảng (KHÔNG để cột trống mơ hồ). */
const DASH = "—";

/** Bảng markdown review — id/role/count/state ONLY (KHÔNG email/mã/secret/token). */
function renderTable(rows: AdminAccessRow[]): string {
  const head =
    "| userId | adminRole | MFA | Mã khôi phục chưa dùng | Session active | Session quá TTL | Hành động admin gần nhất | Tuổi tài khoản (ngày) |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map(
    (r) =>
      `| ${r.userId} | ${r.adminRole} | ${r.mfaEnrolled ? "Đã enroll" : "CHƯA enroll"} | ${r.unusedRecoveryCodes} | ${r.activeSessions} | ${r.staleSessions} | ${r.lastAdminAuditAction ?? DASH} | ${r.accountAgeDays} |`,
  );
  return [head, sep, ...body].join("\n");
}

/**
 * Sinh findings typed từ rows (pure — cùng logic cho mọi transport):
 *  - `ADMIN_WITHOUT_MFA:<userId>` — admin chưa enroll MFA (§5.4.2 fail-closed;
 *    enroll qua scripts/admin-bootstrap.ts mfa-enroll — runbook §1);
 *  - `NO_UNUSED_RECOVERY_CODES:<userId>` — ĐÃ enroll nhưng hết mã chưa dùng
 *    (nguy cơ lockout — runbook §2B; sinh lại qua /admin/security sau step-up);
 *  - `STALE_SESSIONS:<userId>` — giữ session active cũ hơn TTL admin (info —
 *    cân nhắc thu hồi qua /admin/security, runbook §1 quy tắc thu hồi);
 *  - `LAST_SUPER_ADMIN` — đúng một super_admin (tiếng vang operational của
 *    last-super-admin guard — runbook §4: luôn ≥ 2 khi > 1 người vận hành);
 *  - `NO_ADMINS` — không có admin nào (info — cần bootstrap runbook §1).
 *
 * Thứ tự deterministic: per-row theo thứ tự row, LAST_SUPER_ADMIN sau cùng.
 * (0 super_admin khi vẫn còn admin khác: KHÔNG có finding typed — bảng hiển thị
 * rõ phân bố role; phục hồi qua runbook §4.)
 */
export function evaluateAdminAccess(rows: AdminAccessRow[]): {
  findings: string[];
  tableMarkdown: string;
} {
  const findings: string[] = [];

  if (rows.length === 0) {
    findings.push("NO_ADMINS");
    return { findings, tableMarkdown: renderTable(rows) };
  }

  for (const r of rows) {
    if (!r.mfaEnrolled) {
      findings.push(`ADMIN_WITHOUT_MFA:${r.userId}`);
    } else if (r.unusedRecoveryCodes === 0) {
      findings.push(`NO_UNUSED_RECOVERY_CODES:${r.userId}`);
    }
    if (r.staleSessions > 0) {
      findings.push(`STALE_SESSIONS:${r.userId}`);
    }
  }

  const superAdmins = rows.filter((r) => r.adminRole === "super_admin");
  if (superAdmins.length === 1) {
    findings.push("LAST_SUPER_ADMIN");
  }

  return { findings, tableMarkdown: renderTable(rows) };
}

// ─── Transport 1: ORM (dev — DATABASE_URL trong env thật, D4) ─────────────────

/**
 * D4 (cùng pattern scripts/admin-bootstrap.ts): db.client (kèm dotenv) chỉ nạp
 * SAU khi DATABASE_URL đã có trong process.env THẬT — fail closed khi thiếu,
 * kể cả khi gọi từ test; .env KHÔNG được là nguồn ngầm định đích.
 */
async function loadDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL chưa đặt trong MÔI TRƯỜNG THẬT — script offline cần DB rõ ràng " +
        "(từ chối chạy mù; .env không được tự động dùng làm đích — export DATABASE_URL " +
        "hoặc chạy --docker qua container db như docs/operations/admin-access-review.md).",
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

/**
 * Facts qua ORM (dev) — READ-ONLY. Số admin là nhỏ (vài tài khoản) nên per-admin
 * query thẳng; cùng định nghĩa mỗi cột với SQL transport bên dưới:
 * active = revokedAt null && expiresAt > now; stale = active && createdAt cũ
 * hơn ADMIN_SESSION_TTL_HOURS.
 */
async function fetchFactsOrm(): Promise<AdminFacts[]> {
  const db = await loadDb();
  const nowMs = Date.now();
  const staleCutoffMs = nowMs - ADMIN_SESSION_TTL_HOURS * 3_600_000;

  const admins = await db.orm.public.User
    .where((u) => u.adminRole.isNotNull())
    .select("id", "adminRole", "createdAt")
    .orderBy([(u) => u.adminRole.asc(), (u) => u.createdAt.asc()])
    .all();

  const facts: AdminFacts[] = [];
  for (const u of admins) {
    const mfa = await db.orm.public.AdminMfa.where({ userId: u.id }).first();

    let unusedRecoveryCodes = 0;
    if (mfa) {
      const agg = await db.orm.public.AdminRecoveryCode
        .where({ mfaId: mfa.id })
        .where((c) => c.usedAt.isNull())
        .aggregate((a) => ({ n: a.count() }));
      unusedRecoveryCodes = agg.n;
    }

    const sessions = await db.orm.public.UserSession
      .where({ userId: u.id })
      .where((s) => s.revokedAt.isNull())
      .select("createdAt", "expiresAt")
      .all();
    let activeSessions = 0;
    let staleSessions = 0;
    for (const s of sessions) {
      if (Date.parse(s.expiresAt) > nowMs) {
        activeSessions++;
        if (Date.parse(s.createdAt) < staleCutoffMs) staleSessions++;
      }
    }

    const lastAudit = await db.orm.public.AuditEvent
      .where({ actorId: u.id })
      .select("action", "createdAt")
      .orderBy((e) => e.createdAt.desc())
      .first();

    facts.push({
      userId: u.id,
      adminRole: u.adminRole ?? "",
      accountCreatedAt: u.createdAt,
      mfaConfirmedAt: mfa?.totpConfirmedAt ?? null,
      unusedRecoveryCodes,
      activeSessions,
      staleSessions,
      lastAuditAction: lastAudit?.action ?? null,
      lastAuditAt: lastAudit?.createdAt ?? null,
    });
  }
  return facts;
}

// ─── Transport 2: docker exec psql (production — db KHÔNG publish port) ───────

/** Mặc định khớp docker-compose.prod.yml / scripts/db-ops.sh. */
const DB_CONTAINER = process.env.DB_CONTAINER ?? "loaviet-db";
const DB_USER = process.env.DB_USER ?? "loaviet";
const DB_NAME = process.env.DB_NAME ?? "loaviet";

/**
 * MỘT query read-only tính mọi facts per-admin (LATERAL — cùng định nghĩa từng
 * cột với fetchFactsOrm bên trên; TTL interpolate từ hằng số TS — một nguồn).
 * Cột timestamptz thật (migration batch2) nên so với now() trực tiếp được.
 */
function adminFactsSql(): string {
  return `
SELECT
  u."id"                 AS user_id,
  u."adminRole"          AS admin_role,
  u."createdAt"          AS account_created_at,
  m."totpConfirmedAt"    AS mfa_confirmed_at,
  COALESCE(rc.unused_count, 0) AS unused_recovery_codes,
  COALESCE(ss.active_count, 0) AS active_sessions,
  COALESCE(ss.stale_count, 0)  AS stale_sessions,
  ae."action"           AS last_audit_action,
  ae."createdAt"        AS last_audit_at
FROM "User" u
LEFT JOIN "AdminMfa" m ON m."userId" = u."id"
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS unused_count
  FROM "AdminRecoveryCode" r
  WHERE r."mfaId" = m."id" AND r."usedAt" IS NULL
) rc ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (
      WHERE s."revokedAt" IS NULL AND s."expiresAt" > now()
    ) AS active_count,
    COUNT(*) FILTER (
      WHERE s."revokedAt" IS NULL AND s."expiresAt" > now()
        AND s."createdAt" < now() - make_interval(hours => ${ADMIN_SESSION_TTL_HOURS})
    ) AS stale_count
  FROM "UserSession" s
  WHERE s."userId" = u."id"
) ss ON TRUE
LEFT JOIN LATERAL (
  SELECT a."action", a."createdAt"
  FROM "AuditEvent" a
  WHERE a."actorId" = u."id"
  ORDER BY a."createdAt" DESC
  LIMIT 1
) ae ON TRUE
WHERE u."adminRole" IS NOT NULL
ORDER BY u."adminRole" ASC, u."createdAt" ASC`;
}

/**
 * CSV tối giản (psql --csv): field quoted chứa dấu phẩy/nháy; NULL in thành
 * field rỗng KHÔNG quoted. Mọi cột của query này không-bao-giờ-chuỗi-rỗng
 * (id/role/timestamp/action đều không rỗng) nên field rỗng ⇔ NULL — an toàn.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Field CSV → string | null (rỗng = NULL — xem ghi chú parseCsv). */
const csvCell = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

/** Facts qua `docker exec <container> psql` (production — read-only). */
async function fetchFactsDocker(): Promise<AdminFacts[]> {
  const { stdout } = await execFile("docker", [
    "exec",
    DB_CONTAINER,
    "psql",
    "-U",
    DB_USER,
    "-d",
    DB_NAME,
    "-X",
    "--csv",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    adminFactsSql(),
  ]);
  const lines = parseCsv(stdout);
  if (lines.length === 0) {
    throw new Error("PSQL_NO_OUTPUT: psql không trả về header — kiểm tra container/dbname.");
  }
  const header = lines[0]!;
  const col = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`PSQL_BAD_OUTPUT: thiếu cột ${name} trong header.`);
    return idx;
  };
  const c = {
    userId: col("user_id"),
    adminRole: col("admin_role"),
    accountCreatedAt: col("account_created_at"),
    mfaConfirmedAt: col("mfa_confirmed_at"),
    unusedRecoveryCodes: col("unused_recovery_codes"),
    activeSessions: col("active_sessions"),
    staleSessions: col("stale_sessions"),
    lastAuditAction: col("last_audit_action"),
    lastAuditAt: col("last_audit_at"),
  };
  return lines.slice(1).map((cells) => {
    const adminRole = csvCell(cells[c.adminRole]) ?? "";
    // Fail-closed: role phải nằm trong danh sách runtime chia sẻ
    // (src/lib/admin-roles.ts) — role lạ = cột CSV lệch/parse hỏng, KHÔNG in
    // bảng rác rồi coi như review xong.
    if (adminRole !== "" && !(ADMIN_ROLES as readonly string[]).includes(adminRole)) {
      throw new Error(`PSQL_BAD_OUTPUT: adminRole lạ "${adminRole}" — cột CSV lệch?`);
    }
    return {
      userId: csvCell(cells[c.userId]) ?? "",
      adminRole,
      accountCreatedAt: csvCell(cells[c.accountCreatedAt]) ?? "",
      mfaConfirmedAt: csvCell(cells[c.mfaConfirmedAt]),
      unusedRecoveryCodes: Number(csvCell(cells[c.unusedRecoveryCodes]) ?? "0"),
      activeSessions: Number(csvCell(cells[c.activeSessions]) ?? "0"),
      staleSessions: Number(csvCell(cells[c.staleSessions]) ?? "0"),
      lastAuditAction: csvCell(cells[c.lastAuditAction]),
      lastAuditAt: csvCell(cells[c.lastAuditAt]),
    };
  });
}

// ─── runReview — fetch (transport) → rows → findings ──────────────────────────

/**
 * Chạy review: fetch facts (ORM dev mặc định / docker exec psql production qua
 * `--docker`) → map rows → evaluate findings. READ-ONLY — không audit, không
 * mutation (review là quan sát; thay đổi thật đi qua runbook/bootstrap script).
 */
export async function runReview(
  mode: "orm" | "docker" = "orm",
): Promise<{ rows: AdminAccessRow[]; findings: string[] }> {
  const facts = mode === "docker" ? await fetchFactsDocker() : await fetchFactsOrm();
  const rows = facts.map((f) => toAdminAccessRow(f));
  const { findings } = evaluateAdminAccess(rows);
  return { rows, findings };
}

// ─── CLI (chỉ chạy khi được gọi trực tiếp — test import hàm) ───────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--docker")) {
    console.error("Usage:");
    console.error("  npx tsx scripts/admin-access-review.ts            # dev — ORM qua DATABASE_URL (env thật)");
    console.error("  npx tsx scripts/admin-access-review.ts --docker  # production — docker exec <db> psql (read-only)");
    console.error("  (DB_CONTAINER/DB_USER/DB_NAME override mặc định loaviet-db/loaviet/loaviet)");
    process.exit(1);
  }
  const mode: "orm" | "docker" = args.includes("--docker") ? "docker" : "orm";

  if (mode === "orm") {
    if (!process.env.DATABASE_URL) {
      console.error("✗ DATABASE_URL chưa đặt trong MÔI TRƯỜNG THẬT (export DATABASE_URL=… hoặc chạy --docker).");
      process.exit(1);
    }
    console.log(`── ĐÍCH: ${describeTarget(process.env.DATABASE_URL)} (không in password)`);
  } else {
    console.log(`── ĐÍCH: docker exec ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} (read-only — db không publish port)`);
  }

  let review: Awaited<ReturnType<typeof runReview>>;
  try {
    review = await runReview(mode);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  console.log();
  console.log(evaluateAdminAccess(review.rows).tableMarkdown);
  console.log();
  if (review.findings.length === 0) {
    console.log("── Findings: (không có)");
  } else {
    console.log("── Findings:");
    for (const f of review.findings) {
      console.log(`   · ${f}`);
    }
  }
  console.log("── Paste output này vào docs/operations/admin-access-review.md (mục dated) — sign-off founder-only.");
  console.log("── Review hoàn tất (findings là tín hiệu cho sign-off, KHÔNG phải lỗi chạy).");

  if (mode === "orm") {
    // Đóng pool (script dài hơi giữ process sống) — docker mode không mở pool.
    const db = await loadDb();
    await db.close();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("admin-access-review.ts");
if (invokedDirectly) {
  await main();
}
