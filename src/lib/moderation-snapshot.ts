import "server-only";
import { db } from "@/src/prisma/db.client";
import type { ReportTargetType } from "@/src/lib/moderation-vocab";

/**
 * Evidence snapshot capture (Batch 3 Task 2 — spec §5.5.1) — chụp JSON
 * evidence tại thời điểm báo cáo. Row ModerationEvidence tạo từ snapshot
 * này (Task 4) là BẤT BIẾN từ product flow: KHÔNG update, KHÔNG delete —
 * evidence sống qua source edit (snapshot giữ nguyên) và source delete
 * (SetNull FK — Review Focus 2, pin bằng integration test Task 4).
 *
 * PII minimization (spec §4.8 tinh thần + §7.6): snapshot user chỉ mang
 * PUBLIC profile fields — KHÔNG BAO GIỜ email/phone (moderator không giữ
 * `user.view_basic`; email/phone chỉ hiện qua /admin/users cho super/ops).
 * Message body CÓ mặt trong snapshot — đó là điểm của evidence (§5.5.1),
 * là moderation material, KHÔNG phải analytics event (§4.8).
 *
 * `capturedAt` = ISO string tại thời điểm capture — trong MỌI snapshot.
 */

/** Kết quả capture — ghi vào ModerationEvidence.relevantSnapshot (Json). */
export type CapturedSnapshot = {
  /** JSON snapshot bất biến — lưu nguyên vào relevantSnapshot. */
  snapshot: Record<string, unknown>;
  /** Subject (người bị báo cáo) — seller/sender, hoặc chính user target. */
  subjectUserId: string | null;
};

/**
 * Chụp snapshot target theo loại — trả null khi target KHÔNG tồn tại
 * (caller — submitReportAction Task 4 — trả typed NOT_FOUND cho reporter;
 * capture TRƯỚC khi tạo bất kỳ row nào trong transaction báo cáo).
 */
export async function captureTargetSnapshot(
  targetType: ReportTargetType,
  targetId: string,
): Promise<CapturedSnapshot | null> {
  const capturedAt = new Date().toISOString();

  if (targetType === "listing") {
    const listing = await db.orm.public.Listing.first({ id: targetId });
    if (listing === null) return null;
    // Ảnh theo sortOrder — thứ tự hiển thị tại thời điểm báo cáo.
    const images = await db.orm.public.ListingImage
      .where({ listingId: targetId })
      .orderBy((i) => i.sortOrder.asc())
      .all();
    return {
      snapshot: {
        kind: "listing",
        id: listing.id,
        slug: listing.slug,
        title: listing.title,
        description: listing.description,
        price: listing.price,
        condition: listing.condition,
        city: listing.city,
        status: listing.status,
        categoryId: listing.categoryId,
        brandId: listing.brandId,
        sellerId: listing.sellerId,
        imageUrls: images.map((i) => i.url),
        capturedAt,
      },
      subjectUserId: listing.sellerId,
    };
  }

  if (targetType === "user") {
    // Select RÕ public fields — email/phone/passwordHash KHÔNG bao giờ transit
    // qua app process (belt-and-braces ngoài việc snapshot chỉ build từ field công khai).
    const user = await db.orm.public.User
      .select("id", "name", "bio", "city", "role", "isVerifiedSeller", "createdAt")
      .first({ id: targetId });
    if (user === null) return null;
    return {
      snapshot: {
        kind: "user",
        id: user.id,
        name: user.name,
        bio: user.bio,
        city: user.city,
        role: user.role,
        isVerifiedSeller: user.isVerifiedSeller,
        createdAt: user.createdAt,
        capturedAt,
      },
      subjectUserId: targetId,
    };
  }

  // targetType === "message" — conversationId là scalar column trên Message
  // (không cần include relation); body LÀ evidence (§5.5.1).
  const message = await db.orm.public.Message.first({ id: targetId });
  if (message === null) return null;
  return {
    snapshot: {
      kind: "message",
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      body: message.body,
      imageUrl: message.imageUrl,
      createdAt: message.createdAt,
      capturedAt,
    },
    subjectUserId: message.senderId,
  };
}
