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

  await db.orm.public.User
    .where({ id: user.id })
    .update({ name, phone, city, bio });

  revalidatePath("/profile");
  revalidatePath("/"); // header hiển thị tên
  return { success: true };
}
