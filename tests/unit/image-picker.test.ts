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
      // b4-holistic round-4 (LOW regression ×2): 429 UPLOAD_QUOTA (quota 24h
      // route app/api/upload) thiếu trong map → picker hiển thị RAW CODE tiếng
      // Anh "UPLOAD_QUOTA" — đúng lớp lỗi round-1 đã fix, tái xuất qua commit
      // quota. Route gửi kèm message tiếng Việt — picker ưu tiên message.
      "UPLOAD_QUOTA",
    ]) {
      expect(source).toContain(`${code}:`);
    }
    // lookup own-property-safe — ?error=__proto__ không resolve prototype
    expect(source).toContain("Object.hasOwn(UPLOAD_ERROR_TEXT, code)");
    // fallback generic khi rỗng (body không JSON)
    expect(source).toContain(': "Upload thất bại — thử lại"');
  });

  it("b4-holistic round-4: uploadErrorText ƯU TIÊN message tiếng Việt của route TRƯỚC khi rơi vào map/code", () => {
    // Route quota gửi {error:'UPLOAD_QUOTA', message:'Bạn đã tải tối đa 60 ảnh
    // trong 24 giờ.'} — message kèm SỐ LIỆU thật (cap) chính xác hơn map tĩnh.
    // Trước fix: message bị bỏ qua, code không có trong map → raw "UPLOAD_QUOTA".
    expect(source).toMatch(
      /if \(typeof json\.message === "string" && json\.message !== ""\) return json\.message;/,
    );
    // json type có message (uploadFile trả về nguyên body json của route)
    expect(source).toMatch(/json: \{ url\?: string; error\?: string; message\?: string \}/);
  });

  it("b4-holistic round-4 (LOW partial): RESERVE budget NGAY khi pick — onCountChange TRƯỚC vòng upload", () => {
    // Trước fix: count chỉ publish sau TOÀN BỘ file xong (re-encode mất vài
    // giây/file) → parent totalImages vẫn 0 trong lúc upload → pick slot khác
    // cùng lúc vượt cap toàn tin (mỗi save IMAGE_TOO_MANY sau khi đốt n× budget
    // upload token). Sau fix: reserve = urls.length + files.length NGAY khi
    // check pass, publish count THẬT sau (upload fail → nhả budget).
    const onPickStart = source.indexOf("async function onPick");
    const loopStart = source.indexOf("for (const file of files)", onPickStart);
    expect(onPickStart).toBeGreaterThanOrEqual(0);
    expect(loopStart).toBeGreaterThan(onPickStart);
    const beforeLoop = source.slice(onPickStart, loopStart);
    expect(beforeLoop).toContain("onCountChange?.(urls.length + files.length)");
    // pendingFiles giữ reservation qua remove() giữa chừng upload
    expect(source).toContain("const [pendingFiles, setPendingFiles] = useState(0)");
    expect(source).toMatch(/onCountChange\?\.\(next\.length \+ pendingFiles\)/);
    // message tràn hiển thị CÒN LẠI (max - urls.length), KHÔNG phải max nguyên
    expect(source).toContain("(${max - urls.length} ảnh còn lại)");
  });

  it("res.json() bọc try/catch — body không phải JSON không crash picker", () => {
    expect(source).toMatch(/try \{\s*json = \(await res\.json\(\)\)/);
    expect(source).toMatch(/} catch \{\s*json = \{\};/);
  });

  it("onCountChange báo count lên parent mỗi thay đổi (thêm qua publish, xoá qua publish)", () => {
    expect(source).toContain("onCountChange?: (count: number) => void");
    // count = ảnh đã gắn + file đang upload (reservation — b4-holistic round-4)
    expect(source).toMatch(/onCountChange\?\.\(next\.length \+ pendingFiles\)/);
    // chặn per-picker TRƯỚC upload theo max (budget toàn tin do parent truyền)
    expect(source).toContain("if (urls.length + files.length > max)");
  });
});
