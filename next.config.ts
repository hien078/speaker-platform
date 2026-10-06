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
    ];
  },
};

export default nextConfig;
