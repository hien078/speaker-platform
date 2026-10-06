"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { requireCapabilityWithStepUp } from "@/src/lib/rbac";
import { auditEvent, auditEventTx } from "@/src/lib/audit-event";
import { notify } from "@/src/lib/notify";
import {
  SELLER_VERIFICATION_POLICY_VERSION,
  SELLER_RULES_POLICY_KEY,
  SELLER_RULES_POLICY_VERSION,
  SELLER_VERIFICATION_REASON_CODES,
  SELLER_VERIFICATION_DECISIONS,
  checkSellerPublicationRequirements,
  formatMissingRequirements,
} from "@/src/lib/seller-verification-policy";
import { isProvinceCode } from "@/src/lib/provinces";

/**
 * SellerVerification workflow (Batch 2 Task 10 — spec §5.3.2/§5.3.3, §4.5,
 * §4.6, §7.3) — workflow có review thay cho boolean legacy:
 *
 *  - declareSellerProfileAction: seller KHAI BÁO (seller type + mã tỉnh
 *    canonical 34 đơn vị — FD-1) — không thu thập giấy tờ danh tính ở bất kỳ
 *    đâu (spec §5.3.2 "Do not collect identity documents 'just in case'").
 *  - submitSellerVerificationAction: seller gửi hồ sơ — kiểm mọi yêu cầu
 *    TRỪ operations_review_verified (review là việc ops) + ghi nhận đồng ý
 *    Seller Rules v1 (cơ chế ghi nhận; văn bản pháp lý thuộc Batch 8 —
 *    FD-3: placeholder trung tính, không bịa nội dung pháp lý).
 *  - reviewSellerVerificationAction: MỌI quyết định verification thủ công là
 *    step-up capability (Ambiguity A5 — seller.verify /
 *    seller.verification.revoke ∈ STEP_UP_CAPABILITIES) + ATOMIC CLAIM theo
 *    status (Review Focus 5): quyết định thứ hai trên row đã review →
 *    VERIFICATION_ALREADY_REVIEWED, không bao giờ ghi đè quyết định trước.
 *
 * Audit (spec §4.6): mọi hành động ghi AuditEvent với reason typed +
 * policyVersion; detail KHÔNG chứa PII thô (spec §4.8) — chỉ typed values.
 * KHÔNG thu thập/in email/phone của seller trong audit path.
 *
 * Copy §6.2: thông báo xác minh dùng đúng câu trung tính
 * "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet." —
 * không bao giờ ngôn ngữ bảo đảm/đảm bảo/chứng nhận sản phẩm.
 */

export type SellerVerificationFormState = {
  /** Thông báo lỗi tiếng Việt (user-facing). */
  error?: string;
  /** Thông báo thành công tiếng Việt (user-facing). */
  success?: string;
  /** Mã ổn định cho test/client — không phải prose. */
  code?: string;
};

// ─── Validation ───────────────────────────────────────────────────────────────

const sellerTypeSchema = z.enum(["individual", "business"], {
  error: () => "Loại người bán: cá nhân hoặc doanh nghiệp.",
});
const provinceCodeSchema = z.string().trim().min(1).refine(isProvinceCode, {
  error: "Chọn khu vực hoạt động trong danh sách 34 tỉnh/thành hiện hành.",
});

// ─── 1. Khai báo hồ sơ người bán ───────────────────────────────────────────────

/**
 * Seller khai báo loại người bán (individual|business) + mã tỉnh hoạt động
 * canonical (FD-1 — registry 34 đơn vị, src/lib/provinces.ts). requireUser;
 * validate; update User.sellerType/sellerOperatingProvinceCode + audit
 * "seller_profile.declared". KHÔNG thu thập giấy tờ tùy thân (spec §5.3.2).
 */
export async function declareSellerProfileAction(
  _prev: SellerVerificationFormState,
  formData: FormData,
): Promise<SellerVerificationFormState> {
  const user = await requireUser();

  const typeParsed = sellerTypeSchema.safeParse(String(formData.get("sellerType") ?? ""));
  if (!typeParsed.success) {
    return { error: typeParsed.error.issues[0]?.message ?? "Loại người bán không hợp lệ.", code: "INVALID_SELLER_TYPE" };
  }
  const provinceParsed = provinceCodeSchema.safeParse(String(formData.get("operatingProvinceCode") ?? ""));
  if (!provinceParsed.success) {
    return { error: provinceParsed.error.issues[0]?.message ?? "Khu vực hoạt động không hợp lệ.", code: "INVALID_PROVINCE" };
  }

  await db.orm.public.User.where({ id: user.id }).updateAll({
    sellerType: typeParsed.data,
    sellerOperatingProvinceCode: provinceParsed.data,
  });

  await auditEvent({
    actorId: user.id,
    subjectId: user.id,
    action: "seller_profile.declared",
    resourceType: "User",
    resourceId: user.id,
    sessionId: user.sessionId,
    // typed values — KHÔNG PII (spec §4.8)
    detail: `sellerType=${typeParsed.data};province=${provinceParsed.data}`,
  });

  revalidatePath("/sell/verification");
  return { success: "Đã lưu khai báo hồ sơ người bán." };
}

// ─── 2. Gửi hồ sơ xác minh ───────────────────────────────────────────────────

/**
 * Seller gửi hồ sơ xác minh: tick đồng ý Seller Rules v1 (cơ chế ghi nhận —
 * văn bản thuộc Batch 8, FD-3) + kiểm MỌI yêu cầu publication TRỪ
 * operations_review_verified (review là việc của operations) VÀ trừ
 * seller_rules_accepted (chính action này ghi nhận trong cùng tx).
 *
 * Thiếu → error LIỆT KÊ yêu cầu (không tạo row). Đủ → tạo/cập nhật
 * SellerVerification status=pending (CAS theo status đã đọc —
 * rejected/needs_review/revoked → pending; pending/verified → no-op idempotent)
 * + PolicyAcceptance(seller_rules, v1) TRONG CÙNG tx + audit
 * "seller_verification.submitted" (trên tx — sống chết cùng hồ sơ).
 */
export async function submitSellerVerificationAction(
  _prev: SellerVerificationFormState,
  formData: FormData,
): Promise<SellerVerificationFormState> {
  const user = await requireUser();

  if (formData.get("acceptSellerRules") !== "on") {
    return {
      error: "Bạn phải đồng ý với Quy tắc người bán LoaViet trước khi gửi hồ sơ.",
      code: "SELLER_RULES_NOT_ACCEPTED",
    };
  }

  // Mọi requirement TRỪ operations_review_verified (ops review) và
  // seller_rules_accepted (action này ghi nhận ngay dưới đây).
  const check = await checkSellerPublicationRequirements(user.id);
  const missing = check.missing.filter(
    (r) => r !== "operations_review_verified" && r !== "seller_rules_accepted",
  );
  if (missing.length > 0) {
    return {
      error: `Chưa đủ điều kiện gửi hồ sơ — còn thiếu: ${formatMissingRequirements(missing)}.`,
      code: "REQUIREMENTS_MISSING",
    };
  }

  const now = new Date().toISOString();
  // Row có THẬT được tạo/chuyển trạng thái → mới audit (no-op idempotent không ghi vết ồn).
  let submittedRowId: string | null = null;

  await db.transaction(async (tx) => {
    // Ghi nhận đồng ý Seller Rules v1 — idempotent theo @@unique(userId, key, version)
    const acceptance = await tx.orm.public.PolicyAcceptance.first({
      userId: user.id,
      policyKey: SELLER_RULES_POLICY_KEY,
      policyVersion: SELLER_RULES_POLICY_VERSION,
    });
    if (acceptance === null) {
      await tx.orm.public.PolicyAcceptance.create({
        userId: user.id,
        policyKey: SELLER_RULES_POLICY_KEY,
        policyVersion: SELLER_RULES_POLICY_VERSION,
      });
    }

    const row = await tx.orm.public.SellerVerification.first({ userId: user.id });
    if (row === null) {
      const created = await tx.orm.public.SellerVerification.create({
        userId: user.id,
        status: "pending",
        method: "operations_review",
        submittedAt: now,
        policyVersion: SELLER_VERIFICATION_POLICY_VERSION,
      });
      submittedRowId = created.id;
    } else if (row.status === "pending" || row.status === "verified") {
      // đã trong hàng đợi / đã được xác minh — no-op idempotent (không reset gì)
    } else {
      // rejected/needs_review/revoked → gửi lại: CAS CHỈ khi vẫn còn status đã đọc
      // (quyết định trước đó không bị request khác ghi đè giữa chừng).
      const claimed = await tx.orm.public.SellerVerification
        .where({ id: row.id, status: row.status })
        .updateAll({
          status: "pending",
          submittedAt: now,
          policyVersion: SELLER_VERIFICATION_POLICY_VERSION,
          reasonCode: null, // quyết định cũ thuộc về AuditEvent history
          note: null,
        });
      if (claimed.length > 0) submittedRowId = row.id;
    }

    if (submittedRowId !== null) {
      await auditEventTx(tx, {
        actorId: user.id,
        subjectId: user.id,
        action: "seller_verification.submitted",
        resourceType: "SellerVerification",
        resourceId: submittedRowId,
        policyVersion: SELLER_VERIFICATION_POLICY_VERSION,
        sessionId: user.sessionId,
      });
    }
  });

  revalidatePath("/sell/verification");
  return { success: "Đã gửi hồ sơ — operations sẽ xem xét theo chính sách hiện hành." };
}

// ─── 3. Quyết định của operations (review) ────────────────────────────────────

/** Thông báo seller theo quyết định — copy trung tính §6.2, không bảo đảm. */
const DECISION_NOTIFY: Record<
  (typeof SELLER_VERIFICATION_DECISIONS)[number],
  { title: string; body: string }
> = {
  verified: {
    title: "Xác minh người bán đã được duyệt",
    body: "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.",
  },
  needs_review: {
    title: "Hồ sơ người bán cần xem xét thêm",
    body: "Hồ sơ của bạn đang được operations xem xét thêm theo yêu cầu hiện hành của LoaViet.",
  },
  rejected: {
    title: "Hồ sơ xác minh người bán chưa được duyệt",
    body: "Hồ sơ chưa thỏa yêu cầu hiện hành của LoaViet — xem chi tiết và gửi lại khi đã đủ điều kiện.",
  },
  revoked: {
    title: "Xác minh người bán đã bị thu hồi",
    body: "Xác minh người bán của bạn đã bị thu hồi theo yêu cầu hiện hành của LoaViet.",
  },
};

/**
 * Operations review một hồ sơ (spec §5.3.3): MỌI quyết định thủ công ghi
 * reviewer + timestamp + policy version + typed reason code + note tuỳ chọn.
 *
 * Capability theo quyết định (Ambiguity A5 — step-up capability):
 *  - verified|needs_review|rejected → seller.verify
 *  - revoked                        → seller.verification.revoke
 *
 * ATOMIC CLAIM (Review Focus 5 — spec §10.1 concurrent update): MỘT
 * updateAll có điều kiện status — pending → verified|needs_review|rejected;
 * verified → revoked. 0 row (đã có quyết định khác / row không tồn tại) →
 * Error("VERIFICATION_ALREADY_REVIEWED") — quyết định thứ hai KHÔNG BAO GIỜ
 * ghi đè quyết định đầu. KHÔNG đọc-then-write: claim là compare-and-set.
 *
 * Sau claim: audit "seller_verification.reviewed" (reason + policyVersion) +
 * notify seller (copy §6.2 trung tính).
 */
export async function reviewSellerVerificationAction(formData: FormData): Promise<void> {
  const decisionParsed = z.enum(SELLER_VERIFICATION_DECISIONS).safeParse(
    String(formData.get("decision") ?? ""),
  );
  if (!decisionParsed.success) throw new Error("INVALID_DECISION");
  const reasonParsed = z.enum(SELLER_VERIFICATION_REASON_CODES).safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_REASON_CODE");

  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) throw new Error("INVALID_USER");
  const note = String(formData.get("note") ?? "").trim() || null;
  const totpCode = String(formData.get("totpCode") ?? "").trim() || undefined;

  // Guard THEO quyết định — revoked đòi capability thu hồi riêng (fail closed
  // trước khi đụng MFA/db: role sai không nhận được oracle nào).
  const cap = decisionParsed.data === "revoked" ? "seller.verification.revoke" : "seller.verify";
  const admin = await requireCapabilityWithStepUp(cap, totpCode);

  // ATOMIC CLAIM — compare-and-set theo status, KHÔNG read-then-write.
  const expectedCurrent = decisionParsed.data === "revoked" ? "verified" : "pending";
  const claimed = await db.orm.public.SellerVerification
    .where({ userId, status: expectedCurrent })
    .updateAll({
      status: decisionParsed.data,
      reviewedAt: new Date().toISOString(),
      reviewerId: admin.user.id,
      reasonCode: reasonParsed.data,
      note,
      policyVersion: SELLER_VERIFICATION_POLICY_VERSION,
    });
  if (claimed.length === 0) {
    // row đã được quyết định bởi request khác (hoặc không tồn tại) — KHÔNG ghi đè
    throw new Error("VERIFICATION_ALREADY_REVIEWED");
  }

  await auditEvent({
    actorId: admin.user.id,
    subjectId: userId,
    action: "seller_verification.reviewed",
    resourceType: "SellerVerification",
    resourceId: claimed[0]!.id,
    reason: reasonParsed.data,
    policyVersion: SELLER_VERIFICATION_POLICY_VERSION,
    sessionId: admin.session.id,
    detail: `decision=${decisionParsed.data}`, // typed — KHÔNG PII (spec §4.8)
  });

  const notifyCopy = DECISION_NOTIFY[decisionParsed.data];
  await notify(userId, "security", notifyCopy.title, notifyCopy.body, "/sell/verification");

  revalidatePath("/admin/seller-verification");
  revalidatePath("/sell/verification");
}
