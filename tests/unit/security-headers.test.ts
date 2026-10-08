/**
 * Security headers — §7.4 effective-headers contract (Batch 8 Task 8a; spec §7.4;
 * corrections 2026-10-08 items 4 + 23).
 *
 * KHÔNG phải source-presence scan — test ĐÁNH GIÁ OUTPUT `headers()` của
 * next.config.ts và tính header HIỆU DỤNG theo path với last-match-wins
 * (node_modules/next/dist/docs/01-app/03-api-reference/05-config/
 * 01-next-config-js/headers.md:47 — "If two headers match the same path and
 * set the same header key, the last header key will override the first").
 *
 * Hợp đồng cấu trúc (corrections item 4 — app-wide entry ĐỨNG ĐẦU mảng):
 *  - element [0] = app-wide `"/((?!uploads/).*)"` — mọi path trừ /uploads/*;
 *  - Batch 4 `"/uploads/:path*"` (nosniff + CSP `default-src 'none'; sandbox`)
 *    và Batch 7 `"/invite/:token"` (Referrer-Policy no-referrer) + `"/invite"`
 *    (X-Robots-Tag noindex) theo SAU, NGUYÊN VẸN, và THẮNG trên key của mình
 *    (last-match-wins). App-wide ĐƯỢC ĐẶT ĐẦU là điều kiện để no-referrer
 *    còn thắng trên /invite/<token> (đảo thứ tự → app-wide đè → mở lại RR-21).
 *  - /uploads bị loại khỏi source regex app-wide: Report-Only là KEY KHÁC
 *    so với Content-Security-Policy nên nếu không loại, /uploads sẽ nhận CẢ HAI.
 *
 * Hiệu lực theo path (corrections item 4):
 *  - /uploads/x      → CHỈ CSP sandbox của Batch 4, KHÔNG Report-Only;
 *  - /invite/<token> → Referrer-Policy: no-referrer + X-Robots-Tag: noindex;
 *  - /invite         → strict-origin-when-cross-origin, KHÔNG no-referrer
 *                      (corrections #8: no-referrer trên /invite gửi Origin
 *                      null trên action POST cùng origin → Next CSRF reject);
 *  - path app thường → Report-Only CSP + nosniff + HSTS + X-Frame-Options DENY.
 *
 * CSP value (corrections item 23 — theo guide đã cài
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md
 * "Without Nonces"): default-src/script-src/style-src/img-src (giữ
 * https://res.cloudinary.com theo images.remotePatterns) + font-src 'self'
 * + worker-src 'self' (public/sw.js qua src/components/sw-register.tsx) +
 * connect-src 'self' (chat poll same-origin /api/chat/[id]) + frame-ancestors
 * 'none' + form-action 'self' + base-uri 'self' + object-src 'none';
 * script-src thêm 'unsafe-eval' CHỈ khi NODE_ENV === "development".
 * Ship dưới key Content-Security-Policy-Report-Only — flip sang
 * Content-Security-Policy là release-checklist row của OPERATOR (sau
 * docker:smoke + manual page-load), không phải commit của batch này.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

type HeaderEntry = { source: string; headers: Array<{ key: string; value: string }> };

/**
 * path-to-regexp → RegExp cho CÁC DẠNG source repo này đang dùng trong
 * next.config.ts (không phải cài đặt path-to-regexp đầy đủ — test là hợp
 * đồng cho config NÀY, thêm dạng source mới = thêm nhánh ở đây):
 *  - `"/((?!uploads/).*)"` → regex nguyên văn (Next cho phép regex bọc parens);
 *  - `"/uploads/:path*"`   → zero-or-more segment sau prefix;
 *  - `"/invite/:token"`    → đúng MỘT segment (không match /invite, không match /invite/a/b);
 *  - `"/invite"`           → literal.
 */
function sourceToRegex(source: string): RegExp {
  if (source.startsWith("/(")) return new RegExp(`^${source}$`);
  const star = /^(\/[a-z-]+)\/:[a-z]+\*$/i.exec(source);
  if (star) return new RegExp(`^${star[1]}(?:/(.*))?$`);
  const param = /^(\/[a-z-]+)\/:[a-z]+$/i.exec(source);
  if (param) return new RegExp(`^${param[1]}/([^/]+)$`);
  return new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** Header HIỆU DỤNG cho một path — last-match-wins qua TOÀN BỘ mảng (docs headers.md:47). */
async function effectiveHeaders(path: string): Promise<Record<string, string>> {
  const list = (await nextConfig.headers!()) as HeaderEntry[];
  const effective: Record<string, string> = {};
  for (const entry of list) {
    if (sourceToRegex(entry.source).test(path)) {
      for (const h of entry.headers) effective[h.key] = h.value;
    }
  }
  return effective;
}

async function entries(): Promise<HeaderEntry[]> {
  return (await nextConfig.headers!()) as HeaderEntry[];
}

// ─── Cấu trúc mảng (corrections item 4) ──────────────────────────────────────

describe("§7.4 headers() — cấu trúc mảng (app-wide ĐẦU, Batch 4/7 NGUYÊN VẸN)", () => {
  it("app-wide entry ĐỨNG ĐẦU ([0]) với source loại trừ /uploads", async () => {
    const list = await entries();
    expect(list[0]!.source).toBe("/((?!uploads/).*)");
  });

  it("Batch 4 /uploads block NGUYÊN VẸN — đúng 2 header, thứ tự giữ nguyên", async () => {
    const uploads = (await entries()).find((h) => h.source === "/uploads/:path*");
    expect(uploads).toBeDefined();
    expect(uploads!.headers).toEqual([
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
    ]);
  });

  it("Batch 7 /invite blocks NGUYÊN VẸN — no-referrer chỉ trên :token; /invite KHÔNG có Referrer-Policy", async () => {
    const list = await entries();
    const token = list.find((h) => h.source === "/invite/:token");
    expect(token).toBeDefined();
    expect(token!.headers).toEqual([
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex" },
    ]);
    const invite = list.find((h) => h.source === "/invite");
    expect(invite).toBeDefined();
    expect(invite!.headers).toEqual([{ key: "X-Robots-Tag", value: "noindex" }]);
  });
});

// ─── Header HIỆU DỤNG theo path (last-match-wins) ─────────────────────────────

describe("§7.4 header HIỆU DỤNG theo path (last-match-wins)", () => {
  it("/uploads/x → CHỈ Batch 4 CSP sandbox + nosniff; KHÔNG Report-Only, KHÔNG header app-wide nào", async () => {
    const h = await effectiveHeaders("/uploads/x");
    expect(h["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(h["Referrer-Policy"]).toBeUndefined();
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBeUndefined();
  });

  it("/invite/<token> → Referrer-Policy no-referrer (Batch 7 THẮNG — app-wide đứng TRƯỚC) + noindex", async () => {
    const h = await effectiveHeaders("/invite/9f8d7c6b5a4e3f2d1c0b9a8d7e6f5a4b");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Robots-Tag"]).toBe("noindex");
  });

  it("/invite (tokenless) → strict-origin-when-cross-origin, KHÔNG no-referrer (corrections #8 — origin check action POST)", async () => {
    const h = await effectiveHeaders("/invite");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["X-Robots-Tag"]).toBe("noindex");
  });

  it("path app thường → Report-Only CSP + nosniff + HSTS + X-Frame-Options DENY + strict-origin-when-cross-origin", async () => {
    const h = await effectiveHeaders("/listings/foo");
    expect(h["Content-Security-Policy-Report-Only"]).toBeDefined();
    expect(h["Content-Security-Policy"]).toBeUndefined(); // KHÔNG enforce — flip là checklist row của operator
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Strict-Transport-Security"]).toBe("max-age=15552000; includeSubDomains");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("/policies/<key> (trang chính sách static) cũng nhận bộ app-wide", async () => {
    const h = await effectiveHeaders("/policies/terms");
    expect(h["Content-Security-Policy-Report-Only"]).toBeDefined();
    expect(h["X-Frame-Options"]).toBe("DENY");
  });
});

// ─── CSP Report-Only value (corrections item 23 — guide "Without Nonces") ────

describe("§7.4 CSP Report-Only value (guide 'Without Nonces' đã cài)", () => {
  it("đủ mọi directive: default/script/style/img (cloudinary)/font/worker/connect/frame-ancestors/form-action/base-uri/object-src", async () => {
    const csp = (await effectiveHeaders("/listings/foo"))["Content-Security-Policy-Report-Only"]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' blob: data: https://res.cloudinary.com");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    // KHÔNG upgrade-insecure-requests — lựa chọn được ghi nhận ở §3 security review doc
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("script-src THÊM 'unsafe-eval' CHỈ ở development (NODE_ENV đọc lúc gọi headers())", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const dev = await effectiveHeaders("/listings/foo");
      expect(dev["Content-Security-Policy-Report-Only"]).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    } finally {
      process.env.NODE_ENV = prev;
    }
    process.env.NODE_ENV = "production";
    try {
      const prod = await effectiveHeaders("/listings/foo");
      expect(prod["Content-Security-Policy-Report-Only"]).not.toContain("'unsafe-eval'");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("HSTS max-age 180 ngày + includeSubDomains, KHÔNG preload (founder decision)", async () => {
    const h = await effectiveHeaders("/listings/foo");
    expect(h["Strict-Transport-Security"]).toBe("max-age=15552000; includeSubDomains");
    expect(h["Strict-Transport-Security"]).not.toContain("preload");
  });
});
