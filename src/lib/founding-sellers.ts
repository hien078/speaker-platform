import "server-only";

import { db } from "@/src/prisma/db.client";
import {
  FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS,
  type FoundingSellerCandidateStatus,
} from "@/src/lib/founding-seller-vocab";

/**
 * Founding-seller domain module — server-only (Batch 7 Task 2 — spec §5.10,
 * §5.10.1, §4.8/§7.6). KHÔNG phải action file (directive use server chỉ dành
 * cho action — đây là domain module; mọi action của Tasks 3–5 import
 * từ đây). Client component KHÔNG BAO GIỜ import module này (import db →
 * server-only marker → client build break) — client import
 * founding-seller-vocab.ts.
 *
 * `export *` re-export toàn bộ vocabulary client-safe — server consumers
 * import mọi thứ từ một nơi (deal.ts / moderation.ts precedent).
 *
 * ── Funnel sync (corrections #22) ─────────────────────────────────────────────
 * syncFoundingSellerFunnel đọc GROUND TRUTH (SellerVerification + Listing
 * approved) và CHỈ TIẾN — không bao giờ lùi, nhảy thẳng tới trạng thái
 * furthest mà ground truth cho phép trong MỘT update. Sync dùng thứ tự
 * monotonic RIÊNG và được EXEMPT canTransitionCandidate — bảng
 * FOUNDING_SELLER_TRANSITIONS chỉ chi phối MANUAL operator moves
 * (updateCandidateStatusAction, Task 4); sync là cơ chế phản ánh ground
 * truth, không phải thao tác operator.
 *
 * CHỈ được gọi với global `db`, SAU một transaction đã commit (từ
 * acceptInviteAction — Task 3 — và syncCandidateFunnelAction — Task 4,
 * audited). KHÔNG BAO GIỜ gọi bên trong callback db.transaction (Postgres
 * abort tx khi constraint violation — Batch 3/6 rule) và KHÔNG BAO GIỜ
 * trong page render (S5: render không ghi db).
 *
 * ── Task 1 seam (parallel worktree — typecheck sau merge) ─────────────────────
 * `FoundingSellerCandidate` (và `BetaInviteToken`) thuộc migration batch 7 —
 * Task 1 (contract + migration) chạy song song trong worktree khác và CHƯA
 * merge ở tree này, nên table chưa có trong contract emit tại đây. Cho tới
 * merge, table được đọc qua structural view cục bộ với MỘT cast tập trung
 * (dưới đây) — "typecheck against the contract happens after merge"
 * (corrections parallelism map). SAU MERGE: thay bằng typed access trực tiếp
 * `db.orm.public.FoundingSellerCandidate` và xoá cast (theo dõi trong
 * docs/operations/private-beta-batch7-cohort-operations-verification.md);
 * enum contract emit cho status là cùng union giá trị
 * FOUNDING_SELLER_CANDIDATE_STATUSES (migration test Task 1 pin từng giá trị).
 */

export * from "@/src/lib/founding-seller-vocab";

// ─── Task 1 seam — structural view của FoundingSellerCandidate ───────────────

/** Row funnel-sync đọc/ghi — subset của table Task 1 (đủ cho sync). */
type FoundingSellerCandidateFunnelRow = {
  id: string;
  userId: string | null;
  status: FoundingSellerCandidateStatus;
  verifiedAt: string | null;
  firstListingAt: string | null;
};

/** Table handle — đúng dạng các call sync dùng (first + where().updateAll()). */
type FoundingSellerCandidateFunnelTable = {
  first(filter: { userId: string }): Promise<FoundingSellerCandidateFunnelRow | null>;
  where(filter: {
    id: string;
    status: FoundingSellerCandidateStatus;
  }): {
    updateAll(
      data: Partial<FoundingSellerCandidateFunnelRow>,
    ): Promise<FoundingSellerCandidateFunnelRow[]>;
  };
};

/** MỘT cast tập trung cho Task 1 seam — xem header module trước khi đổi. */
const FoundingSellerCandidateTable = (
  db.orm.public as unknown as {
    FoundingSellerCandidate: FoundingSellerCandidateFunnelTable;
  }
).FoundingSellerCandidate;

// ─── Funnel sync — thứ tự monotonic riêng (EXEMPT canTransitionCandidate) ─────

/**
 * Thứ tự monotonic RIÊNG của sync (corrections #22) — KHÔNG phải bảng
 * FOUNDING_SELLER_TRANSITIONS: sync được EXEMPT canTransitionCandidate và
 * nhảy thẳng tới trạng thái furthest (vd registered → first_listing khi
 * verification verified + đã có tin approved). Ops states xếp trên
 * first_listing nên sync không bao giờ đụng tới (chỉ để so rank — sync
 * không set chúng).
 */
const SYNC_RANK: Record<FoundingSellerCandidateStatus, number> = {
  prospect: 0,
  invited: 1,
  registered: 2,
  verification_pending: 3,
  verified: 4,
  concierge_onboarding: 5,
  first_listing: 6,
  active_founding_seller: 7,
  inactive: 8,
  exited: 9,
};

/**
 * Các trạng thái sync ĐƯỢC PHÉP tiến TỪ — tập con của lifecycle: funnel
 * ground-truth (registered → first_listing) + concierge_onboarding (S4:
 * ground truth thắng phase ops — một tin đã publish là first_listing một
 * cách khách quan, operator chuyển tiếp từ đó). prospect/invited thuộc
 * invite flow (Task 3), inactive/exited/active_founding_seller là ops
 * states — sync SKIP hoàn toàn (không bao giờ đụng).
 */
const SYNC_SOURCE_STATUSES: readonly FoundingSellerCandidateStatus[] = [
  "registered",
  "verification_pending",
  "verified",
  "concierge_onboarding",
];

/** Kết quả một lần sync — from→to cho audit "founding_seller.funnel_synced" (Task 4). */
export type FoundingSellerFunnelSync = {
  from: FoundingSellerCandidateStatus;
  to: FoundingSellerCandidateStatus;
  /** true chỉ khi có transition thực sự; sync không đổi gì → false (KHÔNG audit). */
  changed: boolean;
};

/**
 * Đếm listing ĐÃ DUYỆT của seller — factual count (KHÔNG phải "quality" —
 * A3: không có định nghĩa "quality listing", hệ thống không auto-compute;
 * qualityListingCount là ops input riêng, §12.1 manual sampling).
 */
export async function approvedListingCountOf(sellerId: string): Promise<number> {
  const agg = await db.orm.public.Listing.where({ sellerId, status: "approved" }).aggregate(
    (a) => ({ c: a.count() }),
  );
  return agg.c;
}

/**
 * Trạng thái furthest mà GROUND TRUTH cho phép (corrections #22 — mapping từ
 * SellerVerification.status):
 *  - pending | needs_review → ít nhất verification_pending;
 *  - verified → ít nhất verified; cùng ≥ 1 Listing approved → first_listing;
 *  - not_started | rejected | revoked | không có row → KHÔNG tiến (null).
 */
async function funnelGroundTruthTarget(
  userId: string,
): Promise<"verification_pending" | "verified" | "first_listing" | null> {
  const verification = await db.orm.public.SellerVerification.first({ userId });
  const verificationStatus = verification?.status ?? null;
  if (verificationStatus !== "verified" && verificationStatus !== "pending" && verificationStatus !== "needs_review") {
    return null; // not_started | rejected | revoked | không có row — không tiến
  }
  if (verificationStatus !== "verified") return "verification_pending";
  const approvedCount = await approvedListingCountOf(userId);
  return approvedCount > 0 ? "first_listing" : "verified";
}

/**
 * Sync trạng thái funnel của ứng viên founding seller từ GROUND TRUTH — chỉ
 * TIẾN, không lùi (spec §5.10 lifecycle):
 *  registered → verification_pending (SellerVerification pending/needs_review)
 *  verification_pending → verified (SellerVerification verified) + verifiedAt
 *  verified/concierge_onboarding → first_listing (≥ 1 Listing approved) + firstListingAt
 * Một update duy nhất: nhảy thẳng tới trạng thái furthest mà ground truth
 * cho phép (không walk từng bước). SKIP hoàn toàn ops states
 * (inactive/exited/active_founding_seller) + pre-registration
 * (prospect/invited — thuộc invite flow). Idempotent: chạy lại không đổi gì
 * đã đúng.
 *
 * Conditional write (compare-and-set trên status đã đọc — corrections #22):
 * `where({ id, status })` → 0 row nghĩa là candidate đã di chuyển giữa lúc
 * đọc và lúc ghi (operator/sync khác) — trả về `{ from, to: from, changed:
 * false }`, KHÔNG retry mù, KHÔNG ghi vô điều kiện.
 *
 * Trả về null khi user KHÔNG phải ứng viên founding seller (không có row
 * link userId — §8.4: không auto-membership, prospect chưa link không phải
 * ứng viên của user). CHỈ được gọi sau tx đã commit — xem header module.
 */
export async function syncFoundingSellerFunnel(
  userId: string,
): Promise<FoundingSellerFunnelSync | null> {
  const candidate = await FoundingSellerCandidateTable.first({ userId });
  if (candidate === null) return null;

  const from = candidate.status;
  if (!(SYNC_SOURCE_STATUSES as readonly string[]).includes(from)) {
    // Ops states + pre-registration + first_listing (đã ở target tối đa) —
    // sync bỏ qua hoàn toàn, KHÔNG ghi gì.
    return { from, to: from, changed: false };
  }

  const target = await funnelGroundTruthTarget(userId);
  if (target === null || SYNC_RANK[target] <= SYNC_RANK[from]) {
    // Ground truth không cho tiến, hoặc target thấp hơn hiện tại —
    // sync KHÔNG BAO GIỜ lùi (vd first_listing + verification rejected).
    return { from, to: from, changed: false };
  }

  const now = new Date().toISOString();
  const patch: Partial<FoundingSellerCandidateFunnelRow> = { status: target };
  if (SYNC_RANK[target] >= SYNC_RANK.verified && candidate.verifiedAt === null) {
    patch.verifiedAt = now; // milestone verified đạt được trên đường nhảy
  }
  if (target === "first_listing" && candidate.firstListingAt === null) {
    patch.firstListingAt = now;
  }

  // COMPARE-AND-SET: chỉ ghi khi status còn đúng như lúc đọc — 0 row = đã có
  // ai đó di chuyển candidate; sync nhường (không retry — corrections #22).
  const updated = await FoundingSellerCandidateTable.where({
    id: candidate.id,
    status: from,
  }).updateAll(patch);
  if (updated.length === 0) {
    return { from, to: from, changed: false };
  }
  return { from, to: target, changed: true };
}

// ─── Concierge tracking (§5.10 "seller needing assistance" — D2) ──────────────

/**
 * Các trạng thái "đang trong funnel active" — ứng viên cần hỗ trợ chỉ tính ở
 * đây (D2): first_listing trở đi là milestone đạt rồi, ops states là quyết
 * định operator — không phải "cần hỗ trợ".
 */
const ASSISTANCE_ELIGIBLE_STATUSES: readonly FoundingSellerCandidateStatus[] = [
  "invited",
  "registered",
  "verification_pending",
  "verified",
  "concierge_onboarding",
];

/**
 * Ứng viên cần hỗ trợ không? (§5.10 "seller needing assistance" — D2):
 * status ∈ active-funnel VÀ (lastContactAt IS NULL || lastContactAt cũ hơn
 * FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS ngày). Ngưỡng 7 ngày là ops heuristic
 * PROVISIONAL được ghi nhận (D2) — KHÔNG phải SLA (spec không định nghĩa);
 * render thành badge ở console (Task 5). Pure cho các trường truyền vào —
 * async để giữ dạng call site `await` (plan Task 2 interface).
 */
export async function candidateNeedsAssistance(candidate: {
  status: FoundingSellerCandidateStatus;
  lastContactAt: string | null;
}): Promise<boolean> {
  if (!(ASSISTANCE_ELIGIBLE_STATUSES as readonly string[]).includes(candidate.status)) {
    return false;
  }
  if (candidate.lastContactAt === null) return true;
  const thresholdMs = Date.now() - FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS * 24 * 60 * 60_000;
  return Date.parse(candidate.lastContactAt) < thresholdMs;
}
