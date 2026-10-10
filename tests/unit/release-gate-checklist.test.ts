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
 *  - hàng Evidence type founder/user-run → bắt buộc Status FOUNDER + Sign-off
 *    thật (review fix 2026-10-10 finding 2: flip sang PASS không thay được
 *    chữ ký);
 *  - ô placeholder NGUYÊN Ô (`—`, `-`, `— (chờ founder)`, đúng `PENDING`/`TBD`/
 *    `chờ` case-insensitive sau trim) KHÔNG tính là đã điền (review fix
 *    2026-10-10 finding 5; vòng 2 finding 5: whole-cell — KHÔNG substring,
 *    decision/sign-off thật chứa "chờ"/"pending"/"tbd" vẫn tính là đã điền);
 *  - mirror: Decision không trống + ≠ PENDING + Date không trống;
 *  - blocking set derive MECHANICALLY từ register (counts không bao giờ
 *    hardcode — dòng "Register size:" của register phải khớp số derive).
 *
 * Gate ĐỎ là kết quả ĐÚNG khi policy còn DRAFT-NOT-REVIEWED và hàng founder
 * blocking chưa ký (FD-3 fail-closed) — test KHÔNG pin trạng thái sign-off
 * ban đầu (founder điền sau); test pin: format + derivation + wiring.
 *
 * Section 5 (review 2026-10-10): fixture test CHẠY THẬT logic bash của
 * `scripts/release-gate.sh` (source với RELEASE_GATE_SOURCED=1 — chỉ định
 * nghĩa hàm, KHÔNG chạy gate) trên fixture file, chứng minh từng bad case
 * giờ FAIL: hàng CRITICAL+OPEN (finding 1), hàng founder/user-run flip
 * PASS / bị xoá (finding 2), ô Reviewer placeholder (finding 5), row duyệt
 * v1 PENDING giữ làm history (finding 6). Gate fail-closed — chỉ xanh bằng
 * chữ ký founder/user thật.
 *
 * Review 2026-10-10 vòng 2: finding 5 — placeholder NGUYÊN Ô (whole-cell,
 * không substring: decision thật chứa "chờ"/"pending" vẫn qua); finding 6 —
 * env override fixture bị guard đầu script TỪ CHỐI chạy thật (exit 1 khi
 * bị set mà không ở source mode của test — override không thể force gate
 * xanh trong một lần chạy thật).
 */
import { describe, expect, it, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CHECKLIST_PATH = "docs/operations/private-beta-release-checklist.md";
const REGISTER_PATH = "docs/operations/founder-decision-register.md";
const SECURITY_REVIEW_PATH = "docs/operations/private-beta-security-review.md";
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

/**
 * Ô đã điền: không rỗng, không "—"/"-", không placeholder NGUYÊN Ô (review fix
 * 2026-10-10 finding 5 + vòng 2 finding 5 — mirror filled() của gate bash:
 * "— (chờ founder)" không là chữ ký; KHÔNG match substring — decision thật
 * chứa "chờ"/"pending" (vd "Chờ provider OTP (FD-R1) — chấp nhận") vẫn tính
 * là đã điền; chỉ đúng "PENDING"/"TBD"/"chờ" (case-insensitive, sau trim)
 * bị từ chối).
 */
function isFilled(cell: string): boolean {
  const s = cell.trim();
  if (s === "" || s.startsWith("—") || s.startsWith("-")) return false;
  return !/^(pending|tbd|chờ)$/i.test(s);
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

/** Hàng founder/user-run (Evidence type chứa founder/user-run) — review fix 2026-10-10 finding 2. */
function isFounderOrUserRun(row: ChecklistRow): boolean {
  return /founder|user-run/.test(row.evidenceType.toLowerCase());
}

/**
 * Hàng chính qua gate? PASS → có; PENDING → không; FOUNDER → chỉ khi sign-off
 * không trống; hàng founder/user-run → bắt buộc FOUNDER + sign-off thật
 * (review fix 2026-10-10 finding 2 — PASS không thay được chữ ký).
 */
function rowPasses(row: ChecklistRow): boolean {
  if (isFounderOrUserRun(row)) {
    return row.status === "FOUNDER" && isFilled(row.signOff);
  }
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
  // Review fix 2026-10-10 finding 2: hàng user-run flip sang PASS (không chữ ký).
  "| A-6 | việc F | user-run | drill production | PASS | — |",
  // Review fix 2026-10-10 finding 5: sign-off placeholder không là chữ ký.
  "| A-7 | việc G | user-run | drill production | FOUNDER | — (chờ founder) |",
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
    expect(rows).toHaveLength(7);
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

  it("review fix 2026-10-10: hàng founder/user-run flip PASS / sign-off placeholder → trượt", () => {
    const rows = parseChecklistRows(MAIN_FIXTURE);
    expect(
      rowPasses(rows[5]!),
      "hàng user-run (A-6) flip sang PASS không chữ ký phải trượt — PASS không thay được chữ ký founder",
    ).toBe(false);
    expect(
      rowPasses(rows[6]!),
      "hàng user-run (A-7) FOUNDER với sign-off placeholder phải trượt — placeholder không là chữ ký",
    ).toBe(false);
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

  // ── Review fix 2026-10-10 finding 2: hàng founder/user-run không thể machine-pass ──

  it("mọi hàng Evidence type founder/user-run có Status FOUNDER (flip sang PASS = vi phạm)", () => {
    const founderRows = mainRows.filter((r) => isFounderOrUserRun(r));
    expect(founderRows.length, "checklist phải có hàng founder/user-run").toBeGreaterThan(0);
    for (const row of founderRows) {
      expect(
        row.status,
        `hàng ${row.ref} (Evidence type "${row.evidenceType}") phải là FOUNDER — PASS/đổi status không thay được chữ ký founder/user`,
      ).toBe("FOUNDER");
    }
  });

  it("OPS-01..OPS-10 + SEC-01 tồn tại với Status FOUNDER (xoá hàng = vi phạm)", () => {
    const refs = [
      "SEC-01",
      ...Array.from({ length: 10 }, (_, i) => `OPS-${String(i + 1).padStart(2, "0")}`),
    ];
    for (const ref of refs) {
      const row = mainRows.find((r) => r.ref === ref);
      expect(row, `thiếu hàng ${ref} — xoá hàng founder/user-run không làm gate xanh`).toBeDefined();
      expect(row!.status, `hàng ${ref} phải là FOUNDER`).toBe("FOUNDER");
      expect(
        row!.evidenceType.toLowerCase(),
        `hàng ${ref} phải là hàng user-run`,
      ).toContain("user-run");
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

// ─── 5. Gate script (bash) — fixture fail-closed (review 2026-10-10) ─────────
//
// Source THẬT scripts/release-gate.sh (RELEASE_GATE_SOURCED=1 — chỉ định nghĩa
// hàm, KHÔNG chạy 9 gate) rồi gọi từng check trên fixture file. Mỗi test chứng
// minh bad case giờ FAIL — gate fail-closed: không có đường nào làm gate xanh
// mà thiếu chữ ký founder/user thật.

/** Chạy bash: source gate script rồi thực thi snippet; trả exit code + output. */
function bashGate(
  snippet: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(
    "bash",
    ["-c", `RELEASE_GATE_SOURCED=1 source '${GATE_SCRIPT}'\n${snippet}`],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
  );
  expect(res.error, `bash không chạy được: ${res.error ?? ""}`).toBeUndefined();
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const fixtureDir = mkdtempSync(join(tmpdir(), "release-gate-t9fix-"));

/** Ghi fixture file vào thư mục tạm, trả path tuyệt đối. */
function fixtureFile(name: string, content: string): string {
  const file = join(fixtureDir, name);
  writeFileSync(file, content);
  return file;
}

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// ── 5a. Finding 1 — findings register CRITICAL+OPEN parse theo cột ─────────

describe("gate bash — check_findings_register: CRITICAL+OPEN theo cột (finding 1)", () => {
  const REGISTER_HEADER = [
    "## Findings register",
    "",
    "| Severity | Status | File | Finding | Recommendation | Blocks launch |",
    "|---|---|---|---|---|---|",
  ];

  it("fixture có hàng | CRITICAL | OPEN | … | → check FAIL (regex cũ silent-pass)", () => {
    const f = fixtureFile(
      "sec-critical-open.md",
      [
        ...REGISTER_HEADER,
        "| CRITICAL | OPEN | src/x.ts | bad | fix | yes |",
        "",
        "**Tổng:** 1 CRITICAL.",
      ].join("\n"),
    );
    const r = bashGate(`check_findings_register '${f}'`);
    expect(r.status, "hàng CRITICAL+OPEN phải FAIL — không được im lặng qua").toBe(1);
    expect(r.stderr).toContain("CRITICAL + OPEN");
  });

  it("fixture sạch (MEDIUM ACCEPTED + LOW OPEN) → check PASS", () => {
    const f = fixtureFile(
      "sec-clean.md",
      [
        ...REGISTER_HEADER,
        "| MEDIUM | ACCEPTED | src/lib/actions/admin-identity.ts | FD-R58 | Founder review | no |",
        "| LOW | OPEN | next.config.ts | CSP Report-Only | flip header | no |",
      ].join("\n"),
    );
    const r = bashGate(`check_findings_register '${f}'`);
    expect(r.status, "không có CRITICAL+OPEN → PASS").toBe(0);
  });

  it("section '## Findings register' vắng → FAIL (không silent pass)", () => {
    const f = fixtureFile(
      "sec-nosection.md",
      ["| Severity | Status | File | Finding | Recommendation | Blocks launch |", "|---|---|---|---|---|---|", "| CRITICAL | OPEN | src/x.ts | bad | fix | yes |"].join("\n"),
    );
    const r = bashGate(`check_findings_register '${f}'`);
    expect(r.status, "section vắng phải FAIL").toBe(1);
    expect(r.stderr).toContain("Findings register");
  });

  it("findings register THẬT (security review) → PASS (không false-positive)", () => {
    const r = bashGate(`check_findings_register '${SECURITY_REVIEW_PATH}'`);
    expect(r.status, "security review thật không có CRITICAL+OPEN → PASS").toBe(0);
  });
});

// ── 5b. Finding 2 — pin hàng founder/user-run trong checklist ───────────────

describe("gate bash — gate_release_checklist: pin hàng founder/user-run (finding 2)", () => {
  const REQ_ENV = { RELEASE_GATE_REQUIRED_FOUNDER_REFS: "OPS-01 OPS-02" };

  /** Fixture checklist nhỏ: 2 hàng user-run bắt buộc + 1 hàng mirror đã quyết. */
  function checklistFixture(
    mutate: (rows: string[]) => string[] = (rows) => rows,
    mirrorDecision = "Đã quyết",
  ): string {
    const rows = mutate([
      "| OPS-01 | drill production | user-run | restore-drill --file | FOUNDER | Founder — 2026-10-10 |",
      "| OPS-02 | access review production | user-run | admin-access-review-prod | FOUNDER | Founder — 2026-10-10 |",
    ]);
    return [
      "| Ref | Criterion | Evidence type | Evidence | Status | Sign-off |",
      "|---|---|---|---|---|---|",
      ...rows,
      `| FD-R1 | mirror item | ${mirrorDecision} | 2026-10-10 |`,
    ].join("\n");
  }

  it("fixture sạch (đủ hàng bắt buộc FOUNDER + ký) → gate PASS", () => {
    const f = fixtureFile("cl-clean.md", checklistFixture());
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "checklist sạch phải PASS").toBe(0);
  });

  it("hàng user-run flip sang PASS (không chữ ký) → gate FAIL", () => {
    const f = fixtureFile(
      "cl-flip.md",
      checklistFixture((rows) => [
        rows[0]!.replace("| FOUNDER | Founder — 2026-10-10 |", "| PASS | Founder — 2026-10-10 |"),
        rows[1]!,
      ]),
    );
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "flip PASS không chữ ký phải FAIL").toBe(1);
    expect(r.stderr).toContain("OPS-01");
    expect(r.stderr).toContain("FOUNDER");
  });

  it("hàng user-run bị XOÁ → gate FAIL (xoá hàng không làm gate xanh)", () => {
    const f = fixtureFile("cl-delete.md", checklistFixture((rows) => [rows[1]!]));
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "thiếu hàng bắt buộc phải FAIL").toBe(1);
    expect(r.stderr).toContain("OPS-01");
    expect(r.stderr).toContain("thiếu hàng founder/user-run bắt buộc");
  });

  it("hàng founder/user-run MỚI (ngoài list) flip PASS cũng FAIL (rule theo Evidence type)", () => {
    const f = fixtureFile(
      "cl-newrow.md",
      checklistFixture((rows) => [
        ...rows,
        "| OPS-99 | hàng mới | user-run | evidence mới | PASS | — |",
      ]),
    );
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "hàng user-run mới Status PASS phải FAIL").toBe(1);
    expect(r.stderr).toContain("OPS-99");
  });

  it("Sign-off placeholder — (chờ founder) trên hàng FOUNDER → gate FAIL (finding 5)", () => {
    const f = fixtureFile(
      "cl-placeholder.md",
      checklistFixture((rows) => [
        rows[0]!.replace("Founder — 2026-10-10", "— (chờ founder)"),
        rows[1]!,
      ]),
    );
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "sign-off placeholder không là chữ ký").toBe(1);
    expect(r.stderr).toContain("OPS-01");
  });

  // ── Review 2026-10-10 vòng 2 (finding 5): mirror Decision whole-cell ──────

  it("FD-mirror Decision thật chứa 'chờ' + Date → hàng qua (whole-cell, không substring)", () => {
    const f = fixtureFile(
      "cl-mirror-real-decision.md",
      checklistFixture(
        (rows) => rows,
        "Chờ provider OTP (FD-R1) — chấp nhận trì hoãn launch",
      ),
    );
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(
      r.status,
      "decision thật chứa từ 'chờ' + date phải qua — FD-R69 'đợi provider (FD-R1)' là quyết định thật",
    ).toBe(0);
  });

  it("FD-mirror Decision 'PENDING' → gate FAIL (chưa quyết)", () => {
    const f = fixtureFile(
      "cl-mirror-pending.md",
      checklistFixture((rows) => rows, "PENDING"),
    );
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "PENDING nguyên ô phải bị từ chối").toBe(1);
    expect(r.stderr).toContain("FD-R1");
    expect(r.stderr).toContain("chưa quyết");
  });

  it("FD-mirror Decision '— (chờ founder)' → gate FAIL (placeholder không là quyết)", () => {
    const f = fixtureFile(
      "cl-mirror-placeholder.md",
      checklistFixture((rows) => rows, "— (chờ founder)"),
    );
    const r = bashGate(`gate_release_checklist '${f}'`, REQ_ENV);
    expect(r.status, "placeholder dash phải bị từ chối").toBe(1);
    expect(r.stderr).toContain("FD-R1");
    expect(r.stderr).toContain("chưa quyết");
  });
});

// ── 5c. Finding 5 — filled() từ chối placeholder NGUYÊN Ô (whole-cell) ───────

describe("gate bash — filled(): placeholder nguyên ô không là đã điền (finding 5 + vòng 2)", () => {
  // Review 2026-10-10 vòng 2 (finding 5): placeholder NGUYÊN Ô, KHÔNG substring
  // — "chờ founder" trần (không dash) không còn bị từ chối (không phải
  // placeholder ship nào — placeholder ship là "— (chờ founder)", dash rule
  // bắt); decision/sign-off THẬT chứa "chờ"/"pending"/"tbd" phải qua.
  const PLACEHOLDER_CELLS = [
    "— (chờ founder)", // placeholder ship của policy-review-record.md:23-28
    "—",
    "-",
    "PENDING",
    "pending",
    "TBD",
    "tbd",
    "chờ",
    "Chờ",
    " PENDING ", // trim hai đầu → đúng "PENDING" → vẫn bị từ chối
  ];
  for (const cell of PLACEHOLDER_CELLS) {
    it(`filled('${cell}') → CHƯA điền (exit ≠ 0)`, () => {
      const r = bashGate(`filled '${cell}'`);
      expect(r.status, `ô '${cell}' phải bị từ chối — gate yêu cầu TÊN founder`).not.toBe(0);
    });
  }

  it("filled(tên founder thật) → đã điền (exit 0)", () => {
    const r = bashGate(`filled 'Founder A'`);
    expect(r.status).toBe(0);
  });

  it("filled(decision thật chứa 'chờ') → đã điền (exit 0 — không substring)", () => {
    const r = bashGate(`filled 'Chờ provider OTP (FD-R1) — chấp nhận trì hoãn launch'`);
    expect(r.status, "decision thật chứa từ 'chờ' phải tính là đã điền (FD-R69: đợi provider)").toBe(0);
  });

  it("filled('Accept; pending provider') → đã điền (exit 0 — không substring)", () => {
    const r = bashGate(`filled 'Accept; pending provider'`);
    expect(r.status).toBe(0);
  });
});

// ── 5d. Finding 6 — chọn row duyệt khớp version+hash (row mới, không row đầu) ─

describe("gate bash — policy_record_row: chọn row khớp version+hash (finding 6)", () => {
  const hashA = "a".repeat(64); // v1 (history)
  const hashB = "b".repeat(64); // v2 (đang ship)
  const record = fixtureFile(
    "policy-record.md",
    [
      "| Policy | Version | sha256 (scripts/policy-hash.ts) | Reviewer | Reviewed at | Decision | Notes |",
      "|---|---|---|---|---|---|---|",
      `| seller_rules | v1 | ${hashA} | — (chờ founder) | — | PENDING | Placeholder (history) |`,
      `| seller_rules | v2 | ${hashB} | Founder | 2026-10-10 | APPROVED | Đã duyệt |`,
    ].join("\n"),
  );

  it("chọn row v2 khớp registry (không phải row v1 đầu tiên của key)", () => {
    const r = bashGate(`policy_record_row '${record}' seller_rules v2 ${hashB}`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("v2");
    expect(r.stdout).toContain("APPROVED");
    expect(r.stdout, "row v1 PENDING history không được chọn").not.toContain("PENDING");
  });

  it("không có row khớp version/hash → in rỗng (stale review — gate FAIL ở caller)", () => {
    const r = bashGate(`policy_record_row '${record}' seller_rules v1 ${hashB}`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim(), "không khớp → rỗng (caller fail-closed)").toBe("");
  });
});

// ── 5e. Finding 5+6 end-to-end — gate_policy_reviews với stub hash ──────────

describe("gate bash — gate_policy_reviews: history row + placeholder reviewer (finding 5+6)", () => {
  const POLICY_KEYS = [
    "terms",
    "privacy",
    "marketplace_rules",
    "seller_rules",
    "community_rules",
    "safety_guidance",
  ] as const;
  const hex = (c: string, n: number) => `${c.repeat(63)}${n}`; // 64 ký tự hex, khác nhau mỗi policy
  const hashes = POLICY_KEYS.map((_, i) => hex("a", i + 1));
  // seller_rules = v2 (kịch bản FD-R4 bump v1→v2); các policy khác v1.
  const stub = fixtureFile(
    "policy-hash-stub.txt",
    POLICY_KEYS.map((key, i) => {
      const version = key === "seller_rules" ? "v2" : "v1";
      return `${key} ${version} ${hashes[i]} REVIEWED`;
    }).join("\n") + "\n",
  );

  /** Fixture record: mọi policy có row APPROVED khớp stub; seller_rules GIỮ row v1 PENDING làm history. */
  function recordFixture(reviewerFor: (key: string) => string): string {
    const rows = POLICY_KEYS.map((key, i) => {
      const version = key === "seller_rules" ? "v2" : "v1";
      return `| ${key} | ${version} | ${hashes[i]} | ${reviewerFor(key)} | 2026-10-10 | APPROVED | ok |`;
    });
    const history = [`| seller_rules | v1 | ${hex("9", 1)} | — (chờ founder) | — | PENDING | Placeholder (history) |`];
    return [
      "| Policy | Version | sha256 (scripts/policy-hash.ts) | Reviewer | Reviewed at | Decision | Notes |",
      "|---|---|---|---|---|---|---|",
      ...rows.slice(0, 3),
      ...history,
      ...rows.slice(3),
    ].join("\n");
  }

  it("row v1 PENDING giữ làm history + row v2 APPROVED → gate PASS (duyệt hợp lệ không bị chặn)", () => {
    const record = fixtureFile("pr-history.md", recordFixture(() => "Founder"));
    const r = bashGate("gate_policy_reviews", {
      RELEASE_GATE_POLICY_RECORD: record,
      RELEASE_GATE_POLICY_HASH_CMD: `cat ${stub}`,
    });
    expect(r.status, "row duyệt v2 khớp registry → 6/6 policy qua").toBe(0);
    expect(r.stdout).toContain("6/6 policy");
  });

  it("Reviewer = '— (chờ founder)' (Decision APPROVED + date filled) → gate FAIL", () => {
    const record = fixtureFile(
      "pr-placeholder.md",
      recordFixture((key) => (key === "terms" ? "— (chờ founder)" : "Founder")),
    );
    const r = bashGate("gate_policy_reviews", {
      RELEASE_GATE_POLICY_RECORD: record,
      RELEASE_GATE_POLICY_HASH_CMD: `cat ${stub}`,
    });
    expect(r.status, "placeholder reviewer phải FAIL — cần TÊN founder").toBe(1);
    expect(r.stderr).toContain('policy "terms"');
    expect(r.stderr).toContain("Reviewer");
  });
});

// ── 5f. Drift pin — tập hàng bắt buộc của gate khớp checklist thật ───────────

describe("gate bash — RELEASE_GATE_REQUIRED_FOUNDER_REFS khớp checklist thật (drift pin)", () => {
  it("default của gate == mọi hàng Evidence type founder/user-run của checklist", () => {
    const checklist = readDoc(CHECKLIST_PATH);
    const founderRefs = parseChecklistRows(checklist)
      .filter((r) => isFounderOrUserRun(r))
      .map((r) => r.ref);
    expect(founderRefs.length, "checklist phải có hàng founder/user-run").toBeGreaterThan(0);
    const r = bashGate(`printf '%s\\n' "$RELEASE_GATE_REQUIRED_FOUNDER_REFS"`);
    expect(r.status).toBe(0);
    const gateRefs = r.stdout.trim().split(/\s+/).filter(Boolean);
    expect(
      [...gateRefs].sort(),
      "tập Ref bắt buộc của gate phải == tập hàng founder/user-run của checklist (thêm/bớt hàng mà quên update = FAIL)",
    ).toEqual([...founderRefs].sort());
  });
});

// ── 5g. Vòng 2 finding 6 — env override fixture bị từ chối NGOÀI test mode ──

describe("gate bash — fixture override env ngoài test mode → gate từ chối chạy (vòng 2 finding 6)", () => {
  /** Env sạch (không kế thừa bất kỳ RELEASE_GATE_* nào của process) + override. */
  function cleanEnvWith(override: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("RELEASE_GATE_")) delete env[k];
    }
    return { ...env, ...override };
  }

  const OVERRIDES = [
    "RELEASE_GATE_POLICY_RECORD",
    "RELEASE_GATE_POLICY_HASH_CMD",
    "RELEASE_GATE_CHECKLIST_DOC",
    "RELEASE_GATE_REQUIRED_FOUNDER_REFS",
  ];
  for (const v of OVERRIDES) {
    it(`${v} bị set (chạy thật, không source mode) → exit 1 NGAY, không gate nào chạy`, () => {
      const res = spawnSync("bash", [`${root}/${GATE_SCRIPT}`], {
        cwd: root,
        encoding: "utf8",
        env: cleanEnvWith({ [v]: "/tmp/fixture-override-phai-bi-tu-choi.md" }),
      });
      expect(res.error, `bash không chạy được: ${res.error ?? ""}`).toBeUndefined();
      expect(res.status, `${v} set ngoài test mode → gate phải từ chối chạy (fail-closed)`).toBe(1);
      expect(res.stderr).toContain(v);
      expect(res.stderr).toContain("chỉ dành cho fixture test");
      // Guard ở đầu script — KHÔNG gate nào được chạy (không có dòng GATE: nào).
      expect(res.stdout).not.toContain("GATE:");
    });
  }

  it("RELEASE_GATE_SOURCED=1 (source mode của fixture test) → override vẫn được phép", () => {
    const r = bashGate(`printf '%s\\n' "$RELEASE_GATE_POLICY_RECORD"`, {
      RELEASE_GATE_POLICY_RECORD: "/tmp/fixture-ok-trong-test-mode.md",
    });
    expect(r.status, "source mode (test) vẫn cho phép override — fixture test hoạt động").toBe(0);
    expect(r.stdout).toContain("/tmp/fixture-ok-trong-test-mode.md");
  });
});
