import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LoaViet — Chợ loa secondhand & mới (beta)",
    short_name: "LoaViet",
    description:
      "Nền tảng đăng tin mua bán, trao đổi loa và thiết bị âm thanh. Người mua và người bán tự thỏa thuận qua chat — LoaViet không giữ tiền và không bảo đảm giao dịch.",
    start_url: "/",
    display: "standalone",
    background_color: "#07070e",
    theme_color: "#fbbf24",
    lang: "vi",
    categories: ["shopping", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
