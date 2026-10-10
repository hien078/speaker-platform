/**
 * Chat + listing surface XSS — source contract (Batch 8 Task 8b; spec §7.4
 * "stored XSS"; corrections 2026-10-08 item 5 + item 10).
 *
 * Hàng "Stored XSS through chat" của ma trận §10.1 trước đây chỉ cite
 * deal-ui.test.ts (Deal-side) — KHÔNG quét các surface chat. Test này là
 * gap-fill source-contract (pattern finance-public-surface.test.ts — đọc
 * file nguồn, không jsdom):
 *
 *  1. Chat surfaces (src/components/chat-window.tsx, app/chat/[id]/page.tsx,
 *     app/chat/page.tsx, MỌI src/components/chat-*.tsx): ZERO HTML sink
 *     (dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML) trong DÒNG
 *     CODE — hit trong comment không tính (strip comment whole-line/JSX).
 *  2. KHÔNG có href={`/src={` dựng từ NỘI DUNG TIN NHẮN (m.body) — link/ảnh
 *     từ message render dạng text hoặc qua component đã validate.
 *  3. Sink Ảnh DUY NHẤT được phép: <img src={m.imageUrl}> của chat-window.tsx
 *     — server-validated: POST /api/chat/[id] chặn imageUrl không khớp
 *     LISTING_IMAGE_URL_PATTERN (/uploads/<uuid>.<ext> — chặn scheme
 *     javascript:, traversal "..", mọi path ngoài /uploads) + ownership
 *     (ListingImageUpload.ownerUserId PHẢI là người gửi) TRƯỚC Message.create.
 *     Test PIN route validation bằng source-assert (import + dùng pattern
 *     trước Message.create) — sink client chỉ tin giá trị đã qua cổng đó.
 *  4. Body tin nhắn render React text thuần (whitespace-pre-wrap) — không
 *     qua HTML nào.
 *  5. Deal surfaces (MỌI src/components/deal-*.tsx): ZERO HTML sink;
 *     cancellationReason (untrusted, D3) render React text trong deal-panel.
 *  6. Listing surfaces (gap hàng "Stored XSS through listing" — corrections
 *     item 10): app/listings/[slug]/page.tsx, app/seller/[id]/page.tsx,
 *     src/components/listing-card.tsx, src/components/portable-listing-form.tsx
 *     — ZERO HTML sink trong dòng code (mô tả/diễn đàn text render React text).
 *
 * Contract test (Batch 4 Task 8 precedent): các case là source-scan nên CÓ
 * THỂ pass ngay ở lần chạy đầu — ghi nhận case nào pass-first-run trong
 * report; vi phạm mới = defect của file SỞ HỮU (sửa ở đó, không weaken scan).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

/**
 * Bỏ comment — comment nguồn không phải code render (pattern
 * copy-safety.test.ts): (a) block comment JSX `{/* … *\/}` thay bằng dấu
 * cách; (b) dòng thuần comment (docblock ` * …`, `// …`, `/* …`, `<!-- …`)
 * bỏ cả dòng. Dòng code giữ nguyên — comment cuối dòng KHÔNG bị bỏ (hit
 * trong đó vẫn bị soi — hướng bảo thủ).
 */
const stripComments = (text: string) =>
  text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*|<!--)/.test(line))
    .join("\n");

/** Nguồn đã strip comment — HTML sink trong ĐÒNG CODE mới là vi phạm. */
const code = (p: string) => stripComments(read(p));

/** Mọi src/components/<prefix>-*.tsx — file mới tự vào scope (glob động). */
const componentGlob = (prefix: string) =>
  readdirSync(`${root}/src/components`)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".tsx"))
    .map((f) => `src/components/${f}`);

const HTML_SINKS = ["dangerouslySetInnerHTML", "innerHTML", "insertAdjacentHTML"] as const;

/** Chat surfaces — chat-window + 2 trang chat + mọi chat-*.tsx (glob động). */
const CHAT_SURFACES = [
  "src/components/chat-window.tsx",
  "app/chat/[id]/page.tsx",
  "app/chat/page.tsx",
  ...componentGlob("chat"),
].filter((p, i, a) => a.indexOf(p) === i); // chat-window.tsx xuất hiện 2 lần (list + glob) — dedupe

/** Deal surfaces — mọi deal-*.tsx (glob động). */
const DEAL_SURFACES = componentGlob("deal");

/** Listing surfaces (corrections item 10 — gap "Stored XSS through listing"). */
const LISTING_SURFACES = [
  "app/listings/[slug]/page.tsx",
  "app/seller/[id]/page.tsx",
  "src/components/listing-card.tsx",
  "src/components/portable-listing-form.tsx",
] as const;

// ─── 1. Chat surfaces — zero HTML sink ──────────────────────────────────────

describe("Stored XSS through chat — chat surfaces ZERO HTML sink (dòng code)", () => {
  it("mọi chat surface tồn tại (glob rỗng = walker hỏng — không được im lặng pass)", () => {
    expect(CHAT_SURFACES.length).toBeGreaterThanOrEqual(3);
    expect(CHAT_SURFACES).toContain("src/components/chat-window.tsx");
    for (const p of CHAT_SURFACES) {
      expect(read(p).length, `${p} phải tồn tại`).toBeGreaterThan(0);
    }
  });

  it("ZERO dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML trong dòng code", () => {
    for (const p of CHAT_SURFACES) {
      const src = code(p);
      for (const sink of HTML_SINKS) {
        expect(src, `${p} không được chứa ${sink} trong dòng code`).not.toContain(sink);
      }
    }
  });

  it("KHÔNG có href={`/src={` dựng từ nội dung tin nhắn (m.body)", () => {
    for (const p of CHAT_SURFACES) {
      const src = code(p);
      expect(
        src,
        `${p}: link/ảnh từ nội dung tin phải render text, không interpolate vào HTML sink`,
      ).not.toMatch(/(?:src|href)=\{[^}]*\bm\.body\b/);
    }
  });

  it("body tin nhắn render React text thuần (whitespace-pre-wrap) — không qua HTML", () => {
    const src = read("src/components/chat-window.tsx");
    expect(src).toContain(`<p className="whitespace-pre-wrap">{m.body}</p>`);
  });
});

// ─── 2. Sink ảnh duy nhất được phép — server-validated m.imageUrl ────────────

describe("Sink ảnh chat — m.imageUrl được phép VÀ được ghim bằng route validation", () => {
  it("chat-window.tsx có đúng MỘT sink ảnh: <img src={m.imageUrl}> (corrections item 5)", () => {
    const src = read("src/components/chat-window.tsx");
    // Sink được phép — pin để một refactor đổi sang HTML sink làm test đỏ
    expect(src).toContain("<img src={m.imageUrl}");
    // Mọi src={ khác trong chat-window KHÔNG được dựng từ m. gì khác (chỉ imageUrl)
    const srcInterpolations = src.match(/src=\{[^}]*\}/g) ?? [];
    expect(srcInterpolations).toEqual(["src={m.imageUrl}"]);
  });

  it("POST /api/chat/[id] import LISTING_IMAGE_URL_PATTERN và dùng TRƯỚC Message.create", () => {
    const route = read("app/api/chat/[id]/route.ts");
    // Import từ module Batch 4 (KHÔNG tự chế pattern mới)
    expect(route).toContain('import { LISTING_IMAGE_URL_PATTERN } from "@/src/lib/listing-images"');
    // Dùng pattern trong handler (gate trước ownership read)
    expect(route).toMatch(/LISTING_IMAGE_URL_PATTERN\.test\(/);
    // Gate PHẢI đứng trước Message.create (thứ tự dòng — vi phạm = route ghi
    // tin với imageUrl chưa validate)
    const lines = route.split("\n");
    const patternLine = lines.findIndex((l) => l.includes("LISTING_IMAGE_URL_PATTERN.test("));
    const createLine = lines.findIndex((l) => l.includes("Message.create("));
    expect(patternLine, "pattern check phải tồn tại trong route").toBeGreaterThanOrEqual(0);
    expect(createLine, "Message.create phải tồn tại trong route").toBeGreaterThanOrEqual(0);
    expect(patternLine).toBeLessThan(createLine);
  });

  it("route chặn cả ownership: upload row phải thuộc CHÍNH người gửi (Batch 4 rule 1)", () => {
    const route = read("app/api/chat/[id]/route.ts");
    expect(route).toContain("MESSAGE_IMAGE_INVALID");
    expect(route).toMatch(/upload\.ownerUserId !== user\.id/);
  });
});

// ─── 3. Deal surfaces — zero HTML sink ───────────────────────────────────────

describe("Deal surfaces (src/components/deal-*.tsx) — ZERO HTML sink", () => {
  it("mọi deal surface tồn tại (glob rỗng = walker hỏng)", () => {
    expect(DEAL_SURFACES.length).toBeGreaterThanOrEqual(3);
    expect(DEAL_SURFACES).toContain("src/components/deal-panel.tsx");
  });

  it("ZERO dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML trong dòng code", () => {
    for (const p of DEAL_SURFACES) {
      const src = code(p);
      for (const sink of HTML_SINKS) {
        expect(src, `${p} không được chứa ${sink} trong dòng code`).not.toContain(sink);
      }
    }
  });

  it("cancellationReason (untrusted, D3) render React text trong deal-panel — không HTML", () => {
    const src = read("src/components/deal-panel.tsx");
    expect(src).toContain("{deal.cancellationReason}");
    expect(code("src/components/deal-panel.tsx")).not.toMatch(
      /dangerouslySetInnerHTML[^}]*cancellationReason/,
    );
  });
});

// ─── 4. Listing surfaces (corrections item 10 — gap "Stored XSS through listing") ──

describe("Listing surfaces — ZERO HTML sink trong dòng code (mô tả render React text)", () => {
  it("mọi listing surface tồn tại", () => {
    for (const p of LISTING_SURFACES) {
      expect(read(p).length, `${p} phải tồn tại`).toBeGreaterThan(0);
    }
  });

  it("ZERO dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML trong dòng code (comment không tính)", () => {
    for (const p of LISTING_SURFACES) {
      const src = code(p);
      for (const sink of HTML_SINKS) {
        expect(src, `${p} không được chứa ${sink} trong dòng code`).not.toContain(sink);
      }
    }
  });
});
