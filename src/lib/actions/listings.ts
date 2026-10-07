"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import type { JsonValue } from "@prisma/orm-postgres/target/codec-types";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { slugify } from "@/src/lib/utils";
import { isModerationLocked } from "@/src/lib/moderation";
import {
  assertListingPublishable,
  assertListingContentValid,
  type ListingPublicationInput,
} from "@/src/lib/listing-publication";
import { assertListingImagesOwned } from "@/src/lib/listing-images";
import {
  LISTING_MUTATION_RATE,
  LISTING_EDIT_RATE,
  draftListingSchema,
  type ListingSubmissionInput,
} from "@/src/lib/listing-schema";
import {
  assertCategoryPublicationAllowed,
  listingRegimeForCategorySlug,
} from "@/src/lib/beta-categories";
import { PROVINCE_CODES } from "@/src/lib/provinces";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { auditEvent, auditEventTx } from "@/src/lib/audit-event";
import {
  formatMissingRequirements,
  SELLER_RULES_POLICY_VERSION,
  type SellerPublicationRequirement,
} from "@/src/lib/seller-verification-policy";
import { listingPublicationInputFromRow } from "@/src/lib/actions/helpers";
import type { Models } from "@/src/prisma/contract";
import type { Scalars } from "@prisma/orm-postgres/family-contract/types";

export type ListingFormState = { error?: string };

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Row Listing scalars (output type của contract). */
type ListingRow = Scalars<Models.public_Listing>;

/** Giá trị enum product_condition (contract) — schema đã validate giá trị. */
type ProductConditionValue = "new" | "open_box" | "like_new" | "excellent" | "good" | "fair" | "refurbished" | "for_parts";

/** Giá trị enum inventory_context (Batch 4 migration) — schema đã validate. */
type InventoryContextValue = "new" | "open_box" | "used";

/**
 * Publication gate (Batch 2 Task 10 — spec §4.4/§4.9; Batch 4 Task 4 mở rộng):
 * MỌI transition vào duyệt/công khai (pending/approved) của tin đăng đi qua
 * `assertListingPublishable` (Task 2 wrapper) = Batch 2 Seller Verification
 * Policy v1 (8 yêu cầu incl. Batch 3 `account_not_suspended` — R6 inherit, đọc
 * FRESH từ DB) + `assertListingContentValid` (category allowlist §5.6.1 +
 * regime schema §5.6/§6.3 + canonical-model DB check + image ownership §5.6.4).
 * Draft/sửa không chuyển trạng thái thì KHÔNG cần seller gate (spec §4.4) —
 * chỉ `assertListingContentValid` (item 1: non-transition update vẫn validate
 * content).
 *
 * Trust boundary (Global Constraints): `currentCategorySlug` (và mọi trường
 * gate) luôn resolve TỪ DB ROW — formData chỉ mang listingId (submit) hoặc
 * giá trị edit của chính seller (create/update).
 */

// ─── Typed content error → form error tiếng Việt (Batch 2 pattern) ────────────

/**
 * Map typed code → text tiếng Việt cho form error. Code ổn định nằm trong
 * message (test + redirect ?error= + audit reason dùng chung bộ code).
 */
const CONTENT_ERROR_TEXT: Record<string, string> = {
  CATEGORY_NOT_PUBLICATION_ALLOWED: "Danh mục chưa mở cho đăng tin trong giai đoạn beta",
  CATEGORY_NOT_FOUND: "Danh mục không hợp lệ",
  CATEGORY_REQUIRED: "Chọn danh mục",
  MODEL_INVALID: "Model sản phẩm không hợp lệ",
  MODEL_REQUIRED: "Chọn model sản phẩm",
  MODEL_BRAND_MISMATCH: "Model không thuộc thương hiệu đã chọn",
  BRAND_REQUIRED: "Chọn thương hiệu",
  IMAGE_NOT_OWNED: "Ảnh không thuộc về bạn — tải ảnh lại từ thiết bị",
  IMAGE_URL_INVALID: "Đường dẫn ảnh không hợp lệ",
  IMAGE_DUPLICATE: "Ảnh bị trùng lặp",
  IMAGE_SLOT_MISMATCH: "Số ảnh và số slot không khớp",
  IMAGE_SLOT_INVALID: "Slot ảnh không hợp lệ",
  IMAGE_REQUIRED: "Thêm ít nhất 1 ảnh sản phẩm",
  IMAGE_TOO_MANY: "Tối đa 8 ảnh",
  TITLE_INVALID: "Tiêu đề từ 8–120 ký tự",
  DESCRIPTION_INVALID: "Mô tả từ 20–4.000 ký tự",
  PRICE_INVALID: "Giá từ 100.000₫ đến 2 tỷ ₫",
  CONDITION_REQUIRED: "Chọn tình trạng sản phẩm",
  CONDITION_INVALID: "Tình trạng sản phẩm không hợp lệ",
  INVENTORY_CONTEXT_REQUIRED: "Chọn nguồn hàng (mới / mở hộp / đã qua sử dụng)",
  INVENTORY_CONTEXT_INVALID: "Nguồn hàng không hợp lệ",
  FREE_TEXT_INVALID: "Nội dung quá dài (tối đa 2.000 ký tự)",
  FULFILLMENT_REQUIRED: "Chọn ít nhất 1 phương thức giao hàng",
  FULFILLMENT_INVALID: "Phương thức giao hàng không hợp lệ",
  FULFILLMENT_DUPLICATE: "Phương thức giao hàng bị trùng",
  PROVINCE_REQUIRED: "Chọn tỉnh/thành phố",
  PROVINCE_INVALID: "Mã tỉnh/thành phố không hợp lệ",
  LOCATION_DISPLAY_REQUIRED: "Nhập khu vực hiển thị (không nhập địa chỉ nhà riêng)",
  LOCATION_DISPLAY_INVALID: "Khu vực hiển thị quá dài (tối đa 120 ký tự)",
};

/** Allowlist typed code — lỗi NGOÀI tập này được ném tiếp (fail closed). */
const CONTENT_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(CONTENT_ERROR_TEXT));

const LISTING_VALIDATION_PREFIX = "LISTING_VALIDATION_FAILED:";

/** Bỏ prefix schema — code nội bộ ổn định (vd MODEL_REQUIRED). */
const bareContentCode = (code: string): string =>
  code.startsWith(LISTING_VALIDATION_PREFIX) ? code.slice(LISTING_VALIDATION_PREFIX.length) : code;

const isKnownContentCode = (code: string): boolean => CONTENT_ERROR_CODES.has(bareContentCode(code));

/** Form error tiếng Việt kèm code ổn định (Batch 2 pattern). */
const contentErrorText = (code: string): string => {
  const bare = bareContentCode(code);
  return `${CONTENT_ERROR_TEXT[bare] ?? "Nội dung tin chưa hợp lệ"} (${bare})`;
};

/** Allowlist ?error= — CHỈ typed code cố định, giá trị lạ → generic (spec §4.8). */
const SUBMIT_ERROR_PARAM_CODES: ReadonlySet<string> = new Set([
  ...CONTENT_ERROR_CODES,
  "RATE_LIMITED",
  "CONTENT_INVALID",
]);

const submitErrorParam = (code: string): string => {
  const bare = bareContentCode(code);
  return SUBMIT_ERROR_PARAM_CODES.has(bare) ? bare : "CONTENT_INVALID";
};

/** Audit reason cho listing.submit_blocked — typed keys only (KHÔNG PII/free text). */
const submitBlockedReason = (code: string): string => {
  if (code.startsWith("SELLER_PUBLICATION_BLOCKED")) return code; // typed requirement keys
  return submitErrorParam(code);
};

/** Thông báo rate limit tiếng Việt kèm code ổn định. */
const rateLimitedText = (retryAfterSec: number): string =>
  `Bạn thao tác quá nhanh — thử lại sau ${retryAfterSec} giây (RATE_LIMITED)`;

/**
 * Chạy publication gate (seller → category → schema → model → images) — trả
 * form error tiếng Việt khi blocked, null khi cho qua. Lỗi không phải policy
 * (db…) được ném tiếp — fail closed, không masquerade.
 *
 * Text SELLER_PUBLICATION_BLOCKED giữ nguyên verbatim từ Batch 2 (tests pin):
 * đình chỉ là sanction của moderation — KHÔNG hoàn tất được tại trang xác
 * minh, thông báo riêng (review fix Task 5).
 */
async function runPublicationGate(
  input: ListingPublicationInput,
): Promise<{ error: string } | null> {
  try {
    await assertListingPublishable(input);
    return null;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("SELLER_PUBLICATION_BLOCKED:")) {
      const missing = e.message
        .slice("SELLER_PUBLICATION_BLOCKED:".length)
        .split(",") as SellerPublicationRequirement[];
      // Đình chỉ là sanction của moderation — KHÔNG hoàn tất được tại trang
      // xác minh (chỉ lift bởi admin). Thông báo riêng, KHÔNG kèm hướng dẫn
      // "Hoàn tất tại trang Xác minh người bán" (misleading — review fix Task 5).
      if (missing.includes("account_not_suspended")) {
        return { error: "Tài khoản đang bị đình chỉ — không thể đăng tin." };
      }
      return {
        error: `Chưa đủ điều kiện đăng tin theo chính sách người bán hiện hành — còn thiếu: ${formatMissingRequirements(missing)}. Hoàn tất tại trang Xác minh người bán.`,
      };
    }
    const code = e instanceof Error ? e.message : "";
    if (isKnownContentCode(code)) return { error: contentErrorText(code) };
    throw e;
  }
}

/**
 * Content validation (KHÔNG seller gate — item 1: non-transition update vẫn
 * validate content nhưng không đòi verification). Cùng phân loại lỗi như
 * runPublicationGate — fail closed với lỗi lạ.
 */
async function runContentValidation(
  input: ListingPublicationInput,
): Promise<{ error: string } | null> {
  try {
    await assertListingContentValid(input);
    return null;
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (isKnownContentCode(code)) return { error: contentErrorText(code) };
    throw e;
  }
}

// ─── Form → input (structured — spec §5.6/§6.3) ───────────────────────────────

/** Input từ formData — ListingSubmissionInput + trường form riêng (city/acceptExchange). */
type ListingFormInput = ListingSubmissionInput & { city: string; acceptExchange: boolean };

function listingFormInput(formData: FormData): ListingFormInput {
  const images = formData.getAll("images").map(String).filter(Boolean);
  const rawSlots = formData.getAll("imageSlots").map(String);
  // imageSlots song song images (zip theo index) — vắng mặt → undefined (KHÔNG
  // phải [] — mảng rỗng là IMAGE_SLOT_MISMATCH); giá trị rỗng = không gán slot
  const imageSlots = rawSlots.length > 0 ? rawSlots.map((s) => (s === "" ? null : s)) : undefined;
  const fulfillment = formData.getAll("fulfillmentMethods").map(String).filter(Boolean);
  return {
    title: String(formData.get("title") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    categoryId: String(formData.get("categoryId") ?? ""),
    brandId: String(formData.get("brandId") ?? "") || null,
    productModelId: String(formData.get("productModelId") ?? "") || null,
    condition: String(formData.get("condition") ?? "good"),
    price: Number(formData.get("price") ?? 0),
    negotiable: formData.get("negotiable") === "on",
    inventoryContext: String(formData.get("inventoryContext") ?? "") || null,
    includedAccessories: String(formData.get("includedAccessories") ?? "").trim() || null,
    knownDefects: String(formData.get("knownDefects") ?? "").trim() || null,
    repairHistory: String(formData.get("repairHistory") ?? "").trim() || null,
    fulfillmentMethods: fulfillment.length > 0 ? fulfillment : null,
    provinceLevelCode: String(formData.get("provinceLevelCode") ?? "") || null,
    locationDisplayName: String(formData.get("locationDisplayName") ?? "").trim() || null,
    imageUrls: images,
    imageSlots,
    city: String(formData.get("city") ?? "").trim(),
    acceptExchange: formData.get("acceptExchange") === "on",
  };
}

/**
 * city (cột NON-NULL — item 12): beta derive từ province =
 * PROVINCE_CODES[provinceLevelCode] (canonical 34-unit displayName — FD-1);
 * legacy (không province) giữ text form. Mã lạ → null → typed error ở caller
 * (schema đã chặn PROVINCE_INVALID trước đó — đây là belt-and-braces cho cột
 * non-null, KHÔNG bao giờ chuỗi rỗng).
 */
function deriveCity(input: ListingFormInput): string | null {
  if (input.provinceLevelCode != null) {
    const displayName: string | undefined = PROVINCE_CODES[input.provinceLevelCode];
    if (displayName === undefined) return null;
    return displayName;
  }
  return input.city.length > 0 ? input.city : null;
}

/** Json value cho cột fulfillmentMethods (Json?) — null khi không có. */
function fulfillmentJson(input: ListingFormInput): JsonValue | null {
  return input.fulfillmentMethods === null ? null : (input.fulfillmentMethods as unknown as JsonValue);
}

/**
 * Image diff BÊN TRONG tx (giữ nguyên logic xóa/thêm/sortOrder của
 * updateListingAction + checklistSlot): xóa ảnh bỏ (deleteAll — (listingId, url)
 * KHÔNG unique, terminal đơn-row chỉ xoá row ĐẦU), cập nhật sortOrder + slot
 * cho ảnh giữ, tạo ảnh mới kèm slot. Form không gửi slot → giữ slot cũ.
 */
async function applyImageDiff(
  tx: TxContext,
  listingId: string,
  imageUrls: string[],
  imageSlots: (string | null)[] | undefined,
): Promise<void> {
  const oldImages = await tx.orm.public.ListingImage
    .where({ listingId })
    .orderBy((i) => i.sortOrder.asc())
    .all();
  const oldUrls = oldImages.map((i) => i.url);
  const removed = oldUrls.filter((u) => !imageUrls.includes(u));
  for (const url of removed) {
    await tx.orm.public.ListingImage.where({ listingId, url }).deleteAll();
  }
  let sort = 0;
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i]!;
    const exists = oldImages.find((im) => im.url === url);
    const slot = imageSlots !== undefined ? (imageSlots[i] ?? null) : (exists?.checklistSlot ?? null);
    if (exists) {
      await tx.orm.public.ListingImage.where({ id: exists.id }).update({ sortOrder: sort, checklistSlot: slot });
    } else {
      await tx.orm.public.ListingImage.create({ listingId, url, sortOrder: sort, checklistSlot: slot });
    }
    sort++;
  }
}

/** Classify lỗi tx NGOÀI callback (Global Constraints — KHÔNG catch-and-return trong callback). */
const isListingSlugCollision = (e: unknown): boolean =>
  SqlQueryError.is(e) &&
  e.sqlState === "23505" &&
  e.constraint != null &&
  e.constraint.startsWith("Listing_slug");

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function createListingAction(
  _prev: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const user = await requireUser();

  // ─── Rate limit (§7.1) — 20/h/user cho create/draft/submit ───
  const rl = checkRateLimit(`listing:create:${user.id}`, LISTING_MUTATION_RATE);
  if (!rl.allowed) return { error: rateLimitedText(rl.retryAfterSec) };

  const input = listingFormInput(formData);

  // resolve category TỪ DB (trust boundary — KHÔNG tin formData cho slug)
  const category = await db.orm.public.Category.first({ id: input.categoryId });
  if (!category) return { error: "Chọn danh mục" };

  // city (cột non-null) — beta derive từ province (item 12)
  const city = deriveCity(input);
  if (city === null) return { error: "Chọn khu vực" };

  // ─── Publication gate MỘT LẦN (spec §4.4 + Batch 4 content) — TRƯỚC mọi write ───
  const blocked = await runPublicationGate({
    ...input,
    sellerId: user.id,
    // currentCategorySlug: undefined — tạo mới phải ∈ allowlist (§5.6.1)
  });
  if (blocked) return blocked;

  // slug duy nhất — thêm suffix nếu trùng (giữ nguyên hành vi)
  let slug = slugify(input.title);
  const slugTaken = await db.orm.public.Listing.where({ slug }).first();
  if (slugTaken) slug = `${slug}-${Date.now().toString(36)}`;

  // ─── MỘT tx cho cả ba write (item 8): Listing + ListingImage + PriceHistory ───
  // 23505 Listing.slug → THROW ra khỏi callback, classify NGOÀI tx (typed
  // slug-collision — KHÔNG catch-and-return trong callback: silent-success bug).
  try {
    await db.transaction(async (tx) => {
      const listing = await tx.orm.public.Listing.create({
        sellerId: user.id,
        categoryId: category.id,
        brandId: input.brandId,
        title: input.title,
        slug,
        description: input.description,
        condition: input.condition as ProductConditionValue,
        price: Math.round(input.price),
        negotiable: input.negotiable,
        acceptExchange: input.acceptExchange,
        status: "pending", // chờ admin duyệt
        city,
        productModelId: input.productModelId,
        inventoryContext: input.inventoryContext as InventoryContextValue | null,
        includedAccessories: input.includedAccessories,
        knownDefects: input.knownDefects,
        repairHistory: input.repairHistory,
        fulfillmentMethods: fulfillmentJson(input),
        provinceLevelCode: input.provinceLevelCode,
        communeLevelCode: null, // reserved — Batch 5 populate
        locationDisplayName: input.locationDisplayName,
      });
      for (let i = 0; i < input.imageUrls.length; i++) {
        await tx.orm.public.ListingImage.create({
          listingId: listing.id,
          url: input.imageUrls[i]!,
          sortOrder: i,
          checklistSlot: input.imageSlots?.[i] ?? null,
        });
      }
      if (input.productModelId) {
        await tx.orm.public.PriceHistory.create({
          modelId: input.productModelId,
          listingId: listing.id,
          price: Math.round(input.price),
          kind: "listed",
        });
      }
    });
  } catch (e) {
    if (isListingSlugCollision(e)) {
      return { error: "Tiêu đề đã trùng — chọn tiêu đề khác (LISTING_SLUG_COLLISION)" };
    }
    throw e;
  }

  revalidatePath("/sell/my");
  revalidatePath("/admin/listings");
  redirect("/sell/my?created=1");
}

/**
 * Lưu nháp (spec §4.4/§5.6.2 — draft được phép TRƯỚC verification): KHÔNG gọi
 * seller gate; draft schema (base requiredness + structured TUYỂN CHỌN + ảnh
 * 0..8); category ∈ allowlist (tạo mới) / chỉ đổi INTO allowlist (update);
 * ảnh vẫn qua rule (1)/(2)/(3); R5 guard (isModerationLocked); CAS theo
 * status draft; audit listing.draft_created / listing.draft_updated sống
 * chết cùng tx chính (auditEventTx).
 */
export async function saveListingDraftAction(
  _prev: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const user = await requireUser();

  // ─── Rate limit (§7.1) — 20/h/user cho create/draft/submit ───
  const rl = checkRateLimit(`listing:draft:${user.id}`, LISTING_MUTATION_RATE);
  if (!rl.allowed) return { error: rateLimitedText(rl.retryAfterSec) };

  const input = listingFormInput(formData);
  const listingId = String(formData.get("listingId") ?? "");

  // ─── Update path: ownership TRƯỚC mọi read ảnh/category + mọi write (IDOR) ───
  let existing: ListingRow | null = null;
  if (listingId !== "") {
    existing = await db.orm.public.Listing.first({ id: listingId });
    if (!existing || existing.sellerId !== user.id) return {}; // silent return (IDOR)
    // R5 — moderation lock (Batch 3 helper — KHÔNG hardcode status)
    if (isModerationLocked(existing.status)) {
      throw new Error("LISTING_MODERATION_LOCKED");
    }
    // chỉ draft được sửa như draft (approved/pending/… không qua đường này)
    if (existing.status !== "draft") return {};
  }

  // ─── Draft schema (base requiredness + structured TUYỂN CHỌN + 0..8 ảnh) ───
  const parsed = draftListingSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "SCHEMA_INVALID";
    return { error: contentErrorText(`${LISTING_VALIDATION_PREFIX}${first}`) };
  }

  // ─── Category allowlist (§5.6.1): tạo mới ∈ allowlist; update INTO allowlist ───
  const category = await db.orm.public.Category.first({ id: input.categoryId });
  if (!category) return { error: "Chọn danh mục" };
  let currentCategorySlug: string | undefined;
  if (existing !== null) {
    const currentCategory = await db.orm.public.Category.first({ id: existing.categoryId });
    currentCategorySlug = currentCategory?.slug;
  }
  try {
    assertCategoryPublicationAllowed({ targetSlug: category.slug, currentSlug: currentCategorySlug });
  } catch {
    return { error: contentErrorText("CATEGORY_NOT_PUBLICATION_ALLOWED") };
  }

  // city (cột non-null) — draft HIỆU DỤNG yêu cầu tỉnh (city derive từ province)
  const city = deriveCity(input);
  if (city === null) return { error: "Chọn khu vực" };

  // ─── Ảnh: draft cũng KHÔNG nhận URL lạ (rule 1/2/3) — 0 ảnh OK ───
  try {
    await assertListingImagesOwned({
      sellerId: user.id,
      listingId: existing !== null ? existing.id : undefined,
      imageUrls: input.imageUrls,
      imageSlots: input.imageSlots,
    });
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (isKnownContentCode(code)) return { error: contentErrorText(code) };
    throw e;
  }

  // slug duy nhất — thêm suffix nếu trùng (giữ nguyên hành vi)
  let slug = slugify(input.title);
  const slugTaken = await db.orm.public.Listing.where({ slug }).first();
  if (slugTaken) slug = `${slug}-${Date.now().toString(36)}`;

  // ─── MỘT tx: Listing + ListingImage + audit (auditEventTx — sống chết cùng tx) ───
  try {
    await db.transaction(async (tx) => {
      if (existing !== null) {
        // CAS theo draft — 0 rows → THROW ra khỏi callback, classify NGOÀI tx
        // (status đổi tay giữa read và write — Global Constraints).
        const claimed = await tx.orm.public.Listing
          .where({ id: existing.id, status: "draft" })
          .updateAll({
            title: input.title,
            categoryId: category.id,
            brandId: input.brandId,
            condition: input.condition as ProductConditionValue,
            price: Math.round(input.price),
            city,
            description: input.description,
            negotiable: input.negotiable,
            acceptExchange: input.acceptExchange,
            productModelId: input.productModelId,
            inventoryContext: input.inventoryContext as InventoryContextValue,
            includedAccessories: input.includedAccessories,
            knownDefects: input.knownDefects,
            repairHistory: input.repairHistory,
            fulfillmentMethods: fulfillmentJson(input),
            provinceLevelCode: input.provinceLevelCode,
            locationDisplayName: input.locationDisplayName,
          });
        if (claimed.length === 0) throw new Error("LISTING_CONCURRENT_CHANGE");
        await applyImageDiff(tx, existing.id, input.imageUrls, input.imageSlots);
        await auditEventTx(tx, {
          actorId: user.id,
          subjectId: user.id,
          action: "listing.draft_updated",
          resourceType: "Listing",
          resourceId: existing.id,
        });
      } else {
        const listing = await tx.orm.public.Listing.create({
          sellerId: user.id,
          categoryId: category.id,
          brandId: input.brandId,
          title: input.title,
          slug,
          description: input.description,
          condition: input.condition as ProductConditionValue,
          price: Math.round(input.price),
          negotiable: input.negotiable,
          acceptExchange: input.acceptExchange,
          status: "draft", // spec §5.6.2 — KHÔNG transition vào review
          city,
          productModelId: input.productModelId,
          inventoryContext: input.inventoryContext as InventoryContextValue,
          includedAccessories: input.includedAccessories,
          knownDefects: input.knownDefects,
          repairHistory: input.repairHistory,
          fulfillmentMethods: fulfillmentJson(input),
          provinceLevelCode: input.provinceLevelCode,
          communeLevelCode: null, // reserved — Batch 5 populate
          locationDisplayName: input.locationDisplayName,
        });
        for (let i = 0; i < input.imageUrls.length; i++) {
          await tx.orm.public.ListingImage.create({
            listingId: listing.id,
            url: input.imageUrls[i]!,
            sortOrder: i,
            checklistSlot: input.imageSlots?.[i] ?? null,
          });
        }
        await auditEventTx(tx, {
          actorId: user.id,
          subjectId: user.id,
          action: "listing.draft_created",
          resourceType: "Listing",
          resourceId: listing.id,
        });
      }
    });
  } catch (e) {
    // Classify NGOÀI tx (Global Constraints): 23505 Listing.slug → typed
    // slug-collision; lỗi khác ném tiếp (fail closed).
    if (isListingSlugCollision(e)) {
      return { error: "Tiêu đề đã trùng — chọn tiêu đề khác (LISTING_SLUG_COLLISION)" };
    }
    throw e;
  }

  revalidatePath("/sell/my");
  return {};
}

/** Ẩn / hiện lại tin */
export async function toggleListingVisibilityAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  // ─── Rate limit — bucket CHUNG listing:mutation:<userId> (update/toggle/delete) ───
  const rl = checkRateLimit(`listing:mutation:${user.id}`, LISTING_EDIT_RATE);
  if (!rl.allowed) return; // silent — form void không error surface

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) return;

  // R5 — moderation lock (Batch 3 Task 6): tin bị moderation takedown thì
  // seller KHÔNG được toggle (không un-remove qua nút hiện lại); helper từ
  // moderation vocab — KHÔNG hardcode chuỗi status.
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }

  if (listing.status === "approved") {
    // Ẩn tin = transition RA khỏi công khai — luôn được phép (gỡ tin khỏi chợ
    // không cần gate; hiện lại mới là transition vào công khai).
    // CAS theo status đã đọc — duyệt/ẩn song song không ghi đè nhau;
    // 0 rows → typed error (row đổi tay giữa read và write).
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: "approved" })
      .updateAll({ status: "hidden" });
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
  } else if (listing.status === "hidden") {
    // Hiện lại = transition vào CÔNG KHAI — full publication gate (Batch 4:
    // seller gate + category + schema + model + images) với input TỪ DB ROW
    // (trust boundary — KHÔNG tin formData cho trường gate).
    const input = await listingPublicationInputFromRow(listing, user.id);
    let blocked: string | null = null;
    try {
      await assertListingPublishable(input);
    } catch (e) {
      blocked = e instanceof Error ? e.message : "CONTENT_INVALID";
      // Audit fail-open — block vẫn chặn kể cả khi audit lỗi (spec §4.6/§4.8:
      // reason chỉ typed code, KHÔNG PII). KHÔNG redirect trong catch.
      try {
        await auditEvent({
          actorId: user.id,
          subjectId: user.id,
          action: "listing.submit_blocked",
          resourceType: "Listing",
          resourceId: listingId,
          reason: submitBlockedReason(blocked),
        });
      } catch {
        /* fail-open: audit lỗi không mở đường hiện lại */
      }
    }
    if (blocked !== null) return; // silent return — seller thấy tin không hiện lại
    // CAS như trên — 0 rows → typed error (row đổi tay giữa read và write).
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: "hidden" })
      .updateAll({ status: "approved" });
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
  }

  revalidatePath("/sell/my");
}

/**
 * Sửa tin đăng (chỉ khi chưa bán / không có đơn).
 *
 * Batch 4 Task 4: contentChanged MỞ RỘNG (B3) — MỌI structured field
 * (inventoryContext/free-text/fulfillment/province/location), brandId,
 * productModelId, image set (urls) và slot set đều là content change;
 * transition vào review: content-change trên approved/rejected/hidden →
 * pending (hidden cũng phải qua lại review — spec §5.6.2). INTERIM (A10):
 * legacy-regime listing bị từ chối KHÔNG resubmit (giữ rejected + message).
 * Vào pending → assertListingPublishable MỘT LẦN; không vào pending →
 * assertListingContentValid (item 1 — KHÔNG seller gate).
 *
 * Review fix Task 6 (item 7) giữ nguyên: conditional status write (CAS theo
 * status đã đọc) là write ĐẦU TIÊN trong MỘT tx cùng image diff +
 * PriceHistory — listing bị takedown giữa chừng → 0 rows → typed error →
 * rollback → ảnh của listing đã bị takedown KHÔNG bị đổi.
 */
export async function updateListingAction(
  _prev: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const user = await requireUser();

  // ─── Rate limit — bucket CHUNG listing:mutation:<userId> (§7.1) ───
  const rl = checkRateLimit(`listing:mutation:${user.id}`, LISTING_EDIT_RATE);
  if (!rl.allowed) return { error: rateLimitedText(rl.retryAfterSec) };

  const listingId = String(formData.get("listingId") ?? "");
  const input = listingFormInput(formData);

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) {
    return { error: "Không tìm thấy tin đăng" };
  }
  // R5 — moderation lock (Batch 3 Task 6): tin bị moderation takedown thì
  // seller KHÔNG được sửa (không edit để thoát takedown); helper từ moderation
  // vocab — KHÔNG hardcode chuỗi status.
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }
  if (listing.status === "sold") {
    return { error: "Không thể sửa tin đã bán" };
  }

  // resolve target category TỪ DB (trust boundary)
  const category = await db.orm.public.Category.first({ id: input.categoryId });
  if (!category) return { error: "Chọn danh mục" };
  if (input.brandId) {
    const brand = await db.orm.public.Brand.first({ id: input.brandId });
    if (!brand) return { error: "Thương hiệu không hợp lệ" };
  }

  // city (cột non-null): beta derive từ province; legacy giữ text form
  const city = deriveCity(input);
  if (city === null) return { error: "Chọn khu vực" };

  // currentCategorySlug TỪ DB ROW (trust boundary — KHÔNG tin formData)
  const currentCategory = await db.orm.public.Category.first({ id: listing.categoryId });
  const currentCategorySlug = currentCategory?.slug;

  // ─── contentChanged MỞ RỘNG (B3) — structured + brand/model + image/slot set ───
  const oldImages = await db.orm.public.ListingImage
    .where({ listingId })
    .orderBy((i) => i.sortOrder.asc())
    .all();
  const oldUrls = oldImages.map((i) => i.url);
  const oldSlots = oldImages.map((i) => (i.checklistSlot ?? null));
  const newSlots = input.imageSlots ?? oldSlots; // form không gửi slot → slot giữ nguyên
  const contentChanged =
    listing.title !== input.title ||
    listing.description !== input.description ||
    listing.price !== Math.round(input.price) ||
    listing.categoryId !== input.categoryId ||
    listing.condition !== input.condition ||
    listing.negotiable !== input.negotiable ||
    (listing.brandId ?? null) !== (input.brandId ?? null) ||
    (listing.productModelId ?? null) !== (input.productModelId ?? null) ||
    (listing.inventoryContext ?? null) !== (input.inventoryContext ?? null) ||
    (listing.includedAccessories ?? null) !== (input.includedAccessories ?? null) ||
    (listing.knownDefects ?? null) !== (input.knownDefects ?? null) ||
    (listing.repairHistory ?? null) !== (input.repairHistory ?? null) ||
    JSON.stringify(listing.fulfillmentMethods ?? null) !==
      JSON.stringify(input.fulfillmentMethods ?? null) ||
    (listing.provinceLevelCode ?? null) !== (input.provinceLevelCode ?? null) ||
    (listing.locationDisplayName ?? null) !== (input.locationDisplayName ?? null) ||
    oldUrls.length !== input.imageUrls.length ||
    oldUrls.some((u, idx) => input.imageUrls[idx] !== u) ||
    oldSlots.some((s, idx) => (newSlots[idx] ?? null) !== s);

  // transition vào review: content-change trên approved/rejected/hidden (B3)
  const intoReview =
    contentChanged && ["approved", "rejected", "hidden"].includes(listing.status);

  // INTERIM (A10 — FD-3 fail-closed): legacy-regime listing bị từ chối
  // KHÔNG resubmit vào pending trên edit — seller được hướng tạo tin mới trong
  // category beta (chính sách legacy-repurposing = Batch 8 register).
  if (
    intoReview &&
    listing.status === "rejected" &&
    listingRegimeForCategorySlug(category.slug) === "legacy"
  ) {
    return {
      error:
        "Tin bị từ chối trong danh mục cũ không thể gửi duyệt lại — hãy tạo tin mới trong danh mục loa bluetooth di động",
    };
  }

  const nextStatus: typeof listing.status = intoReview ? "pending" : listing.status;

  const publicationInput: ListingPublicationInput = {
    ...input,
    sellerId: user.id,
    listingId: listing.id,
    currentCategorySlug,
  };

  // ─── Gate: vào pending → full gate MỘT LẦN; không → content-only (item 1) ───
  if (intoReview) {
    const blocked = await runPublicationGate(publicationInput);
    if (blocked) return blocked; // KHÔNG mutation ảnh/video nào xảy ra trước điểm này
  } else {
    const invalid = await runContentValidation(publicationInput);
    if (invalid) return invalid;
  }

  // ─── MỘT tx: CAS TRƯỚC, image diff SAU (review fix Task 6 item 7 — giữ nguyên) ───
  try {
    await db.transaction(async (tx) => {
      const claimed = await tx.orm.public.Listing
        .where({ id: listingId, status: listing.status })
        .updateAll({
          title: input.title,
          categoryId: category.id,
          brandId: input.brandId,
          condition: input.condition as ProductConditionValue,
          price: Math.round(input.price),
          city,
          description: input.description,
          negotiable: input.negotiable,
          acceptExchange: input.acceptExchange,
          productModelId: input.productModelId,
          status: nextStatus,
          inventoryContext: input.inventoryContext as InventoryContextValue | null,
          includedAccessories: input.includedAccessories,
          knownDefects: input.knownDefects,
          repairHistory: input.repairHistory,
          fulfillmentMethods: fulfillmentJson(input),
          provinceLevelCode: input.provinceLevelCode,
          locationDisplayName: input.locationDisplayName,
        });
      if (claimed.length === 0) {
        // Phân loại typed error (item 7): moderation lock (takedown) KHÔNG phải
        // lỗi "trạng thái đổi tay" của admin duyệt/từ chối thường — hai lỗi
        // RIÊNG, KHÔNG masquerade. Re-read fresh trong tx — statement sau lock
        // wait thấy commit của bên thắng race (READ COMMITTED); row biến mất →
        // concurrent change.
        const fresh = await tx.orm.public.Listing.first({ id: listingId });
        if (fresh !== null && isModerationLocked(fresh.status)) {
          throw new Error("LISTING_MODERATION_LOCKED");
        }
        throw new Error("LISTING_CONCURRENT_CHANGE");
      }

      // cập nhật ảnh: xóa ảnh cũ không còn, thêm ảnh mới — SAU claim, cùng tx
      // (+ checklistSlot — Batch 4)
      await applyImageDiff(tx, listingId, input.imageUrls, input.imageSlots);

      const finalModelId = input.productModelId ?? listing.productModelId;
      if (finalModelId && listing.price !== Math.round(input.price)) {
        await tx.orm.public.PriceHistory.create({
          modelId: finalModelId,
          listingId: listing.id,
          price: Math.round(input.price),
          kind: "reprice",
        });
      }
    });
  } catch (e) {
    // Classify NGOÀI tx (Global Constraints): 23505 Listing.slug → typed
    // slug-collision; lỗi khác ném tiếp (fail closed — KHÔNG masquerade).
    if (isListingSlugCollision(e)) {
      return { error: "Tiêu đề đã trùng — chọn tiêu đề khác (LISTING_SLUG_COLLISION)" };
    }
    throw e;
  }

  revalidatePath("/sell/my");
  revalidatePath(`/listings/${listing.slug}`);
  redirect("/sell/my?updated=1");
}

/**
 * Gửi duyệt (spec §5.6.2 — đường draft→pending DUY NHẤT, full gate): formData
 * CHỈ mang listingId; input publication XÂY TỪ DB ROW (trust boundary —
 * title/description/price/… đọc từ listing row, imageUrls từ ListingImage rows
 * theo sortOrder, currentCategorySlug từ Category row). Blocked → audit
 * listing.submit_blocked + redirect NGOÀI catch (Global Constraints —
 * redirect() KHÔNG BAO GIỜ trong catch). Thành công → CAS claim draft→pending
 * + audit listing.submitted (policyVersion) trong cùng tx.
 */
export async function submitListingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  // ─── Rate limit (§7.1) — 20/h/user cho create/draft/submit ───
  const rl = checkRateLimit(`listing:submit:${user.id}`, LISTING_MUTATION_RATE);
  if (!rl.allowed) {
    return redirect(
      listingId !== "" ? `/sell/${listingId}/edit?error=RATE_LIMITED` : "/sell/my?error=RATE_LIMITED",
    );
  }

  // ─── Ownership TRƯỚC mọi read ảnh/category + mọi write (IDOR — listingId từ formData) ───
  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) return;

  // R5 — moderation lock (Batch 3 helper — KHÔNG hardcode status)
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }
  // draft-only (không double-submit — pending/approved/… no-op im lặng)
  if (listing.status !== "draft") return;

  // ─── Input TỪ DB ROW (trust boundary — formData CHỈ mang listingId) ───
  const input = await listingPublicationInputFromRow(listing, user.id);

  let blocked: string | null = null;
  try {
    await assertListingPublishable(input);
  } catch (e) {
    blocked = e instanceof Error ? e.message : "CONTENT_INVALID";
    // Audit fail-open — block vẫn chặn kể cả khi audit lỗi (spec §4.6/§4.8:
    // reason chỉ typed code từ allowlist, KHÔNG PII/free text). KHÔNG redirect
    // trong catch (Global Constraints — NEXT_REDIRECT throw trong catch là bug).
    try {
      await auditEvent({
        actorId: user.id,
        subjectId: user.id,
        action: "listing.submit_blocked",
        resourceType: "Listing",
        resourceId: listing.id,
        reason: submitBlockedReason(blocked),
      });
    } catch {
      /* fail-open: audit lỗi không mở đường submit */
    }
  }
  if (blocked !== null) {
    if (blocked.startsWith("SELLER_PUBLICATION_BLOCKED")) {
      return redirect("/sell/verification");
    }
    // ?error= chỉ typed code từ allowlist cố định — giá trị lạ → CONTENT_INVALID
    return redirect(`/sell/${listing.id}/edit?error=${encodeURIComponent(submitErrorParam(blocked))}`);
  }

  // ─── CAS claim draft→pending + audit trong cùng tx (audit sống chết với transition) ───
  // 0 rows → THROW ra khỏi callback, classify NGOÀI tx (status đổi tay).
  await db.transaction(async (tx) => {
    const claimed = await tx.orm.public.Listing
      .where({ id: listing.id, status: "draft" })
      .updateAll({ status: "pending" });
    if (claimed.length === 0) {
      throw new Error("LISTING_CONCURRENT_CHANGE");
    }
    await auditEventTx(tx, {
      actorId: user.id,
      subjectId: user.id,
      action: "listing.submitted",
      resourceType: "Listing",
      resourceId: listing.id,
      policyVersion: SELLER_RULES_POLICY_VERSION, // §4.6
    });
  });

  revalidatePath("/sell/my");
  revalidatePath("/admin/listings");
}

/** Xóa tin (chỉ khi chưa bán / không có đơn) */
export async function deleteListingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  // ─── Rate limit — bucket CHUNG listing:mutation:<userId> (§7.1) ───
  const rl = checkRateLimit(`listing:mutation:${user.id}`, LISTING_EDIT_RATE);
  if (!rl.allowed) return; // silent — form void không error surface

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) return;
  // R5 — moderation lock (Batch 3 Task 6): tin bị moderation takedown thì
  // seller KHÔNG được xóa — nguồn của moderation record không bị phá bởi
  // chính subject của nó; helper từ moderation vocab.
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }
  if (listing.status === "sold") return;

  const orderItems = await db.orm.public.OrderItem.where({ listingId }).all();
  if (orderItems.length > 0) {
    // đã nằm trong đơn — chỉ cho ẩn. CAS theo status đã đọc (SHOULD-FIX 3):
    // 0 rows = row đổi tay giữa read và write → typed error, KHÔNG clobber.
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: listing.status })
      .updateAll({ status: "hidden" });
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
  } else {
    // Xóa CÓ ĐIỀU KIỆN theo status đã đọc (SHOULD-FIX 3) — deleteAll compile
    // điều kiện status VÀO câu DELETE (Prisma 8 .delete() đơn-row select rồi
    // xoá theo id → KHÔNG atomic, takedown song song bị xoá mất). 0 rows = row
    // đổi tay (moderation takedown) → typed error, row SỐNG SÓT.
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: listing.status })
      .deleteAll();
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
    // FK cascade đã xoá ảnh/cart theo Listing; deleteAll giữ đúng nghĩa nếu
    // cascade đổi sau này.
    await db.orm.public.ListingImage.where({ listingId }).deleteAll();
    await db.orm.public.CartItem.where({ listingId }).deleteAll();
  }

  revalidatePath("/sell/my");
}
