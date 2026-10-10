"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireCapability } from "@/src/lib/rbac";
import { audit } from "@/src/lib/actions/helpers";
import { auditEventTx } from "@/src/lib/audit-event";
import { slugify } from "@/src/lib/utils";

/**
 * Catalog admin actions (Batch 4 Task 4) — b4-holistic round-3 hardening
 * (LOW — status-conditional writes + merge gate):
 *
 *  - approveModelAction: CAS theo status pending — stale 'Duyệt' click trên
 *    model đã merged/approved bởi admin khác → 0 rows → NO-OP (trước fix:
 *    updateAll VÔ ĐIỀU KIỆN resurrect model đã merged — mergedIntoId vẫn set
 *    nhưng status quay approved, trùng lặp sống lại trong seller model picker).
 *    Audit AuditEvent sống chết cùng tx (auditEventTx).
 *  - mergeModelAction: MỌI check + write trong MỘT tx — target PHẢI approved
 *    + CÙNG categoryId + CÙNG brandId (merge sang brand/category khác làm
 *    MỌI listing chuyển qua fail gate MODEL_BRAND_MISMATCH/MODEL_INVALID
 *    vĩnh viễn — admin không sửa được từng listing); source claim CAS theo
 *    status (stale page merge chéo A↔B → sentinel, KHÔNG để cả hai biến
 *    merged); Listing.brandId RESYNC theo target brand (canonical gate đọc
 *    model.brandId === listing.brandId); audit trong cùng tx.
 */

/** Sentinel của mergeModelAction — classify NGOÀI tx (fail closed cho lỗi khác). */
const MERGE_SENTINELS = new Set([
  "MODEL_TARGET_INVALID",
  "MODEL_SOURCE_INVALID",
  "MODEL_ALREADY_MERGED",
  "MODEL_TARGET_MISMATCH",
]);

/** Duyệt model vào catalog công khai */
export async function approveModelAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("listing.moderate"); // catalog = listing-quality ops — cùng mapping admin/catalog page (plan Task 4)
  const modelId = String(formData.get("modelId") ?? "");
  const model = await db.orm.public.ProductModel.first({ id: modelId });
  if (!model) return;

  // b4-holistic round-3: MỘT tx — CAS claim theo status pending + audit
  // AuditEvent sống chết cùng claim. 0 rows (stale click — model đã
  // merged/approved bởi admin khác) → NO-OP, KHÔNG audit, KHÔNG resurrect.
  let claimed = 0;
  await db.transaction(async (tx) => {
    const rows = await tx.orm.public.ProductModel
      .where({ id: modelId, status: "pending" })
      .updateAll({ status: "approved" });
    claimed = rows.length;
    if (rows.length === 0) return;
    await auditEventTx(tx, {
      actorId: admin.user.id,
      action: "model.approved",
      resourceType: "ProductModel",
      resourceId: modelId,
    });
  });
  if (claimed === 0) return; // stale click — no-op im lặng (posture admin action)

  // legacy AdminAuditLog (Batch 2) — giữ nguyên shape các action admin khác
  await audit(admin.user.id, "approve_model", "ProductModel", modelId, `${model.brandId}/${model.name}`);
  revalidatePath("/admin/catalog");
  revalidatePath("/models");
}

/** Gộp model trùng vào model gốc (§68) */
export async function mergeModelAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("listing.moderate");
  const modelId = String(formData.get("modelId") ?? "");
  const targetId = String(formData.get("targetId") ?? "");
  if (modelId === targetId) return;

  // MỌI check + write trong MỘT tx (b4-holistic round-3): đọc model/target
  // TRONG tx, claim source CAS theo status — stale admin page (model/target đã
  // đổi tay sau render) → sentinel typed, KHÔNG merge chéo. Sentinel classify
  // NGOÀI tx → no-op + revalidate (card render lại trạng thái mới); lỗi khác
  // ném tiếp (fail closed).
  let sentinel: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const model = await tx.orm.public.ProductModel.first({ id: modelId });
      if (model === null) throw new Error("MODEL_SOURCE_INVALID");
      // Source đã merged (stale page) → sentinel — CAS theo status dưới cũng
      // chặn, nhưng check tường minh ở đây cho sentinel ĐÚNG nghĩa (không phải
      // chỉ thua race).
      if (model.status === "merged") throw new Error("MODEL_ALREADY_MERGED");
      // Target PHẢI approved (merge vào model pending/merged = gộp vào hư không)
      // + CÙNG category + CÙNG brand — khác nhau làm mọi listing chuyển qua
      // fail canonical gate (MODEL_BRAND_MISMATCH/MODEL_INVALID) vĩnh viễn.
      const target = await tx.orm.public.ProductModel
        .where({ id: targetId, status: "approved" })
        .first();
      if (target === null) throw new Error("MODEL_TARGET_INVALID");
      if (target.categoryId !== model.categoryId || target.brandId !== model.brandId) {
        throw new Error("MODEL_TARGET_MISMATCH");
      }
      // b4-holistic round-4 (LOW partial — concurrent opposite merges): LOCK
      // TARGET row bằng CAS UPDATE (giá trị không đổi — status approved →
      // approved — nhưng UPDATE lấy ROW LOCK) TRƯỚC khi claim source. Trước
      // fix: guard merge chéo chỉ chặn TUẦN TỰ (stale page) — hai request
      // ĐỒNG THỜI A→B + B→A dưới READ COMMITTED: cả hai đọc target approved
      // (MVCC), claim source KHÁC NHAU (lock A của tx1, lock B của tx2 —
      // không đụng nhau), Listing/PriceHistory moves đụng row disjoint →
      // CẢ HAI commit → A.merged=B VÀ B.merged=A — mọi listing trỏ model
      // merged, MODEL_INVALID chặn approve/submit/toggle vĩnh viễn (failure
      // finding 464). Sau lock: merge ngược hoặc BLOCK trên row lock rồi
      // re-evaluate predicate sau commit bên kia (thấy 'merged' → 0 rows →
      // sentinel MODEL_TARGET_INVALID), hoặc Postgres deadlock-abort MỘT
      // bên (rethrow — fail closed). Cả hai: TỐI ĐA MỘT merge commit.
      // (Race test thật: tests/integration/catalog-merge-race.test.ts.)
      const targetLock = await tx.orm.public.ProductModel
        .where({ id: targetId, status: "approved" })
        .updateAll({ status: "approved" });
      if (targetLock.length === 0) throw new Error("MODEL_TARGET_INVALID");
      // Claim source CAS theo status đã đọc — merge chéo A↔B từ hai tab stale
      // thua race ở request thứ hai (0 rows → sentinel).
      const claimed = await tx.orm.public.ProductModel
        .where({ id: modelId, status: model.status })
        .updateAll({ status: "merged", mergedIntoId: targetId });
      if (claimed.length === 0) throw new Error("MODEL_ALREADY_MERGED");

      // chuyển listings + price history sang model gốc — brandId RESYNC theo
      // target (canonical gate: model.brandId === listing.brandId — trước fix
      // listing giữ brand cũ → MODEL_BRAND_MISMATCH chặn approve/submit/toggle).
      // updateAll (KHÔNG .update()): terminal đơn-row chỉ chuyển row ĐẦU khớp
      // productModelId/modelId — merge phải chuyển TẤT CẢ rows của model.
      await tx.orm.public.Listing
        .where({ productModelId: modelId })
        .updateAll({ productModelId: targetId, brandId: target.brandId });
      await tx.orm.public.PriceHistory
        .where({ modelId })
        .updateAll({ modelId: targetId });

      // Audit sống chết cùng tx (b4-holistic round-3 — KHÔNG fire-after-commit)
      await auditEventTx(tx, {
        actorId: admin.user.id,
        action: "model.merged",
        resourceType: "ProductModel",
        resourceId: modelId,
        detail: `into=${targetId}`, // typed value — KHÔNG free text (spec §4.8)
      });
    });
  } catch (e) {
    if (e instanceof Error && MERGE_SENTINELS.has(e.message)) {
      sentinel = e.message; // stale page / target đổi tay — no-op, revalidate dưới
    } else {
      throw e; // fail closed — KHÔNG masquerade
    }
  }
  if (sentinel !== null) {
    // no-op posture: card stale render lại trạng thái mới (model/target đã
    // merged/approved bởi admin khác) — KHÔNG banner (admin page không có
    // error surface; revalidate là tín hiệu đủ).
    revalidatePath("/admin/catalog");
    return;
  }

  const model = await db.orm.public.ProductModel.first({ id: modelId });
  const target = await db.orm.public.ProductModel.first({ id: targetId });
  // legacy AdminAuditLog (Batch 2) — sau commit (audit chính đã atomic trong tx)
  await audit(
    admin.user.id,
    "merge_model",
    "ProductModel",
    modelId,
    `${model?.name ?? modelId} → ${target?.name ?? targetId}`,
  );
  revalidatePath("/admin/catalog");
}

/** Tạo model mới từ admin */
export async function createModelAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("listing.moderate");
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
  await audit(admin.user.id, "create_model", "ProductModel", slug, name);
  revalidatePath("/admin/catalog");
}
