"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireCapability, requireAdminUser } from "@/src/lib/rbac";
import { audit, auditTx, recordStatusChange, listingPublicationInputFromRow } from "@/src/lib/actions/helpers";
import { recordLedgerTx, escrowRelease, escrowRefund } from "@/src/lib/ledger";
import { assertFinancialFeaturesEnabled } from "@/src/lib/financial-features";
import { auditEvent, auditEventTx } from "@/src/lib/audit-event";
import { checkListingPublication } from "@/src/lib/listing-publication";
import { notify } from "@/src/lib/notify";
import {
  recordListingRejected,
  recordSellerFirstListingPublished,
} from "@/src/lib/telemetry-recorders";

/**
 * Batch 2 Task 10: legacy seller-verification toggle đã XÓA — SellerVerification
 * workflow (src/lib/actions/seller-verification.ts) là canonical (spec §8.2);
 * legacy User.isVerifiedSeller chỉ còn hiển thị (badge "legacy" ở
 * /admin/users). approveListingAction được nối vào publication gate
 * (defense-in-depth — spec §7.3: admin duyệt cũng bị chặn khi seller mất
 * verification/membership) + auditEvent("listing.approved"|"listing.rejected"|
 * "listing.approve_blocked") theo registry Task 5 (song song legacy audit()).
 *
 * Batch 4 Task 4: gate qua `checkListingPublication` (Task 2 wrapper) MỘT LẦN —
 * seller gate (Batch 2, giờ qua wrapper — call trực tiếp
 * checkSellerPublicationRequirements ĐÃ XÓA) + category allowlist (§5.6.1) +
 * regime schema (§5.6/§6.3) + canonical-model DB check + image ownership
 * (§5.6.4). Audit HAI reason tách bạch (item 6): seller thiếu →
 * "publication_requirements_unmet" + missing=… (Batch 2 pin); content sai →
 * "listing_content_invalid" + issues=… (typed codes).
 */

/**
 * Duyệt tin đăng — version ĐÃ REVIEW + recusal + audit cùng tx (Batch 4
 * holistic review fix).
 *
 * Version (CONFIRMED MEDIUM authz-idor/tx-concurrency): review card post
 * `version` = `updatedAt` mà card đã RENDER (hidden input). Action CAS theo
 * CHÍNH giá trị đó — KHÔNG còn CAS theo updatedAt đọc tươi trong action
 * (seller edit content giữa lúc admin mở card và click Duyệt → updatedAt
 * bump → version stale → approval TỪ CHỐI: content moderator chưa bao giờ
 * thấy KHÔNG được duyệt). Thiếu/malformed → no approval + audit typed
 * reason (form mới luôn post version — request thiếu = forged/stale).
 *
 * Recusal (S9 — Batch 3 takedown pattern, moderation.ts): moderator là
 * seller của CHÍNH listing → KHÔNG tự duyệt (bypass human review trên tin
 * của mình) → audit `moderator_conflict` + redirect typed ?error= code.
 *
 * Tx (CONFIRMED LOW tx-concurrency): CAS claim + legacy AdminAuditLog
 * (auditTx) + AuditEvent listing.approved (auditEventTx) trong MỘT
 * db.transaction — audit fail → rollback, không còn approved-missing-audit.
 * 0-row claim → sentinel throw ra khỏi callback, classify NGOÀI tx.
 */
export async function approveListingAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("listing.moderate");
  const listingId = String(formData.get("listingId") ?? "");

  // ─── Version listing mà admin đã REVIEW (hidden input từ review card) ───
  // Thiếu/malformed → KHÔNG approve (fail closed) + audit typed reason.
  const versionRaw = String(formData.get("version") ?? "");
  if (versionRaw === "" || Number.isNaN(Date.parse(versionRaw))) {
    try {
      await auditEvent({
        actorId: admin.user.id,
        subjectId: null,
        action: "listing.approve_blocked",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
        reason: "listing_version_missing",
      });
    } catch {
      /* fail-open: audit lỗi không mở đường approve */
    }
    return; // no approval
  }

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.status !== "pending") return;

  // ─── Recusal (S9 — conflict of interest, Batch 3 takedown pattern) ───
  // moderator-seller KHÔNG tự duyệt tin của chính mình — human review trên
  // tin của mình phải do moderator khác thực hiện.
  if (listing.sellerId === admin.user.id) {
    try {
      await auditEvent({
        actorId: admin.user.id,
        subjectId: listing.sellerId,
        action: "listing.approve_blocked",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
        reason: "moderator_conflict",
      });
    } catch {
      /* fail-open: audit lỗi không mở đường approve */
    }
    revalidatePath("/admin/listings");
    redirect("/admin/listings?error=MODERATOR_CONFLICT"); // typed code trong allowlist banner
  }

  // ─── Version check: admin review ĐÚNG version này? ───
  // Content đổi tay giữa render (review) và click → updatedAt khác version
  // → KHÔNG approve content chưa review. Card re-render với content mới.
  if (listing.updatedAt !== versionRaw) {
    try {
      await auditEvent({
        actorId: admin.user.id,
        subjectId: listing.sellerId,
        action: "listing.approve_blocked",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
        reason: "listing_changed_during_review",
      });
    } catch {
      /* fail-open: audit lỗi không mở đường approve */
    }
    revalidatePath("/admin/listings");
    return; // no approval
  }

  // ─── Publication gate (Task 10 — spec §4.4/§7.3 defense-in-depth) ───
  // Admin duyệt KHÔNG phải escape hatch: seller mất verification (revoked) /
  // membership (suspended) / đang bị đình chỉ → KHÔNG approve; content sai
  // (category/schema/model/ảnh) → KHÔNG approve. Input TỪ DB ROW (trust
  // boundary), đọc FRESH từ DB.
  // b4-holistic-2 (LOW — legacy bounds): admin approve của row KHÔNG đổi
  // content → HAI upper bound lưu-trữ (description ≤4000, ảnh ≤8) được
  // grandfather — row legacy hợp lệ dưới luật cũ không kẹt approve_blocked
  // mãi mãi. Đường formData KHÔNG bao giờ grandfather (xem listing-schema.ts).
  const input = await listingPublicationInputFromRow(listing, listing.sellerId);
  input.grandfatherStoredBounds = true;
  const check = await checkListingPublication(input);
  if (!check.ok) {
    // Audit fail-open — block vẫn chặn kể cả khi audit lỗi (spec §4.6/§4.8:
    // detail chỉ typed requirement keys / typed content codes, KHÔNG PII).
    try {
      await auditEvent({
        actorId: admin.user.id,
        subjectId: listing.sellerId,
        action: "listing.approve_blocked",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
        // HAI reason tách bạch (item 6): seller thiếu thắng priority — giữ
        // nguyên Batch 2 pin (publication_requirements_unmet + missing=…);
        // còn lại là content → listing_content_invalid + issues=… (mới).
        reason:
          check.sellerMissing.length > 0
            ? "publication_requirements_unmet"
            : "listing_content_invalid",
        detail:
          check.sellerMissing.length > 0
            ? `missing=${check.sellerMissing.join(",")}`
            : `issues=${check.listingIssues.join(",")}`,
      });
    } catch {
      /* fail-open: audit lỗi không mở đường approve */
    }
    return; // no approval
  }

  // ─── MỘT tx: CAS claim theo version ĐÃ REVIEW + CẢ HAI audit ───
  // (Batch 4 holistic — LOW tx-concurrency: claim + AdminAuditLog +
  // AuditEvent sống chết cùng tx; audit fail → rollback → KHÔNG approve).
  // 0 rows → sentinel THROW ra khỏi callback, classify NGOÀI tx.
  // b4-holistic-2 (LOW — review backfill): approvedContentAt ghi trong CÙNG
  // tx với claim — review version của content (toggle hidden→show đọc cột
  // này: SET ⇒ content hiện tại đã được duyệt; NULL ⇒ vào pending).
  let claimLost = false;
  try {
    await db.transaction(async (tx) => {
      const claimed = await tx.orm.public.Listing
        .where({ id: listingId, status: "pending", updatedAt: versionRaw })
        .updateAll({
          status: "approved",
          rejectionReason: null,
          approvedContentAt: new Date().toISOString(),
        });
      if (claimed.length === 0) throw new Error("LISTING_APPROVE_CLAIM_LOST");
      await auditTx(tx, admin.user.id, "approve_listing", "Listing", listingId, listing.title);
      await auditEventTx(tx, {
        actorId: admin.user.id,
        subjectId: listing.sellerId,
        action: "listing.approved",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "LISTING_APPROVE_CLAIM_LOST") {
      claimLost = true;
    } else {
      throw e; // infra/constraint error — fail closed VISIBLE (không masquerade no-op)
    }
  }
  if (claimLost) {
    // Phân loại NGOÀI tx: row vẫn pending → content đổi giữa review và claim
    // (updatedAt bump) → audit typed reason, KHÔNG approve (admin duyệt lại —
    // review content MỚI). Row không còn pending → admin khác đã xử lý →
    // no-op im lặng (Batch 2 behavior giữ nguyên).
    const fresh = await db.orm.public.Listing.first({ id: listingId });
    if (fresh !== null && fresh.status === "pending") {
      try {
        await auditEvent({
          actorId: admin.user.id,
          subjectId: listing.sellerId,
          action: "listing.approve_blocked",
          resourceType: "Listing",
          resourceId: listingId,
          sessionId: admin.session.id,
          reason: "listing_changed_during_review",
        });
      } catch {
        /* fail-open: audit lỗi không mở đường approve */
      }
    }
    revalidatePath("/admin/listings");
    return; // no approval
  }

  // ─── Telemetry (Batch 5 Task 8 — S7/S-19) ──────────────────────────────────
  // seller_first_listing_published: điểm này chỉ tới khi checkListingPublication
  // PASS + update thành công (S5 — mọi return trước đó đã chặn). S-19 re-fire
  // guard sống trong recorder (event-existence theo actorPseudonym của seller —
  // append-only → check chính xác "lần approve ĐẦU"). Actor = seller được kích
  // hoạt (KHÔNG phải admin duyệt). Fail-open — KHÔNG đổi kết quả action.
  await recordSellerFirstListingPublished({
    sellerId: listing.sellerId,
    listingId,
  });

  const { notify } = await import("@/src/lib/notify");
  await notify(listing.sellerId, "listing", `Tin đã được duyệt: ${listing.title.slice(0, 50)}`, "Tin của bạn đang hiển thị trên chợ", `/listings/${listing.slug}`);
  revalidatePath("/admin/listings");
  revalidatePath("/listings");
}

/**
 * Từ chối tin đăng — cùng hợp đồng version/recusal/tx của approveListingAction
 * (Batch 4 holistic review fix): CAS theo version ĐÃ REVIEW (lý do từ chối
 * được viết cho content moderator THẤY — content đổi giữa render và click →
 * KHÔNG reject), claim + AdminAuditLog + AuditEvent listing.rejected trong
 * MỘT tx. Recusal KHÔNG áp dụng cho reject (tự từ chối tin của mình là
 * self-harm, KHÔNG phải review bypass — recorded trong report).
 */
export async function rejectListingAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("listing.moderate");
  const listingId = String(formData.get("listingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || "Nội dung không rõ ràng, thiếu thông tin";
  const versionRaw = String(formData.get("version") ?? "");
  if (versionRaw === "" || Number.isNaN(Date.parse(versionRaw))) {
    try {
      await auditEvent({
        actorId: admin.user.id,
        subjectId: null,
        action: "listing.reject_blocked",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
        reason: "listing_version_missing",
      });
    } catch {
      /* fail-open: audit lỗi không mở đường reject */
    }
    return;
  }

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.status !== "pending") return;

  // Version check: lý do từ chối được viết cho content moderator THẤY —
  // content đổi giữa render và click → KHÔNG reject với lý do cũ.
  if (listing.updatedAt !== versionRaw) {
    try {
      await auditEvent({
        actorId: admin.user.id,
        subjectId: listing.sellerId,
        action: "listing.reject_blocked",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
        reason: "listing_changed_during_review",
      });
    } catch {
      /* fail-open: audit lỗi không mở đường reject */
    }
    revalidatePath("/admin/listings");
    return;
  }

  // MỘT tx: CAS claim theo version ĐÃ REVIEW + cả hai audit (Batch 4
  // holistic — LOW tx-concurrency). 0 rows → sentinel throw ra khỏi
  // callback, classify NGOÀI tx.
  let claimLost = false;
  try {
    await db.transaction(async (tx) => {
      const claimed = await tx.orm.public.Listing
        .where({ id: listingId, status: "pending", updatedAt: versionRaw })
        .updateAll({ status: "rejected", rejectionReason: reason });
      if (claimed.length === 0) throw new Error("LISTING_REJECT_CLAIM_LOST");
      await auditTx(tx, admin.user.id, "reject_listing", "Listing", listingId, `${listing.title} — lý do: ${reason}`);
      await auditEventTx(tx, {
        actorId: admin.user.id,
        subjectId: listing.sellerId,
        action: "listing.rejected",
        resourceType: "Listing",
        resourceId: listingId,
        sessionId: admin.session.id,
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "LISTING_REJECT_CLAIM_LOST") {
      claimLost = true;
    } else {
      throw e; // infra/constraint error — fail closed VISIBLE
    }
  }
  if (claimLost) {
    const fresh = await db.orm.public.Listing.first({ id: listingId });
    if (fresh !== null && fresh.status === "pending") {
      try {
        await auditEvent({
          actorId: admin.user.id,
          subjectId: listing.sellerId,
          action: "listing.reject_blocked",
          resourceType: "Listing",
          resourceId: listingId,
          sessionId: admin.session.id,
          reason: "listing_changed_during_review",
        });
      } catch {
        /* fail-open: audit lỗi không mở đường reject */
      }
    }
    revalidatePath("/admin/listings");
    return;
  }

  // ─── Telemetry (Batch 5 Task 8 — S7) ──────────────────────────────────────
  // listing_rejected: sau khi update thành công (điểm này chỉ tới khi claim
  // không thua). Actor = admin. Lý do từ chối là FREE TEXT — KHÔNG BAO GIỀ vào
  // telemetry (schema {}). Fail-open — KHÔNG đổi kết quả action.
  await recordListingRejected({
    actorId: admin.user.id,
    sessionId: admin.session.id,
    listingId,
  });

  const { notify } = await import("@/src/lib/notify");
  await notify(listing.sellerId, "listing", `Tin bị từ chối: ${listing.title.slice(0, 50)}`, `Lý do: ${reason} — sửa tin để duyệt lại`, "/sell/my");
  revalidatePath("/admin/listings");
}

/** Xử lý khiếu nại: nghiêng về buyer (hoàn tiền) hoặc seller (giải ngân) */
export async function resolveDisputeAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // khiếu nại tài chính = finance mutation — admin không phải escape hatch (spec §4.10)
  const admin = await requireAdminUser();
  const disputeId = String(formData.get("disputeId") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? ""); // resolved_buyer | resolved_seller | closed

  if (resolution.length < 5) return;

  const dispute = await db.orm.public.Dispute.first({ id: disputeId });
  if (!dispute || dispute.status !== "open") return;

  const order = await db.orm.public.Order.first({ id: dispute.orderId });
  if (!order) return;

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.orm.public.Dispute
      .where({ id: disputeId })
      .update({ status: outcome as "resolved_buyer" | "resolved_seller" | "closed", resolution, resolvedAt: now });

    const isEscrowOrder = order.paymentMethod === "escrow";
    if (outcome === "resolved_buyer") {
      await tx.orm.public.Payment
        .where({ orderId: order.id })
        .update({ status: "refunded" });
      await tx.orm.public.Order
        .where({ id: order.id })
        .update({ status: "refunded" });
      await recordStatusChange(tx, order.id, "refunded", `Admin xử lý khiếu nại — nghiêng buyer: ${resolution}`, admin.user.id);
      if (isEscrowOrder) {
        // CHỈ escrow mới có tiền trong nền tảng để hoàn
        await recordLedgerTx(tx, "refund", order.id, escrowRefund(order.buyerId, order.totalAmount, `Admin hoàn escrow đơn ${order.code}`));
      }
      // trả tin về đang bán
      const items = await tx.orm.public.OrderItem.where({ orderId: order.id }).all();
      for (const item of items) {
        await tx.orm.public.Listing.where({ id: item.listingId }).update({ status: "approved" });
      }
    } else if (outcome === "resolved_seller") {
      await tx.orm.public.Payment
        .where({ orderId: order.id })
        .update({ status: "released", releasedAt: now });
      await tx.orm.public.Order
        .where({ id: order.id })
        .update({ status: "completed", escrowReleasedAt: now });
      if (isEscrowOrder) {
        const existingPayout = await tx.orm.public.Payout.where({ orderId: order.id }).first();
        if (!existingPayout) {
          await tx.orm.public.Payout.create({
            orderId: order.id,
            sellerId: order.sellerId,
            amount: order.sellerPayout,
            status: "released",
          });
        }
        await recordStatusChange(tx, order.id, "completed", `Admin xử lý khiếu nại — giải ngân escrow cho seller: ${resolution}`, admin.user.id);
        await recordLedgerTx(tx, "payout", order.id, escrowRelease(order.sellerId, order.totalAmount, order.commissionAmount, `Admin giải ngân đơn ${order.code}`));
      } else {
        await recordStatusChange(tx, order.id, "completed", `Admin xử lý khiếu nại — nghiêng seller (giao dịch trực tiếp): ${resolution}`, admin.user.id);
      }
    } else {
      // đóng băng tiếp tục → trả đơn về shipped để chờ tự giải ngân
      await tx.orm.public.Order
        .where({ id: order.id })
        .update({ status: "shipped" });
      await recordStatusChange(tx, order.id, "shipped", `Admin đóng khiếu nại — đơn tiếp tục chờ xác nhận: ${resolution}`, admin.user.id);
    }
  });

  await audit(admin.user.id, "resolve_dispute", "Dispute", disputeId, `Đơn ${order.code}: ${resolution}`);
  await notify(order.buyerId, "dispute", `Khiếu nại đơn ${order.code} đã xử lý`, resolution.slice(0, 120), `/orders/${order.id}`);
  await notify(order.sellerId, "dispute", `Khiếu nại đơn ${order.code} đã xử lý`, resolution.slice(0, 120), `/orders/${order.id}`);
  revalidatePath("/admin/disputes");
  revalidatePath(`/orders/${order.id}`);
}

/** Cập nhật % hoa hồng danh mục */
export async function updateCommissionAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // commission mutation — spec §4.1
  const admin = await requireAdminUser();
  const categoryId = String(formData.get("categoryId") ?? "");
  const commissionRate = Math.min(30, Math.max(0, Number(formData.get("commissionRate") ?? 5)));

  const category = await db.orm.public.Category.first({ id: categoryId });
  if (!category) return;

  await db.orm.public.Category
    .where({ id: categoryId })
    .update({ commissionRate });

  await audit(admin.user.id, "update_commission", "Category", categoryId, `${category.name}: ${commissionRate}%`);
  revalidatePath("/admin/settings");
}

/** Cấu hình nền tảng (key-value) */
export async function updateSettingAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // UI settings hôm nay chỉ còn finance keys (escrow/commission) — spec §4.1
  const admin = await requireAdminUser();
  const key = String(formData.get("key") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!key) return;

  const existing = await db.orm.public.PlatformSetting.first({ key });
  if (existing) {
    await db.orm.public.PlatformSetting.where({ key }).update({ value });
  } else {
    await db.orm.public.PlatformSetting.create({ key, value });
  }

  await audit(admin.user.id, "update_setting", "PlatformSetting", key, value);
  revalidatePath("/admin/settings");
}

/*
 * Legacy seller-verification TOGGLE — ĐÃ XÓA (Batch 2 Task 10, spec §8.2):
 * SellerVerification workflow (src/lib/actions/seller-verification.ts) là
 * canonical; legacy User.isVerifiedSeller KHÔNG còn đường mutate từ admin UI
 * (chỉ hiển thị badge "legacy" ở /admin/users). Grant/suspend founding_seller
 * membership: src/lib/actions/beta-cohort.ts (setBetaMembershipAction).
 */
