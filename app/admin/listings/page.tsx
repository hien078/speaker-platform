import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { formatVND, formatDate, cn } from "@/src/lib/utils";
import { LISTING_STATUS_LABELS, LISTING_STATUS_BADGE, CONDITION_LABELS } from "@/src/lib/constants";
import { listingRegimeForCategorySlug } from "@/src/lib/beta-categories";
import { isVerifiedSellerStatus } from "@/src/lib/seller-verification-status";
import { PROVINCE_CODES } from "@/src/lib/provinces";
import type {
  InventoryContext,
  ListingFulfillmentMethod,
  PhotoChecklistSlot,
} from "@/src/lib/listing-schema";
import { ATTACHED_IMAGE_PATH_PATTERN } from "@/src/lib/listing-images";
import { approveListingAction, rejectListingAction } from "@/src/lib/actions/admin";
import { FileSearch, CheckCircle2, XCircle } from "lucide-react";

// ─── Label maps (PROVISIONAL — FD-3) ─────────────────────────────────────────
// Plan Task 6 consume INVENTORY_CONTEXT_LABELS / FULFILLMENT_METHOD_LABELS /
// PHOTO_CHECKLIST_SLOT_LABELS từ src/lib/constants.ts (Task 5) — nhưng Task 5
// chạy SONG SONG trong batch này và là chủ sở hữu constants.ts (file-conflict
// rule), exports chưa tồn tại ở tree này. Labels sống cục bộ với giá trị theo
// comment contract.prisma + spec §5.2/§5.6.3. PROVISIONAL (FD-3): label copy là
// founder-authored content pending — Batch 8 Founder Decision Register.
// TODO(L1): unify with constants.ts after Task 5 merges.
//
// L1 (review fix): map TYPED theo union Task 2 (listing-schema.ts) — thiếu key
// fail typecheck, Record<string, string> rỗng không lọt nữa.

/** Enum `inventory_context` (contract.prisma — spec §5.6): new/open_box/used. */
const INVENTORY_CONTEXT_LABELS: Record<InventoryContext, string> = {
  new: "Mới / nguyên seal",
  open_box: "Mở hộp chưa dùng",
  used: "Đã qua sử dụng",
};

/** §5.2 fulfillment methods (mapping A7): meetup/seller_delivery/carrier/other. */
const FULFILLMENT_METHOD_LABELS: Record<ListingFulfillmentMethod, string> = {
  meetup: "Gặp trực tiếp",
  seller_delivery: "Người bán tự giao",
  carrier: "Đơn vị vận chuyển",
  other: "Khác",
};

/** 8 slot ảnh §5.6.3 — nhãn caption cho gallery duyệt. */
const PHOTO_CHECKLIST_SLOT_LABELS: Record<PhotoChecklistSlot, string> = {
  front: "Mặt trước",
  back: "Mặt sau",
  control_panel: "Bảng điều khiển",
  ports: "Cổng sạc / kết nối",
  damage: "Vết xước / hư hại",
  accessories: "Phụ kiện",
  box: "Hộp đựng",
  label_serial: "Nhãn / serial",
};

/** NULL/blank → "—" (legacy "not captured" — spec §8.3, KHÔNG backfill). */
const orDash = (v: string | null | undefined): string =>
  v != null && v.trim().length > 0 ? v : "—";

/**
 * Label lookup an toàn (L4 — review fix): Object.hasOwn TRƯỚC khi tra map —
 * key lạ (dữ liệu legacy/dirty không qua enum) → raw value làm text, KHÔNG
 * undefined. Map TYPED (L1) + hasOwn = cả typecheck lẫn runtime đều khép.
 */
const labelOrRaw = <K extends string>(labels: Record<K, string>, raw: string): string =>
  Object.hasOwn(labels, raw) ? labels[raw as K] : raw;

/**
 * Chỉ render <img> khi url là PATH same-origin sạch (M2 — review fix): reuse
 * ATTACHED_IMAGE_PATH_PATTERN của Task 2 (listing-images.ts — import, KHÔNG
 * copy pattern local) + chặn ".." như rule (2) của ownership check. URL có
 * scheme (https://… — row pre-Batch-4 có thể còn giữ) KHÔNG bao giờ vào
 * <img src>: browser moderator sẽ request nó → leak IP/UA về server của
 * kẻ gắn tracking pixel. Ảnh bị chặn → placeholder text, KHÔNG link tới nó.
 */
const isSafeImagePath = (url: string): boolean =>
  ATTACHED_IMAGE_PATH_PATTERN.test(url) && !url.includes("..");

/** fulfillmentMethods (Json) → nhãn hiển thị an toàn — chỉ phần tử string. */
const fulfillmentLabel = (raw: unknown): string => {
  if (!Array.isArray(raw)) return "—";
  const parts: string[] = [];
  for (const m of raw) {
    if (typeof m === "string") parts.push(labelOrRaw(FULFILLMENT_METHOD_LABELS, m));
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
};

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Duyệt tin" };

export default async function AdminListingsPage({
  searchParams,
}: PageProps<"/admin/listings">) {
  // Guard server-side (spec §4.5/§4.9) — moderation queue cần listing.moderate;
  // requireAdminUser ở layout chỉ là cổng vào /admin, không phải quyền xem queue.
  await requireCapability("listing.moderate");
  const sp = (await searchParams) as { tab?: string };
  const tab = sp.tab === "all" ? "all" : "pending";

  const listings = await db.orm.public.Listing
    // L5 (review fix): draft là seller-private (chưa submit — spec §4.4) —
    // KHÔNG xuất hiện ở queue moderator, kể cả tab "Tất cả". MỌI query của
    // page này loại draft (tab Chờ duyệt = pending hẹp hơn, cũng không draft).
    .where((l) => (tab === "pending" ? l.status.eq("pending") : l.status.neq("draft")))
    // Badge "đã xác minh" đọc WORKFLOW SỐNG (SellerVerification.status —
    // spec §8.2): seller bị thu hồi mất badge NGAY; boolean legacy
    // isVerifiedSeller đã đóng băng (Batch 2 review fix) — KHÔNG còn nguồn.
    .include("seller", (s) =>
      s.select("name", "email")
        .include("sellerVerification", (v) => v.select("status")))
    // slug để derive regime beta/legacy (§5.6.1) — badge trên card.
    .include("category", (c) => c.select("name", "slug"))
    .include("brand", (b) => b.select("name"))
    // Model chuẩn (§6.3 Step 1) — link /models/<slug> cho moderator; status
    // (L3) để badge model chưa canonical (pending/merged — enum model_status).
    .include("productModel", (m) => m.select("name", "slug", "status"))
    // Gallery MỌI ảnh + caption slot §5.6.3 — KHÔNG cắt ở ảnh đầu (bỏ limit 1 ảnh);
    // L2 (review fix): cap 12 ảnh theo sortOrder — include branch không kéo
    // vô hạn ảnh của listing legacy (Prisma 8 hỗ trợ .limit trên include branch).
    .include("images", (i) =>
      i.select("id", "url", "checklistSlot")
        .orderBy((img) => img.sortOrder.asc())
        .limit(12))
    .orderBy((l) => l.createdAt.desc())
    .limit(100)
    .all();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <FileSearch className="size-6 text-[var(--accent)]" />
          Duyệt tin đăng
        </h1>
        <div className="flex gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1">
          <a
            href="/admin/listings"
            className={cn("rounded-md px-3.5 py-1.5 text-sm font-medium transition", tab === "pending" ? "bg-[var(--accent)] text-white" : "text-[var(--ink-2)] hover:text-white")}
          >
            Chờ duyệt
          </a>
          <a
            href="/admin/listings?tab=all"
            className={cn("rounded-md px-3.5 py-1.5 text-sm font-medium transition", tab === "all" ? "bg-[var(--accent)] text-white" : "text-[var(--ink-2)] hover:text-white")}
          >
            Tất cả
          </a>
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="card mt-8 grid place-items-center gap-2 p-16 text-center">
          <span className="text-4xl">🎉</span>
          <p className="font-bold">
            {tab === "pending" ? "Hàng đợi duyệt trống!" : "Chưa có tin đăng nào"}
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {listings.map((l) => {
            // Regime category (§5.6.1): beta = trong allowlist, legacy = grandfathered.
            const isBeta = listingRegimeForCategorySlug(l.category!.slug) === "beta";
            // Vị trí canonical (§5.6): locationDisplayName (thô) + tỉnh canonical
            // từ registry 34 đơn vị (FD-1) — NULL = legacy → "—". L4: hasOwn trước
            // khi tra PROVINCE_CODES — mã lạ → raw value làm text.
            const provinceName =
              l.provinceLevelCode != null && l.provinceLevelCode.trim().length > 0
                ? (Object.hasOwn(PROVINCE_CODES, l.provinceLevelCode)
                    ? PROVINCE_CODES[l.provinceLevelCode]
                    : l.provinceLevelCode)
                : null;
            const locationParts = [l.locationDisplayName, provinceName].filter(
              (p): p is string => p != null && p.trim().length > 0,
            );
            return (
              <div key={l.id} className="card p-5">
                <div className="flex flex-col gap-4 sm:flex-row">
                  {/* Gallery — MỌI ảnh + caption slot §5.6.3 (KHÔNG cắt ở ảnh đầu) */}
                  <div className="flex w-full flex-wrap content-start gap-2 sm:w-[15.5rem] sm:shrink-0">
                    {l.images.length === 0 ? (
                      <span className="grid size-14 place-items-center text-2xl text-[var(--muted)]">🔇</span>
                    ) : (
                      l.images.map((img) => (
                        <figure key={img.id} className="w-14">
                          <div className="relative block size-14 overflow-hidden rounded-lg bg-[var(--paper-deep)]">
                            {isSafeImagePath(img.url) ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img src={img.url} alt="" className="size-full object-cover" />
                            ) : (
                              /* M2: url không tin được → placeholder, KHÔNG request, KHÔNG link */
                              <span className="grid size-full place-items-center p-1 text-center text-[9px] leading-[1.1] text-[var(--muted)]">
                                URL ảnh không hợp lệ
                              </span>
                            )}
                          </div>
                          <figcaption className="mt-0.5 text-center text-[10px] leading-3 text-[var(--muted)]">
                            {img.checklistSlot != null
                              ? labelOrRaw(PHOTO_CHECKLIST_SLOT_LABELS, img.checklistSlot)
                              : "—"}
                          </figcaption>
                        </figure>
                      ))
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("badge", LISTING_STATUS_BADGE[l.status])}>
                        {LISTING_STATUS_LABELS[l.status] ?? l.status}
                      </span>
                      <span
                        className={cn(
                          "badge",
                          isBeta
                            ? "bg-violet-500/15 text-violet-400"
                            : "bg-zinc-700/60 text-zinc-300",
                        )}
                      >
                        {isBeta ? "Danh mục beta" : "Danh mục legacy"}
                      </span>
                      <span className="text-xs text-[var(--muted)]">{formatDate(l.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-1 font-bold">{l.title}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {l.category!.name}{l.brand ? ` · ${l.brand.name}` : ""} · {CONDITION_LABELS[l.condition]} · {l.city}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      Người bán: <b className="text-[var(--ink-2)]">{l.seller!.name}</b>
                      <span className="text-[var(--muted)]"> ({l.seller!.email})</span>
                      {isVerifiedSellerStatus(l.seller!.sellerVerification?.status) && (
                        <span className="ml-1 text-[var(--green)]">✓ đã xác minh</span>
                      )}
                    </p>
                    <p className="mt-1 text-base font-extrabold text-[var(--accent)]">{formatVND(l.price)}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--ink-2)]">{l.description}</p>

                    {/* ─── Structured fields (Batch 4 — spec §5.6) — NULL = legacy → "—" ─── */}
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                      <div>
                        <p className="text-[var(--muted)]">Nguồn hàng</p>
                        <p className="font-medium text-[var(--ink-2)]">
                          {l.inventoryContext != null
                            ? labelOrRaw(INVENTORY_CONTEXT_LABELS, l.inventoryContext)
                            : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[var(--muted)]">Model chuẩn</p>
                        <p className="font-medium text-[var(--ink-2)]">
                          {l.productModel ? (
                            <>
                              <a
                                href={`/models/${l.productModel.slug}`}
                                className="text-[var(--accent)] underline-offset-2 hover:underline"
                              >
                                {l.productModel.name}
                              </a>
                              {l.productModel.status !== "approved" && (
                                /* L3: model chưa canonical (pending chờ duyệt /
                                 * merged đã gộp — enum model_status) → badge cạnh
                                 * link, moderator KHÔNG duyệt như model chuẩn. */
                                <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                                  {l.productModel.status === "merged"
                                    ? "Model đã gộp"
                                    : "Model chờ duyệt"}
                                </span>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-[var(--muted)]">Vị trí</p>
                        <p className="font-medium text-[var(--ink-2)]">
                          {locationParts.length > 0 ? locationParts.join(" · ") : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[var(--muted)]">Cách giao hàng</p>
                        <p className="font-medium text-[var(--ink-2)]">{fulfillmentLabel(l.fulfillmentMethods)}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-[var(--muted)]">Phụ kiện kèm theo</p>
                        <p className="line-clamp-2 font-medium text-[var(--ink-2)]">{orDash(l.includedAccessories)}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-[var(--muted)]">Vết lỗi đã biết</p>
                        <p className="line-clamp-2 font-medium text-[var(--ink-2)]">{orDash(l.knownDefects)}</p>
                      </div>
                      <div className="col-span-2 sm:col-span-4">
                        <p className="text-[var(--muted)]">Lịch sử sửa chữa</p>
                        <p className="line-clamp-2 font-medium text-[var(--ink-2)]">{orDash(l.repairHistory)}</p>
                      </div>
                    </div>
                  </div>

                  {l.status === "pending" && (
                    <div className="flex shrink-0 gap-2 sm:flex-col">
                      <form action={approveListingAction} className="flex-1">
                        <input type="hidden" name="listingId" value={l.id} />
                        <button type="submit" className="btn-primary h-10 w-full px-4 text-sm">
                          <CheckCircle2 className="size-4" />
                          Duyệt
                        </button>
                      </form>
                      <form action={rejectListingAction} className="flex-1">
                        <input type="hidden" name="listingId" value={l.id} />
                        <input type="hidden" name="reason" value="Nội dung chưa rõ ràng, vui lòng bổ sung thông tin và hình ảnh thực tế" />
                        <button type="submit" className="btn-danger h-10 w-full px-4 text-sm">
                          <XCircle className="size-4" />
                          Từ chối
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
