"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { BLOCK_ACTION_RATE_LIMIT } from "@/src/lib/moderation";

/**
 * Chặn / bỏ chặn người dùng (Batch 3 Task 3 — spec §5.5).
 *
 * Block là dữ liệu ĐỊNH HƯỚNG (blocker→blocked) nhưng enforcement ĐỐI XỨNG
 * (guard ở startConversationAction + POST /api/chat/[id] chặn theo BẤT KỌ
 * hướng nào — spec §5.5 "new messages in either direction"). Hai action này
 * KHÔNG đụng Message/Conversation — block không phá evidence/history; lịch sử
 * chat của cặp bị chặn vẫn đọc được qua GET /api/chat/[id].
 *
 * UI (nút Chặn/Bỏ chặn trên seller profile + chat, "Danh sách chặn" trên
 * /profile) là convenience — action tự enforce auth + rate limit + self/target
 * checks server-side (spec §4.5 backend authorization).
 */

/** userId từ formData — uuid; chuỗi khác không thể là user (fail closed). */
const userIdSchema = z.string().uuid();

export async function blockUserAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  // Rate limit TRƯỚC mọi mutation (spec §7.1 — 20 block/unblock / phút / user;
  // bucket `block:<userId>` DÙNG CHUNG cho cả hai action — chống xoáy spam).
  const limited = checkRateLimit(`block:${user.id}`, BLOCK_ACTION_RATE_LIMIT);
  if (!limited.allowed) throw new Error("RATE_LIMITED");

  // uuid-validate trước khi chạm DB: id không phải uuid không thể là user và
  // làm Postgres lỗi syntax thay vì trả null — fail closed với CÙNG typed
  // error như target không tồn tại (không probe oracle).
  const parsed = userIdSchema.safeParse(String(formData.get("userId") ?? ""));
  if (!parsed.success) throw new Error("NOT_FOUND");
  const targetId = parsed.data;

  if (targetId === user.id) throw new Error("CANNOT_BLOCK_SELF");

  const target = await db.orm.public.User.first({ id: targetId });
  if (!target) throw new Error("NOT_FOUND");

  // Idempotent theo @@unique [blockerId, blockedId] — chặn lại khi đã chặn =
  // no-op thành công (update rỗng giữ nguyên row). Form giả mạo không giúp
  // gì: mọi check phía trên đã chạy lại server-side.
  await db.orm.public.UserBlock.upsert({
    create: { blockerId: user.id, blockedId: targetId },
    update: {},
    conflictOn: { blockerId: user.id, blockedId: targetId },
  });

  // "/profile" (Danh sách chặn); trang hiện tại re-render cùng response của
  // action (Next 16: một revalidatePath → RSC payload của route hiện tại đi
  // cùng response — docs server-actions "single response carries data and UI").
  revalidatePath("/profile");
}

export async function unblockUserAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  // Cùng bucket `block:<userId>` — xem blockUserAction.
  const limited = checkRateLimit(`block:${user.id}`, BLOCK_ACTION_RATE_LIMIT);
  if (!limited.allowed) throw new Error("RATE_LIMITED");

  const parsed = userIdSchema.safeParse(String(formData.get("userId") ?? ""));
  if (!parsed.success) throw new Error("NOT_FOUND");
  const targetId = parsed.data;

  // Chỉ xóa row CỦA MÌNH (blockerId = user.id) — không thể bỏ chặn block của
  // người khác; không có row → no-op thành công (idempotent).
  await db.orm.public.UserBlock.where({ blockerId: user.id, blockedId: targetId }).delete();

  revalidatePath("/profile");
}
