/**
 * ImagePicker (b4-holistic round-1 LOW form-action-contract) — source-contract:
 * đọc source component, assert hợp đồng upload qua hàng đợi + message tiếng Việt.
 *
 * Không jsdom (repo không có browser/E2E infra — precedent portable-listing-form).
 * Hợp đồng (b4-holistic findings 12/13 + round-3 upload-resource):
 *  1. MỌI fetch /api/upload đi qua HÀNG ĐỢI module-level (enqueueUpload) —
 *     8 picker của form 7 bước không POST song song đâm lock 1-in-flight/user.
 *  2. 429 UPLOAD_IN_PROGRESS / 503 TOO_BUSY → retry theo Retry-After (bounded
 *     MAX_UPLOAD_ATTEMPTS, fallback + trần) — KHÔNG drop file ở lần chạm đầu.
 *  3. Typed code → text tiếng Việt qua map own-property-safe (Object.hasOwn) —
 *     KHÔNG hiển thị raw code ("UPLOAD_IN_PROGRESS") cho seller.
 *  4. res.json() bọc try/catch — body không JSON (proxy 413/502) → generic.
 *  5. onCountChange: count lift lên parent — cap ảnh TOÀN TIN sống ở
 *     PortableListingForm (không phải 8/picker).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = readFileSync(`${root}/src/components/image-picker.tsx`, "utf8");

describe("ImagePicker — upload queue + Vietnamese messages (b4-holistic)", () => {
  it("MỌI upload đi qua hàng đợi module-level — serialize giữa các picker instance", () => {
    expect(source).toContain("let uploadChain: Promise<unknown> = Promise.resolve()");
    expect(source).toContain("function enqueueUpload");
    // request bị từ chối vẫn nhả chuỗi cho request kế tiếp
    expect(source).toContain("uploadChain.then(fn, fn)");
    // fetch upload đi qua enqueueUpload (trong uploadFile), KHÔNG fetch trực tiếp
    const fetchCallSites = source.match(/await fetch\("\/api\/upload"/g) ?? [];
    expect(fetchCallSites).toHaveLength(1);
    expect(source).toMatch(/return enqueueUpload\(async \(\) => \{/);
  });

  it("429 UPLOAD_IN_PROGRESS / 503 TOO_BUSY → retry theo Retry-After, bounded", () => {
    expect(source).toContain("const MAX_UPLOAD_ATTEMPTS = 3");
    expect(source).toContain('res.status === 429 && code === "UPLOAD_IN_PROGRESS"');
    expect(source).toContain('res.status === 503 && code === "TOO_BUSY"');
    expect(source).toMatch(/res\.headers\.get\("retry-after"\)/);
    expect(source).toContain("const RETRY_AFTER_FALLBACK_SEC = 5");
    expect(source).toContain("const RETRY_AFTER_MAX_SEC = 15");
    // vòng retry bounded — attempt < MAX mới continue
    expect(source).toContain("attempt < MAX_UPLOAD_ATTEMPTS");
  });

  it("typed code → text tiếng Việt, own-property-safe — KHÔNG raw code", () => {
    expect(source).toContain("const UPLOAD_ERROR_TEXT: Record<string, string> = {");
    for (const code of [
      "UPLOAD_IN_PROGRESS",
      "TOO_BUSY",
      "RATE_LIMITED",
      "ACCOUNT_SUSPENDED",
      "UNAUTHENTICATED",
      "CONTENT_LENGTH_REQUIRED",
      "INVALID_CONTENT_LENGTH",
      "INVALID_BODY",
      "UPLOAD_FAILED",
    ]) {
      expect(source).toContain(`${code}:`);
    }
    // lookup own-property-safe — ?error=__proto__ không resolve prototype
    expect(source).toContain("Object.hasOwn(UPLOAD_ERROR_TEXT, code)");
    // fallback generic khi rỗng (body không JSON)
    expect(source).toContain(': "Upload thất bại — thử lại"');
  });

  it("res.json() bọc try/catch — body không phải JSON không crash picker", () => {
    expect(source).toMatch(/try \{\s*json = \(await res\.json\(\)\)/);
    expect(source).toMatch(/} catch \{\s*json = \{\};/);
  });

  it("onCountChange báo count lên parent mỗi thay đổi (thêm qua publish, xoá qua publish)", () => {
    expect(source).toContain("onCountChange?: (count: number) => void");
    expect(source).toContain("onCountChange?.(next.length)");
    // chặn per-picker TRƯỚC upload theo max (budget toàn tin do parent truyền)
    expect(source).toContain("if (urls.length + files.length > max)");
  });
});
