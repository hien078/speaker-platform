import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // trang riêng tư — không cho index.
        // Các route finance (cart/checkout/orders/wallet/offers/exchange) đã retire
        // (trả 404 khi tài chính tắt) — giữ disallow như defense-in-depth;
        // /payments là callback provider, không bao giờ cho crawl.
        disallow: ["/admin", "/admin/", "/api/", "/cart", "/checkout", "/orders", "/wallet", "/chat", "/profile", "/notifications", "/offers", "/exchange", "/wishlist", "/sell", "/payments"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
