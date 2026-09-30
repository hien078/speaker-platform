"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db";
import { requireAdmin } from "@/src/lib/auth";
import { audit } from "@/src/lib/actions/helpers";
import { slugify } from "@/src/lib/utils";

/** Duyệt model vào catalog công khai */
export async function approveModelAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId") ?? "");
  const model = await db.orm.public.ProductModel.first({ id: modelId });
  if (!model) return;
  await db.orm.public.ProductModel
    .where({ id: modelId })
    .update({ status: "approved" });
  await audit(admin.id, "approve_model", "ProductModel", modelId, `${model.brandId}/${model.name}`);
  revalidatePath("/admin/catalog");
  revalidatePath("/models");
}

/** Gộp model trùng vào model gốc (§68) */
export async function mergeModelAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId") ?? "");
  const targetId = String(formData.get("targetId") ?? "");
  if (modelId === targetId) return;

  const model = await db.orm.public.ProductModel.first({ id: modelId });
  const target = await db.orm.public.ProductModel.first({ id: targetId });
  if (!model || !target) return;

  await db.transaction(async (tx) => {
    // chuyển listings + price history sang model gốc
    await tx.orm.public.Listing
      .where({ productModelId: modelId })
      .update({ productModelId: targetId });
    await tx.orm.public.PriceHistory
      .where({ modelId })
      .update({ modelId: targetId });
    await tx.orm.public.ProductModel
      .where({ id: modelId })
      .update({ status: "merged", mergedIntoId: targetId });
  });
  await audit(admin.id, "merge_model", "ProductModel", modelId, `${model.name} → ${target.name}`);
  revalidatePath("/admin/catalog");
}

/** Tạo model mới từ admin */
export async function createModelAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const brandId = String(formData.get("brandId") ?? "");
  const categoryId = String(formData.get("categoryId") ?? "");
  const releaseYear = Number(formData.get("releaseYear") ?? 0) || null;
  const description = String(formData.get("description") ?? "").trim() || null;

  if (name.length < 2 || !brandId || !categoryId) return;

  const brand = await db.orm.public.Brand.first({ id: brandId });
  if (!brand) return;
  let slug = slugify(`${brand.name} ${name}`);
  const exists = await db.orm.public.ProductModel.where({ slug }).first();
  if (exists) slug = `${slug}-${Date.now().toString(36)}`;

  await db.orm.public.ProductModel.create({
    brandId,
    categoryId,
    name,
    slug,
    releaseYear,
    description,
    status: "approved",
  });
  await audit(admin.id, "create_model", "ProductModel", slug, name);
  revalidatePath("/admin/catalog");
}
