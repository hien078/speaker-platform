"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/src/prisma/db";
import { hashPassword, verifyPassword, createSession, destroySession } from "@/src/lib/auth";

const registerSchema = z.object({
  name: z.string().trim().min(2, "Tên quá ngắn").max(80),
  email: z.string().trim().email("Email không hợp lệ"),
  password: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự").max(100),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  role: z.enum(["buyer", "seller"]).default("buyer"),
});

export type AuthFormState = { error?: string };

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    phone: formData.get("phone") || "",
    role: formData.get("role") || "buyer",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  }
  const { name, email, password, phone, role } = parsed.data;
  const emailNormalized = email.toLowerCase();

  const existing = await db.orm.public.User.where({ email: emailNormalized }).first();
  if (existing) {
    return { error: "Email này đã được đăng ký. Bạn thử đăng nhập xem." };
  }

  const passwordHash = await hashPassword(password);
  const user = await db.orm.public.User.create({
    name,
    email: emailNormalized,
    passwordHash,
    phone: phone || null,
    role,
  });

  // tạo giỏ hàng riêng cho user
  await db.orm.public.Cart.create({ userId: user.id });

  await createSession(user.id);
  redirect("/");
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Vui lòng nhập email và mật khẩu" };
  }

  const user = await db.orm.public.User.where({ email }).first();
  if (!user) {
    return { error: "Email hoặc mật khẩu không đúng" };
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return { error: "Email hoặc mật khẩu không đúng" };
  }

  // đảm bảo có giỏ hàng
  const cart = await db.orm.public.Cart.first({ userId: user.id });
  if (!cart) await db.orm.public.Cart.create({ userId: user.id });

  await createSession(user.id);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}
