"use client";

import { useRef, useState } from "react";
import { LoaderCircle, ImagePlus, X } from "lucide-react";
import { cn } from "@/src/lib/utils";

export function ImagePicker({
  name = "images",
  max = 8,
  initialUrls = [],
}: {
  name?: string;
  max?: number;
  initialUrls?: string[];
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
          <div key={url} className="group relative size-24 overflow-hidden rounded-lg border border-[var(--border)] bg-zinc-900">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="size-full object-cover" />
            <button
              type="button"
              onClick={() => remove(url)}
              className="absolute inset-0 grid place-items-center bg-black/60 opacity-0 transition group-hover:opacity-100"
            >
              <X className="size-5 text-red-400" />
            </button>
          </div>
        ))}

        {urls.length < max && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className={cn(
              "grid size-24 place-items-center gap-1 rounded-lg border-2 border-dashed border-[var(--border)] text-zinc-500 transition hover:border-amber-500/50 hover:text-amber-400",
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
        <input key={u} type="hidden" name={name} value={u} />
      ))}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <p className="mt-2 text-[11px] text-zinc-500">
        {urls.length}/{max} ảnh · JPEG/PNG/WebP tối đa 5MB
      </p>
    </div>
  );
}
