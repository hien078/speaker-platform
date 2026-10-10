"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { auditEvent } from "@/src/lib/audit-event";

/**
 * Beta cohort membership — admin grant/suspend (Batch 2 Task 10 — spec §2.1,
 * §4.9, §8.4). Cohort membership là ĐIỀU KIỆN publication trong controlled beta
 * (founding_seller active — xem seller-verification-policy.ts); user hiện có
 * KHÔNG tự động thành founding seller (spec §8.4) — chỉ qua reviewed seed /
 * explicit migration / admin operation (hành động này).
 *
 * Full invitation/console/concierge flow thuộc Batch 7 — đây là action tối
 * thiểu mà publication gate cần (plan Batch 2 Scope #7).
 *
 * Guard: requireCapability("beta_cohort.manage") — super/ops (ma trận §5.4.1);
 * moderator/support/analyst fail closed (Ambiguities A2). KHÔNG step-up —
 * capability này KHÔNG nằm trong STEP_UP_CAPABILITIES (không phải quyết định
 * verification; thu hồi membership có hiệu lực gate NGAY qua check FRESH).
 *
 * Upsert theo @@unique(userId, cohort): tạo mới ghi invitedBy/invitedAt;
 * đã có → update status/notes (KHÔNG đụng invitedBy/invitedAt gốc — provenance
 * của lời mời giữ nguyên; acceptedAt thuộc Batch 7 acceptance flow).
 * Race create song song → unique violation 23505 phân loại NGOÀI callback
 * (Postgres abort tx nếu catch bên trong) → fall back update theo unique key.
 *
 * Audit "beta_cohort.membership_set" (registry Task 5): cohort + status trong
 * detail — KHÔNG PII (spec §4.8).
 */

const cohortSchema = z.enum(["internal", "founding_seller", "private_beta_buyer"], {
  error: () => "Cohort không hợp lệ.",
});
const statusSchema = z.enum(["invited", "active", "suspended", "exited"], {
  error: () => "Trạng thái membership không hợp lệ.",
});

export async function setBetaMembershipAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("beta_cohort.manage");

  const cohortParsed = cohortSchema.safeParse(String(formData.get("cohort") ?? ""));
  if (!cohortParsed.success) throw new Error("INVALID_COHORT");
  const statusParsed = statusSchema.safeParse(String(formData.get("status") ?? ""));
  if (!statusParsed.success) throw new Error("INVALID_MEMBERSHIP_STATUS");

  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) throw new Error("INVALID_USER");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  // Review fix M3 (fail closed — FD-3): admin KHÔNG được tự cấp/sửa membership
  // CỦA CHÍNH MÌNH — founding_seller active là điều kiện publication, tự cấp
  // là đường leo thang đặc quyền (dùng admin KHÁC hoặc bootstrap script).
  if (admin.user.id === userId) {
    throw new Error("SELF_GRANT_FORBIDDEN");
  }

  const existing = await db.orm.public.BetaCohortMembership.first({
    userId,
    cohort: cohortParsed.data,
  });

  let membershipId: string;
  if (existing === null) {
    try {
      const created = await db.orm.public.BetaCohortMembership.create({
        userId,
        cohort: cohortParsed.data,
        status: statusParsed.data,
        invitedBy: admin.user.id,
        invitedAt: new Date().toISOString(),
        notes,
      });
      membershipId = created.id;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      // Race: hàng được tạo đồng thời bởi request khác — upsert theo unique key
      // (idempotent, KHÔNG nhân bản row).
      const claimed = await db.orm.public.BetaCohortMembership
        .where({ userId, cohort: cohortParsed.data })
        .updateAll({ status: statusParsed.data, notes });
      if (claimed.length === 0) throw e; // vẫn không có — lỗi thật, fail closed
      membershipId = claimed[0]!.id;
    }
  } else {
    // Update theo unique key (id + userId + cohort — không thể trượt sang row khác)
    await db.orm.public.BetaCohortMembership
      .where({ id: existing.id, userId, cohort: cohortParsed.data })
      .updateAll({ status: statusParsed.data, notes });
    membershipId = existing.id;
  }

  await auditEvent({
    actorId: admin.user.id,
    subjectId: userId,
    action: "beta_cohort.membership_set",
    resourceType: "BetaCohortMembership",
    resourceId: membershipId,
    sessionId: admin.session.id,
    // typed values — KHÔNG PII thô (spec §4.8)
    detail: `cohort=${cohortParsed.data};status=${statusParsed.data}`,
  });

  revalidatePath("/admin/users");
  revalidatePath("/admin/seller-verification");
}
