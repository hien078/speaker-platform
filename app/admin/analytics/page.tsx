import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { cohortPseudonyms } from "@/src/lib/product-events";
import {
  METRIC_CONTRACTS,
  PENDING_FOUNDER_DECISION,
  type MetricContract,
  type MetricName,
} from "@/src/lib/metric-contracts";
import {
  medianFirstResponseTime,
  searchResultCtr,
  searchToChat,
  successfulMatchCount,
  zeroResultRate,
  type ProductEventRow,
} from "@/src/lib/metrics";
import {
  BETA_PRIMARY_MARKET_PROVINCE,
  BETA_SECONDARY_MARKET_PROVINCE,
  PROVINCE_CODES,
} from "@/src/lib/location";
import { formatDate } from "@/src/lib/utils";
import { ChartColumn } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Phân tích beta" };

/**
 * /admin/analytics — Private-beta analytics dashboard (Batch 5 Task 10 — spec §5.8.2).
 *
 * Guard: requireCapability("analytics.read") server-side, TRƯỚC mọi db read
 * (spec §4.5 — super_admin/operations_admin/analyst theo ma trận §5.4.1;
 * moderator/support fail closed; nav filtering chỉ là convenience).
 *
 * SCALING — P0 shape (nit, ghi nhận cho review post-beta): trang NẠP MỌI
 * ProductEvent row mỗi request (full scan) và tổng hợp MỌI thứ từ khi
 * telemetry bắt đầu ghi — không cửa sổ hiển thị nào được tự chế (retention
 * là Ambiguity A6, chưa có lịch). Scaling ceiling của full scan được ghi
 * nhận ở đây + trong verification doc; không tối ưu trong P0.
 *
 * Trung thực metric (spec §4.11 Policy Non-Invention + FD-3):
 *  - 4 contract pending (listing_to_chat_v1 / seller_response_rate_v1 /
 *    successful_match_rate_v1 / repeat_user_rate_v1 — A1/A2/A3) render trạng
 *    thái pending CÓ TÊN tham số — KHÔNG BAO GIỜ con số tự chế (engine của
 *    chúng nhận window làm THAM SỐ nên dashboard không gọi khi window chưa
 *    được quyết);
 *  - search_to_chat_v1 render giá trị thật (unbounded click chain — S-16);
 *  - mọi rate kèm n=numerator/denominator (low-sample context §5.8.2);
 *  - count thô (query volume, listing marked sold, report count) đếm MỌI row
 *    — rate theo contract loại internal (S-12) nên n=… hiển thị khác count
 *    thô khi có internal traffic (đều trung thực, đều có nhãn);
 *  - active seller count (§12.2) = sellers với ≥ 1 tin approved — QUYẾT
 *    ĐỊNH GHI RÕ: raw aggregate, không tự chế định nghĩa "active" nào khác.
 *
 * Location neutrality (spec §4.7): nhãn thị trường là nhãn operational/
 * acquisition ONLY ("khu vực beta trọng điểm") — location KHÔNG bao giờ là
 * tín hiệu tin cậy, không copy bảo chứng cho khu vực nào.
 *
 * Privacy (spec §4.8): chỉ render aggregate — không render pseudonym, không
 * payload event, không query text (ProductEvent không lưu query text thô).
 */

// ─── Types (helper thuần — export cho tests/unit/analytics-dashboard.test.ts) ───

/** Shape Listing (approved) mà các aggregate/segment tiêu thụ (tường minh). */
export type ListingRow = {
  id: string;
  sellerId: string;
  categoryId: string;
  brandId: string | null;
  productModelId: string | null;
  createdAt: string;
};

/** Kết quả rate của engine Task 9 (zeroResultRate/searchResultCtr/searchToChat). */
export type RateAggregate = { numerator: number; denominator: number; rate: number | null };

// ─── Render helpers (thuần — không db, không log) ────────────────────────────────

/**
 * Tham số từng contract pending chờ founder quyết (A1/A2/A3) — TÊN hiển thị
 * ở trạng thái pending (spec §4.11: không tự chế giá trị, chỉ nêu thiếu gì).
 */
const PENDING_PARAMETERS: Partial<Record<MetricName, string>> = {
  listing_to_chat_v1: "attribution window",
  seller_response_rate_v1: "response window",
  successful_match_rate_v1: "reconciliation policy + attribution period",
  repeat_user_rate_v1: "return window",
};

/**
 * Render GIÁ TRỊ một metric rate theo contract (spec §5.8.2 "Avoid displaying
 * misleading low-sample percentages without context"):
 *  - contract pending (PENDING_FOUNDER_DECISION) → trạng thái pending CÓ TÊN
 *    tham số — aggregate BỊ BỎ QUA (kể cả khi caller truyền vào: window
 *    production chưa được quyết thì KHÔNG render số);
 *  - rate null (denominator 0) → "chưa có dữ liệu" + n=0/0 (không render 0%);
 *  - rate thật → phần trăm + n=numerator/denominator (low-sample context).
 */
export function renderMetricValue(
  contract: MetricContract,
  aggregate: RateAggregate | null,
): string {
  if (contract.attributionWindow === PENDING_FOUNDER_DECISION) {
    const param = PENDING_PARAMETERS[contract.name as MetricName] ?? "tham số chưa ghi rõ";
    return `— chờ quyết định: ${param}`;
  }
  const { numerator, denominator, rate } =
    aggregate ?? { numerator: 0, denominator: 0, rate: null };
  if (rate === null) return `chưa có dữ liệu (n=${numerator}/${denominator})`;
  return `${(rate * 100).toFixed(1)}% (n=${numerator}/${denominator})`;
}

/** Format khoảng thời gian ms → đơn vị lớn nhất + phần dư (giây/phút/giờ/ngày). */
export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} giây`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const remSec = totalSeconds % 60;
    return remSec === 0 ? `${totalMinutes} phút` : `${totalMinutes} phút ${remSec} giây`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const remMin = totalMinutes % 60;
    return remMin === 0 ? `${totalHours} giờ` : `${totalHours} giờ ${remMin} phút`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours === 0 ? `${days} ngày` : `${days} ngày ${remHours} giờ`;
}

/** Render metric duration (median) — kèm sample size (n). */
/** Note thẻ "Tin đăng của seller" — null (chưa seller nào có tin approved) →
 *  "chưa có dữ liệu", KHÔNG bịa median 0 (cùng quy tắc renderMetricValue/renderDurationValue). */
export function sellerListingNote(medianPerSeller: number | null): string {
  return medianPerSeller === null
    ? "median: chưa có dữ liệu (n=0 seller)"
    : `median ${String(medianPerSeller)} tin/seller (approved)`;
}

export function renderDurationValue(medianMs: number | null, sample: number): string {
  if (medianMs === null) return `chưa có dữ liệu (n=${sample})`;
  return `${formatDurationMs(medianMs)} (n=${sample})`;
}

// ─── Segmentation helpers (spec §5.8.2 — thuần) ─────────────────────────────────

/**
 * Segment cohort: event có actorPseudonym ∈ tập pseudonym của cohort
 * (cohortPseudonyms(cohort) — member ACTIVE). Event anonymous
 * (actorPseudonym null) KHÔNG thuộc cohort nào. KHÔNG phải exclusion —
 * exclusion internal của rate dùng row.isInternal (S-12).
 */
export function eventsInCohort(
  events: ProductEventRow[],
  cohortActorPseudonyms: readonly string[],
): ProductEventRow[] {
  const set = new Set(cohortActorPseudonyms);
  return events.filter((e) => e.actorPseudonym !== null && set.has(e.actorPseudonym));
}

/** Segment thị trường (spec §5.9.1): primary / secondary / khác (kể cả null). */
export type MarketSegments = {
  primary: ProductEventRow[];
  secondary: ProductEventRow[];
  other: ProductEventRow[];
};

export function segmentByMarket(events: ProductEventRow[]): MarketSegments {
  const primary: ProductEventRow[] = [];
  const secondary: ProductEventRow[] = [];
  const other: ProductEventRow[] = [];
  for (const e of events) {
    if (e.provinceCode === BETA_PRIMARY_MARKET_PROVINCE) primary.push(e);
    else if (e.provinceCode === BETA_SECONDARY_MARKET_PROVINCE) secondary.push(e);
    else other.push(e); // kể cả null — event không mang mã tỉnh
  }
  return { primary, secondary, other };
}

/**
 * Segment danh mục (spec §5.8.2): join listingId → Listing.categoryId.
 * Event không join được (listingId null / listing không trong tập đã nạp)
 * KHÔNG xuất hiện trong segment nào (fail closed — không đoán danh mục).
 */
export function segmentByCategory(
  events: ProductEventRow[],
  listings: readonly ListingRow[],
): Map<string, ProductEventRow[]> {
  const categoryIdByListingId = new Map(listings.map((l) => [l.id, l.categoryId]));
  const byCategory = new Map<string, ProductEventRow[]>();
  for (const e of events) {
    if (e.listingId === null) continue;
    const categoryId = categoryIdByListingId.get(e.listingId);
    if (categoryId === undefined) continue;
    const bucket = byCategory.get(categoryId) ?? [];
    bucket.push(e);
    byCategory.set(categoryId, bucket);
  }
  return byCategory;
}

/**
 * Segment brand/model (spec §5.8.2 "where sample size permits"): join
 * listingId → Listing.brandId / productModelId. Listing thiếu brand/model
 * (null) KHÔNG tạo bucket (fail closed). "Where sample size permits" =
 * count luôn hiển thị — KHÔNG ngưỡng minimum-n tự chế.
 */
export function segmentByBrandModel(
  events: ProductEventRow[],
  listings: readonly ListingRow[],
): { byBrand: Map<string, ProductEventRow[]>; byModel: Map<string, ProductEventRow[]> } {
  const brandByListingId = new Map<string, string | null>(
    listings.map((l) => [l.id, l.brandId]),
  );
  const modelByListingId = new Map<string, string | null>(
    listings.map((l) => [l.id, l.productModelId]),
  );
  const byBrand = new Map<string, ProductEventRow[]>();
  const byModel = new Map<string, ProductEventRow[]>();
  for (const e of events) {
    if (e.listingId === null) continue;
    const brandId = brandByListingId.get(e.listingId);
    if (brandId !== undefined && brandId !== null) {
      const bucket = byBrand.get(brandId) ?? [];
      bucket.push(e);
      byBrand.set(brandId, bucket);
    }
    const modelId = modelByListingId.get(e.listingId);
    if (modelId !== undefined && modelId !== null) {
      const bucket = byModel.get(modelId) ?? [];
      bucket.push(e);
      byModel.set(modelId, bucket);
    }
  }
  return { byBrand, byModel };
}

// ─── Aggregates không cần contract (spec §5.8.2 — thuần) ─────────────────────────

/** Query volume — count thô mọi search_submitted đã ghi. */
export function queryVolume(events: ProductEventRow[]): number {
  return events.filter((e) => e.name === "search_submitted").length;
}

/** Listing marked sold — count thô; honest zero cho tới khi Batch 6 emit (S7). */
export function listingMarkedSoldCount(events: ProductEventRow[]): number {
  return events.filter((e) => e.name === "listing_marked_sold").length;
}

/** Report count — count thô report_submitted (Batch 3 emit — S7). */
export function reportCount(events: ProductEventRow[]): number {
  return events.filter((e) => e.name === "report_submitted").length;
}

/** Seller activation — distinct actorPseudonym trong seller_first_listing_published. */
export function sellerActivation(events: ProductEventRow[]): number {
  const actors = new Set<string>();
  for (const e of events) {
    if (e.name !== "seller_first_listing_published") continue;
    if (e.actorPseudonym === null) continue;
    actors.add(e.actorPseudonym);
  }
  return actors.size;
}

/** Median tuổi tin đăng approved (ms) — lẻ: giữa; chẵn: trung bình 2 giá trị giữa. */
export function medianListingAgeMs(
  listings: readonly ListingRow[],
  nowMs: number,
): number | null {
  const ages = listings
    .map((l) => nowMs - Date.parse(l.createdAt))
    .sort((a, b) => a - b);
  if (ages.length === 0) return null;
  const mid = Math.floor(ages.length / 2);
  return ages.length % 2 === 1 ? ages[mid]! : (ages[mid - 1]! + ages[mid]!) / 2;
}

/** Seller listing count — tổng approved + median mỗi seller. */
export function sellerListingCount(
  listings: readonly ListingRow[],
): { total: number; medianPerSeller: number | null } {
  const perSeller = new Map<string, number>();
  for (const l of listings) {
    perSeller.set(l.sellerId, (perSeller.get(l.sellerId) ?? 0) + 1);
  }
  const counts = [...perSeller.values()].sort((a, b) => a - b);
  if (counts.length === 0) return { total: 0, medianPerSeller: null };
  const mid = Math.floor(counts.length / 2);
  const medianPerSeller =
    counts.length % 2 === 1 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;
  return { total: listings.length, medianPerSeller };
}

/**
 * Active seller count (§12.2) — sellers với ≥ 1 tin approved. QUYẾT ĐỊNH GHI
 * RÕ: raw aggregate, không tự chế định nghĩa "active" nào khác (spec §4.11).
 */
export function activeSellerCount(listings: readonly ListingRow[]): number {
  return new Set(listings.map((l) => l.sellerId)).size;
}

// ─── Page ───────────────────────────────────────────────────────────────────────

/** JsonValue → Record | null (engine tiêu thụ metadata dạng object; giá trị khác → null). */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export default async function AnalyticsDashboardPage() {
  // Guard server-side (spec §4.5) — analytics.read: super_admin/
  // operations_admin/analyst (ma trận §5.4.1); moderator/support fail closed.
  // requireCapability THROW FORBIDDEN (không redirect — rbac.ts), trước MỌI db read.
  await requireCapability("analytics.read");

  // ─── Nạp dữ liệu (full scan — P0 shape, xem ghi chú scaling đầu module) ───
  const [eventRows, listingRows, categoryRows, brandRows, modelRows, internalCohort, foundingCohort, buyerCohort] =
    await Promise.all([
      db.orm.public.ProductEvent
        .select(
          "id",
          "name",
          "occurredAt",
          "actorPseudonym",
          "sessionPseudonym",
          "isInternal",
          "searchSessionId",
          "listingId",
          "conversationId",
          "provinceCode",
          "metadata",
        )
        .all(),
      db.orm.public.Listing
        .where({ status: "approved" })
        .select("id", "sellerId", "categoryId", "brandId", "productModelId", "createdAt")
        .all(),
      db.orm.public.Category.select("id", "name").all(),
      db.orm.public.Brand.select("id", "name").all(),
      db.orm.public.ProductModel.select("id", "name").all(),
      // Cohort segmentation — member ACTIVE (fail-open: lỗi đọc → [] — dashboard
      // không vỡ vì telemetry, segment hiển thị 0).
      cohortPseudonyms("internal"),
      cohortPseudonyms("founding_seller"),
      cohortPseudonyms("private_beta_buyer"),
    ]);

  // Map row db → shape engine (metadata JsonValue → Record | null).
  const events: ProductEventRow[] = eventRows.map((r) => ({
    id: r.id,
    name: r.name,
    occurredAt: r.occurredAt,
    actorPseudonym: r.actorPseudonym,
    sessionPseudonym: r.sessionPseudonym,
    isInternal: r.isInternal,
    searchSessionId: r.searchSessionId,
    listingId: r.listingId,
    conversationId: r.conversationId,
    provinceCode: r.provinceCode,
    metadata: isPlainRecord(r.metadata) ? r.metadata : null,
  }));
  const listings: ListingRow[] = listingRows.map((l) => ({
    id: l.id,
    sellerId: l.sellerId,
    categoryId: l.categoryId,
    brandId: l.brandId,
    productModelId: l.productModelId,
    createdAt: l.createdAt,
  }));

  // ─── Metric contracts (engine Task 9) ───
  // listingToChat/sellerResponseRate KHÔNG được gọi ở đây: window là
  // PENDING_FOUNDER_DECISION (A1) — engine nhận window làm tham số, dashboard
  // không tự chế giá trị để hiển thị (render pending state thay vì số).
  const zeroResult = zeroResultRate(events);
  const ctr = searchResultCtr(events);
  const s2c = searchToChat(events); // unbounded click chain — S-16, không window
  const medianResponse = medianFirstResponseTime(events);
  const matches = successfulMatchCount(events); // rate pending A2 — count thô

  // ─── Aggregates không cần contract ───
  // nowMs qua new Date() (không Date.now() — react-hooks/purity); helper thuần
  // nhận nowMs làm tham số để test được (medianListingAgeMs).
  const nowMs = new Date().getTime();
  const volume = queryVolume(events);
  const soldCount = listingMarkedSoldCount(events);
  const reports = reportCount(events);
  const activation = sellerActivation(events);
  const listingAge = medianListingAgeMs(listings, nowMs);
  const listingCount = sellerListingCount(listings);
  const activeSellers = activeSellerCount(listings);

  // ─── Segments (spec §5.8.2) ───
  const market = segmentByMarket(events);
  const byCategory = segmentByCategory(events, listings);
  const { byBrand, byModel } = segmentByBrandModel(events, listings);
  const cohortSegments = [
    { label: "Cohort nội bộ (internal)", events: eventsInCohort(events, internalCohort) },
    { label: "Founding seller", events: eventsInCohort(events, foundingCohort) },
    { label: "Buyer beta riêng tư", events: eventsInCohort(events, buyerCohort) },
  ];
  const marketSegments = [
    {
      label: `${PROVINCE_CODES[BETA_PRIMARY_MARKET_PROVINCE] ?? BETA_PRIMARY_MARKET_PROVINCE} — khu vực beta trọng điểm`,
      events: market.primary,
    },
    {
      label: `${PROVINCE_CODES[BETA_SECONDARY_MARKET_PROVINCE] ?? BETA_SECONDARY_MARKET_PROVINCE} — thị trường thứ hai`,
      events: market.secondary,
    },
    { label: "Khu vực khác / không chọn", events: market.other },
  ];
  const categoryNameById = new Map(categoryRows.map((c) => [c.id, c.name]));
  const brandNameById = new Map(brandRows.map((b) => [b.id, b.name]));
  const modelNameById = new Map(modelRows.map((m) => [m.id, m.name]));
  const byCountDesc = (entries: Array<[string, ProductEventRow[]]>): Array<[string, ProductEventRow[]]> =>
    [...entries].sort((a, b) => b[1].length - a[1].length);

  // ─── §5.8.2 — danh sách metric tối thiểu ───
  const cards: Array<{ label: string; value: string; note?: string; pending?: boolean }> = [
    {
      label: "Lượt tìm kiếm",
      value: volume.toLocaleString("vi-VN"),
      note: "count thô mọi search_submitted đã ghi",
    },
    {
      label: "Tỉ lệ tìm không thấy kết quả",
      value: renderMetricValue(METRIC_CONTRACTS.zero_result_rate_v1, zeroResult),
    },
    {
      label: "CTR kết quả tìm kiếm",
      value: renderMetricValue(METRIC_CONTRACTS.search_result_ctr_v1, ctr),
    },
    {
      label: "Xem tin → hội thoại",
      value: renderMetricValue(METRIC_CONTRACTS.listing_to_chat_v1, null),
      pending: true,
    },
    {
      label: "Tìm kiếm → hội thoại",
      value: renderMetricValue(METRIC_CONTRACTS.search_to_chat_v1, s2c),
      note: "unbounded click chain (S-16)",
    },
    {
      label: "Tỉ lệ seller trả lời",
      value: renderMetricValue(METRIC_CONTRACTS.seller_response_rate_v1, null),
      pending: true,
    },
    {
      label: "Thời gian trả lời đầu tiên (median)",
      value: renderDurationValue(medianResponse.medianMs, medianResponse.sample),
    },
    {
      label: "Tuổi tin đã duyệt (median)",
      value: renderDurationValue(listingAge, listings.length),
    },
    {
      label: "Tin đánh dấu đã bán",
      value: soldCount.toLocaleString("vi-VN"),
      note: "— chờ quyết định: mẫu số tỉ lệ (A5); count honest zero tới Batch 6",
    },
    {
      label: "Match thành công",
      value: matches.toLocaleString("vi-VN"),
      note: renderMetricValue(METRIC_CONTRACTS.successful_match_rate_v1, null),
    },
    {
      label: "Báo cáo vi phạm",
      value: reports.toLocaleString("vi-VN"),
      note: "— chờ quyết định: mẫu số tỉ lệ (A5)",
    },
    {
      label: "Người dùng quay lại",
      value: renderMetricValue(METRIC_CONTRACTS.repeat_user_rate_v1, null),
      pending: true,
    },
    {
      label: "Seller kích hoạt",
      value: activation.toLocaleString("vi-VN"),
      note: "seller có tin đầu được duyệt (distinct pseudonym)",
    },
    {
      label: "Tin đăng của seller",
      value: listingCount.total.toLocaleString("vi-VN"),
      note: sellerListingNote(listingCount.medianPerSeller),
    },
    {
      label: "Seller đang hoạt động",
      value: activeSellers.toLocaleString("vi-VN"),
      note: "≥ 1 tin đã duyệt (§12.2)",
    },
  ];

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <ChartColumn className="size-6 text-[var(--accent)]" />
        Phân tích beta
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        {events.length.toLocaleString("vi-VN")} sự kiện telemetry — tổng hợp từ khi bắt đầu
        ghi (không cửa sổ hiển thị; retention chờ quyết định — A6). Số liệu tính đến{" "}
        {formatDate(new Date())}.
      </p>

      {/* §5.8.2 — metric cards (mọi rate kèm n=numerator/denominator) */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p className="text-xs text-[var(--muted)]">{c.label}</p>
            <p
              className={`mt-2 text-lg font-extrabold tracking-tight ${
                c.pending ? "text-[var(--muted)]" : ""
              }`}
            >
              {c.value}
            </p>
            {c.note && <p className="mt-1 text-[11px] text-[var(--muted)]">{c.note}</p>}
          </div>
        ))}
      </div>

      {/* Pending contracts — giải thích trạng thái chờ (không tự chế số) */}
      <section className="card mt-6 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
          Chỉ số chờ quyết định của founder
        </h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Các contract metric phụ thuộc window/chính sách chưa được founder quyết định
          (A1/A2/A3 — spec §4.11 Policy Non-Invention) hiển thị trạng thái pending có tên
          tham số, không bao giờ hiển thị con số tự chế. Giá trị chỉ có sau khi founder
          quyết — các mục này nằm trong Batch 8 Founder Decision Register.
        </p>
      </section>

      {/* Segmentation (spec §5.8.2) — count luôn hiển thị, không ngưỡng minimum-n */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Phân đoạn theo cohort beta
          </h2>
          <div className="mt-3 space-y-2">
            {cohortSegments.map((seg) => (
              <div key={seg.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-[var(--ink-2)]">{seg.label}</span>
                <span className="font-bold">
                  {seg.events.length.toLocaleString("vi-VN")}{" "}
                  <span className="text-xs font-normal text-[var(--muted)]">sự kiện</span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            Event của member ACTIVE của cohort (join qua pseudonym); event anonymous không
            thuộc cohort nào.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Phân đoạn theo thị trường
          </h2>
          <div className="mt-3 space-y-2">
            {marketSegments.map((seg) => (
              <div key={seg.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-[var(--ink-2)]">{seg.label}</span>
                <span className="text-right">
                  <span className="font-bold">
                    {seg.events.length.toLocaleString("vi-VN")}{" "}
                    <span className="text-xs font-normal text-[var(--muted)]">sự kiện</span>
                  </span>
                  <span className="block text-[11px] text-[var(--muted)]">
                    {renderMetricValue(
                      METRIC_CONTRACTS.zero_result_rate_v1,
                      zeroResultRate(seg.events),
                    )}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            Nhãn thị trường là nhãn operational/acquisition (spec §4.7) — location không
            phải tín hiệu tin cậy.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Phân đoạn theo danh mục
          </h2>
          <div className="mt-3 space-y-2">
            {byCountDesc([...byCategory.entries()]).map(([categoryId, segEvents]) => (
              <div
                key={categoryId}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-[var(--ink-2)]">
                  {categoryNameById.get(categoryId) ?? categoryId}
                </span>
                <span className="font-bold">
                  {segEvents.length.toLocaleString("vi-VN")}{" "}
                  <span className="text-xs font-normal text-[var(--muted)]">sự kiện</span>
                </span>
              </div>
            ))}
            {byCategory.size === 0 && (
              <p className="text-sm text-[var(--muted)]">Chưa có sự kiện gắn danh mục.</p>
            )}
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            Join event → listing approved → danh mục; sự kiện không gắn tin không vào segment.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Phân đoạn theo brand / model
          </h2>
          <div className="mt-3 space-y-2">
            {byCountDesc([...byBrand.entries()]).map(([brandId, segEvents]) => (
              <div
                key={`brand-${brandId}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-[var(--ink-2)]">
                  {brandNameById.get(brandId) ?? brandId}
                </span>
                <span className="font-bold">
                  {segEvents.length.toLocaleString("vi-VN")}{" "}
                  <span className="text-xs font-normal text-[var(--muted)]">sự kiện</span>
                </span>
              </div>
            ))}
            {byCountDesc([...byModel.entries()]).map(([modelId, segEvents]) => (
              <div
                key={`model-${modelId}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-[var(--ink-2)]">
                  {modelNameById.get(modelId) ?? modelId}
                </span>
                <span className="font-bold">
                  {segEvents.length.toLocaleString("vi-VN")}{" "}
                  <span className="text-xs font-normal text-[var(--muted)]">sự kiện</span>
                </span>
              </div>
            ))}
            {byBrand.size === 0 && byModel.size === 0 && (
              <p className="text-sm text-[var(--muted)]">Chưa có sự kiện gắn brand/model.</p>
            )}
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            Join event → listing approved → brand/model; count luôn hiển thị (sample size
            permits — không ngưỡng tự chế).
          </p>
        </section>
      </div>
    </div>
  );
}
