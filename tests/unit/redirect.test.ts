/**
 * safeNextPath — chống open redirect cho ?next= sau login/register.
 * Lỗi đã chứng minh: "/\\evil.com" qua WHATGWG URL parser → "//evil.com" (cross-origin).
 */
import { describe, expect, it } from "vitest";
import { safeNextPath } from "../../src/lib/redirect";

describe("safeNextPath", () => {
  it("chấp nhận path nội bộ thuần", () => {
    expect(safeNextPath("/orders")).toBe("/orders");
    expect(safeNextPath("/orders?tab=2")).toBe("/orders?tab=2");
    expect(safeNextPath("/san-pham/abc#reviews")).toBe("/san-pham/abc#reviews");
    expect(safeNextPath("/")).toBe("/");
  });

  it("chặn protocol-relative //evil.com", () => {
    expect(safeNextPath("//evil.com")).toBeNull();
  });

  it("chặn /\\evil.com — browser normalize \\ như / (open redirect đã chứng minh)", () => {
    expect(safeNextPath("/\\evil.com")).toBeNull();
  });

  it("chặn scheme tuyệt đối", () => {
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("chặn control chars — URL parser bỏ tab → '/\\tevil' thành host", () => {
    expect(safeNextPath("/\tevil.com")).toBeNull();
    expect(safeNextPath("/orders\n")).toBeNull();
    expect(safeNextPath("/\u0000")).toBeNull();
  });

  it("chặn chuỗi rỗng / null / undefined", () => {
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });

  it("backslash GIỮA path được URL parser normalize thành / — vẫn same-origin, an toàn", () => {
    // WHATGWG parser: chỉ backslash sau slash ĐẦU tạo protocol-relative (đã chặn);
    // giữa path parser normalize thành '/' → path thuần same-origin
    expect(safeNextPath("/orders\\evil")).toBe("/orders/evil");
  });
});
