/**
 * b4-holistic round-4 (LOW deploy-risk) — data-only migration backfill
 * Listing.approvedContentAt cho row approved HIỆN CÓ:
 *
 * Hợp đồng source-contract (đọc artefact migration — KHÔNG cần DB):
 *  1. Migration MỚI (additive — KHÔNG đụng migration đã áp
 *     20261007T1708_batch4_holistic_review_fixes): self-edge from == to ==
 *     contract hash hiện tại (data-only, KHÔNG đổi schema).
 *  2. Op data: precheck EXISTS (còn việc) / execute UPDATE approvedContentAt
 *     = updatedAt WHERE status='approved' AND NULL / postcheck NOT EXISTS —
 *     cùng hợp đồng "check là rowset, presence-of-any-row = còn việc" như
 *     dataTransform (prisma-8 migrations.md).
 *  3. invariantId trên op + providedInvariants trong migration.json + ref
 *     'production' khai báo invariant — CƠ CHẾ BẮT BUỘC: self-edge
 *     from == to KHÔNG BAO GIỜ được path walk mặc định chọn
 *     (findPathWithDecision: from == to && required rỗng → path rỗng) —
 *     required = ref.invariants \ marker.invariants buộc db migrate --to
 *     production ĐI QUA edge này đúng MỘT lần; marker ghi invariant → chạy
 *     lại idempotent. ĐÃ verify trên scratch DB: pre-deploy marker (không
 *     invariant) + row approved NULL → migrate chạy backfill →
 *     approvedContentAt = updatedAt → chạy lại "Already up to date".
 *  4. Row hidden/pending/rejected/draft KHÔNG bị backfill (fail-closed —
 *     không có cách biết content hiện tại đã duyệt hay chưa).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const DIR = "migrations/app/20261007T2007_batch4_round4_approved_content_backfill";
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

type OpsStep = { description: string; sql: string; params?: unknown[] };
type OpsOp = {
  id: string;
  label: string;
  operationClass: string;
  invariantId?: string;
  precheck?: OpsStep[];
  execute?: OpsStep[];
  postcheck?: OpsStep[];
};

const ops = JSON.parse(read(`${DIR}/ops.json`)) as OpsOp[];
const migrationJson = JSON.parse(read(`${DIR}/migration.json`)) as {
  from: string;
  to: string;
  providedInvariants: string[];
};
const productionRef = JSON.parse(read("migrations/app/refs/production.json")) as {
  hash: string;
  invariants: string[];
};
const prevMigration = JSON.parse(
  read("migrations/app/20261007T1708_batch4_holistic_review_fixes/migration.json"),
) as { to: string };

const INVARIANT = "backfill-listing-approved-content-at";
const dataOp = ops.find((o) => o.operationClass === "data");

// Head của migration graph trên disk — dir mới nhất theo timestamp prefix.
// Ref production phải trỏ vào head này (quy tắc advance-ref cùng commit —
// Batch 2/4 Task 1, Batch 5 Task 1): mọi migration đã commit nằm trên đường
// `db migrate --to production` đi qua.
const headDir = readdirSync(`${root}/migrations/app`)
  .filter((e) => /^\d{8}T\d{4}_/.test(e))
  .sort()
  .at(-1)!;
const headTo = (JSON.parse(read(`migrations/app/${headDir}/migration.json`)) as { to: string }).to;

describe("migration backfill approvedContentAt — artefact contract (b4-holistic round-4)", () => {
  it("data op tồn tại duy nhất, KHÔNG op schema nào khác (data-only)", () => {
    expect(ops).toHaveLength(1);
    expect(dataOp).toBeDefined();
    expect(dataOp!.id).toBe("data.backfill-listing-approved-content-at");
    expect(dataOp!.operationClass).toBe("data");
  });

  it("self-edge từ contract hash hiện tại — KHÔNG đụng migration đã áp", () => {
    // from == to == hash mà migration trước NHẤT (đã áp production) kết thúc —
    // additive data-only, KHÔNG sửa migration cũ (hash của NÓ không đổi).
    expect(migrationJson.from).toBe(prevMigration.to);
    expect(migrationJson.to).toBe(prevMigration.to);
    expect(migrationJson.from).toBe(migrationJson.to);
  });

  it("execute = UPDATE approvedContentAt = updatedAt cho row approved đang NULL", () => {
    expect(dataOp!.execute).toHaveLength(1);
    const step = dataOp!.execute![0]!;
    expect(step.sql).toBe(
      'UPDATE "public"."Listing" SET "approvedContentAt" = "updatedAt" WHERE ("status" = $1 AND "approvedContentAt" IS NULL)',
    );
    expect(step.params).toEqual(["approved"]);
  });

  it("precheck/postcheck = EXISTS/NOT EXISTS rowset (presence-of-any-row = còn việc)", () => {
    const rowset =
      'SELECT "id" AS "id" FROM "public"."Listing" WHERE ("status" = $1 AND "approvedContentAt" IS NULL) LIMIT 1';
    expect(dataOp!.precheck![0]!.sql).toBe(`SELECT EXISTS (${rowset}) AS ok`);
    expect(dataOp!.precheck![0]!.params).toEqual(["approved"]);
    expect(dataOp!.postcheck![0]!.sql).toBe(`SELECT NOT EXISTS (${rowset}) AS ok`);
    expect(dataOp!.postcheck![0]!.params).toEqual(["approved"]);
  });

  it("invariant routing: op khai invariantId + migration.json providedInvariants + ref production", () => {
    // CƠ CHẾ BẮT BUỘC để self-edge được db migrate --to production CHỌN (xem
    // header file) — thiếu một trong ba thì backfill KHÔNG BAO GIỜ chạy.
    expect(dataOp!.invariantId).toBe(INVARIANT);
    expect(migrationJson.providedInvariants).toEqual([INVARIANT]);
    // Batch 5 Task 1 đã advance ref production qua migration mới — ref không
    // còn trỏ THẲNG vào self-edge này mà trỏ vào head mới nhất của graph.
    // Điều kiện để backfill VẪN CHẠY trên đường tới production là ref tiếp
    // tục khai báo invariant (dòng dưới): path walk buộc đi qua self-edge
    // đúng một lần — đã chứng minh `db migrate --show --from @empty --to
    // production` = 7 migration, gồm round4 backfill + batch5.
    expect(productionRef.invariants).toContain(INVARIANT);
    expect(productionRef.hash).toBe(headTo);
  });

  it(
    "production path từ @empty GỒM self-edge backfill (b5-review Task 1 L2 — path walk thật)",
    // [b6-review leftover 3 — flake] Test này spawn `npx prisma db migrate
    // --show` (CLI thật, ~3s idle) và đã FAIL một lần dưới full-suite parallel
    // load: vitest default testTimeout 5s bị vượt khi máy chạy nhiều worker.
    // Timeout riêng 120s (rất dư dả) — KHÔNG đổi gì test pin. Giữ subprocess
    // vì nó là nguồn chân thực (chính path walk của CLI — xem header); gọi
    // in-process thay thế đòi import internal chunk của @prisma/orm-toolchain
    // (executeMigrateShowPlan/buildReadAggregate không nằm trong exports map
    // công khai) + tự viết lại aggregate loading → yếu hơn pin, không hơn.
    { timeout: 120_000 },
    async () => {
      // [b5-review Task 1 L2 — đóng trong Task 11] Khẳng định deploy-risk bằng
      // CHÍNH path walk của CLI (nguồn chân thực — không tự viết lại thuật toán
      // findPathWithDecision): `db migrate --show --from @empty --to production`
      // là offline (graph trên đĩa, KHÔNG kết nối DB — chạy được trong npm test).
      // Self-edge from == to là đường DUY NHẤT cung cấp invariant — nếu ref
      // mất khai báo invariant (lỗi `migration ref set` ghi đè invariants: [])
      // thì round4 backfill rơi khỏi path → test này FAIL ngay (đã từng xảy ra:
      // commit 194f65a + Task 1 §4.4).
      const { stdout } = await execFileAsync(
        "npx",
        ["prisma", "db", "migrate", "--show", "--from", "@empty", "--to", "production"],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 },
      );
      const line = stdout
        .split("\n")
        .filter((l) => l.startsWith("{") && l.includes('"kind":"result"'))
        .at(-1);
      expect(line, "prisma --show result line").toBeTruthy();
      const migrations = (
        JSON.parse(line!) as {
          envelope: { result: { migrations: Array<{ dirName: string; from: string; to: string }> } };
        }
      ).envelope.result.migrations;

      // path tuyến tính: baseline → b2 → b3 → b4 → holistic → round4 self-edge → batch5 → batch6
      // (Batch 6 Task 1 — corrections item 3: pin update khi ref production advance;
      //  không assertion nào bị yếu đi — chỉ append dir mới của graph)
      expect(migrations.map((m) => m.dirName)).toEqual([
        "20261003T0448_baseline",
        "20261006T0209_batch2_identity_security",
        "20261006T1420_batch3_trust_safety",
        "20261006T1902_batch4_listing_quality",
        "20261007T1708_batch4_holistic_review_fixes",
        "20261007T2007_batch4_round4_approved_content_backfill",
        "20261007T2208_batch5_search_telemetry",
        "20261008T0237_batch6_chat_deal",
        "20261008T1130_batch7_cohort_operations",
      ]);
      // self-edge: from == to (data-only, không đổi schema)
      const selfEdge = migrations.find((m) => m.dirName === "20261007T2007_batch4_round4_approved_content_backfill");
      expect(selfEdge!.from).toBe(selfEdge!.to);
      // path kết thúc đúng hash ref production (đi qua MỌI migration đã commit)
      expect(migrations.at(-1)!.to).toBe(productionRef.hash);
    },
  );
});
