import type { MetadataRoute } from "next";
import { db } from "@/src/prisma/db.client";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";

  // trang tĩnh
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: "daily", priority: 1 },
    { url: `${base}/listings`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/listings?exchange=1`, changeFrequency: "daily", priority: 0.7 },
    { url: `${base}/compare`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/login`, priority: 0.3 },
    { url: `${base}/register`, priority: 0.3 },
  ];

  // tin đang bán
  const listings = await db.orm.public.Listing
    .where({ status: "approved" })
    .select("slug", "updatedAt")
    .orderBy((l) => l.createdAt.desc())
    .limit(500)
    .all();
  const listingRoutes: MetadataRoute.Sitemap = listings.map((l) => ({
    url: `${base}/listings/${l.slug}`,
    lastModified: new Date(l.updatedAt),
    changeFrequency: "daily",
    priority: 0.8,
  }));

  // model catalog
  const models = await db.orm.public.ProductModel
    .where({ status: "approved" })
    .select("slug", "updatedAt")
    .limit(500)
    .all();
  const modelRoutes: MetadataRoute.Sitemap = models.map((m) => ({
    url: `${base}/models/${m.slug}`,
    lastModified: new Date(m.updatedAt),
    priority: 0.6,
  }));

  // gian hàng seller có tin đang bán
  const sellers = await db.orm.public.User
    .where({ role: "seller" })
    .select("id")
    .limit(200)
    .all();
  const sellerRoutes: MetadataRoute.Sitemap = sellers.map((s) => ({
    url: `${base}/seller/${s.id}`,
    priority: 0.4,
  }));

  return [...staticRoutes, ...listingRoutes, ...modelRoutes, ...sellerRoutes];
}
