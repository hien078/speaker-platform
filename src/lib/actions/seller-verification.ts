"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { requireCapabilityWithStepUp } from "@/src/lib/rbac";
import { auditEventTx } from "@/src/lib/audit-event";
import { notify } from "@/src/lib/notify";
import {
  SELLER_VERIFICATION_POLICY_VERSION,
  SELLER_RULES_POLICY_KEY,
  SELLER_RULES_POLICY_VERSION,
  SELLER_VERIFICATION_REASON_CODES,
  SELLER_VERIFICATION_DECISIONS,
  SELLER_VERIFICATION_DECISION_REASON_CODES,
  checkSellerPublicationRequirements,
  formatMissingRequirements,
  type SellerVerificationStatus,
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
 *
 * Review fix M2 (fail closed — FD-3): khai báo ĐỔI sau khi verification đã
 * `verified` làm quyết định trước đó hết căn cứ → chuyển verification sang
 * `needs_review` bằng COMPARE-AND-SET (chỉ khi vẫn còn `verified`) trong CÙNG
 * transaction với update User — gate chặn publication NGAY cho tới khi ops
 * quyết lại (needs_review ≠ verified). Khai báo KHÔNG đổi → no-op (không
 * update, không đụng verification). Audit
 * "seller_verification.declaration_changed" (reason typed
 * identity_information_inconsistent) + notify seller — seller không bị bỏ
 * mặc không hiểu sao hồ sơ rơi vào needs_review.
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

  // Row HIỆN TẠI để so sánh — khai báo không đổi → no-op (M2).
  const current = await db.orm.public.User.first({ id: user.id });
  if (current === null) {
    return { error: "Không tìm thấy tài khoản — đăng nhập lại.", code: "USER_NOT_FOUND" };
  }
  if (current.sellerType === typeParsed.data && current.sellerOperatingProvinceCode === provinceParsed.data) {
    return { success: "Khai báo không thay đổi." };
  }

  let movedToNeedsReview = false;
  await db.transaction(async (tx) => {
    await tx.orm.public.User.where({ id: user.id }).updateAll({
      sellerType: typeParsed.data,
      sellerOperatingProvinceCode: provinceParsed.data,
    });
    await auditEventTx(tx, {
      actorId: user.id,
      subjectId: user.id,
      action: "seller_profile.declared",
      resourceType: "User",
      resourceId: user.id,
      sessionId: user.sessionId,
      // typed values — KHÔNG PII (spec §4.8)
      detail: `sellerType=${typeParsed.data};province=${provinceParsed.data}`,
    });

    // M2: verification đang verified → needs_review (CAS — chỉ khi VẪN còn
    // verified; request khác đã quyết thì quyết định đó thắng, không ghi đè).
    const verification = await tx.orm.public.SellerVerification.first({ userId: user.id });
    if (verification !== null && verification.status === "verified") {
      const claimed = await tx.orm.public.SellerVerification
        .where({ id: verification.id, status: "verified" })
        .updateAll({
          status: "needs_review",
          reasonCode: "identity_information_inconsistent",
          note: "seller changed declaration after verification — re-review required",
        });
      movedToNeedsReview = claimed.length > 0;
      if (movedToNeedsReview) {
        await auditEventTx(tx, {
          actorId: user.id,
          subjectId: user.id,
          action: "seller_verification.declaration_changed",
          resourceType: "SellerVerification",
          resourceId: verification.id,
          reason: "identity_information_inconsistent",
          policyVersion: SELLER_VERIFICATION_POLICY_VERSION,
          sessionId: user.sessionId,
          detail: "decision=needs_review", // typed — KHÔNG PII (spec §4.8)
        });
      }
    }
  });

  // Notify seller (best-effort — không sống chết với khai báo đã commit).
  if (movedToNeedsReview) {
    await notify(
      user.id,
      "security",
      "Khai báo hồ sơ người bán đã thay đổi",
      "Khai báo của bạn thay đổi sau khi đã được xác minh — hồ sơ chuyển sang cần xem xét lại theo yêu cầu hiện hành của LoaViet.",
      "/sell/verification",
    );
  }

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
    // Review fix Task 5: đình chỉ KHÔNG phải requirement "fixable" — KHÔNG liệt
    // kê "còn thiếu: Tài khoản không bị đình chỉ" như thể hoàn tất được tại
    // trang này (suspended user không thể vào verification queue — S10);
    // special-case thông báo riêng, code REQUIREMENTS_MISSING giữ nguyên.
    if (missing.includes("account_not_suspended")) {
      return {
        error: "Tài khoản đang bị đình chỉ — không thể đăng tin.",
        code: "REQUIREMENTS_MISSING",
      };
    }
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
    // Review fix M1: needs_review là MỘT QUYẾT ĐỊNH (ops cần soi thêm/bổ sung),
    // KHÔNG phải "đang xem xét" — copy phải chính xác để seller biết phải hành động.
    title: "Hồ sơ người bán cần xem xét thêm",
    body: "Operations đánh dấu hồ sơ của bạn cần xem xét thêm theo yêu cầu hiện hành của LoaViet — bổ sung thông tin nếu được yêu cầu, hồ sơ sẽ được duyệt lại.",
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
 * Review fix M3: admin KHÔNG được duyệt CHÍNH MÌNH (self-review) — typed
 * SELF_REVIEW_FORBIDDEN, không mutation (một admin tự xác minh mình là đường
 * leo thang đặc quyền; ghi cho Batch 8 register).
 *
 * Review fix L2: reason code phải nằm trong map
 * SELLER_VERIFICATION_DECISION_REASON_CODES[decision] (PROVISIONAL) —
 * `migrated_legacy_verified` KHÔNG bao giờ hợp lệ ở quyết định người (chỉ
 * backfill); cặp vô nghĩa (verified + duplicate_account_risk) bị từ chối.
 *
 * ATOMIC CLAIM (Review Focus 5 — spec §10.1 concurrent update; review fix M1
 * — needs_review không còn ngõ chết): MỘT updateAll có điều kiện status IN:
 *  - verified|rejected (quyết định cuối) ← status IN (pending, needs_review)
 *  - needs_review (đánh dấu soi thêm)    ← status = pending
 *  - revoked (thu hồi)                   ← status = verified
 * 0 row (đã có quyết định khác / row không tồn tại) → throw
 * Error("VERIFICATION_ALREADY_REVIEWED") RA KHỎI callback → tx rollback —
 * quyết định thứ hai KHÔNG BAO GIỜ ghi đè quyết định đầu.
 *
 * Review fix L1: claim + audit "seller_verification.reviewed" TRONG CÙNG
 * db.transaction (auditEventTx) — quyết định và vết audit sống chết với nhau;
 * KHÔNG catch constraint/lỗi nào bên trong callback (Postgres abort tx —
 * lỗi được ném ra ngoài, caller thấy lỗi thật).
 *
 * Sau tx: notify seller (copy §6.2 trung tính, best-effort).
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

  // L2 — reason code phải tương thích với quyết định (map PROVISIONAL).
  const allowedReasons = SELLER_VERIFICATION_DECISION_REASON_CODES[decisionParsed.data];
  if (!allowedReasons.includes(reasonParsed.data)) {
    throw new Error("REASON_CODE_INCOMPATIBLE");
  }

  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) throw new Error("INVALID_USER");
  const note = String(formData.get("note") ?? "").trim() || null;
  const totpCode = String(formData.get("totpCode") ?? "").trim() || undefined;

  // Guard THEO quyết định — revoked đòi capability thu hồi riêng (fail closed
  // trước khi đụng MFA/db: role sai không nhận được oracle nào).
  const cap = decisionParsed.data === "revoked" ? "seller.verification.revoke" : "seller.verify";
  const admin = await requireCapabilityWithStepUp(cap, totpCode);

  // M3 — tự duyệt bị chặn (sau guard: role sai thấy FORBIDDEN trước, không leak).
  if (admin.user.id === userId) {
    throw new Error("SELF_REVIEW_FORBIDDEN");
  }

  // M1 — status có thể claim THEO quyết định (compare-and-set, KHÔNG read-then-write).
  const claimableStatuses: readonly SellerVerificationStatus[] =
    decisionParsed.data === "revoked"
      ? ["verified"]
      : decisionParsed.data === "needs_review"
        ? ["pending"]
        : ["pending", "needs_review"];

  // L1 — claim + audit trong MỘT transaction; throw RA KHỎI callback khi 0 row
  // (tx rollback — không có gì được ghi; KHÔNG catch bên trong).
  await db.transaction(async (tx) => {
    const claimed = await tx.orm.public.SellerVerification
      .where({ userId })
      .where((v) => v.status.in(claimableStatuses))
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
    await auditEventTx(tx, {
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
  });

  const notifyCopy = DECISION_NOTIFY[decisionParsed.data];
  await notify(userId, "security", notifyCopy.title, notifyCopy.body, "/sell/verification");

  revalidatePath("/admin/seller-verification");
  revalidatePath("/sell/verification");
}
