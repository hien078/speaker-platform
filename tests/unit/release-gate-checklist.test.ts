/**
 * Release-gate checklist — machine-checked §12 + §12.1 + §9 Batch 8 mapping
 * + FD register mirror derivation (Batch 8 Task 9; spec §12, §12.1, §9 Batch 8
 * Gate; corrections 2026-10-08 items 7, 8, 31, 32).
 *
 * HAI nguồn được parse (Review Focus 6 — gate không được im lặng qua khi
 * thiếu evidence):
 *
 *  1. `docs/operations/founder-decision-register.md` — nguồn machine-parsed
 *     CHÍNH của blocking set (corrections item 7: KHÔNG parse file plan —
 *     plan đã review là không được sửa; register = 59 hàng plan + mọi cập
 *     nhật §E corrections + ghi chú register của các fix playbook);
 *  2. `docs/operations/private-beta-release-checklist.md` — bảng chính
 *     `| Ref | Criterion | Evidence type | Evidence | Status | Sign-off |`
 *     (mọi tiêu chí §12 + §12.1 + §9 Batch 8 + hàng CSP flip + hàng vận
 *     hành người deploy) + bảng FD-mirror
 *     `| FD | Item | Decision (founder) | Date |` (một hàng mỗi register item
 *     Blocking=YES).
 *
 * Parser là hàm pure TRONG file test (logic test-only — `scripts/release-gate.sh`
 * grep/awk checklist trực tiếp, KHÔNG thêm module src/lib). Quy tắc:
 *  - PASS → qua; PENDING → trượt; FOUNDER → chỉ qua với Sign-off không trống;
 *    status lạ → fail-closed (trượt);
 *  - mirror: Decision không trống + ≠ PENDING + Date không trống;
 *  - blocking set derive MECHANICALLY từ register (counts không bao giờ
 *    hardcode — dòng "Register size:" của register phải khớp số derive).
 *
 * Gate ĐỎ là kết quả ĐÚNG khi policy còn DRAFT-NOT-REVIEWED và hàng founder
 * blocking chưa ký (FD-3 fail-closed) — test KHÔNG pin trạng thái sign-off
 * ban đầu (founder điền sau); test pin: format + derivation + wiring.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CHECKLIST_PATH = "docs/operations/private-beta-release-checklist.md";
const REGISTER_PATH = "docs/operations/founder-decision-register.md";
const GATE_SCRIPT = "scripts/release-gate.sh";

// ─── Parser (test-only — bash gate grep/awk checklist trực tiếp) ─────────────

/** Các ô của một dòng bảng markdown sau khi trim (bỏ hai ô rìa). */
function parseTableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    // "| a | b |" → ["", "a", "b", ""] → ["a", "b"]
    rows.push(cells.slice(1, -1));
  }
  return rows;
}

/** Ô đã điền: không rỗng, không "—", không "-". */
function isFilled(cell: string): boolean {
  return cell !== "" && cell !== "—" && cell !== "-";
}

type ChecklistRow = {
  ref: string;
  criterion: string;
  evidenceType: string;
  evidence: string;
  status: string;
  signOff: string;
};

/** Bảng chính: | Ref | Criterion | Evidence type | Evidence | Status | Sign-off | */
function parseChecklistRows(markdown: string): ChecklistRow[] {
  return parseTableRows(markdown)
    .filter((c) => c.length === 6 && c[0] !== "" && c[0] !== "Ref" && !c[0]!.startsWith("---"))
    .map((c) => ({
      ref: c[0]!,
      criterion: c[1]!,
      evidenceType: c[2]!,
      evidence: c[3]!,
      status: c[4]!,
      signOff: c[5]!,
    }));
}

/** Hàng chính qua gate? PASS → có; PENDING → không; FOUNDER → chỉ khi sign-off không trống. */
function rowPasses(row: ChecklistRow): boolean {
  if (row.status === "PASS") return true;
  if (row.status === "PENDING") return false;
  if (row.status === "FOUNDER") return isFilled(row.signOff);
  return false; // status lạ → fail-closed
}

type MirrorRow = { fd: string; item: string; decision: string; date: string };

/** Bảng FD-mirror: | FD | Item | Decision (founder) | Date | */
function parseMirrorRows(markdown: string): MirrorRow[] {
  return parseTableRows(markdown)
    .filter((c) => c.length === 4 && /^FD-R\d+$/.test(c[0] ?? ""))
    .map((c) => ({ fd: c[0]!, item: c[1]!, decision: c[2]!, date: c[3]! }));
}

/** Hàng mirror qua gate? Decision không trống + ≠ PENDING + Date không trống. */
function mirrorRowPasses(row: MirrorRow): boolean {
  return (
    isFilled(row.decision) && row.decision.toUpperCase() !== "PENDING" && isFilled(row.date)
  );
}

type RegisterRow = {
  id: string;
  item: string;
  source: string;
  blocks: string;
  where: string;
};

/** Bảng register: | FD-R<n> | Item | Source | Blocks launch? | Where recorded / verified | */
function parseRegisterRows(markdown: string): RegisterRow[] {
  return parseTableRows(markdown)
    .filter((c) => c.length === 5 && /^FD-R\d+$/.test(c[0] ?? ""))
    .map((c) => ({ id: c[0]!, item: c[1]!, source: c[2]!, blocks: c[3]!, where: c[4]! }));
}

/** Blocking set derive mechanically từ register — mọi hàng có `**YES**`. */
function blockingRegisterIds(registerMarkdown: string): string[] {
  return parseRegisterRows(registerMarkdown)
    .filter((r) => r.blocks.includes("**YES**"))
    .map((r) => r.id);
}

// ─── 1. Parser — fixture (Review Focus 6) ───────────────────────────────────

const MAIN_FIXTURE = [
  "| Ref | Criterion | Evidence type | Evidence | Status | Sign-off |",
  "|---|---|---|---|---|---|",
  "| A-1 | việc A | test | `tests/unit/a.test.ts` | PASS | — |",
  "| A-2 | việc B | doc | `docs/x.md` | PENDING | — |",
  "| A-3 | việc C | founder | FD-R9 | FOUNDER | — |",
  "| A-4 | việc D | founder | FD-R9 | FOUNDER | Founder — chấp nhận 2026-10-10 |",
  "| A-5 | việc E | test | `tests/unit/e.test.ts` | WEIRD | — |",
].join("\n");

const MIRROR_FIXTURE = [
  "| FD | Item | Decision (founder) | Date |",
  "|---|---|---|---|",
  "| FD-R1 | provider OTP | PENDING | — |",
  "| FD-R2 | RBAC cells | Chấp nhận posture fail-closed | 2026-10-10 |",
  "| FD-R3 | recovery proofing | — | — |",
].join("\n");

describe("parser — hàng chính: PASS qua, PENDING trượt, FOUNDER cần sign-off", () => {
  it("parse đúng từng ô của hàng chính", () => {
    const rows = parseChecklistRows(MAIN_FIXTURE);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      ref: "A-1",
      criterion: "việc A",
      evidenceType: "test",
      evidence: "`tests/unit/a.test.ts`",
      status: "PASS",
      signOff: "—",
    });
  });

  it("PASS qua; PENDING trượt; FOUNDER chỉ qua với sign-off không trống; status lạ fail-closed", () => {
    const rows = parseChecklistRows(MAIN_FIXTURE);
    expect(rowPasses(rows[0]!), "PASS phải qua").toBe(true);
    expect(rowPasses(rows[1]!), "PENDING phải trượt").toBe(false);
    expect(rowPasses(rows[2]!), "FOUNDER sign-off trống phải trượt").toBe(false);
    expect(rowPasses(rows[3]!), "FOUNDER đã ký phải qua").toBe(true);
    expect(rowPasses(rows[4]!), "status lạ phải trượt (fail-closed)").toBe(false);
  });
});

describe("parser — hàng mirror: Decision + Date bắt buộc", () => {
  it("PENDING/— trượt; decision + date đã điền qua", () => {
    const rows = parseMirrorRows(MIRROR_FIXTURE);
    expect(rows).toHaveLength(3);
    expect(mirrorRowPasses(rows[0]!), "PENDING phải trượt").toBe(false);
    expect(mirrorRowPasses(rows[1]!), "decision + date đã điền phải qua").toBe(true);
    expect(mirrorRowPasses(rows[2]!), "decision — phải trượt").toBe(false);
  });
});

// ─── 2. Register — nguồn machine-parsed chính (corrections item 7) ──────────

function readDoc(path: string): string {
  const full = `${root}/${path}`;
  expect(existsSync(full), `thiếu file: ${path}`).toBe(true);
  return readFileSync(full, "utf8");
}

describe("founder-decision-register.md — nguồn blocking set", () => {
  const register = readDoc(REGISTER_PATH);
  const rows = parseRegisterRows(register);
  const blocking = blockingRegisterIds(register);

  it("mọi hàng register có Blocks cell bắt đầu **YES** hoặc no (đúng format plan)", () => {
    expect(rows.length, "register phải có các hàng FD-R").toBeGreaterThan(0);
    for (const r of rows) {
      // Plan register dùng `**YES** (qualifier)` / `no (qualifier)` — derivation
      // (blockingRegisterIds) dùng includes("**YES**") nên qualifier không sao,
      // nhưng cell phải bắt đầu bằng một trong hai marker (không marker = format violation).
      expect(
        r.blocks.startsWith("**YES**") || r.blocks.startsWith("no"),
        `hàng ${r.id}: Blocks cell "${r.blocks}" phải bắt đầu **YES** hoặc no`,
      ).toBe(true);
    }
  });

  it("không có ID trùng lặp", () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size, "ID trùng trong register").toBe(ids.length);
  });

  it("dòng Register size tự khai báo khớp số derive từ bảng (drift pin)", () => {
    const m = register.match(/\*\*Register size:\*\* (\d+) rows — (\d+) blocking/);
    expect(m, "register phải có dòng '**Register size:** N rows — B blocking'").not.toBeNull();
    const statedRows = Number(m![1]);
    const statedBlocking = Number(m![2]);
    expect(rows.length, "tổng hàng derive phải khớp dòng khai báo").toBe(statedRows);
    expect(blocking.length, "tổng blocking derive phải khớp dòng khai báo").toBe(statedBlocking);
  });
});

// ─── 3. Checklist thật — mirror chứa ĐÚNG blocking set ──────────────────────

describe("private-beta-release-checklist.md — bảng chính + FD mirror", () => {
  const checklist = readDoc(CHECKLIST_PATH);
  const register = readDoc(REGISTER_PATH);
  const mainRows = parseChecklistRows(checklist);
  const mirrorRows = parseMirrorRows(checklist);
  const blocking = blockingRegisterIds(register);

  it("bảng chính có hàng, mọi Status đúng một trong PASS / PENDING / FOUNDER", () => {
    expect(mainRows.length, "bảng chính phải có các hàng §12/§12.1/§9").toBeGreaterThan(0);
    for (const row of mainRows) {
      expect(
        row.status === "PASS" || row.status === "PENDING" || row.status === "FOUNDER",
        `hàng ${row.ref}: Status "${row.status}" phải là PASS/PENDING/FOUNDER`,
      ).toBe(true);
    }
  });

  it("FD-mirror chứa ĐÚNG blocking set derive từ register — không thừa, không thiếu", () => {
    expect(blocking.length, "blocking set derive không rỗng").toBeGreaterThan(0);
    const mirrorIds = mirrorRows.map((r) => r.fd);
    expect(new Set(mirrorIds).size, "ID trùng trong mirror").toBe(mirrorIds.length);
    const mirrorSet = new Set(mirrorIds);
    for (const id of blocking) {
      expect(mirrorSet.has(id), `mirror thiếu hàng blocking ${id}`).toBe(true);
    }
    for (const id of mirrorIds) {
      expect(
        blocking.includes(id),
        `mirror có hàng ${id} không nằm trong blocking set của register`,
      ).toBe(true);
    }
  });

  it("hai hàng E2E §12 là FOUNDER mang FD-R59 (S8 — founder quyết, không machine-pass)", () => {
    const e2eRows = mainRows.filter((r) => r.criterion.includes("E2E"));
    expect(e2eRows.length, "phải có đúng 2 hàng E2E (listing flow + search→chat)").toBe(2);
    for (const row of e2eRows) {
      expect(row.status, `hàng ${row.ref} phải là FOUNDER`).toBe("FOUNDER");
      expect(row.evidence, `hàng ${row.ref} phải mang FD-R59`).toContain("FD-R59");
    }
  });
});

// ─── 4. Wiring — package.json + script tồn tại ──────────────────────────────

describe("release:gate wiring", () => {
  it('package.json có "release:gate": "bash scripts/release-gate.sh" + script tồn tại', () => {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["release:gate"]).toBe("bash scripts/release-gate.sh");
    expect(existsSync(`${root}/${GATE_SCRIPT}`), `thiếu ${GATE_SCRIPT}`).toBe(true);
  });
});
