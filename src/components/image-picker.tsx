"use client";

import { Fragment, useRef, useState } from "react";
import { LoaderCircle, ImagePlus, X } from "lucide-react";
import { cn } from "@/src/lib/utils";

export function ImagePicker({
  name = "images",
  max = 8,
  initialUrls = [],
  slotName,
  slotValue,
}: {
  name?: string;
  max?: number;
  initialUrls?: string[];
  /**
   * Batch 4 Task 5 — slot-aware variant: khi có slotName, MỖI ảnh post kèm một
   * hidden input song song (giá trị slotValue hoặc "" = không gán slot) để
   * formData.getAll("images") zip theo index với getAll(slotName) — action
   * đọc hai mảng song song (imageSlots lệch độ dài → IMAGE_SLOT_MISMATCH).
   */
  slotName?: string;
  /** Giá trị slot gắn cho MỌI ảnh của picker này (null/"" = không gán slot). */
  slotValue?: string | null;
}) {
  const [urls, setUrls] = useState<string[]>(initialUrls);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (urls.length + files.length > max) {
      setError(`Tối đa ${max} ảnh`);
      return;
    }

    setUploading(true);
    const uploaded: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = (await res.json()) as { url?: string; error?: string };
      if (json.url) uploaded.push(json.url);
      else setError(json.error ?? "Upload thất bại");
    }
    setUrls((prev) => [...prev, ...uploaded]);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function remove(url: string) {
    setUrls((prev) => prev.filter((u) => u !== url));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {urls.map((url) => (
          <div key={url} className="group relative size-24 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-deep)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="size-full object-cover" />
            <button
              type="button"
              onClick={() => remove(url)}
              className="absolute inset-0 grid place-items-center bg-[var(--ink)]/60 opacity-0 transition group-hover:opacity-100"
            >
              <X className="size-5 text-[var(--red)]" />
            </button>
          </div>
        ))}

        {urls.length < max && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className={cn(
              "grid size-24 place-items-center gap-1 rounded-lg border-2 border-dashed border-[var(--line)] text-[var(--muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--accent)]",
              uploading && "opacity-50",
            )}
          >
            {uploading ? (
              <LoaderCircle className="size-5 animate-spin" />
            ) : (
              <>
                <ImagePlus className="size-5" />
                <span className="text-[10px] font-medium">Thêm ảnh</span>
              </>
            )}
          </button>
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
      {urls.map((u) => (
        <Fragment key={u}>
          <input type="hidden" name={name} value={u} />
          {slotName !== undefined && (
            <input type="hidden" name={slotName} value={slotValue ?? ""} />
          )}
        </Fragment>
      ))}
      {error && <p className="mt-2 text-xs text-[var(--red)]">{error}</p>}
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        {urls.length}/{max} ảnh · JPEG/PNG/WebP tối đa 5MB
      </p>
    </div>
  );
}
