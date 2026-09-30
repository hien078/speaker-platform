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
};

export default nextConfig;
