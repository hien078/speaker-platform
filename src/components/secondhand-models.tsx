import Image from "next/image";
import Link from "next/link";

/**
 * Gợi ý mẫu loa secondhand đáng tìm — section tham khảo trên trang chủ.
 *
 * Nguyên tắc trung thực (đừng vi phạm):
 * - Đây là GỢI Ý mẫu loa đáng tìm trên thị trường secondhand, KHÔNG phải tin đang bán:
 *   không giá, không tồn kho, không tình trạng hàng, không thông số kỹ thuật.
 * - Ảnh là ảnh tham khảo mẫu loa, không đại diện hàng shop đang có.
 * - Link dẫn về tìm kiếm nội bộ /listings?q=… — người mua tự xem tin thật.
 * - Server component thuần: không "use client", không carousel, không animation,
 *   không backdrop-filter — chỉ CSS grid tĩnh để giữ FPS cao.
 */

export type SecondhandModel = {
  brand: string;
  model: string;
  /** Nhãn dòng loa / kiểu dáng — nhãn phân loại, không phải thông số kỹ thuật */
  category: string;
  /** Chuỗi tìm kiếm trên chợ (q=) */
  query: string;
  image: {
    src: string;
    width: number;
    height: number;
  };
  /** Alt mô tả ảnh tham khảo, nêu rõ thương hiệu + model */
  alt: string;
};

/** 8 mẫu loa secondhand đáng tìm — dữ liệu bất biến, thứ tự cố định */
export const SECONDHAND_MODELS = [
  {
    brand: "Bose",
    model: "Home Speaker 500",
    category: "Loa thông minh để bàn",
    query: "Bose Home Speaker 500",
    image: {
      src: "/img/secondhand-models/bose-home-500.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Bose Home Speaker 500 — loa thông minh để bàn",
  },
  {
    brand: "Bose",
    model: "S1 Pro",
    category: "Loa PA di động",
    query: "Bose S1 Pro",
    image: {
      src: "/img/secondhand-models/bose-s1-pro.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Bose S1 Pro — loa PA di động",
  },
  {
    brand: "Bose",
    model: "SoundLink Flex",
    category: "Loa Bluetooth di động",
    query: "Bose SoundLink Flex",
    image: {
      src: "/img/secondhand-models/bose-soundlink-flex.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Bose SoundLink Flex — loa Bluetooth di động",
  },
  {
    brand: "Harman Kardon",
    model: "Invoke",
    category: "Loa thông minh để bàn",
    query: "Harman Kardon Invoke",
    image: {
      src: "/img/secondhand-models/hk-invoke.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Harman Kardon Invoke — loa thông minh để bàn",
  },
  {
    brand: "JBL",
    model: "Charge 4",
    category: "Loa Bluetooth di động",
    query: "JBL Charge 4",
    image: {
      src: "/img/secondhand-models/jbl-charge-4.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa JBL Charge 4 — loa Bluetooth di động",
  },
  {
    brand: "Marshall",
    model: "Acton",
    category: "Loa Bluetooth để bàn",
    query: "Marshall Acton",
    image: {
      src: "/img/secondhand-models/marshall-acton.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Marshall Acton — loa Bluetooth để bàn",
  },
  {
    brand: "Sony",
    model: "SRS-XB2",
    category: "Loa Bluetooth di động",
    query: "Sony SRS-XB2",
    image: {
      src: "/img/secondhand-models/sony-srs-xb2.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Sony SRS-XB2 — loa Bluetooth di động",
  },
  {
    brand: "Yamaha",
    model: "NS-10M",
    category: "Loa monitor studio",
    query: "Yamaha NS-10M",
    image: {
      src: "/img/secondhand-models/yamaha-ns10m.webp",
      width: 960,
      height: 720,
    },
    alt: "Ảnh tham khảo loa Yamaha NS-10M — loa monitor studio",
  },
] as const satisfies readonly SecondhandModel[];

export function SecondhandModelsSection() {
  return (
    <section
      aria-labelledby="secondhand-models-heading"
      className="border-b border-[var(--line)] py-10"
    >
      <div className="mb-6">
        <h2 id="secondhand-models-heading" className="text-[17px] font-extrabold tracking-tight">
          Gợi ý mẫu loa secondhand đáng tìm
        </h2>
        <p className="mt-0.5 text-[12px] text-[var(--muted)]">
          Gợi ý mẫu loa đáng tìm trên thị trường secondhand · ảnh tham khảo, không phải tin đang
          bán · không giá, không tồn kho, không tình trạng hàng — tự kiểm tra với người bán thật
        </p>
      </div>

      {/* Grid tĩnh: 2 cột mobile, 3 cột sm, 4 cột desktop — không JS, không carousel */}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {SECONDHAND_MODELS.map((m) => (
          <li key={m.model}>
            <article className="card flex h-full flex-col overflow-hidden">
              {/* Ảnh tham khảo — contain 4:3, width/height khai báo đúng để tránh layout shift */}
              <div className="relative aspect-[4/3] bg-[var(--paper-deep)]">
                <Image
                  src={m.image.src}
                  alt={m.alt}
                  width={m.image.width}
                  height={m.image.height}
                  sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
                  loading="lazy"
                  className="size-full object-contain"
                />
              </div>

              <div className="flex flex-1 flex-col gap-1 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
                  {m.brand}
                </p>
                <h3 className="text-[14px] font-bold leading-snug text-[var(--ink)]">
                  {m.model}
                </h3>
                <p className="text-[12px] text-[var(--ink-2)]">{m.category}</p>

                <div className="mt-auto border-t border-[var(--line)]/70 pt-2.5">
                  <Link
                    href={`/listings?q=${encodeURIComponent(m.query)}`}
                    className="block text-[12.5px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    Tìm tin bán model này →
                  </Link>
                </div>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
