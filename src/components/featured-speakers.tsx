import Image from "next/image";
import Link from "next/link";

/**
 * Mẫu loa nổi bật — showcase sản phẩm tham khảo trên trang chủ, nhóm theo thương hiệu.
 *
 * Nguyên tắc (đừng vi phạm):
 * - Ảnh minh họa AI, không phải ảnh thật sản phẩm.
 * - Thông số tham khảo từ nhà sản xuất, không phải do shop tự đo.
 * - KHÔNG phải tin rao bán: không giá, không tồn kho, không khuyến mại.
 * - Server component thuần: không "use client", không carousel, không JS scroll,
 *   không animation — chỉ CSS grid tĩnh để giữ FPS cao.
 */

export type FeaturedSpeaker = {
  /** Dòng loa / kiểu dáng */
  type: string;
  model: string;
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

export type FeaturedBrand = {
  brand: string;
  /** slug dùng làm id cho heading ngữ nghĩa (semantic heading) */
  slug: string;
  speakers: FeaturedSpeaker[];
};

/** Thứ tự thương hiệu cố định: JBL, Harman Kardon, Bose, Sony, Marshall, Klipsch, Yamaha, Electro-Voice */
export const FEATURED_BRANDS: FeaturedBrand[] = [
  {
    brand: "JBL",
    slug: "jbl",
    speakers: [
      {
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
        model: "Charge 6",
        type: "Loa Bluetooth di động",
        specs: [
          "30 W woofer + 15 W tweeter RMS",
          "Pin tối đa 28 giờ",
          "IP68 chống nước & bụi",
          "Powerbank sạc ngược USB-C",
        ],
        query: "JBL Charge 6",
        image: {
          src: "/img/featured/jbl-charge-6-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa JBL Charge 6",
        sourceUrl: "https://www.jbl.com/CHARGE-6.html",
        sourceLabel: "jbl.com",
      },
      {
        model: "PartyBox Stage 320",
        type: "Loa party di động có bánh xe",
        specs: [
          "240 W RMS (IEC60268)",
          "2 × woofer 6,5 inch + 2 × tweeter 25 mm",
          "Pin tối đa 18 giờ",
          "IPX4 chống bắn nước",
        ],
        query: "PartyBox Stage 320",
        image: {
          src: "/img/featured/jbl-partybox-stage-320-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa JBL PartyBox Stage 320",
        sourceUrl: "https://www.jbl.com/PARTYBOX-STAGE-320.html",
        sourceLabel: "jbl.com",
      },
    ],
  },
  {
    brand: "Harman Kardon",
    slug: "harman-kardon",
    speakers: [
      {
        model: "Go + Play 3",
        type: "Loa Bluetooth di động",
        specs: [
          "160 W RMS",
          "43 Hz–20 kHz (−6 dB)",
          "Pin tối đa 8 giờ",
          "4,7 kg",
        ],
        query: "Go + Play 3",
        image: {
          src: "/img/featured/harman-kardon-go-play-3-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Harman Kardon Go + Play 3",
        sourceUrl:
          "https://www.harmankardon.com/on/demandware.static/-/Sites-masterCatalog_Harman/default/dw2b4318bf/pdfs/HK%20Go%2BPlay%203_Spec%20Sheet_EN.pdf",
        sourceLabel: "harmankardon.com",
      },
      {
        model: "Aura Studio 4",
        type: "Loa Bluetooth để bàn vòm trong suốt",
        specs: [
          "2 × 15 W + 1 × 100 W RMS",
          "45 Hz–20 kHz (−6 dB)",
          "Bluetooth 4.2",
          "3,6 kg",
        ],
        query: "Aura Studio 4",
        image: {
          src: "/img/featured/harman-kardon-aura-studio-4-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Harman Kardon Aura Studio 4",
        sourceUrl: "https://www.harmankardon.com/AURASTUDIO4.html",
        sourceLabel: "harmankardon.com",
      },
      {
        model: "Onyx Studio 9",
        type: "Loa Bluetooth di động để bàn",
        specs: [
          "50 W RMS",
          "Woofer 120 mm + 3 × tweeter 20 mm",
          "Pin tối đa 8 giờ",
          "Bluetooth 5.3",
        ],
        query: "Onyx Studio 9",
        image: {
          src: "/img/featured/harman-kardon-onyx-studio-9-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Harman Kardon Onyx Studio 9",
        sourceUrl: "https://www.harmankardon.com/ONYX-STUDIO-9.html",
        sourceLabel: "harmankardon.com",
      },
    ],
  },
  {
    brand: "Bose",
    slug: "bose",
    speakers: [
      {
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
      {
        model: "SoundLink Max",
        type: "Loa Bluetooth di động",
        specs: [
          "Pin tối đa 20 giờ",
          "IP67 chống nước & bụi",
          "Bluetooth 5.3 (aptX Adaptive)",
          "USB-C sạc ngược điện thoại",
        ],
        query: "SoundLink Max",
        image: {
          src: "/img/featured/bose-soundlink-max-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Bose SoundLink Max",
        sourceUrl:
          "https://www.bose.com/p/speakers/bose-soundlink-max-portable-speaker/SLMAX-SPEAKERWIRELESS.html",
        sourceLabel: "bose.com",
      },
      {
        model: "SoundLink Revolve+ II",
        type: "Loa Bluetooth 360° di động",
        specs: [
          "Pin tối đa 17 giờ",
          "IP55 chống nước & bụi",
          "Bluetooth 4.2",
          "Phát âm true 360°",
        ],
        query: "SoundLink Revolve+ II",
        image: {
          src: "/img/featured/bose-soundlink-revolve-plus-ii-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Bose SoundLink Revolve+ II",
        sourceUrl: "https://support.bose.com/article/soundlink-revolve-plus-ii-specifications",
        sourceLabel: "support.bose.com",
      },
    ],
  },
  {
    brand: "Sony",
    slug: "sony",
    speakers: [
      {
        model: "SRS-XV800",
        type: "Loa party di động",
        specs: [
          "Pin tối đa 25 giờ",
          "Bluetooth 5.2",
          "IPX4 đặt dọc / IPX2 đặt ngang",
          "Khoảng 18,5 kg",
        ],
        query: "SRS-XV800",
        image: {
          src: "/img/featured/sony-srs-xv800-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Sony SRS-XV800",
        sourceUrl:
          "https://www.sony.com/electronics/support/speakers-wireless-speakers/srs-xv800/specifications",
        sourceLabel: "sony.com",
      },
      {
        model: "ULT FIELD 7",
        type: "Loa party di động ULT POWER SOUND",
        specs: [
          "Pin tối đa 30 giờ",
          "IP67 chống nước & bụi",
          "Nút ULT tăng trầm bass",
          "Khoảng 6,3 kg",
        ],
        query: "ULT FIELD 7",
        image: {
          src: "/img/featured/sony-ult-field-7-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Sony ULT FIELD 7",
        sourceUrl:
          "https://www.sony.com/electronics/support/speakers-wireless-speakers/srs-ult70/specifications",
        sourceLabel: "sony.com",
      },
    ],
  },
  {
    brand: "Marshall",
    slug: "marshall",
    speakers: [
      {
        model: "Stanmore III",
        type: "Loa Bluetooth để bàn",
        specs: [
          "80 W Class D (50 W + 2 × 15 W)",
          "45 Hz–20 kHz",
          "Max SPL 97 dB @ 1 m",
          "Bluetooth 5.2",
        ],
        query: "Stanmore III",
        image: {
          src: "/img/featured/marshall-stanmore-iii-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Marshall Stanmore III",
        sourceUrl:
          "https://www.marshall.com/gb/en/product/stanmore-iii?color=black&pid=1006013",
        sourceLabel: "marshall.com",
      },
      {
        model: "Woburn III",
        type: "Loa Bluetooth để bàn lớn",
        specs: [
          "90 W woofer + 2 × 15 W mid + 2 × 15 W tweeter Class D",
          "35 Hz–20 kHz",
          "Max SPL 100,5 dB @ 1 m",
          "Bluetooth 5.2 (sẵn sàng LE Audio)",
        ],
        query: "Woburn III",
        image: {
          src: "/img/featured/marshall-woburn-iii-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Marshall Woburn III",
        sourceUrl: "https://www.marshall.com/gb/en/product/woburn-iii",
        sourceLabel: "marshall.com",
      },
    ],
  },
  {
    brand: "Klipsch",
    slug: "klipsch",
    speakers: [
      {
        model: "The Three Plus",
        type: "Loa Bluetooth tabletop cao cấp",
        specs: [
          "120 W",
          "45 Hz–20 kHz",
          "Max acoustic output 106 dB",
          "Bluetooth 5.3",
        ],
        query: "The Three Plus",
        image: {
          src: "/img/featured/klipsch-the-three-plus-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Klipsch The Three Plus",
        sourceUrl: "https://assets.klipsch.com/product-specsheets/Klipsch-The_Three_Plus-Spec_Sheet.pdf",
        sourceLabel: "klipsch.com",
      },
      {
        model: "The One Plus",
        type: "Loa Bluetooth tabletop nhỏ",
        specs: [
          "60 W RMS hệ 2.1 bi-amp",
          "2 × full-range 2,25 inch + woofer 4,5 inch",
          "55 Hz–20 kHz",
          "Bluetooth 5.3",
        ],
        query: "The One Plus",
        image: {
          src: "/img/featured/klipsch-the-one-plus-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Klipsch The One Plus",
        sourceUrl: "https://www.klipsch.com/products/the-one-plus",
        sourceLabel: "klipsch.com",
      },
    ],
  },
  {
    brand: "Yamaha",
    slug: "yamaha",
    speakers: [
      {
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
        model: "STAGEPAS 200BTR",
        type: "Hệ PA di động có mixer + pin",
        specs: [
          "180 W dynamic Class-D (150 W LF + 30 W HF)",
          "Max SPL 125 dB",
          "60 Hz–20 kHz (−10 dB)",
          "Pin lithium tối đa 10 giờ",
        ],
        query: "STAGEPAS 200",
        image: {
          src: "/img/featured/yamaha-stagepas-200btr-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Yamaha STAGEPAS 200BTR",
        sourceUrl:
          "https://usa.yamaha.com/products/proaudio/pa_systems/stagepas_200/specs.html",
        sourceLabel: "usa.yamaha.com",
      },
    ],
  },
  {
    brand: "Electro-Voice",
    slug: "electro-voice",
    speakers: [
      {
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
        model: "EVERSE 8",
        type: "Loa PA pin di động thời tiết",
        specs: [
          "400 W",
          "Max SPL 121 dB",
          "50 Hz–20 kHz (−10 dB)",
          "Pin 86,4 Wh — 12+ giờ @ 95 dB SPL",
        ],
        query: "EVERSE 8",
        image: {
          src: "/img/featured/ev-everse-8-ai.webp",
          width: 1000,
          height: 750,
        },
        alt: "Ảnh minh họa AI của loa Electro-Voice EVERSE 8",
        sourceUrl: "https://www.electrovoice.com/product/everse-8",
        sourceLabel: "electrovoice.com",
      },
    ],
  },
];

/** Danh sách phẳng (kèm brand) — tiện dùng cho test và các nơi cần duyệt toàn bộ */
export const FEATURED_SPEAKERS: Array<FeaturedSpeaker & { brand: string }> =
  FEATURED_BRANDS.flatMap((g) => g.speakers.map((s) => ({ ...s, brand: g.brand })));

export function FeaturedSpeakersSection() {
  return (
    <section
      aria-labelledby="featured-speakers-heading"
      className="border-b border-[var(--line)] py-10"
    >
      <div className="mb-6">
        <h2 id="featured-speakers-heading" className="text-[17px] font-extrabold tracking-tight">
          Mẫu loa nổi bật
        </h2>
        <p className="mt-0.5 text-[12px] text-[var(--muted)]">
          Ảnh minh họa AI, không phải ảnh thật · thông số tham khảo từ nhà sản xuất ·
          không phải tin rao bán — không giá, không tồn kho, không khuyến mại
        </p>
      </div>

      <div className="space-y-8">
        {FEATURED_BRANDS.map((group) => (
          <section
            key={group.slug}
            aria-labelledby={`featured-brand-${group.slug}`}
            className="border-t border-[var(--line)]/60 pt-5 first:border-t-0 first:pt-0"
          >
            <h3
              id={`featured-brand-${group.slug}`}
              className="mb-3 text-[13px] font-bold uppercase tracking-wider text-[var(--muted)]"
            >
              {group.brand}
              <span className="ml-2 font-medium normal-case tracking-normal text-[var(--muted)]/70">
                {group.speakers.length} mẫu
              </span>
            </h3>

            {/* Grid tĩnh: 2 cột trên mobile, 3 cột trên desktop — không JS, không carousel */}
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {group.speakers.map((s) => (
                <li key={s.model}>
                  <article className="card flex h-full flex-col overflow-hidden">
                    {/* Ảnh minh họa — tỉ lệ 4:3, width/height khai báo đúng để tránh layout shift */}
                    <div className="relative aspect-[4/3] bg-[var(--paper-deep)]">
                      <Image
                        src={s.image.src}
                        alt={s.alt}
                        width={s.image.width}
                        height={s.image.height}
                        sizes="(min-width: 1024px) 33vw, 50vw"
                        loading="lazy"
                        className="size-full object-cover"
                      />
                      <span className="badge absolute left-1.5 top-1.5 bg-white text-[var(--muted)]">
                        Ảnh minh họa AI
                      </span>
                    </div>

                    <div className="flex flex-1 flex-col gap-1 p-3">
                      <h4 className="text-[14px] font-bold leading-snug text-[var(--ink)]">
                        {s.model}
                      </h4>
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
        ))}
      </div>
    </section>
  );
}
