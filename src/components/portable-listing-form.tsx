"use client";

import { useActionState, useState, useTransition } from "react";
import Link from "next/link";
import {
  createListingAction,
  updateListingAction,
  saveListingDraftAction,
  type ListingFormState,
} from "@/src/lib/actions/listings";
import { ImagePicker } from "@/src/components/image-picker";
import { cn, formatVND } from "@/src/lib/utils";
import {
  Banknote,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  LoaderCircle,
  Save,
} from "lucide-react";

/**
 * PortableListingForm (Batch 4 Task 5 — spec §6.3) — form đăng/sửa tin loa
 * bluetooth di động 7 BƯỚC progressive disclosure cho regime "beta".
 *
 * Ranh giới (Global Constraints — spec §4.5): MỌI giá trị danh mục/label/slot/
 * tỉnh đến từ PROPS do server page build (page import listing-schema/beta-
 * categories/provinces/seller-verification-policy — module server-only hoặc
 * ranh giới validation); component KHÔNG import listing-schema.ts hay
 * beta-categories.ts. Server là gate: submit KHÔNG BAO GIỜ bị chặn bởi trạng
 * thái verification client-side — bước 7 chỉ HIỂN THỊ trạng thái từng yêu cầu
 * (prop verification, đọc FRESH ở server) + link /sell/verification nơi cơ chế
 * chấp nhận Seller Rules của Batch 2 sống (PolicyAcceptance) — KHÔNG text
 * chấp nhận mới nào được viết ở đây.
 *
 * Nút bấm (một <form>, một useActionState — dispatcher route theo intent):
 *  - submit thường → createListingAction (tạo mới) / updateListingAction
 *    (sửa tin đã duyệt — content change → pending);
 *  - "Lưu nháp" (intent=draft) → saveListingDraftAction (draft được phép trước
 *    verification — spec §4.4);
 *  - SỬA DRAFT: KHÔNG dùng updateListingAction (draft→draft, không transition)
 *    — intent thường cũng route về saveListingDraftAction (Enter key an toàn),
 *    nút "Gửi duyệt" (submitListingAction — đọc DB row) do PAGE render riêng.
 */

type Option = { value: string; label: string };

/** Row listing đang sửa (từ DB — page build; imageSlots song song imageUrls). */
export type PortableListingEdit = {
  listingId: string;
  status: string;
  title: string;
  description: string;
  price: number;
  categoryId: string;
  brandId: string | null;
  productModelId: string | null;
  condition: string;
  negotiable: boolean;
  inventoryContext: string | null;
  includedAccessories: string | null;
  knownDefects: string | null;
  repairHistory: string | null;
  fulfillmentMethods: string[] | null;
  provinceLevelCode: string | null;
  locationDisplayName: string | null;
  imageUrls: string[];
  imageSlots: (string | null)[];
};

const TOTAL_STEPS = 7;

const STEP_TITLES = [
  "Thương hiệu & model",
  "Nguồn hàng & tình trạng",
  "Giá bán",
  "Khu vực & giao hàng",
  "Ảnh sản phẩm",
  "Mô tả & chi tiết",
  "Xem lại & gửi duyệt",
] as const;

export function PortableListingForm({
  categories,
  brands,
  models,
  provinces,
  conditions,
  inventoryContexts,
  fulfillmentMethods,
  photoSlots,
  requirementLabels,
  verification,
  edit,
  maxImages = 8,
}: {
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  models: { id: string; name: string; brandId: string }[];
  provinces: { code: string; displayName: string }[];
  conditions: Option[];
  inventoryContexts: Option[];
  fulfillmentMethods: Option[];
  photoSlots: Option[];
  requirementLabels: Record<string, string>;
  verification: { ok: boolean; missing: string[] };
  edit?: PortableListingEdit;
  /**
   * Cap ảnh TOÀN TIN (LISTING_MAX_IMAGES — server schema, truyền từ page qua
   * prop vì component KHÔNG import listing-schema.ts — spec §4.5 props only,
   * pin tests/unit/portable-listing-form.test.ts). b4-holistic: trước fix
   * mỗi slot picker có max riêng 8 (8×8 = 64 ảnh) trong khi server cap 8/tin
   * → mọi save IMAGE_TOO_MANY sau khi đã đốt budget upload.
   */
  maxImages?: number;
}) {
  const isDraftEdit = edit?.status === "draft";

  // ─── Dispatcher: một useActionState cho cả submit thường lẫn lưu nháp ───────
  // Nút "Lưu nháp" mang name="intent" value="draft" (submitter button) —
  // dispatcher đọc intent và route đúng action server. Sửa draft: intent
  // thường (Enter key) cũng là lưu nháp — KHÔNG updateListingAction (draft→draft).
  async function dispatchSubmit(
    prev: ListingFormState,
    formData: FormData,
  ): Promise<ListingFormState> {
    const intent = String(formData.get("intent") ?? "");
    if (intent === "draft" || isDraftEdit) {
      return saveListingDraftAction(prev, formData);
    }
    return edit !== undefined ? updateListingAction(prev, formData) : createListingAction(prev, formData);
  }

  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    dispatchSubmit,
    {},
  );
  // Dispatch thủ công (b4-holistic round-1 MEDIUM form-action-contract): React 19
  // gọi requestFormReset trên MỌI form action KHÔNG throw — kể cả action trả
  // {error} — nên form.reset() wipe textarea uncontrolled (description/
  // accessories/defects/repair) và revert DOM select/checkbox/radio về giá trị
  // mount-time; React state không đổi → KHÔNG re-sync DOM (value prop không
  // đổi giữa 2 render) → save kế tiếp đọc FormData từ DOM ĐÃ RESET = silent
  // revert (province/brand/model về ""). Bỏ action prop + dispatch qua
  // onSubmit + startTransition: KHÔNG requestFormReset; isPending của
  // useActionState vẫn track đúng (gọi trong transition — React docs).
  const [, startTransition] = useTransition();

  // ─── Bước hiện tại (progressive disclosure — mọi bước đều mount, ẩn bằng CSS
  //     để dữ liệu uncontrolled KHÔNG mất khi qua lại bước) ─────────────────────
  const [step, setStep] = useState(1);
  const [lastIntent, setLastIntent] = useState<"draft" | null>(null);

  // ─── Controlled fields (preview bước 7 + auto-suggest tiêu đề) ─────────────
  const [categoryId, setCategoryId] = useState(edit?.categoryId ?? categories[0]?.id ?? "");
  const [brandId, setBrandId] = useState(edit?.brandId ?? "");
  const [productModelId, setProductModelId] = useState(edit?.productModelId ?? "");
  const [title, setTitle] = useState(edit?.title ?? "");
  const [titleAuto, setTitleAuto] = useState<string | null>(null);
  const [inventoryContext, setInventoryContext] = useState(edit?.inventoryContext ?? "");
  const [condition, setCondition] = useState(edit?.condition ?? "good");
  const [price, setPrice] = useState(edit?.price ?? 0);
  const [negotiable, setNegotiable] = useState(edit?.negotiable ?? false);
  const [provinceLevelCode, setProvinceLevelCode] = useState(edit?.provinceLevelCode ?? "");
  const [locationDisplayName, setLocationDisplayName] = useState(edit?.locationDisplayName ?? "");
  const [fulfillment, setFulfillment] = useState<string[]>(edit?.fulfillmentMethods ?? []);
  // ─── Free-text CONTROLLED (b4-holistic round-1 MEDIUM): 4 textarea trước fix
  // uncontrolled (defaultValue) — form.reset() của React 19 (xem comment
  // startTransition) wipe chúng sau MỌI action response kể cả {error}; giá trị
  // control là nguồn duy nhất của thật — reset/select-revert không còn đụng được.
  const [description, setDescription] = useState(edit?.description ?? "");
  const [includedAccessories, setIncludedAccessories] = useState(edit?.includedAccessories ?? "");
  const [knownDefects, setKnownDefects] = useState(edit?.knownDefects ?? "");
  const [repairHistory, setRepairHistory] = useState(edit?.repairHistory ?? "");

  /** Tiêu đề auto-suggest từ brand+model — CHỈ đề xuất khi trống hoặc đang là đề xuất cũ (editable). */
  function suggestTitle(nextBrandId: string, nextModelId: string): void {
    const brandName = brands.find((b) => b.id === nextBrandId)?.name ?? "";
    const modelName = models.find((m) => m.id === nextModelId)?.name ?? "";
    const suggested = [brandName, modelName].filter(Boolean).join(" ").trim();
    if (suggested === "") return;
    if (title === "" || title === titleAuto) {
      setTitle(suggested);
      setTitleAuto(suggested);
    }
  }

  function onBrandChange(nextBrandId: string): void {
    setBrandId(nextBrandId);
    // model của thương hiệu khác → bỏ chọn (server vẫn chặn MODEL_BRAND_MISMATCH)
    const model = models.find((m) => m.id === productModelId);
    if (model !== undefined && model.brandId !== nextBrandId) {
      setProductModelId("");
    }
    suggestTitle(nextBrandId, productModelId);
  }

  function onModelChange(nextModelId: string): void {
    setProductModelId(nextModelId);
    suggestTitle(brandId, nextModelId);
  }

  function toggleFulfillment(value: string): void {
    setFulfillment((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  // ─── Ảnh edit theo slot (imageSlots song song imageUrls theo sortOrder) ────
  const imageUrls = edit?.imageUrls ?? [];
  const imageSlots = edit?.imageSlots ?? [];
  const imagesBySlot = (slotValue: string): string[] =>
    imageUrls.filter((_, i) => (imageSlots[i] ?? null) === slotValue);
  const unslottedImages = imageUrls.filter((_, i) => (imageSlots[i] ?? null) == null);

  // ─── Cap ảnh TOÀN TIN (b4-holistic round-1 LOW): count mỗi picker lift lên
  // đây qua onCountChange — tổng (kể ảnh chưa gán slot) chặn TRƯỚC khi upload
  // thay vì để server IMAGE_TOO_MANY sau khi đốt budget upload. Key "" = bucket
  // ảnh chưa gán slot (slotValue null).
  const [imageCounts, setImageCounts] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const slot of photoSlots) initial[slot.value] = imagesBySlot(slot.value).length;
    initial[""] = unslottedImages.length;
    return initial;
  });
  const onSlotCountChange = (slotKey: string) => (count: number) => {
    setImageCounts((prev) => ({ ...prev, [slotKey]: count }));
  };
  const totalImages = Object.values(imageCounts).reduce((a, b) => a + b, 0);
  /** Ngân sách ảnh còn lại cho MỘT picker = cap toàn tin − ảnh của các picker khác. */
  const slotBudget = (slotKey: string): number =>
    Math.max(0, maxImages - (totalImages - (imageCounts[slotKey] ?? 0)));

  const brandModels = models.filter((m) => m.brandId === brandId);
  const brandName = brands.find((b) => b.id === brandId)?.name ?? "";
  const modelName = models.find((m) => m.id === productModelId)?.name ?? "";
  const provinceName = provinces.find((p) => p.code === provinceLevelCode)?.displayName ?? "";
  const inventoryContextLabel =
    inventoryContexts.find((ic) => ic.value === inventoryContext)?.label ?? inventoryContext;
  const conditionLabel = conditions.find((c) => c.value === condition)?.label ?? condition;
  const fulfillmentText = fulfillment
    .map((v) => fulfillmentMethods.find((m) => m.value === v)?.label ?? v)
    .join(", ");

  return (
    // noValidate: các bước ẩn (display:none) vẫn tham gia constraint validation —
    // required field trống ở bước ẩn sẽ CHẶN submit với lỗi "not focusable" im
    // lặng (không bubble được). Server validation (zod + typed code tiếng Việt)
    // là gate thật (spec §4.5) — lỗi hiển thị qua banner state.error.
    //
    // KHÔNG có action prop (b4-holistic round-1 MEDIUM): action prop → React 19
    // requestFormReset sau MỌI action (kể cả {error}) → form.reset() (xem
    // comment startTransition ở trên). Dispatch thủ công qua onSubmit +
    // startTransition; FormData build với submitter để name="intent"
    // value="draft" của nút Lưu nháp không bị rơi (Enter key: submitter null →
    // intent rỗng → dispatcher route theo isDraftEdit như trước).
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const fd = new FormData(e.currentTarget, submitter ?? undefined);
        startTransition(() => {
          void formAction(fd);
        });
      }}
      className="space-y-5"
    >
      {edit && <input type="hidden" name="listingId" value={edit.listingId} />}

      {/* Tiến độ + lỗi form (luôn hiển thị — lỗi có thể đến từ intent ở bất kỳ bước) */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">
          Bước {step}/{TOTAL_STEPS}
        </span>
        <span className="font-medium">{STEP_TITLES[step - 1]}</span>
      </div>

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}
      {lastIntent === "draft" && state.ok === true && (
        <p className="rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2.5 text-sm text-[var(--green)]">
          ✓ Đã lưu nháp — bạn có thể tiếp tục chỉnh sửa.
        </p>
      )}

      {/* ═══ Bước 1: Brand + Canonical model (§6.3 Step 1) ═══ */}
      <section data-step="1" className={cn("space-y-5", step !== 1 && "hidden")}>
        <div>
          <label className="label" htmlFor="categoryId">Danh mục</label>
          <select
            id="categoryId"
            name="categoryId"
            className="input"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            required
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="brandId">Thương hiệu</label>
            <select
              id="brandId"
              name="brandId"
              className="input"
              value={brandId}
              onChange={(e) => onBrandChange(e.target.value)}
              required
            >
              <option value="">— Chọn thương hiệu —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="productModelId">Model sản phẩm</label>
            <select
              id="productModelId"
              name="productModelId"
              className="input"
              value={productModelId}
              onChange={(e) => onModelChange(e.target.value)}
              required
            >
              <option value="">— Chọn model —</option>
              {brandModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-[var(--muted)]">
              Model chuẩn lấy từ danh mục loa bluetooth di động đã được duyệt.
            </p>
          </div>
        </div>
      </section>

      {/* ═══ Bước 2: new/open_box/used + Condition (§6.3 Step 2) ═══ */}
      <section data-step="2" className={cn("space-y-5", step !== 2 && "hidden")}>
        <div>
          <p className="label">Nguồn hàng</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {inventoryContexts.map((ic) => (
              <label
                key={ic.value}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg border px-4 py-3 transition",
                  inventoryContext === ic.value
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[var(--line)] bg-[var(--paper)] hover:border-zinc-600",
                )}
              >
                <input
                  type="radio"
                  name="inventoryContext"
                  value={ic.value}
                  className="size-4 accent-[var(--accent)]"
                  checked={inventoryContext === ic.value}
                  onChange={() => setInventoryContext(ic.value)}
                />
                <span className="text-sm text-[var(--ink-2)]">{ic.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="condition">Tình trạng sản phẩm</label>
          <select
            id="condition"
            name="condition"
            className="input"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            required
          >
            {conditions.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </section>

      {/* ═══ Bước 3: Asking price + Negotiable? (§6.3 Step 3) ═══ */}
      <section data-step="3" className={cn("space-y-5", step !== 3 && "hidden")}>
        <div>
          <label className="label" htmlFor="price">Giá bán (₫)</label>
          <input
            id="price"
            name="price"
            type="number"
            min={100000}
            step={10000}
            className="input"
            placeholder="18500000"
            value={price === 0 ? "" : price}
            onChange={(e) => {
              const n = Number(e.target.value);
              setPrice(Number.isFinite(n) ? n : 0);
            }}
            required
          />
          {price > 0 && (
            <p className="mt-1.5 text-xs text-[var(--muted)]">
              {formatVND(price)} — giá niêm yết trên tin đăng
            </p>
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 transition hover:border-zinc-600">
          <input
            type="checkbox"
            name="negotiable"
            className="size-4 accent-[var(--accent)]"
            checked={negotiable}
            onChange={(e) => setNegotiable(e.target.checked)}
          />
          <span className="text-sm text-[var(--ink-2)]">Mở đón thương lượng giá</span>
        </label>
      </section>

      {/* ═══ Bước 4: Location + Fulfillment (§6.3 Step 4) ═══ */}
      <section data-step="4" className={cn("space-y-5", step !== 4 && "hidden")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="provinceLevelCode">Tỉnh/thành phố</label>
            <select
              id="provinceLevelCode"
              name="provinceLevelCode"
              className="input"
              value={provinceLevelCode}
              onChange={(e) => setProvinceLevelCode(e.target.value)}
              required
            >
              <option value="">— Chọn tỉnh/thành phố —</option>
              {provinces.map((p) => (
                <option key={p.code} value={p.code}>{p.displayName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="locationDisplayName">Khu vực hiển thị</label>
            <input
              id="locationDisplayName"
              name="locationDisplayName"
              className="input"
              maxLength={120}
              value={locationDisplayName}
              onChange={(e) => setLocationDisplayName(e.target.value)}
              placeholder="VD: khu vực Quận 7, gần chợ X"
            />
            <p className="mt-1.5 text-xs text-[var(--muted)]">
              Nhập khu vực chung để người mua hình dung khoảng giao hàng —
              không nhập địa chỉ nhà riêng.
            </p>
          </div>
        </div>
        <div>
          <p className="label">Phương thức giao hàng</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {fulfillmentMethods.map((m) => (
              <label
                key={m.value}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 transition hover:border-zinc-600"
              >
                <input
                  type="checkbox"
                  name="fulfillmentMethods"
                  value={m.value}
                  className="size-4 accent-[var(--accent)]"
                  checked={fulfillment.includes(m.value)}
                  onChange={() => toggleFulfillment(m.value)}
                />
                <span className="text-sm text-[var(--ink-2)]">{m.label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ Bước 5: Photos — 8 slot §5.6.3 (§6.3 Step 5) ═══ */}
      <section data-step="5" className={cn("space-y-4", step !== 5 && "hidden")}>
        <p className="text-xs text-[var(--muted)]">
          Thêm ảnh theo từng mục dưới đây — cần ít nhất 1 ảnh để gửi duyệt. Ảnh
          được máy chủ xử lý lại (mã hóa lại WebP, bỏ dữ liệu EXIF/vị trí) trước khi lưu.
        </p>
        {/* b4-holistic: counter TOÀN TIN — cap là tổng MỌI slot (server cap
            LISTING_MAX_IMAGES/tin), không phải 8 cho từng mục. */}
        <p className="text-xs font-medium text-[var(--ink-2)]">
          {totalImages}/{maxImages} ảnh (tổng toàn tin)
        </p>
        {photoSlots.map((slot) => (
          <div key={slot.value}>
            <p className="label mb-1.5">{slot.label}</p>
            {slot.value === "label_serial" && (
              <p className="mb-1.5 text-xs text-[var(--red)]">
                Che hoặc làm mờ serial trước khi chụp — ảnh hiển thị công khai trong gallery.
              </p>
            )}
            <ImagePicker
              name="images"
              slotName="imageSlots"
              slotValue={slot.value}
              max={slotBudget(slot.value)}
              initialUrls={imagesBySlot(slot.value)}
              onCountChange={onSlotCountChange(slot.value)}
            />
          </div>
        ))}
        {unslottedImages.length > 0 && (
          <div>
            <p className="label mb-1.5">Ảnh chưa gán mục</p>
            <ImagePicker
              name="images"
              slotName="imageSlots"
              slotValue={null}
              max={slotBudget("")}
              initialUrls={unslottedImages}
              onCountChange={onSlotCountChange("")}
            />
          </div>
        )}
      </section>

      {/* ═══ Bước 6: Accessories / defects / repair + description (§6.3 Step 6) ═══ */}
      <section data-step="6" className={cn("space-y-5", step !== 6 && "hidden")}>
        <div>
          <label className="label" htmlFor="title">Tiêu đề tin đăng</label>
          <input
            id="title"
            name="title"
            className="input"
            maxLength={120}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleAuto(null);
            }}
            required
            placeholder="VD: JBL Charge 5 đã qua sử dụng"
          />
          <p className="mt-1.5 text-xs text-[var(--muted)]">
            Tiêu đề được gợi ý từ thương hiệu + model — bạn có thể tự chỉnh.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="description">Mô tả chi tiết</label>
          <textarea
            id="description"
            name="description"
            rows={6}
            className="input resize-y"
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            placeholder="Nguồn gốc, thời gian sử dụng, tình trạng thực tế, lý do bán…"
          />
        </div>
        <div>
          <label className="label" htmlFor="includedAccessories">Phụ kiện đi kèm</label>
          <textarea
            id="includedAccessories"
            name="includedAccessories"
            rows={3}
            className="input resize-y"
            maxLength={2000}
            value={includedAccessories}
            onChange={(e) => setIncludedAccessories(e.target.value)}
            placeholder="Sạc, cáp, hộp, tài liệu… (nếu có)"
          />
        </div>
        <div>
          <label className="label" htmlFor="knownDefects">Vết xước / hư hại đã biết</label>
          <textarea
            id="knownDefects"
            name="knownDefects"
            rows={3}
            className="input resize-y"
            maxLength={2000}
            value={knownDefects}
            onChange={(e) => setKnownDefects(e.target.value)}
            placeholder="Nêu rõ vết xước, lỗi đang có, bộ phận bị ảnh hưởng…"
          />
        </div>
        <div>
          <label className="label" htmlFor="repairHistory">Lịch sử sửa chữa</label>
          <textarea
            id="repairHistory"
            name="repairHistory"
            rows={3}
            className="input resize-y"
            maxLength={2000}
            value={repairHistory}
            onChange={(e) => setRepairHistory(e.target.value)}
            placeholder="Đã sửa ở đâu, thay linh kiện gì, thời gian… (nếu có)"
          />
        </div>
      </section>

      {/* ═══ Bước 7: Preview + verification check + submit (§6.3 Step 7) ═══ */}
      <section data-step="7" className={cn("space-y-5", step !== 7 && "hidden")}>
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
          <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Xem lại tin đăng
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Tiêu đề</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">{title || "—"}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Thương hiệu / model</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">
                {[brandName, modelName].filter(Boolean).join(" ") || "—"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Nguồn hàng</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">
                {inventoryContext !== "" ? inventoryContextLabel : "—"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Tình trạng</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">{conditionLabel}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Giá bán</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">
                {price > 0 ? formatVND(price) : "—"}{negotiable ? " (mặc cả)" : ""}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Khu vực</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">
                {[provinceName, locationDisplayName].filter(Boolean).join(" · ") || "—"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--muted)]">Giao hàng</dt>
              <dd className="text-right font-medium text-[var(--ink-2)]">{fulfillmentText || "—"}</dd>
            </div>
          </dl>
        </div>

        {/* Trạng thái từng yêu cầu publication (incl. seller_rules) — prop từ
            server đọc FRESH từ DB; KHÔNG text chấp nhận mới (cơ chế Batch 2 sống
            ở /sell/verification). Server mới là gate — form KHÔNG tự chặn submit. */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
          <p className="text-sm font-bold uppercase tracking-wider text-[var(--ink-2)]">
            Điều kiện đăng tin
          </p>
          <ul className="mt-3 space-y-1.5">
            {Object.entries(requirementLabels).map(([key, label]) => {
              const ok = !verification.missing.includes(key);
              return (
                <li key={key} className="flex items-center gap-2 text-sm">
                  {ok ? (
                    <CheckCircle2 className="size-4 shrink-0 text-[var(--green)]" />
                  ) : (
                    <Circle className="size-4 shrink-0 text-[var(--muted)]" />
                  )}
                  <span className={ok ? "text-[var(--ink-2)]" : "text-[var(--muted)]"}>{label}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Trạng thái trên do LoaViet đọc từ hồ sơ hiện tại của bạn —{" "}
            <Link href="/sell/verification" className="text-[var(--accent)] hover:underline">
              xem trang Xác minh người bán
            </Link>
            .
          </p>
        </div>

        <div className="rounded-lg bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink-2)]">
          <p className="flex items-center gap-1.5 font-semibold text-[var(--ink-2)]">
            <Banknote className="size-3.5 text-[var(--accent)]" />
            Đăng tin miễn phí trong private beta
          </p>
          <p className="mt-1">
            LoaViet không giữ tiền và không tham gia thanh toán — giá và cách giao
            dịch do bạn và người mua tự thỏa thuận ngoài nền tảng.
          </p>
        </div>

        <div className="space-y-3">
          {!isDraftEdit && (
            <button type="submit" disabled={pending} className="btn-primary w-full py-3 text-base">
              {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {edit ? "Lưu thay đổi" : "Gửi tin để chờ duyệt"}
            </button>
          )}
          {(!edit || isDraftEdit) && (
            <button
              type="submit"
              name="intent"
              value="draft"
              onClick={() => setLastIntent("draft")}
              disabled={pending}
              className="btn-secondary w-full py-3"
            >
              {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              Lưu nháp
            </button>
          )}
        </div>
      </section>

      {/* ═══ Điều hướng bước ═══ */}
      <div className="flex items-center justify-between gap-3">
        {step > 1 ? (
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            className="btn-secondary h-10 px-4 text-sm"
          >
            <ChevronLeft className="size-4" />
            Quay lại
          </button>
        ) : (
          <span />
        )}
        {step < TOTAL_STEPS ? (
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            className="btn-primary h-10 px-5 text-sm"
          >
            Tiếp tục
            <ChevronRight className="size-4" />
          </button>
        ) : (
          <span />
        )}
      </div>
    </form>
  );
}
