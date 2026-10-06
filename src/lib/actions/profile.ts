"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";

export type ProfileFormState = { error?: string; success?: boolean };

export async function updateProfileAction(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const city = String(formData.get("city") ?? "").trim() || null;
  const bio = String(formData.get("bio") ?? "").trim() || null;

  if (name.length < 2 || name.length > 80) {
    return { error: "Tên từ 2–80 ký tự" };
  }
  if (phone && !/^0\d{8,9}$/.test(phone.replace(/\s/g, ""))) {
    return { error: "Số điện thoại không hợp lệ (vd: 0901234567)" };
  }

  // Batch 2 Task 6 (spec §5.3.1): số điện thoại chỉnh qua form này là số MỚI —
  // trạng thái "đã xác minh" không còn đúng nữa → reset phoneVerifiedAt (số
  // chưa từng được xác minh cho tài khoản này). So sánh CHUỖI GỐC với giá trị
  // lưu: mọi thay đổi (kể cả định dạng lại) đều bỏ badge verified — fail closed;
  // giữ nguyên chuỗi → giữ verified. Quan trọng cho bất biến collision: row có
  // phoneVerifiedAt != null luôn giữ đúng chuỗi đã được xác minh (chuỗi chuẩn
  // hóa do confirmPhoneVerification/confirmPhoneChange ghi) — re-check
  // `where({ phone })` trong verification.ts không bao giờ bị lỡ bởi row
  // "verified nhưng sai định dạng".
  const stored = await db.orm.public.User.first({ id: user.id });
  const phoneChanged = phone !== (stored?.phone ?? null);

  await db.orm.public.User
    .where({ id: user.id })
    .update({ name, phone, city, bio, ...(phoneChanged ? { phoneVerifiedAt: null } : {}) });

  revalidatePath("/profile");
  revalidatePath("/"); // header hiển thị tên
  return { success: true };
}
