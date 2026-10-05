import { processAutoReleases } from "@/src/lib/actions/helpers";

/**
 * Cron: tự giải ngân escrow các đơn shipped quá hạn khiếu nại.
 * Gọi hàng giờ từ crontab máy chủ:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/auto-release
 * Chỉ POST — GET không được định nghĩa để bot/link preview không trigger.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return new Response(null, { status: 401 });
  }
  const released = await processAutoReleases();
  return Response.json({ ok: true, released });
}
