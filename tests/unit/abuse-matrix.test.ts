/**
 * Abuse matrix — machine-checked §10.1 mapping (Batch 8 Task 8c; spec §10.1;
 * corrections 2026-10-08 item 10).
 *
 * Test parse bảng 29 hàng ra khỏi
 * docs/operations/private-beta-security-review.md (giữa hai marker
 * `<!-- abuse-matrix-begin/end -->`) và chứng minh MAPPING KHÔNG MỤC RỐT
 * (Review Focus 5 của plan):
 *
 *  1. Đủ 29 hàng spec §10.1, mỗi hàng đúng MỘT lần (mảng spec-verbatim nhúng
 *     trong test — thêm/bớt/đổi tên hàng = đỏ);
 *  2. MỌI evidence cell resolve trên đĩa: path dạng
 *     `tests/(unit|integration)/<name>.test.ts` phải fs.existsSync; path dạng
 *     `docs/<path>.md` phải tồn tại; cell KHÔNG nêu dạng nào = format violation;
 *  3. MỌI marker `@<key>` (keyed test title / typed error string) PHẢI xuất
 *     hiện trong source của file được cite (S6 — tồn tại file CHƯA đủ là
 *     coverage: file có thể tồn tại mà không còn case claimed nữa);
 *  4. Mọi hàng có status không rỗng, đúng một trong
 *     `covered` / `covered (framework posture, documented)` / `gap → new test`.
 *
 * Evidence cells đã được re-verify từng cái bằng `git grep -c` ở thời điểm
 * thực thi (corrections item 10 — các cell sai của plan đã được sửa: Deal IDOR
 * dùng @DEAL_CONVERSATION_REQUIRED cho deal-create vì file đó KHÔNG chứa
 * DEAL_FORBIDDEN; moderation IDOR dùng @APPEAL_NOT_AVAILABLE cho appeal-actions
 * vì file đó KHÔNG chứa FORBIDDEN; XSS listing cite admin-listings-page +
 * chat-surface-xss thay vì sell-pages — file đó không có assertion XSS;
 * decompression bomb ở image-validate (@TOO_LARGE_DIMENSIONS) không phải
 * image-process; SVG rejection ở image-validate (@image/svg+xml)).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const DOC = "docs/operations/private-beta-security-review.md";

/** 29 hàng spec §10.1 — verbatim (spec §10.1, đúng thứ tự spec). */
const SPEC_ROWS = [
  "Unauthorized listing edit",
  "Listing IDOR",
  "Deal IDOR",
  "Moderation-resource IDOR",
  "Privilege escalation",
  "Support → admin escalation",
  "OTP brute force",
  "OTP resend flooding",
  "Account enumeration",
  "Session fixation",
  "Session reuse after recovery",
  "CSRF state-changing action",
  "Stored XSS through listing",
  "Stored XSS through chat",
  "Stored XSS through report",
  "Malicious image upload",
  "MIME spoof",
  "Image decompression bomb",
  "Blocked-user chat bypass",
  "Suspended-user publication bypass",
  "Revoked-seller publication bypass",
  "Beta-cohort bypass",
  "Concurrent seller-verification update",
  "Concurrent Deal status update",
  "Financial direct route",
  "Financial API mutation",
  "Financial webhook processing",
  "Financial cron execution",
  "Historical finance escape-hatch abuse",
] as const;

/** Status hợp lệ của một hàng (plan Task 8 Step 1). */
const ALLOWED_STATUSES = [
  "covered",
  "covered (framework posture, documented)",
  "gap → new test",
] as const;

type MatrixRow = { abuse: string; batch: string; evidence: string; status: string };

/** Parse bảng ma trận giữa hai marker của doc. */
function parseMatrix(): MatrixRow[] {
  const doc = readFileSync(`${root}/${DOC}`, "utf8");
  const begin = doc.indexOf("<!-- abuse-matrix-begin -->");
  expect(begin, `${DOC} phải có marker abuse-matrix-begin`).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf("<!-- abuse-matrix-end -->");
  expect(end, `${DOC} phải có marker abuse-matrix-end (sau begin)`).toBeGreaterThan(begin);
  const table = doc.slice(begin, end);
  const rows: MatrixRow[] = [];
  for (const line of table.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    // | abuse | batch | evidence | status | → ["", abuse, batch, evidence, status, ""]
    if (cells.length < 6) continue;
    const abuse = cells[1]!;
    if (!abuse || abuse.startsWith("---") || abuse === "Abuse case (spec §10.1)") continue;
    rows.push({ abuse, batch: cells[2]!, evidence: cells[3]!, status: cells[4]! });
  }
  return rows;
}

/**
 * MỘT evidence item: `` `path @key` `` hoặc `` `path` `` (backtick-wrapped,
 * nối bằng ` + ` trong cell). Path dạng tests/…test.ts hoặc docs/…md.
 * Key là mọi ký tự tới backtick đóng (cho phép key có khoảng trắng, vd
 * `@session fixation`).
 */
const EVIDENCE_ITEM_RE = /`((?:tests|docs)\/[A-Za-z0-9._/-]+\.(?:test\.ts|md))(?:\s+@([^\`]+?))?`/g;

type EvidenceItem = { path: string; key: string | null };

function parseEvidence(cell: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const m of cell.matchAll(EVIDENCE_ITEM_RE)) {
    items.push({ path: m[1]!, key: m[2] ?? null });
  }
  return items;
}

// ─── 1. Đủ 29 hàng, đúng một lần ─────────────────────────────────────────────

describe("§10.1 abuse matrix — 29 hàng spec, mỗi hàng đúng một lần", () => {
  it("mọi hàng spec đều có trong bảng, đúng một lần, không hàng ngoài spec", () => {
    const rows = parseMatrix();
    expect(rows.length).toBe(SPEC_ROWS.length);
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.abuse, (seen.get(r.abuse) ?? 0) + 1);
    for (const spec of SPEC_ROWS) {
      expect(seen.get(spec) ?? 0, `hàng "${spec}" phải xuất hiện đúng một lần`).toBe(1);
    }
    for (const [abuse, count] of seen) {
      expect((SPEC_ROWS as readonly string[]).includes(abuse), `hàng ngoài spec: "${abuse}"`).toBe(true);
      expect(count).toBe(1);
    }
  });

  it("mọi hàng có covering batch + status hợp lệ (covered | framework posture | gap)", () => {
    const rows = parseMatrix();
    for (const r of rows) {
      expect(r.batch.length, `hàng "${r.abuse}": covering batch không rỗng`).toBeGreaterThan(0);
      expect(
        (ALLOWED_STATUSES as readonly string[]).includes(r.status),
        `hàng "${r.abuse}": status "${r.status}" không hợp lệ`,
      ).toBe(true);
    }
  });
});

// ─── 2. Evidence resolve trên đĩa + @key xảy ra trong file được cite ────────

describe("§10.1 abuse matrix — evidence resolve + keyed marker xảy ra trong file cite", () => {
  it("mọi cell có ít nhất một item dạng tests/*.test.ts hoặc docs/*.md (cell rỗng = format violation)", () => {
    for (const r of parseMatrix()) {
      const items = parseEvidence(r.evidence);
      expect(
        items.length,
        `hàng "${r.abuse}": evidence cell phải cite ít nhất một test/doc path (dạng \`path @key\`)`,
      ).toBeGreaterThan(0);
    }
  });

  it("mọi evidence path tồn tại trên đĩa", () => {
    for (const r of parseMatrix()) {
      for (const item of parseEvidence(r.evidence)) {
        expect(
          existsSync(`${root}/${item.path}`),
          `hàng "${r.abuse}": evidence path không tồn tại: ${item.path}`,
        ).toBe(true);
      }
    }
  });

  it("mọi marker @<key> XẢY RA trong source của file được cite (S6 — tồn tại file chưa đủ)", () => {
    for (const r of parseMatrix()) {
      for (const item of parseEvidence(r.evidence)) {
        if (item.key === null) continue;
        const src = readFileSync(`${root}/${item.path}`, "utf8");
        expect(
          src.includes(item.key),
          `hàng "${r.abuse}": key "${item.key}" không xảy ra trong ${item.path} — mapping mục rỤT (file tồn tại nhưng không còn case claimed)`,
        ).toBe(true);
      }
    }
  });

  it("hàng CSRF cite doc posture (không phải test file) — §CSRF tồn tại trong doc", () => {
    const csrf = parseMatrix().find((r) => r.abuse === "CSRF state-changing action");
    expect(csrf).toBeDefined();
    expect(csrf!.status).toBe("covered (framework posture, documented)");
    const items = parseEvidence(csrf!.evidence);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => i.path === DOC)).toBe(true);
    const doc = readFileSync(`${root}/${DOC}`, "utf8");
    expect(doc).toContain("## CSRF");
  });
});
