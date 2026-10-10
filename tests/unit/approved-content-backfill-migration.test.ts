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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    expect(productionRef.hash).toBe(migrationJson.to);
    expect(productionRef.invariants).toContain(INVARIANT);
  });
});
