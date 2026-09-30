"use client";

import { useState } from "react";
import { cn } from "@/src/lib/utils";

export function ListingGallery({ images, title }: { images: { url: string }[]; title: string }) {
  const [active, setActive] = useState(0);
  const current = images[active];

  if (!current) {
    return (
      <div className="card grid aspect-[4/3] place-items-center text-6xl text-zinc-700">🔇</div>
    );
  }

  return (
    <div>
      <div className="card relative aspect-[4/3] overflow-hidden bg-zinc-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={current.url} alt={title} className="size-full object-contain" />
      </div>

      {images.length > 1 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {images.map((img, i) => (
            <button
              key={img.url + i}
              onClick={() => setActive(i)}
              className={cn(
                "relative size-20 shrink-0 overflow-hidden rounded-lg border-2 bg-zinc-900 transition",
                i === active
                  ? "border-amber-500"
                  : "border-[var(--border)] opacity-60 hover:opacity-100",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={`${title} ${i + 1}`} className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
