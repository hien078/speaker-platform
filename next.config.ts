import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // build standalone cho Docker — chỉ bundle file cần chạy
  output: "standalone",
  // ảnh upload từ client để hiển thị (public/uploads)
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com" },
    ],
  },
  // /uploads là file do user upload — serve với nosniff + CSP sandbox
  // (Batch 4 Task 3, spec §7.5): chặn content-type sniffing và mọi việc thực
  // thi/nhúng từ file này (polyglot đã bị re-encode neutralize ở tầng upload —
  // đây là lớp thứ hai cho file pre-Batch-4 còn trên đĩa).
  // b4-holistic round-3 HIGH: file upload sống NGOÀI public/ (data/uploads —
  // UPLOADS_DIR) và được serve bởi route handler app/uploads/[key]/route.ts
  // (đọc đĩa MỌI request — Next production chỉ serve file public/ tồn tại
  // khi start). Route handler tự set ĐÚNG 4 header này; headers() dưới là
  // belt-and-braces cho mọi path /uploads còn lại (kể cả static file cũ
  // còn trong public/uploads của deploy chưa migrate).
  // Production nginx (docs/deployment.md) PROXY location / về app nên header
  // Next có hiệu lực cho /uploads; nếu deploy sau này serve /uploads trực tiếp
  // từ nginx, CÙNG hai header phải vào location block đó (deploy checklist —
  // xem verification doc Batch 4).
  async headers() {
    // ─── Batch 8 Task 8a (spec §7.4 — corrections item 4 + 23): app-wide
    // browser-security headers, ĐỨNG ĐẦU mảng. Next headers()
    // last-match-wins (node_modules/next/dist/docs/01-app/03-api-reference/
    // 05-config/01-next-config-js/headers.md:47: entry sau THẮNG entry trước
    // trên CÙNG key) — vì vậy app-wide PHẢI đứng TRƯỚC để Batch 4 /uploads và
    // Batch 7 /invite (theo sau, NGUYÊN VẸN) giữ được key của mình:
    //  - /uploads/:path* giữ CSP `default-src 'none'; sandbox` (Batch 4);
    //    source app-wide LOẠI TRƯ /uploads (regex lookahead) nên upload path
    //    KHÔNG nhận thêm Report-Only CSP (key khác với
    //    Content-Security-Policy — sẽ nhận CẢ HAI nếu không loại);
    //  - /invite/:token giữ Referrer-Policy: no-referrer (Batch 7 — RR-21);
    //  - /invite (tokenless) KHÔNG match /invite/:token nên giữ
    //    strict-origin-when-cross-origin của entry này — no-referrer trên
    //    /invite sẽ gửi Origin: null trên action POST cùng origin → Next CSRF
    //    check reject (corrections #8).
    // CSP theo guide "Without Nonces" đã cài (node_modules/next/dist/docs/
    // 01-app/02-guides/content-security-policy.md) — KHÔNG nonce (cần
    // proxy.ts + dynamic rendering — ngoài G3; /policies/[key] là static).
    // img-src giữ https://res.cloudinary.com theo images.remotePatterns;
    // worker-src 'self' cho public/sw.js (src/components/sw-register.tsx);
    // connect-src 'self' (chat poll same-origin /api/chat/[id]).
    // KHÔNG upgrade-insecure-requests (lựa chọn được ghi nhận ở §3
    // docs/operations/private-beta-security-review.md — deploy sau nginx TLS,
    // mọi subresource đều 'self'/data:/blob:).
    // Ship Content-Security-Policy-Report-Only: flip sang
    // Content-Security-Policy là release-checklist row của OPERATOR (sau
    // docker:smoke + manual page-load trên stack đã deploy — RR-14 không có
    // E2E), KHÔNG phải commit của batch này.
    const isDev = process.env.NODE_ENV === "development";
    const appCsp = [
      "default-src 'self'",
      // 'unsafe-eval' CHỈ dev (guide: HMR/react-refresh cần eval) — production KHÔNG
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data: https://res.cloudinary.com",
      "font-src 'self'",
      "worker-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ");
    return [
      {
        source: "/((?!uploads/).*)",
        headers: [
          { key: "Content-Security-Policy-Report-Only", value: appCsp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // HSTS 180 ngày, KHÔNG preload (founder decision — preload là
          // một-way door cả domain); app-level là HSTS DUY NHẤT cho tới khi
          // operator cấu hình nginx (corrections item 24 — release-checklist row).
          { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      // ─── Batch 4 Task 3 (/uploads — spec §7.5): KHÔNG ĐỤNG ───────────────
      {
        source: "/uploads/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
        ],
      },
      // Batch 7 Task 3 (spec §4.8 — invite token secrecy; corrections #8):
      // Referrer-Policy no-referrer CHỈ trên response URL token — trang
      // /invite/<token> là nơi token thô xuất hiện (một GET duy nhất trước
      // khi cookie HttpOnly thay thế). KHÔNG dùng "/invite/:path*" — pattern
      // đó match cả /invite, và với no-referrer browser gửi Origin: null trên
      // action POST cùng origin → Next CSRF check reject ("Invalid Server
      // Actions request"). Route handler app/invite/[token]/route.ts set
      // cùng header trên response redirect (belt-and-braces).
      {
        source: "/invite/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      // /invite (tokenless) — KHÔNG Referrer-Policy (action POST cần Origin
      // same-origin), chỉ chặn index (URL mời không được index).
      {
        source: "/invite",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
    ];
  },
};

export default nextConfig;
