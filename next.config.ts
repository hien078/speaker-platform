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
    return [
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
