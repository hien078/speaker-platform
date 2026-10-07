/**
 * Listing error text + own-property-safe label lookup (Batch 4 Task 5
 * review fix LOW-1) — hợp đồng của src/lib/listing-error-text.ts.
 *
 * Lỗ được fix: `SUBMIT_ERROR_TEXT[submitError]` với submitError từ
 * ?error= (USER-controlled query param) resolve được key PROTOTYPE —
 * `?error=__proto__` trả Object.prototype (object — React child crash),
 * `?error=constructor` trả function (render rỗng/crash). Lookup phải là
 * own-property-safe (Object.hasOwn) + generic fallback fail-closed.
 *
 * Hợp đồng:
 *  1. labelOf: CHỈ resolve own property — "__proto__"/"constructor"/
 *     "toString"/unknown/null/undefined → fallback; mọi entry thật của
 *     map resolve đúng text.
 *  2. submitErrorText: mỗi code đã biết → text tiếng Việt của map; code
 *     lạ + prototype key + null → generic CONTENT_INVALID (fail closed —
 *     KHÔNG phản chiếu query text).
 *  3. SUBMIT_ERROR_TEXT: đủ code redirect của submitListingAction
 *     (content codes + RATE_LIMITED + CONTENT_INVALID), CONCURRENT_CHANGE
 *     (defense-in-depth — CAS claim conflict) + LISTING_HAS_ORDERS
 *     (review-fix gọi đích danh; chưa có action nào phát hành — giữ sẵn
 *     để lookup không miss khi code đến).
 */
import { describe, expect, it } from "vitest";
import {
  labelOf,
  SUBMIT_ERROR_TEXT,
  submitErrorText,
} from "@/src/lib/listing-error-text";

/** Text generic fail-closed — pin nguyên văn (fallback của mọi giá trị lạ). */
const GENERIC = "Nội dung tin chưa hợp lệ — kiểm tra lại các bước";

describe("labelOf — own-property-safe lookup (LOW-1)", () => {
  const MAP: Record<string, string> = {
    good: "Còn tốt",
    used: "Đã qua sử dụng",
  };

  it("key có trong map → text của map", () => {
    expect(labelOf(MAP, "good", "fallback")).toBe("Còn tốt");
    expect(labelOf(MAP, "used", "fallback")).toBe("Đã qua sử dụng");
  });

  it('"__proto__" → fallback (KHÔNG resolve Object.prototype)', () => {
    const out = labelOf(MAP, "__proto__", "fallback");
    expect(out).toBe("fallback");
    expect(typeof out).toBe("string");
  });

  it('"constructor" → fallback (KHÔNG resolve Object.prototype.constructor)', () => {
    const out = labelOf(MAP, "constructor", "fallback");
    expect(out).toBe("fallback");
    expect(typeof out).toBe("string");
  });

  it("key lạ (kể cả key có trên prototype: toString/hasOwnProperty) → fallback", () => {
    expect(labelOf(MAP, "toString", "fallback")).toBe("fallback");
    expect(labelOf(MAP, "hasOwnProperty", "fallback")).toBe("fallback");
    expect(labelOf(MAP, "khong-ton-tai", "fallback")).toBe("fallback");
  });

  it("null/undefined → fallback", () => {
    expect(labelOf(MAP, null, "fallback")).toBe("fallback");
    expect(labelOf(MAP, undefined, "fallback")).toBe("fallback");
  });

  it("mọi entry thật của map đều resolve qua labelOf (không entry nào rơi fallback)", () => {
    for (const [key, text] of Object.entries(MAP)) {
      expect(labelOf(MAP, key, "fallback")).toBe(text);
    }
  });
});

describe("submitErrorText — ?error= banner (LOW-1)", () => {
  it("mọi code đã biết → text tiếng Việt của map (không rơi vào generic)", () => {
    expect(Object.keys(SUBMIT_ERROR_TEXT).length).toBeGreaterThan(0);
    for (const [code, text] of Object.entries(SUBMIT_ERROR_TEXT)) {
      expect(submitErrorText(code)).toBe(text);
    }
  });

  // pin đích danh các code review-fix yêu cầu (LOW-1)
  it.each([
    ["CONCURRENT_CHANGE", "Tin vừa thay đổi trạng thái — tải lại trang và kiểm tra lại"],
    ["RATE_LIMITED", "Bạn thao tác quá nhanh — thử lại sau ít phút"],
    ["PROVINCE_INVALID", "Mã tỉnh/thành phố không hợp lệ"],
    ["PROVINCE_REQUIRED", "Chọn tỉnh/thành phố"],
    ["LISTING_HAS_ORDERS", "Tin đang có đơn hàng liên quan — không thể thao tác"],
  ])("code %s → text pin nguyên văn", (code, text) => {
    expect(submitErrorText(code)).toBe(text);
  });

  it("CONTENT_INVALID là text generic (fallback của mọi giá trị lạ)", () => {
    expect(SUBMIT_ERROR_TEXT.CONTENT_INVALID).toBe(GENERIC);
  });

  it('"__proto__" → generic (KHÔNG trả Object.prototype — React child crash)', () => {
    const out = submitErrorText("__proto__");
    expect(out).toBe(GENERIC);
    expect(typeof out).toBe("string");
  });

  it('"constructor" → generic (KHÔNG trả function)', () => {
    const out = submitErrorText("constructor");
    expect(out).toBe(GENERIC);
    expect(typeof out).toBe("string");
  });

  it("code lạ → generic (fail closed — KHÔNG phản chiếu query text)", () => {
    expect(submitErrorText("SOMETHING_ELSE")).toBe(GENERIC);
    expect(submitErrorText("<script>alert(1)</script>")).toBe(GENERIC);
    expect(submitErrorText("")).toBe(GENERIC);
  });

  it("null/undefined → generic", () => {
    expect(submitErrorText(null)).toBe(GENERIC);
    expect(submitErrorText(undefined)).toBe(GENERIC);
  });

  it("map KHÔNG có own key prototype (__proto__/constructor không phải entry)", () => {
    expect(Object.hasOwn(SUBMIT_ERROR_TEXT, "__proto__")).toBe(false);
    expect(Object.hasOwn(SUBMIT_ERROR_TEXT, "constructor")).toBe(false);
    expect(Object.keys(SUBMIT_ERROR_TEXT)).not.toContain("__proto__");
    expect(Object.keys(SUBMIT_ERROR_TEXT)).not.toContain("constructor");
  });
});
