import Image from "next/image";
import Link from "next/link";

/**
 * Mẫu loa nổi bật — showcase sản phẩm tham khảo trên trang chủ.
 *
 * Nguyên tắc (đừng vi phạm):
 * - Ảnh minh họa AI, không phải ảnh thật sản phẩm.
 * - Thông số tham khảo từ nhà sản xuất, không phải do shop tự đo.
 * - KHÔNG phải tin rao bán: không giá, không tồn kho, không khuyến mại.
 */

export type FeaturedSpeaker = {
  brand: string;
  model: string;
  /** Dòng loa / kiểu dáng */
  type: string;
  /** 3–4 thông số chính, tham khảo từ nhà sản xuất */
  specs: string[];
  /** Chuỗi tìm kiếm trên chợ (q=) */
  query: string;
  image: {
    src: string;
    width: number;
    height: number;
  };
  /** Alt nói rõ đây là ảnh minh họa AI */
  alt: string;
  /** Trang thông số chính hãng */
  sourceUrl: string;
  /** Tên miền hiển thị cạnh link nguồn */
  sourceLabel: string;
};

export const FEATURED_SPEAKERS: FeaturedSpeaker[] = [
  {
    brand: "JBL",
    model: "EON715",
    type: "Loa PA active 15 inch",
    specs: [
      "1300 W peak / 650 W RMS",
      "Max SPL 128 dB",
      "45 Hz–20 kHz (−10 dB)",
      "16,9 kg",
    ],
    query: "EON715",
    image: {
      src: "/img/featured/jbl-eon715-ai.webp",
      width: 1000,
      height: 750,
    },
    alt: "Ảnh minh họa AI của loa JBL EON715",
    sourceUrl: "https://jblpro.com/en-US/products/jbl-eon715",
    sourceLabel: "jblpro.com",
  },
  {
    brand: "Yamaha",
    model: "DBR12",
    type: "Loa PA active 12 inch",
    specs: [
      "1000 W dynamic / 465 W continuous",
      "Max SPL 131 dB",
      "52 Hz–20 kHz (−10 dB)",
      "15,8 kg",
    ],
    query: "DBR12",
    image: {
      src: "/img/featured/yamaha-dbr12-ai.webp",
      width: 1000,
      height: 750,
    },
    alt: "Ảnh minh họa AI của loa Yamaha DBR12",
    sourceUrl: "https://usa.yamaha.com/products/proaudio/speakers/dbr/specs.html",
    sourceLabel: "usa.yamaha.com",
  },
  {
    brand: "Electro-Voice",
    model: "ZLX-12P G2",
    type: "Loa PA active 12 inch",
    specs: [
      "1000 W",
      "Max SPL 127 dB",
      "48 Hz–20 kHz (−10 dB)",
      "Phủ âm 90° × 60°",
    ],
    query: "ZLX-12P",
    image: {
      src: "/img/featured/ev-zlx12p-g2-ai.webp",
      width: 1000,
      height: 750,
    },
    alt: "Ảnh minh họa AI của loa Electro-Voice ZLX-12P G2",
    sourceUrl: "https://products.electrovoice.com/emea/en/zlx-g2-powered-loudspeaker",
    sourceLabel: "products.electrovoice.com",
  },
  {
    brand: "Bose",
    model: "S1 Pro+",
    type: "PA di động",
    specs: [
      "Mixer 3 kênh",
      "Pin tối đa 11 giờ",
      "Bluetooth 5.0",
      "6,5 kg",
    ],
    query: "S1 Pro+",
    image: {
      src: "/img/featured/bose-s1-pro-plus-ai.webp",
      width: 1000,
      height: 750,
    },
    alt: "Ảnh minh họa AI của loa Bose S1 Pro+",
    sourceUrl:
      "https://www.bose.com/p/portable-pa/s1-pro-wireless-pa-system/S1PROP-SPEAKERWIRELESS.html",
    sourceLabel: "bose.com",
  },
];

export function FeaturedSpeakersSection() {
  return (
    <section aria-labelledby="featured-speakers-heading" className="border-b border-[var(--line)] py-10">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h2 id="featured-speakers-heading" className="text-[17px] font-extrabold tracking-tight">
            Mẫu loa nổi bật
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--muted)]">
            Ảnh minh họa AI · thông số tham khảo từ nhà sản xuất · không phải tin rao bán
          </p>
        </div>
      </div>

      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {FEATURED_SPEAKERS.map((s) => (
          <li key={s.model}>
            <article className="card card-hover group flex h-full flex-col overflow-hidden">
              {/* Ảnh minh họa — tỉ lệ 4:3 khớp thẻ tin đăng */}
              <div className="relative aspect-[4/3] bg-[var(--paper-deep)]">
                <Image
                  src={s.image.src}
                  alt={s.alt}
                  width={s.image.width}
                  height={s.image.height}
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  className="size-full object-cover"
                />
                <span className="badge absolute left-1.5 top-1.5 bg-white text-[var(--muted)]">
                  Ảnh minh họa AI
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-1 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
                  {s.brand}
                </p>
                <h3 className="text-[14px] font-bold leading-snug text-[var(--ink)]">
                  {s.model}
                </h3>
                <p className="text-[12px] text-[var(--ink-2)]">{s.type}</p>

                <ul className="mt-1.5 space-y-1 text-[12px] leading-snug text-[var(--ink-2)]">
                  {s.specs.map((spec) => (
                    <li key={spec} className="flex gap-1.5">
                      <span aria-hidden="true" className="text-[var(--muted)]">·</span>
                      <span>{spec}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-auto space-y-1 border-t border-[var(--line)]/70 pt-2.5">
                  <Link
                    href={`/listings?q=${encodeURIComponent(s.query)}`}
                    className="block text-[12.5px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    Tìm tin tương tự →
                  </Link>
                  <a
                    href={s.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[11px] text-[var(--muted)] hover:text-[var(--ink-2)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--muted)]"
                  >
                    Nguồn thông số: {s.sourceLabel} ↗
                  </a>
                </div>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
