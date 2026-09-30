import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // trang riêng tư — không cho index
        disallow: ["/admin", "/admin/", "/api/", "/cart", "/checkout", "/orders", "/wallet", "/chat", "/profile", "/notifications", "/offers", "/exchange", "/wishlist", "/sell"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
