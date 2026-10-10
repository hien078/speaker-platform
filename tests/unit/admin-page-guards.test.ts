/**
 * Regression net — MỌI trang admin phải TỰ guard server-side (spec §4.5/§4.9,
 * plan Acceptance Gate "every admin page/action guarded server-side").
 *
 * Enumerate đệ quy mọi file page.tsx dưới app/admin (trang mới tự rơi vào
 * lưới — không cần sửa test khi thêm trang) và assert source gọi
 * requireCapability( hoặc requireAdminUser(. Layout là cổng vào /admin
 * nhưng KHÔNG thay guard
 * trang (spec §4.5: hidden nav không phải authorization); guard action
 * assert ở hợp đồng action riêng (rbac.test.ts, financial-shutdown-actions).
 *
 * Source scan thuần (node:fs) — không mock, không db.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const adminDir = join(root, "app", "admin");

/** Mọi file page.tsx dưới app/admin (đệ quy — kể cả route lồng tương lai). */
function adminPageFiles(): string[] {
  const pages: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(join(dir, ent.name));
      else if (ent.isFile() && ent.name === "page.tsx") pages.push(join(dir, ent.name));
    }
  };
  walk(adminDir);
  return pages.sort();
}

describe("app/admin/**/page.tsx — guard server-side bắt buộc (spec §4.5)", () => {
  it("mọi trang admin gọi requireCapability( hoặc requireAdminUser(", () => {
    const pages = adminPageFiles();
    // sanity: lưới phải bắt được các trang hiện có — walk hỏng không được im lặng pass
    expect(pages.length, "phải enumerate được các trang admin hiện có").toBeGreaterThan(0);

    const GUARD = /requireCapability\(|requireAdminUser\(/;
    for (const abs of pages) {
      const src = readFileSync(abs, "utf8");
      const rel = relative(root, abs); // đường dẫn tương đối repo-root
      expect(src, `${rel} phải tự guard server-side (spec §4.5)`).toMatch(GUARD);
    }
  });
});
