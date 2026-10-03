"use client";

import { useActionState, useState } from "react";
import {
  createListingAction,
  updateListingAction,
  type ListingFormState,
} from "@/src/lib/actions/listings";
import { ImagePicker } from "@/src/components/image-picker";
import { formatVND } from "@/src/lib/utils";
import { LoaderCircle, Banknote } from "lucide-react";

export function ListingForm({
  categories,
  brands,
  cities,
  conditions,
  models,
  edit,
}: {
  categories: { id: string; name: string; commissionRate: number }[];
  brands: { id: string; name: string }[];
  cities: string[];
  conditions: { value: string; label: string }[];
  models: { id: string; name: string; brandId: string }[];
  edit?: {
    listingId: string;
    title: string;
    description: string;
    price: number;
    categoryId: string;
    brandId: string | null;
    condition: string;
    city: string;
    negotiable: boolean;
    acceptExchange: boolean;
    imageUrls: string[];
    productModelId?: string | null;
  };
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    edit ? updateListingAction : createListingAction,
    {},
  );
  const [categoryId, setCategoryId] = useState(edit?.categoryId ?? categories[0]?.id ?? "");
  const [price, setPrice] = useState(edit?.price ?? 0);

  const category = categories.find((c) => c.id === categoryId);
  const commission = category ? Math.round((price * category.commissionRate) / 100) : 0;

  return (
    <form action={formAction} className="space-y-5">
      {edit && <input type="hidden" name="listingId" value={edit.listingId} />}

      {/* Ảnh */}
      <div>
        <label className="label">Ảnh sản phẩm</label>
        <ImagePicker name="images" max={8} initialUrls={edit?.imageUrls ?? []} />
      </div>

      {/* Tiêu đề */}
      <div>
        <label className="label" htmlFor="title">Tiêu đề tin đăng</label>
        <input
          id="title"
          name="title"
          className="input"
          placeholder="VD: Loa thùng JBL EON715 15 inch 1300W mới nguyên seal"
          required
          maxLength={120}
          defaultValue={edit?.title}
        />
      </div>

      {/* Danh mục + hãng */}
      <div className="grid gap-4 sm:grid-cols-2">
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
        <div>
          <label className="label" htmlFor="brandId">Thương hiệu</label>
          <select id="brandId" name="brandId" className="input" defaultValue={edit?.brandId ?? ""}>
            <option value="">Không chọn / khác</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Model sản phẩm (§5 — catalog chuẩn hóa) */}
      <div>
        <label className="label" htmlFor="productModelId">
          Model sản phẩm <span className="font-normal text-[var(--muted)]">(tùy chọn — dùng specs &amp; giá tham chiếu từ catalog)</span>
        </label>
        <select
          id="productModelId"
          name="productModelId"
          className="input"
          defaultValue={edit?.productModelId ?? ""}
        >
          <option value="">— Không chọn model cụ thể —</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {brands.find((b) => b.id === m.brandId)?.name ?? ""} {m.name}
            </option>
          ))}
        </select>
      </div>

      {/* Giá + tình trạng */}
      <div className="grid gap-4 sm:grid-cols-2">
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
            onChange={(e) => setPrice(Number(e.target.value))}
            required
            defaultValue={edit?.price}
          />
          {price > 0 && (
            <p className="mt-1.5 text-xs text-[var(--muted)]">
              {formatVND(price)} · bạn nhận ≈{" "}
              <b className="text-[var(--green)]">
                {formatVND(price - commission)}
              </b>{" "}
              sau hoa hồng {category?.commissionRate ?? 5}%
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="condition">Tình trạng</label>
          <select
            id="condition"
            name="condition"
            className="input"
            defaultValue={edit?.condition ?? "good"}
          >
            {conditions.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Khu vực */}
      <div>
        <label className="label" htmlFor="city">Khu vực</label>
        <select id="city" name="city" className="input" defaultValue={edit?.city ?? cities[0]}>
          {cities.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Mô tả */}
      <div>
        <label className="label" htmlFor="description">Mô tả chi tiết</label>
        <textarea
          id="description"
          name="description"
          rows={6}
          className="input resize-y"
          placeholder="Nguồn gốc, thời gian sử dụng, tình trạng thực tế, phụ kiện đi kèm, lý do bán…"
          required
          defaultValue={edit?.description}
        />
      </div>

      {/* Toggle */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 transition hover:border-zinc-600">
          <input type="checkbox" name="negotiable" className="size-4 accent-[var(--accent)]" defaultChecked={edit?.negotiable} />
          <span className="text-sm text-[var(--ink-2)]">Mở đón thương lượng giá</span>
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 transition hover:border-zinc-600">
          <input type="checkbox" name="acceptExchange" className="size-4 accent-[var(--violet)]" defaultChecked={edit?.acceptExchange} />
          <span className="text-sm text-[var(--ink-2)]">Sẵn sàng trao đổi + tiền bù</span>
        </label>
      </div>

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}

      <div className="rounded-lg bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink-2)]">
        <p className="flex items-center gap-1.5 font-semibold text-[var(--ink-2)]">
          <Banknote className="size-3.5 text-[var(--accent)]" />
          Hoa hồng {category?.commissionRate ?? 5}% chỉ thu khi giao dịch hoàn tất
        </p>
        <p className="mt-1">
          Ví dụ: bán {formatVND(price || 0)} → bạn nhận {formatVND((price || 0) - commission)}.
          Đăng tin hoàn toàn miễn phí.
        </p>
      </div>

      <button type="submit" disabled={pending} className="btn-primary w-full py-3 text-base">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {edit ? "Lưu thay đổi" : "Gửi tin để chờ duyệt"}
      </button>
    </form>
  );
}
