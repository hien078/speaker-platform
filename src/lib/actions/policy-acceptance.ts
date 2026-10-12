"use server";

import { revalidatePath } from "next/cache";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import {
  ACCOUNT_POLICY_KEYS,
  missingPolicyAcceptances,
  recordPolicyAcceptance,
} from "@/src/lib/policy-acceptance";

/**
 * Accept action của /account/policies (zero-cost launch Task D — founder
 * decision 2026-10-12): user hiện có (đăng ký TRƯỚC cơ chế consent) chấp nhận
 * terms + privacy tại version hiện hành của registry; user tương lai chấp
 * nhận ngay trong tx đăng ký (registerAction). Cũng là đường re-accept sau
 * version bump của founder (FD-R4 pattern — bump version → guard chặn lại →
 * user quay lại đây).
 *
 * CƠ CHẾ GHI NHẬN: Batch 2 PolicyAcceptance qua recordPolicyAcceptance —
 * KHÔNG cơ chế thứ hai. Idempotent theo @@unique(userId, policyKey,
 * policyVersion): đã đồng ý → no-op thành công (KHÔNG row mới).
 *
 * Transaction constraint-violation rule (Global Constraints): violation LUÔN
 * throw ra khỏi callback (Postgres abort tx — catch bên trong rồi return là
 * silent-success bug); classify NGOÀI tx theo constraint name — concurrent
 * double-accept thua race thấy 23505 `PolicyAcceptance_userId_policyKey_
 * policyVersion_key` → row của người thắng đã tồn tại = ĐÃ ĐỒNG Ý → trả
 * thành công idempotent (KHÔNG retry, KHÔNG masquerade lỗi khác).
 *
 * KHÔNG audit/telemetry mới (Task D §5): PolicyAcceptance row CHÍNH LÀ record
 * đồng ý (userId + key + version + acceptedAt) — KHÔNG PII trong audit/log.
 */
export type PolicyAcceptanceFormState = {
  /** Thông báo lỗi tiếng Việt (user-facing). */
  error?: string;
  /** Thông báo thành công tiếng Việt (user-facing). */
  success?: string;
  /** Mã ổn định cho test/client — không phải prose. */
  code?: string;
};

/** Prefix constraint unique của PolicyAcceptance (migration batch2) — 23505 classify theo tên. */
const POLICY_ACCEPTANCE_UNIQUE_PREFIX = "PolicyAcceptance_userId_policyKey_policyVersion";

export async function acceptCurrentPoliciesAction(
  _prev: PolicyAcceptanceFormState,
  formData: FormData,
): Promise<PolicyAcceptanceFormState> {
  const user = await requireUser();

  // Consent checkbox bắt buộc — server-side reject (form required chỉ là UX).
  if (formData.get("acceptPolicies") !== "on") {
    return {
      error: "Hãy đánh dấu đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư trước khi gửi.",
      code: "POLICY_CONSENT_REQUIRED",
    };
  }

  // Missing đọc FRESH — đã đủ → no-op idempotent thành công (không row mới,
  // không tx). Double-submit sau khi đã đồng ý là hành vi vô hại.
  const missing = await missingPolicyAcceptances(user.id);
  if (missing.length === 0) {
    return { success: "Bạn đã đồng ý với phiên bản hiện hành của cả hai chính sách." };
  }

  // MỘT tx cho mọi row còn thiếu (terms + privacy sống chết cùng nhau — không
  // bao giờ ghi nửa vời). Violation ném RA KHỎI callback; classify NGOÀI tx.
  try {
    await db.transaction(async (tx) => {
      for (const key of missing) {
        await recordPolicyAcceptance(tx, user.id, key);
      }
    });
  } catch (e) {
    if (
      SqlQueryError.is(e) &&
      e.sqlState === "23505" &&
      e.constraint != null &&
      e.constraint.startsWith(POLICY_ACCEPTANCE_UNIQUE_PREFIX)
    ) {
      // Concurrent double-accept: row của request thắng đã tồn tại theo đúng
      // bộ khóa unique → trạng thái cuối = ĐÃ ĐỒNG Ý — idempotent thành công.
      // (tx của mình đã bị Postgres abort từ khi violation ném ra — KHÔNG retry.)
    } else {
      throw e; // fail closed — KHÔNG masquerade lỗi infra thành form error
    }
  }

  revalidatePath("/account/policies");
  return {
    success: `Đã ghi nhận đồng ý của bạn với phiên bản hiện hành (${ACCOUNT_POLICY_KEYS.length} chính sách).`,
  };
}
