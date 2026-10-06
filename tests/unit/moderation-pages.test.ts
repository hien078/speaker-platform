/**
 * Moderation console pages — source-contract (Batch 3 plan Task 6, spec §4.5/
 * §4.9 backend authorization + §5.5.1 evidence audited + §10.1 Stored XSS).
 *
 * Phong cách tests/unit/finance-public-surface.test.ts: đọc SOURCE trang,
 * assert ranh giới (không render component — guard/db chạy trong behavioral
 * test khác). Hợp đồng (plan Task 6 Step 1):
 *  1. Queue + detail gọi requireCapability("report.resolve") TRƯỚC mọi db read
 *     (moderation-resource IDOR — Review Focus 3; hidden nav không phải
 *     authorization, trang tự guard).
 *  2. Detail page audit MỌI lần xem evidence (moderation.evidence_viewed —
 *     spec §5.5.1 "separately audited").
 *  3. KHÔNG dangerouslySetInnerHTML trong moderation pages (stored XSS qua
 *     report note/message body — spec §10.1; mọi nội dung untrusted render
 *     React text).
 *  4. Detail page KHÔNG select/render thông tin danh tính thô của subject
 *     (fail-closed user.view_basic — A1: moderator không giữ capability đó).
 *  5. Form suspend/lift CHỈ render dưới capability check user.suspend
 *     (capabilitiesOf(...).includes — UI convenience, action tự guard).
 *  6. Nav entry "Báo cáo & kiểm duyệt" lọc theo report.resolve (layout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const QUEUE = "app/admin/moderation/page.tsx";
const DETAIL = "app/admin/moderation/[id]/page.tsx";
const LAYOUT = "app/admin/layout.tsx";
const APPEAL_PAGE = "app/appeal/[caseId]/page.tsx";

// ─── 1. Guard server-side trước mọi db read (spec §4.5/§4.9) ─────────────────

describe("moderation pages — requireCapability(report.resolve) trước db read (Review Focus 3)", () => {
  it.each([[QUEUE], [DETAIL]])("%s tự guard server-side", (page) => {
    const src = read(page);
    // guard tồn tại…
    expect(src).toContain('requireCapability("report.resolve")');
    // …vÀ đứng TRƯỚC mọi db read (index nhỏ hơn — không đọc case/evidence
    // trước khi capability đã được kiểm tra)
    const guardIdx = src.indexOf('requireCapability("report.resolve")');
    const dbIdx = src.indexOf("db.orm.public");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(dbIdx).toBeGreaterThan(guardIdx);
  });

  it.each([[QUEUE], [DETAIL]])("%s là force-dynamic (không cache trang admin)", (page) => {
    expect(read(page)).toContain('export const dynamic = "force-dynamic"');
  });
});

// ─── 2. Evidence view audited (spec §5.5.1) ──────────────────────────────────

describe("detail page — evidence view được audit (moderation.evidence_viewed)", () => {
  it("source gọi auditEvent với action moderation.evidence_viewed (separately audited)", () => {
    const src = read(DETAIL);
    // spec §5.5.1 "separately audited" — mọi lần xem bằng chứng ghi vết audit.
    // (Hành vi per-render — spy bắn đúng 1 lần/render — pin ở Task 8
    // audit-append.test.ts E2; ở đây chỉ pin hợp đồng source.)
    expect(src).toContain("auditEvent");
    expect(src).toContain('"moderation.evidence_viewed"');
  });
});

// ─── 3. Stored XSS — KHÔNG dangerouslySetInnerHTML (spec §10.1) ──────────────

describe("moderation pages — KHÔNG dangerouslySetInnerHTML (stored XSS qua report)", () => {
  it.each([[QUEUE], [DETAIL], [APPEAL_PAGE]])("%s render untrusted content chỉ qua React text", (page) => {
    expect(read(page)).not.toContain("dangerouslySetInnerHTML");
  });
});

// ─── 3b. Appeal page (Task 7 review L1) — subject-only surface ───────────────

describe("appeal page — subject-only surface (Task 7 review L1)", () => {
  it("requireUser TRƯỚC mọi db read (IDOR — không đọc case khi chưa đăng nhập)", () => {
    const src = read(APPEAL_PAGE);
    const guardIdx = src.indexOf("requireUser()");
    const dbIdx = src.indexOf("db.orm.public");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(dbIdx).toBeGreaterThan(guardIdx);
  });

  it("KHÔNG query AbuseReport — reporter identities không bao giờ đến được trang subject", () => {
    const src = read(APPEAL_PAGE);
    expect(src).not.toContain("AbuseReport");
  });

  it("KHÔNG render evidence snapshot — ModerationEvidence chỉ dùng resolve subjectUserId", () => {
    const src = read(APPEAL_PAGE);
    // chỉ MỘT query evidence (resolve subject, .first) — không select snapshot
    expect(src).toContain("ModerationEvidence");
    expect(src).not.toContain("relevantSnapshot");
    expect(src).not.toContain("sourceResourceId");
  });

  it("state gating (L2): actioned/appealed/closed mới render — còn lại notFound", () => {
    const src = read(APPEAL_PAGE);
    expect(src).toContain("notFound()");
    expect(src).toMatch(/actioned/);
    expect(src).toMatch(/appealed/);
    expect(src).toMatch(/closed/);
  });
});

// ─── 3c. Detail page — recusal on views (review fix Task 6 item 3) ────────────

describe("detail page — recusal on views (item 3): subject/reporter KHÔNG xem được case", () => {
  it("conflict check (isCaseViewerConflicted) chạy TRƯỚC mọi read phục vụ render", () => {
    const src = read(DETAIL);
    // check tồn tại…
    expect(src).toContain("isCaseViewerConflicted");
    // …vÀ đứng TRƯỚC read reports/evidence/actions/appeal (Promise.all render)
    const checkIdx = src.indexOf("isCaseViewerConflicted");
    const renderReadsIdx = src.indexOf("AbuseReport");
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(renderReadsIdx).toBeGreaterThan(checkIdx);
  });

  it("conflicted viewer → notFound() (không phải trang denial riêng — không existence oracle)", () => {
    const src = read(DETAIL);
    const checkIdx = src.indexOf("isCaseViewerConflicted");
    const notFoundIdx = src.indexOf("notFound()", checkIdx);
    expect(notFoundIdx).toBeGreaterThan(checkIdx);
  });
});

// ─── 4. PII minimization — subject KHÔNG bị select/render danh tính thô ───────

describe("detail page — KHÔNG select/render thông tin danh tính thô của subject (A1 fail closed)", () => {
  it("source KHÔNG chứa email/phone trong bất kỳ projection nào", () => {
    const src = read(DETAIL);
    // moderator không giữ user.view_basic — mọi select/include trên User
    // chỉ được mang id/name. Pin chặt: chuỗi "email"/"phone" KHÔNG xuất hiện
    // trong source (kể cả projection — fail closed thay vì quy ước review).
    expect(src).not.toContain("email");
    expect(src).not.toContain("phone");
  });
});

// ─── 5. Suspend/lift form chỉ render dưới capability check ──────────────────

describe("detail page — suspend/lift form lọc theo user.suspend (UI convenience)", () => {
  it("source guard bằng capabilitiesOf(...).includes(\"user.suspend\")", () => {
    const src = read(DETAIL);
    expect(src).toContain("capabilitiesOf(");
    expect(src).toContain('includes("user.suspend")');
  });

  it("form suspend mang caseId + trường TOTP step-up (A9 — §5.4.2)", () => {
    const src = read(DETAIL);
    expect(src).toContain('name="caseId"');
    expect(src).toContain('name="totpCode"');
  });
});

// ─── 6. Nav entry lọc theo capability (layout — Batch 2 Task 9 pattern) ──────

describe("admin nav — entry Báo cáo & kiểm duyệt lọc theo report.resolve", () => {
  it("layout có nav entry /admin/moderation + capability report.resolve", () => {
    const src = read(LAYOUT);
    expect(src).toContain('"/admin/moderation"');
    expect(src).toContain('capability: "report.resolve"');
    expect(src).toContain("Báo cáo & kiểm duyệt");
  });
});
