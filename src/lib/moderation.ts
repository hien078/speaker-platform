import "server-only";
import { db } from "@/src/prisma/db.client";
import type { ReportTargetType } from "@/src/lib/moderation-vocab";

/**
 * Moderation domain module — server-only (Batch 3 Task 2, spec §5.5/§7.8).
 * KHÔNG "use server" — đây là domain module, không phải action; mọi action
 * của Batch 3 (blocks/reports/moderation/appeals — Task 3–7) import guard
 * từ đây. Client component KHÔNG BAO GIỜ import module này (import db →
 * "server-only" → client build break) — client import moderation-vocab.ts.
 *
 * `export *` re-export toàn bộ vocabulary client-safe — server consumers
 * import mọi thứ từ một nơi (B2 split: vocab pure + guard đọc DB).
 *
 * §7.8 enforcement guards — ACTOR-SIDE, fail closed (P1: minimal set):
 *  - listing publication/transitions: qua publication gate (Task 5 —
 *    `account_not_suspended`, seller-verification-policy.ts).
 *  - new chat: INITIATOR không được đình chỉ (assertCanStartConversation).
 *  - message send: SENDER không được đình chỉ (assertCanSendMessage).
 * Counterpart/recipient đình chỉ KHÔNG được check — không nằm trong §7.8
 * minimal set (Ambiguity A2); session revocation/login block cũng KHÔNG
 * (P1 — guard đọc DB FRESH mỗi action là enforcement).
 *
 * Block (spec §5.5): dữ liệu ĐỊNH HƯỚNG (blocker→blocked), enforcement
 * ĐỐI XỨNG — block theo BẤT KỌ hướng nào chặn hội thoại/tin nhắn mới theo
 * cả hai hướng. KHÔNG xóa/mutate Message/Conversation — lịch sử đọc được.
 */

export * from "@/src/lib/moderation-vocab";

// ─── §7.8 enforcement guards — actor-side, fail closed ────────────────────────

/** User đang bị đình chỉ? (chỉ episode `active` — lifted không còn chặn). */
export async function isUserSuspended(userId: string): Promise<boolean> {
  const row = await db.orm.public.UserSuspension.where({ userId, status: "active" }).first();
  return row !== null;
}

/**
 * Episode đình chỉ đang active — { id, reasonCode, suspendedAt } | null.
 * Task 6 case page dùng (nút lift khi subject có episode active).
 */
export async function getActiveSuspension(userId: string): Promise<{
  id: string;
  reasonCode: string;
  suspendedAt: string;
} | null> {
  const row = await db.orm.public.UserSuspension.where({ userId, status: "active" }).first();
  if (row === null) return null;
  return { id: row.id, reasonCode: row.reasonCode, suspendedAt: row.suspendedAt };
}

/** Hướng block giữa viewer và người kia — UI banner + nút unblock (Task 3). */
export type BlockState = "none" | "viewer_blocked" | "other_blocked";

/**
 * Block state theo HƯỚNG (S11):
 *  - `viewer_blocked`: viewer là người CHẶN (UserBlock blockerId=viewer) —
 *    hiện nút "Bỏ chặn".
 *  - `other_blocked`: người kia chặn viewer — KHÔNG hiện nút unblock
 *    (không thể bỏ chặn block của người khác).
 *  - `none`: không hướng nào — composer mở.
 */
export async function getBlockState(viewerId: string, otherId: string): Promise<BlockState> {
  const [viewerBlocked, otherBlocked] = await Promise.all([
    db.orm.public.UserBlock.where({ blockerId: viewerId, blockedId: otherId }).first(),
    db.orm.public.UserBlock.where({ blockerId: otherId, blockedId: viewerId }).first(),
  ]);
  if (viewerBlocked !== null) return "viewer_blocked";
  if (otherBlocked !== null) return "other_blocked";
  return "none";
}

/**
 * Guard hội thoại MỚI (spec §7.8 — actor là INITIATOR):
 *  1. INITIATOR đình chỉ → throw Error("ACCOUNT_SUSPENDED") — đọc FRESH
 *     từ DB mỗi action (P1: không revoke session — guard là enforcement).
 *  2. Block theo BẤT KỌ hướng nào → throw Error("CHAT_BLOCKED") (spec §5.5
 *     — symmetric enforcement, directional data).
 * Counterpart đình chỉ KHÔNG được check (A2 — không nằm trong §7.8 minimal
 * set). Thứ tự pinned: suspension thắng block (test moderation.test.ts).
 */
export async function assertCanStartConversation(
  initiatorId: string,
  counterpartId: string,
): Promise<void> {
  if (await isUserSuspended(initiatorId)) throw new Error("ACCOUNT_SUSPENDED");
  if ((await getBlockState(initiatorId, counterpartId)) !== "none") {
    throw new Error("CHAT_BLOCKED");
  }
}

/**
 * Guard gửi tin nhắn (spec §7.8 — actor là SENDER): như
 * assertCanStartConversation nhưng theo SENDER. Recipient đình chỉ
 * KHÔNG được check (A2). Task 3 gọi trong POST /api/chat/[id] sau
 * participant check, trước Message.create.
 */
export async function assertCanSendMessage(
  senderId: string,
  recipientId: string,
): Promise<void> {
  if (await isUserSuspended(senderId)) throw new Error("ACCOUNT_SUSPENDED");
  if ((await getBlockState(senderId, recipientId)) !== "none") {
    throw new Error("CHAT_BLOCKED");
  }
}

/**
 * Subject (người bị báo cáo) của một case target — map theo target type:
 *  - listing → Listing.sellerId
 *  - user    → targetId (sau khi xác nhận User tồn tại)
 *  - message → Message.senderId
 *  - target đã biến mất → null (fail closed, không crash).
 *
 * FALLBACK (Task 7 ưu tiên ModerationEvidence.subjectUserId BẤT BIẾN khi
 * case có evidence — chụp tại report time, sống qua edit/delete của source;
 * hàm này chỉ là fallback khi case không có evidence).
 */
export async function getCaseSubjectUserId(
  targetType: ReportTargetType,
  targetId: string,
): Promise<string | null> {
  if (targetType === "listing") {
    const listing = await db.orm.public.Listing.first({ id: targetId });
    return listing === null ? null : listing.sellerId;
  }
  if (targetType === "user") {
    const user = await db.orm.public.User.first({ id: targetId });
    return user === null ? null : user.id;
  }
  const message = await db.orm.public.Message.first({ id: targetId });
  return message === null ? null : message.senderId;
}

/**
 * Viewer (bất kỳ ai) có xung đột lợi ích với case không? (S9 — fail closed;
 * recusal POLICY = Ambiguity A7). TRUE khi viewer là:
 *  - SUBJECT của case — ưu tiên ModerationEvidence.subjectUserId BẤT BIẾN
 *    (chụp tại report time, sống qua edit/delete của source — S7), fallback
 *    live lookup getCaseSubjectUserId khi case không có evidence (cùng
 *    thứ tự resolve như appeal page + case page + recordAppealAction).
 *  - REPORTER trên case (AbuseReport caseId + reporterId = viewer).
 *
 * Dùng bởi: actions/moderation.ts (assertActorNotConflicted — MODERATOR_CONFLICT
 * khi RA quyết định) VÀ case detail page (recusal on views — item 3 review fix
 * Task 6: subject/reporter cầm report.resolve KHÔNG được XEM reports/evidence
 * của case — retaliation risk; page gọi TRƯỚC mọi read phục vụ render).
 * Thứ tự evidence: capturedAt asc — ĐỒNG BỘ với appeal page + case page
 * (evidence[0] cùng row giữa các caller).
 */
export async function isCaseViewerConflicted(
  caseId: string,
  targetType: ReportTargetType,
  targetId: string,
  viewerId: string,
): Promise<boolean> {
  const evidence = await db.orm.public.ModerationEvidence
    .where({ caseId })
    .orderBy((e) => e.capturedAt.asc())
    .select("subjectUserId")
    .first();
  const subjectUserId =
    evidence?.subjectUserId ??
    (await getCaseSubjectUserId(targetType, targetId));
  if (subjectUserId !== null && subjectUserId === viewerId) return true;
  const reported = await db.orm.public.AbuseReport
    .where({ caseId, reporterId: viewerId })
    .first();
  return reported !== null;
}
