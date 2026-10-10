import Link from "next/link";
import { UsersRound } from "lucide-react";
import { db } from "@/src/prisma/db.client";
import { requireCapability, capabilitiesOf } from "@/src/lib/rbac";
import {
  checkSellerPublicationRequirements,
  SELLER_PUBLICATION_REQUIREMENT_LABELS,
} from "@/src/lib/seller-verification-policy";
import { approvedListingCountOf, candidateNeedsAssistance } from "@/src/lib/founding-sellers";
import {
  FoundingSellerConsole,
  buildSupplyReadinessView,
  summarizeCandidates,
  type CandidateRowView,
  type OperatorOption,
} from "@/src/components/founding-seller-console";
import { CandidateCreateForm } from "@/src/components/founding-seller-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Beta cohort" };

/**
 * /admin/beta-cohort — founding seller console (Batch 7 Task 5 — spec §5.10/
 * §5.10.1/§12.1/§12.3, §4.5/§4.8/§4.9, §7.6; corrections 2026-10-08 items
 * 27/33/37).
 *
 * Guard: requireCapability("beta_cohort.manage") TRƯỚC mọi db read (spec §4.5 —
 * super_admin + operations_admin, ma trận §5.4.1 của Batch 2; moderator/support/
 * analyst fail closed; nav lọc chỉ là convenience).
 *
 * S5 — KHÔNG write trong render: page chỉ đọc (live reads); mọi mutation là
 * action Task 3/4 posted bởi form trong console (tự guard lại + audit). Funnel
 * sync chỉ chạy qua action operator (audited) hoặc đường acceptance — page
 * render STORED status BÊSIDE live reads (verification/listing) để operator
 * thấy độ trễ giữa hai lần sync.
 *
 * PII (§4.8/§7.6): contact reference đến tay component server qua view model
 * và render MASK (maskContact trong console component); KHÔNG có action mở
 * mask PII — ô Scoped của operations_admin chưa được founder định nghĩa (A2,
 * fail closed). Telemetry: KHÔNG emit gì trong render — emission chỉ ở action
 * (Batch 5 seam, fail-open, sau commit).
 */
export default async function AdminBetaCohortPage({
  searchParams,
}: PageProps<"/admin/beta-cohort">) {
  // Guard server-side (spec §4.5) — trước mọi db read.
  await requireCapability("beta_cohort.manage");
  const sp = (await searchParams) as { userId?: string };
  // Link target từ /admin/users (cột Beta cohort) — lọc ứng viên đã link user này.
  const userIdFilter = sp.userId?.trim() ?? "";

  // Load TOÀN BỘ cohort — MỘT query (≤ beta scale; corrections #37). KHÔNG sync,
  // KHÔNG ghi gì trong render (S5) — status render là STORED status.
  // b7-t8 review fix: ?userId= CHỈ thu hẹp BẢNG — summary §5.10 + supply
  // readiness §12.1 vẫn tính từ cohort ĐẦY (tính từ danh sách đã lọc làm
  // badge/mục tiêu đọc số của một user thay vì của chương trình).
  const allCandidates = await db.orm.public.FoundingSellerCandidate.orderBy(
    (c) => c.updatedAt.desc(),
  ).all();

  // Operator đủ điều kiện được gán (select gán operator) — eligibility theo
  // ma trận Batch 2 (capabilitiesOf), KHÔNG hardcode role ở đây.
  const adminUsers = await db.orm.public.User.where((u) => u.adminRole.isNotNull()).all();
  const operators: OperatorOption[] = adminUsers
    .filter((u) => capabilitiesOf(u.adminRole).includes("beta_cohort.manage"))
    .map((u) => ({ id: u.id, name: u.name }));

  // View model — LIVE READS ONLY (S5): mỗi ứng viên link đọc FRESH membership
  // (read-only — grant/suspend là surface Batch 2 trên /admin/users),
  // SellerVerification.status, yêu cầu publication còn thiếu (Batch 2 policy),
  // factual approved-listing count, Listing mới nhất (updatedAt — "last seller
  // activity" §5.10), token active (row id cho form thu hồi — raw token không
  // tồn tại trong db). Tính cho TOÀN BỘ cohort (summary/supply không bị ?userId=
  // thu hẹp — xem trên); bảng lọc ở dưới.
  const allRows: CandidateRowView[] = await Promise.all(
    allCandidates.map(async (c) => {
      const [user, membership, verification, publication, approvedCount, lastListing, activeToken, needsAssistance] =
        await Promise.all([
          c.userId !== null ? db.orm.public.User.first({ id: c.userId }) : Promise.resolve(null),
          c.userId !== null
            ? db.orm.public.BetaCohortMembership.first({ userId: c.userId, cohort: "founding_seller" })
            : Promise.resolve(null),
          c.userId !== null
            ? db.orm.public.SellerVerification.first({ userId: c.userId })
            : Promise.resolve(null),
          c.userId !== null ? checkSellerPublicationRequirements(c.userId) : Promise.resolve(null),
          c.userId !== null ? approvedListingCountOf(c.userId) : Promise.resolve(0),
          c.userId !== null
            ? db.orm.public.Listing.where({ sellerId: c.userId })
                .orderBy((l) => l.updatedAt.desc())
                .first()
            : Promise.resolve(null),
          db.orm.public.BetaInviteToken.where({ candidateId: c.id })
            .where((t) => t.consumedAt.isNull())
            .where((t) => t.revokedAt.isNull())
            .first(),
          candidateNeedsAssistance({ status: c.status, lastContactAt: c.lastContactAt }),
        ]);
      return {
        id: c.id,
        contactChannel: c.contactChannel,
        contactReference: c.contactReference,
        source: c.source,
        targetCommunity: c.targetCommunity,
        status: c.status,
        invitedAt: c.invitedAt,
        registeredAt: c.registeredAt,
        verifiedAt: c.verifiedAt,
        firstListingAt: c.firstListingAt,
        qualityListingCount: c.qualityListingCount,
        lastContactAt: c.lastContactAt,
        notes: c.notes,
        assignedOperatorId: c.assignedOperatorId,
        assignedOperatorName:
          c.assignedOperatorId !== null
            ? adminUsers.find((u) => u.id === c.assignedOperatorId)?.name ?? null
            : null,
        userId: c.userId,
        linkedUserName: user?.name ?? null,
        membershipStatus: membership?.status ?? null,
        verificationStatus: verification?.status ?? null,
        publicationMissing:
          publication?.missing.map((m) => SELLER_PUBLICATION_REQUIREMENT_LABELS[m]) ?? [],
        approvedListingCount: approvedCount,
        lastListingUpdatedAt: lastListing?.updatedAt ?? null,
        needsAssistance,
        activeTokenId: activeToken?.id ?? null,
      };
    }),
  );

  // ?userId= filter — CHỈ cho BẢNG (rows truyền console); summary + supply
  // readiness dùng allCandidates/allRows (cohort đầy — b7-t8 review fix).
  const rows = userIdFilter
    ? allRows.filter((r) => r.userId === userIdFilter)
    : allRows;

  // §5.10 summary + §12.1 supply readiness — helper thuần (console component),
  // counts từ live reads của cohort ĐẦY; targets là DISPLAY STRING (founder
  // ack — Batch 8).
  const summary = summarizeCandidates(allCandidates);
  const supply = buildSupplyReadinessView(allRows);

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <UsersRound className="size-6 text-[var(--accent)]" />
        Beta cohort — founding seller
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Vận hành cohort founding seller (spec §5.10) — mọi hành động ghi audit; kênh liên hệ hiển thị
        mask. Trạng thái hiển thị là trạng thái đã lưu; nhấn nút Sync funnel để đồng bộ từ ground truth.
      </p>
      {userIdFilter !== "" && (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Đang lọc ứng viên đã liên kết người dùng này.{" "}
          <Link href="/admin/beta-cohort" className="font-semibold text-[var(--accent)] hover:underline">
            Xem tất cả
          </Link>
        </p>
      )}

      {/* §5.10 display list — summary counts (STORED status) */}
      <div className="mt-5 flex flex-wrap gap-2 text-sm">
        <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">
          Tổng ứng viên: {summary.totalCandidates}
        </span>
        <span className="badge bg-amber-500/15 text-amber-600">Đã mời: {summary.invited}</span>
        <span className="badge bg-sky-500/15 text-sky-600">Đã tham gia: {summary.registered}</span>
      </div>

      {/* §12.1 supply readiness — MỤC TIÊU THAM CHIẾU (display string), KHÔNG gate */}
      <div className="card mt-4 p-4">
        <p className="text-sm font-bold">Mục tiêu vận hành (tham chiếu — spec §12.1)</p>
        <ul className="mt-2 space-y-1 text-sm text-[var(--ink-2)]">
          <li>
            Founding seller đã mời: <b>{supply.invitedFoundingSellers}</b> / mục tiêu{" "}
            {supply.targetInvited}
          </li>
          <li>
            Founding seller đã xác minh: <b>{supply.verifiedFoundingSellers}</b>
          </li>
          <li>
            Tin đã duyệt của founding seller:{" "}
            <b>{supply.approvedListingsByFoundingSellers}</b> / mục tiêu {supply.targetListings} tin
            chất lượng (ops sample)
          </li>
        </ul>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Các con số là mục tiêu tham chiếu — không có code path nào chặn theo count; mở rộng lời mời
          buyer rộng rãi là quyết định founder (spec §12.1). Chỉ số kích hoạt seller (seller_verified,
          seller_first_listing_published) xem ở{" "}
          <Link href="/admin/analytics" className="font-semibold text-[var(--accent)] hover:underline">
            Phân tích beta
          </Link>
          .
        </p>
      </div>

      {/* §5.10.1 concierge guidance — trách nhiệm split (copy PROVISIONAL FD-3) */}
      <div className="card mt-4 p-4">
        <p className="text-sm font-bold">Hỗ trợ trực tiếp (concierge) — spec §5.10.1</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--ink-2)]">
          <li>
            Operations có thể hỗ trợ người bán: chọn model, trường cấu trúc, checklist ảnh, định dạng
            tin đăng, chuyển dữ liệu tin cũ.
          </li>
          <li>Operations KHÔNG tự ý tạo thông tin thay người bán.</li>
          <li>
            Người bán chịu trách nhiệm: giá hỏi, tình trạng máy, lỗi/vết hư, lịch sử sửa chữa, quyền
            sở hữu và quyền bán, tuyên bố về sản phẩm, đồng ý đăng tin.
          </li>
        </ul>
      </div>

      {/* Form thêm ứng viên (Task 3 — useActionState client form) */}
      <CandidateCreateForm />

      {/* Bảng ứng viên + các form hành động Task 3/4 (server component — plain form posts) */}
      <FoundingSellerConsole rows={rows} operators={operators} />
    </div>
  );
}
