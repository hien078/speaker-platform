/**
 * app/sell/error.tsx (b4-holistic round-3 LOW — error boundary /sell) —
 * source-contract: nút "Thử lại" PHẢI re-fetch server payload.
 *
 * b4-holistic round-4 SPLIT (1/2 verifier — ĐÃ CHECK, finding THẬT):
 * Next 16.3 docs (node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md): `retry` prop stable từ v16.3.0 — "When
 * executed, the function will try to RE-FETCH and RE-RENDER the error
 * boundary's children"; `reset` chỉ "clear the error state and re-render
 * WITHOUT RE-FETCHING the contents" (docs: "In most cases, you should use
 * retry() instead"). Boundary này tồn tại chính vì LỖI SERVER-RENDER (lỗi
 * infra DB khi render /sell/my, /sell/[id]/edit — Server Component) —
 * reset() re-render children từ payload ĐÃ LỖI → cùng lỗi render lại,
 * nút "Thử lại" không làm gì; retry() mới re-fetch RSC payload mới.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = readFileSync(`${root}/app/sell/error.tsx`, "utf8");

describe("app/sell/error.tsx — 'Thử lại' retry() re-fetch (b4-holistic round-4 SPLIT)", () => {
  it("component nhận prop retry và nút Thử lại gọi retry() — KHÔNG reset()", () => {
    // signature: { error, retry } — retry stable v16.3 (docs error.md)
    expect(source).toMatch(/\{\s*error,\s*retry,\s*\}/);
    expect(source).toMatch(/retry: \(\) => void/);
    // nút gọi retry()
    expect(source).toMatch(/onClick=\{\(\) => retry\(\)\}/);
    // KHÔNG dùng reset trong CODE — re-render không re-fetch không retry được
    // lỗi server-render (payload đã lỗi render lại cùng lỗi). (Comment doc
    // được phép nhắc reset — chỉ pin signature + call-site.)
    expect(source).not.toMatch(/reset\(\)/);
    expect(source).not.toMatch(/\{\s*error,\s*reset/);
    expect(source).not.toMatch(/reset: \(\) => void/);
  });

  it("KHÔNG echo error.message (production sanitize; message có thể chứa SQL text)", () => {
    expect(source).toMatch(/void error/);
    expect(source).not.toMatch(/\{error\.message\}|\{error\}/);
  });

  it("vẫn là client component (error boundary phải là Client Component)", () => {
    expect(source).toContain('"use client"');
  });
});
