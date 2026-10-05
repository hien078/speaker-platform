import { db } from "@/src/prisma/db.client";

/** GET /api/health — healthcheck cho Docker/K8s/uptime monitor */
export async function GET() {
  try {
    // kiểm tra DB thực sự trả lời
    await db.orm.public.User.aggregate((a) => ({ c: a.count() }));
    return Response.json({
      ok: true,
      db: "up",
      time: new Date().toISOString(),
    });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
