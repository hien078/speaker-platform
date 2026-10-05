import { processAutoReleases } from "@/src/lib/actions/helpers";
import { verifyCronAuth } from "@/src/lib/cron-auth";
import { captureError } from "@/src/lib/observability";
import {
  FINANCIAL_FEATURES_DISABLED,
  financialFeaturesEnabled,
} from "@/src/lib/financial-features";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/auto-release — giải ngân escrow các đơn shipped quá hạn
 * (quá autoReleaseAt mà không có khiếu nại). Scheduler gọi mỗi giờ:
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://loaviet.vn/api/cron/auto-release
 *
 * - Auth: CRON_SECRET (timing-safe, fail closed — thiếu env là 503, sai là 401).
 * - Idempotent: chỉ xử lý đơn status=shipped AND autoReleaseAt <= now;
 *   chạy lại lần nữa không giải ngân lại đơn đã hoàn tất.
 * - Lỗi xử lý → 500, scheduler thử lại ở chu kỳ kế tiếp (đơn quá hạn vẫn
 *   nằm trong tập hợp cho tới khi được xử lý — không mất dữ liệu).
 * - Response: {"ok":true,"released":<số đơn đã giải ngân>} — released=0
 *   là bình thường (không có đơn quá hạn).
 * - Private beta (spec §4.1): tài chính tắt → KHÔNG giải ngân — typed denial
 *   sau fail-closed auth (caller chưa xác thực không biết trạng thái finance).
 */
export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) {
    // Fail closed: endpoint di chuyển tiền thật không chạy khi chưa cấu hình
    return Response.json(
      { ok: false, error: "CRON_SECRET_NOT_CONFIGURED" },
      { status: 503 },
    );
  }
  if (!verifyCronAuth(request)) {
    return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!financialFeaturesEnabled()) {
    // Ranh giới tài chính: cron không phải escape hatch — không payout/ledger
    // khi tắt (spec §4.1). processAutoReleases còn có assert riêng (defense-in-depth).
    return Response.json(
      { ok: false, error: FINANCIAL_FEATURES_DISABLED },
      { status: 503 },
    );
  }

  try {
    const released = await processAutoReleases();
    return Response.json({ ok: true, released });
  } catch (e) {
    captureError("cron:auto-release", e);
    return Response.json(
      { ok: false, error: "AUTO_RELEASE_FAILED" },
      { status: 500 },
    );
  }
}
