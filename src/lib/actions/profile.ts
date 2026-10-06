"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { normalizePhone } from "@/src/lib/otp";

export type ProfileFormState = {
  error?: string;
  success?: boolean;
  /** Mã ổn định cho test/client (vd "PHONE_VERIFIED_CHANGE_REQUIRED"). */
  code?: string;
};

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

  // (Review fix LOW #7) Chuẩn hóa + validate qua normalizePhone (Task 3) — thay
  // regex cũ ^0\d{8,9}$ (lỏng hơn chuẩn VN 0+9/10 chữ số). Sai format → lỗi,
  // KHÔNG mutation. Lưu giá trị CHUẨN HÓA — giữ bất biến "phoneVerifiedAt !=
  // null ⟹ User.phone là đúng chuỗi đã xác minh (chuỗi chuẩn hóa)" để re-check
  // collision `where({ phone })` trong verification.ts không bao giờ bị lỡ.
  let phoneNormalized: string | null = null;
  if (phone !== null) {
    try {
      phoneNormalized = normalizePhone(phone);
    } catch {
      return { error: "Số điện thoại không hợp lệ (vd: 0901234567)" };
    }
  }

  const stored = await db.orm.public.User.first({ id: user.id });
  if (!stored) {
    return { error: "Không tìm thấy tài khoản — đăng nhập lại.", code: "USER_NOT_FOUND" };
  }

  // (Review fix HIGH) Phone ĐÃ XÁC MINH không đổi được qua hồ sơ — đổi số phải
  // qua change flow (mật khẩu + OTP tới số mới, spec §5.3.1). So sánh CHUẨN HÓA:
  // cùng số viết khác định dạng là KHÔNG đổi (giữ verified).
  if (stored.phoneVerifiedAt !== null && phoneNormalized !== stored.phone) {
    return {
      error: "Số điện thoại đã xác minh — dùng mục \"Đổi số điện thoại\" (mật khẩu + mã OTP) để thay đổi.",
      code: "PHONE_VERIFIED_CHANGE_REQUIRED",
    };
  }

  // (Review fix MEDIUM #2) Atomic CAS: chỉ update khi phone vẫn là giá trị đã
  // đọc — request song song đổi phone giữa read và write → 0 row → typed error,
  // KHÔNG clobber. phoneVerifiedAt reset trong CÙNG statement khi số đổi (số
  // mới chưa từng được xác minh cho tài khoản này).
  // updateAll (KHÔNG .update()): terminal đơn-row select row khớp rồi write
  // WHERE id — phone condition KHÔNG nằm trong statement write (khoảng
  // select→write không atomic, race clobber số đã xác minh). updateAll compile
  // TOÀN BỘ filter (id + phone) vào MỘT statement — 0 row = phone đã đổi.
  const phoneChanged = phoneNormalized !== (stored.phone ?? null);
  let query = db.orm.public.User.where({ id: user.id });
  if (stored.phone === null) {
    query = query.where((u) => u.phone.isNull());
  } else {
    query = query.where({ phone: stored.phone });
  }
  const updated = await query.updateAll({
    name,
    phone: phoneNormalized,
    city,
    bio,
    ...(phoneChanged ? { phoneVerifiedAt: null } : {}),
  });
  if (updated.length === 0) {
    return {
      error: "Số điện thoại vừa thay đổi từ thiết bị khác — tải lại trang rồi thử lại.",
      code: "PHONE_CONCURRENT_CHANGE",
    };
  }

  revalidatePath("/profile");
  revalidatePath("/"); // header hiển thị tên
  return { success: true };
}
