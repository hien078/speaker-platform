/**
 * reencodeImage — server-side re-encode pipeline (Batch 4 Task 3, spec §5.6.4/§7.5).
 *
 * Hợp đồng (plan Task 3):
 *  - output LUÔN là WebP đã strip TOÀN BỘ metadata (EXIF/GPS) — JPEG mang
 *    GPS IFD re-encode xong không còn exif, không còn marker "Exif" nào
 *    trong buffer (Review Focus 1 — §4.7/§4.8 privacy pin).
 *  - auto-orient THEO EXIF áp dụng TRƯỚC khi strip (Orientation 6 → đổi chiều).
 *  - polyglot (GIF header + payload HTML) → pixels sạch, payload biến mất.
 *  - decompression bomb cap 50MP/12k px (siết từ 40MP/10k): 50MP 4:3 qua,
 *    51MP → DECODE_FAILED (fail closed).
 *  - resize bound ≤2560px — output thường WELL UNDER IMAGE_OUTPUT_MAX_BYTES;
 *    OUTPUT_TOO_LARGE chỉ cho output bệnh thái (noise không nén được).
 *  - decode fail (PNG cắt cụt) → DECODE_FAILED, không có output.
 *  - GIF → static WebP frame đầu (pages: 1).
 *
 * Review fix (M1 — decode memory bound):
 *  - SEMAPHORE process-wide quanh reencodeImage: 1 concurrent, xếp hàng chờ
 *    bounded → TOO_BUSY; release đánh thức waiter FIFO.
 *  - PIXEL CAP THEO ĐỊNH DẠNG (metadata TRƯỚC decode): JPEG 50MP giữ nguyên;
 *    PNG/GIF/WebP 8-bit 24MP; interlaced (isProgressive) / depth > 8 bit 12MP.
 *  - multi-frame GIF/WebP → CHỈ frame đầu được giữ (frame 2 không leak).
 *  - ICC/XMP cũng bị strip (không chỉ EXIF/GPS).
 */
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import {
  IMAGE_HEAVY_DECODE_MAX_PIXELS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIM,
  IMAGE_MAX_PIXELS,
  IMAGE_NON_JPEG_MAX_PIXELS,
  IMAGE_OUTPUT_MAX_BYTES,
  IMAGE_RESIZE_MAX,
  REENCODE_MAX_CONCURRENT,
  REENCODE_QUEUE_TIMEOUT_MS,
  acquireReencodeSlot,
  reencodeImage,
  releaseReencodeSlot,
} from "../../src/lib/image-process";

async function solidPng(width: number, height: number, color = "#336699"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

/**
 * JPEG mang EXIF GPS IFD THẬT. sharp 0.35 withExif chỉ ghi IFD0-3 (khóa
 * "GPS" bị bỏ rơi im lặng — đã kiểm chứng thực nghiệm), nên dựng APP1 Exif
 * segment bằng tay: TIFF little-endian, IFD0 1 entry GPS-IFD-pointer (0x8825)
 * → GPS IFD 2 entry GPSLatitudeRef "N" + GPSLatitude 21/1,1/1,1/1, chèn sau
 * SOI. Input này MANG GPS thật — đúng thứ re-encode phải strip (§4.7/§4.8).
 */
function jpegWithGpsExif(jpeg: Buffer): Buffer {
  const IFD0_OFF = 8;
  const IFD0_SIZE = 2 + 12 + 4; // count + 1 entry + next-IFD
  const GPS_OFF = IFD0_OFF + IFD0_SIZE; // 26
  const GPS_SIZE = 2 + 24 + 4; // count + 2 entries + next-IFD
  const RAT_OFF = GPS_OFF + GPS_SIZE; // 56 — 3 rationals × 8 bytes

  const tiff = Buffer.alloc(RAT_OFF + 24);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(IFD0_OFF, 4);
  // IFD0 — entry GPSInfo (0x8825), LONG, trỏ tới GPS IFD
  tiff.writeUInt16LE(1, IFD0_OFF);
  tiff.writeUInt16LE(0x8825, IFD0_OFF + 2);
  tiff.writeUInt16LE(4, IFD0_OFF + 4);
  tiff.writeUInt32LE(1, IFD0_OFF + 6);
  tiff.writeUInt32LE(GPS_OFF, IFD0_OFF + 10);
  tiff.writeUInt32LE(0, IFD0_OFF + 14);
  // GPS IFD — GPSLatitudeRef (ASCII inline "N\0") + GPSLatitude (RATIONAL ×3)
  tiff.writeUInt16LE(2, GPS_OFF);
  tiff.writeUInt16LE(0x1, GPS_OFF + 2);
  tiff.writeUInt16LE(2, GPS_OFF + 4);
  tiff.writeUInt32LE(2, GPS_OFF + 6);
  tiff.write("N\0", GPS_OFF + 10, "ascii");
  tiff.writeUInt16LE(0x2, GPS_OFF + 14);
  tiff.writeUInt16LE(5, GPS_OFF + 16);
  tiff.writeUInt32LE(3, GPS_OFF + 18);
  tiff.writeUInt32LE(RAT_OFF, GPS_OFF + 22);
  tiff.writeUInt32LE(0, GPS_OFF + 26);
  // 21/1, 1/1, 1/1 — 21°1'1"
  tiff.writeUInt32LE(21, RAT_OFF);
  tiff.writeUInt32LE(1, RAT_OFF + 4);
  tiff.writeUInt32LE(1, RAT_OFF + 8);
  tiff.writeUInt32LE(1, RAT_OFF + 12);
  tiff.writeUInt32LE(1, RAT_OFF + 16);
  tiff.writeUInt32LE(1, RAT_OFF + 20);

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** Offset GPS IFD trong buffer EXIF (0 = không có) — parse TIFF nhỏ. */
function gpsIfdOffset(exif: Buffer): number {
  const tiff = exif.subarray(6); // bỏ "Exif\0\0"
  const le = tiff.toString("ascii", 0, 2) === "II";
  const rd16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const rd32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd0 = rd32(4);
  const n = rd16(ifd0);
  for (let i = 0; i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (rd16(e) === 0x8825) return rd32(e + 8);
  }
  return 0;
}

// ─── Helpers cho review fix M1 — 16-bit PNG + animated GIF (hand-crafted) ──────

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

/**
 * PNG 16-bit/channel THEO SPEC (IHDR bit depth 16) — sharp 0.35 không viết được
 * 16-bit output (`.png({ depth: 16 })` bị bỏ im lặng) nên dựng tay: IHDR
 * depth=16 colorType=2, scanline filter 0, sample 16-bit big-endian.
 * metadata() của sharp báo bitsPerSample: 16 / depth: "ushort" cho input này.
 */
function png16Bit(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 6));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 6);
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 6;
      raw.writeUInt16BE(r * 257, p);
      raw.writeUInt16BE(g * 257, p + 2);
      raw.writeUInt16BE(b * 257, p + 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * GIF89a animated N frame (hand-crafted — sharp không tạo được animated GIF từ
 * create): LSD + GCT 4 màu + mỗi frame GCE (delay) + Image Descriptor + LZW
 * "uncompressed" (clear code TRƯỚC MỖI literal — table không lớn lên → code
 * size không bao giờ bump). Frame i vẽ solid bằng palette[colorOfFrame[i]].
 */
function animatedGif(
  w: number,
  h: number,
  frameColorIndexes: number[],
  palette: number[],
): Buffer {
  const minCodeSize = 2; // 4 màu palette
  const codeSize = minCodeSize + 1;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const lzw = (pixels: number[]): Buffer => {
    const all: number[] = [];
    for (const p of pixels) all.push(clear, p); // clear trước MỖI literal
    all.push(eoi);
    // pack LSB-first bằng Number (≤27 bit — an toàn 32-bit, KHÔNG BigInt vì
    // tsconfig target ES2017)
    let acc = 0;
    let nbits = 0;
    const bytes: number[] = [];
    for (const c of all) {
      acc |= c << nbits;
      nbits += codeSize;
      while (nbits >= 8) {
        bytes.push(acc & 0xff);
        acc >>>= 8;
        nbits -= 8;
      }
    }
    if (nbits > 0) bytes.push(acc & 0xff);
    return Buffer.from(bytes);
  };
  const frameData = (pixels: number[]): Buffer => {
    const codes = lzw(pixels);
    const blocks: Buffer[] = [];
    for (let i = 0; i < codes.length; i += 255) {
      blocks.push(
        Buffer.concat([Buffer.from([Math.min(255, codes.length - i)]), codes.subarray(i, i + 255)]),
      );
    }
    return Buffer.concat([...blocks, Buffer.from([0])]);
  };
  const parts: Buffer[] = [Buffer.from("GIF89a", "ascii")];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80 | (Math.log2(palette.length / 3) - 1); // GCT flag + size
  parts.push(lsd);
  parts.push(Buffer.from(palette));
  for (const color of frameColorIndexes) {
    // GCE: introducer 0x21, label 0xF9, block size 4, packed, delay LE16, trans idx, 0x00
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]));
    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(0, 1);
    id.writeUInt16LE(0, 3);
    id.writeUInt16LE(w, 5);
    id.writeUInt16LE(h, 7);
    parts.push(id);
    parts.push(Buffer.from([minCodeSize]));
    parts.push(frameData(Array.from({ length: w * h }, () => color)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

describe("reencodeImage — constants (caps Batch 4)", () => {
  it("caps: 5MB encoded + output, 50MP pixel, 12k px dim, resize 2560", () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(IMAGE_OUTPUT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(IMAGE_MAX_PIXELS).toBe(50_000_000);
    expect(IMAGE_MAX_DIM).toBe(12_000);
    expect(IMAGE_RESIZE_MAX).toEqual({ width: 2560, height: 2560 });
  });
});

describe("reencodeImage — strip metadata (Review Focus 1)", () => {
  it("re-encode strips GPS/EXIF from a JPEG carrying a GPS IFD", async () => {
    const plain = await sharp({ create: { width: 60, height: 40, channels: 3, background: "#123456" } })
      .jpeg()
      .toBuffer();
    const input = jpegWithGpsExif(plain);
    // precondition — input THẬT SỰ mang EXIF với GPS IFD (GPSLatitudeRef + GPSLatitude)
    const inMeta = await sharp(input).metadata();
    expect(inMeta.format).toBe("jpeg");
    expect(inMeta.exif).toBeDefined();
    const gpsOff = gpsIfdOffset(inMeta.exif!);
    expect(gpsOff).toBeGreaterThan(0);

    const out = await reencodeImage(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const outMeta = await sharp(out.buffer).metadata();
    expect(outMeta.format).toBe("webp");
    expect(outMeta.exif).toBeUndefined();
  });

  it("output contains no EXIF marker at all (scan marker bytes)", async () => {
    const input = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#abcdef" } })
      .withExif({ IFD0: { ImageDescription: "LoaViet-Unit-Test" } })
      .jpeg()
      .toBuffer();
    // precondition — input mang EXIF thật (IFD0 ImageDescription)
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeDefined();

    const out = await reencodeImage(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // JPEG APPn marker "Exif\0\0" và WebP chunk "EXIF" — không dạng nào được phép
    expect(out.buffer.includes(Buffer.from("Exif", "ascii"))).toBe(false);
    expect(out.buffer.includes(Buffer.from("EXIF", "ascii"))).toBe(false);
    // giá trị EXIF không sót lại ở bất kỳ đâu trong output
    expect(out.buffer.includes(Buffer.from("LoaViet-Unit-Test", "ascii"))).toBe(false);
  });

  it("auto-orient applies before strip — Orientation 6 re-encodes to swapped dimensions", async () => {
    const input = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#ff0000" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const out = await reencodeImage(input);
    expect(out).toMatchObject({ ok: true, width: 50, height: 100 });
  });

  it("a polyglot file (GIF header + appended HTML comment) re-encodes to clean pixels", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#00ff00" } })
      .gif()
      .toBuffer();
    const payload = "<script>alert('pwned')</script>";
    const polyglot = Buffer.concat([gif, Buffer.from(payload, "ascii")]);
    const out = await reencodeImage(polyglot);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.buffer.includes(Buffer.from(payload, "ascii"))).toBe(false);
    expect(out.buffer.toString("ascii").includes("alert")).toBe(false);
    // output vẫn là ảnh webp hợp lệ (pixels thật, không phải payload)
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
  });
});

describe("reencodeImage — decompression bomb caps (50MP/12k px)", () => {
  it(
    "a ~50MP 4:3 input (8164×6123) decodes and re-encodes fine — cap admits 48MP phone sensors",
    { timeout: 30_000 },
    async () => {
      // 8164×6123 = 49.988.172 px ≤ 50MP (plan dẫn 8165×6124 nhưng tích đó
      // 50.002.460 px > cap — xem report; giữ nguyên ý "50MP 4:3 qua cap")
      const input = await sharp({ create: { width: 8164, height: 6123, channels: 3, background: "#224466" } })
        .jpeg()
        .toBuffer();
      const out = await reencodeImage(input);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.width).toBeLessThanOrEqual(IMAGE_RESIZE_MAX.width);
      expect(out.height).toBeLessThanOrEqual(IMAGE_RESIZE_MAX.height);
    },
  );

  it(
    "a 51MP input (8500×6000) → DECODE_FAILED — cap enforced (cap cũ 40MP đã chặn 41MP từ trước)",
    { timeout: 30_000 },
    async () => {
      const input = await sharp({ create: { width: 8500, height: 6000, channels: 3, background: "#224466" } })
        .jpeg()
        .toBuffer();
      const out = await reencodeImage(input);
      expect(out).toEqual({ ok: false, reason: "DECODE_FAILED" });
    },
  );
});

describe("reencodeImage — output bounds", () => {
  it("resize bounds the output: a large input encodes to ≤2560px WebP well under IMAGE_OUTPUT_MAX_BYTES", async () => {
    const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const out = await reencodeImage(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.width).toBe(2560);
    expect(out.height).toBe(1920);
    expect(out.buffer.length).toBeLessThan(IMAGE_OUTPUT_MAX_BYTES);
    // "well under" — ảnh xám đặc nén WebP phải nhỏ hơn cả 200KB
    expect(out.buffer.length).toBeLessThan(200_000);
  });

  it(
    "OUTPUT_TOO_LARGE fires for a pathological incompressible output (true-random RGBA noise at the resize bound)",
    { timeout: 60_000 },
    async () => {
      // alpha noise là worst-case cho WebP (alpha được nén lossless) —
      // 2560×2560 RGBA random → output ~11MB > cap 5MB → fail closed
      const raw = randomBytes(2560 * 2560 * 4);
      const input = await sharp(raw, { raw: { width: 2560, height: 2560, channels: 4 } }).png().toBuffer();
      const out = await reencodeImage(input);
      expect(out).toEqual({ ok: false, reason: "OUTPUT_TOO_LARGE" });
    },
  );
});

describe("reencodeImage — fail closed", () => {
  it("decode failure (truncated PNG) → DECODE_FAILED", async () => {
    const full = await solidPng(30, 30, "#0000ff");
    const out = await reencodeImage(full.subarray(0, 20));
    expect(out).toEqual({ ok: false, reason: "DECODE_FAILED" });
  });

  it("empty buffer → DECODE_FAILED", async () => {
    const out = await reencodeImage(Buffer.alloc(0));
    expect(out).toEqual({ ok: false, reason: "DECODE_FAILED" });
  });

  it("GIF input → static WebP first frame (format webp, single page)", async () => {
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    const out = await reencodeImage(gif);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.pages ?? 1).toBe(1);
  });
});

// ─── Review fix M1 — semaphore (decode memory bound, process-wide) ─────────────

describe("reencodeImage — semaphore (M1: 1 concurrent, queue bounded)", () => {
  it("constants pinned: REENCODE_MAX_CONCURRENT 1, queue timeout 15s", () => {
    expect(REENCODE_MAX_CONCURRENT).toBe(1);
    expect(REENCODE_QUEUE_TIMEOUT_MS).toBe(15_000);
  });

  it("acquire → slot giữ; acquire thứ hai hết timeout xếp hàng → reject; release → handoff FIFO", async () => {
    await acquireReencodeSlot(0); // giữ slot duy nhất
    await expect(acquireReencodeSlot(20)).rejects.toThrowError("REENCODE_QUEUE_TIMEOUT");

    // waiter xếp hàng — KHÔNG reject trước khi release
    const queued = acquireReencodeSlot(5_000);
    let settled = false;
    void queued.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // vẫn đang chờ

    releaseReencodeSlot(); // handoff trực tiếp cho waiter (FIFO)
    await expect(queued).resolves.toBeUndefined();
    releaseReencodeSlot(); // waiter trả slot — trạng thái sạch cho test sau
  });

  it("reencodeImage khi slot bị giữ → TOO_BUSY sau queue timeout (bounded wait, không treo)", async () => {
    await acquireReencodeSlot(0); // giữ slot duy nhất
    const input = await solidPng(20, 20, "#336699");
    try {
      const out = await reencodeImage(input, { queueTimeoutMs: 40 });
      expect(out).toEqual({ ok: false, reason: "TOO_BUSY" });
    } finally {
      releaseReencodeSlot();
    }
    // slot trả xong → reencode chạy lại bình thường (không deadlock)
    const out2 = await reencodeImage(input);
    expect(out2.ok).toBe(true);
  });

  it("N reencodeImage song song → serialize qua semaphore, TẤT CẢ thành công (không deadlock)", async () => {
    const inputs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => solidPng(40 + i, 30, "#224466")),
    );
    const outs = await Promise.all(inputs.map((b) => reencodeImage(b)));
    for (const out of outs) expect(out.ok).toBe(true);
  });
});

// ─── Review fix M1 — pixel cap THEO ĐỊNH DẠNG (metadata trước decode) ─────────

describe("reencodeImage — format/depth/interlace pixel caps (M1b)", () => {
  it("constants pinned: non-JPEG 24MP, heavy decode (interlaced/>8bit) 12MP", () => {
    expect(IMAGE_NON_JPEG_MAX_PIXELS).toBe(24_000_000);
    expect(IMAGE_HEAVY_DECODE_MAX_PIXELS).toBe(12_000_000);
  });

  it(
    "PNG 8-bit 28MP (7000×4000) → TOO_MANY_PIXELS (non-JPEG cap 24MP — 50MP tổng KHÔNG đủ)",
    { timeout: 60_000 },
    async () => {
      const input = await sharp({ create: { width: 7000, height: 4000, channels: 3, background: "#224466" } })
        .png()
        .toBuffer();
      const out = await reencodeImage(input);
      expect(out).toEqual({ ok: false, reason: "TOO_MANY_PIXELS" });
    },
  );

  it(
    "PNG 8-bit 20MP (5000×4000) → ok (dưới cap non-JPEG 24MP)",
    { timeout: 60_000 },
    async () => {
      const input = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "#224466" } })
        .png()
        .toBuffer();
      const out = await reencodeImage(input);
      expect(out.ok).toBe(true);
    },
  );

  it(
    "PNG interlaced (Adam7) 16MP → TOO_MANY_PIXELS (heavy cap 12MP)",
    { timeout: 60_000 },
    async () => {
      const input = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "#224466" } })
        .png({ progressive: true })
        .toBuffer();
      // precondition — input THẬT SỰ interlaced
      const meta = await sharp(input).metadata();
      expect(meta.isProgressive).toBe(true);
      const out = await reencodeImage(input);
      expect(out).toEqual({ ok: false, reason: "TOO_MANY_PIXELS" });
    },
  );

  it(
    "PNG interlaced 9MP (3000×3000) → ok (dưới heavy cap — interlaced KHÔNG bị chặn hoàn toàn)",
    { timeout: 60_000 },
    async () => {
      const input = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#224466" } })
        .png({ progressive: true })
        .toBuffer();
      const meta = await sharp(input).metadata();
      expect(meta.isProgressive).toBe(true);
      const out = await reencodeImage(input);
      expect(out.ok).toBe(true);
    },
  );

  it(
    "PNG 16-bit 12.25MP (3500×3500) → TOO_MANY_PIXELS (depth > 8 bit → heavy cap 12MP)",
    { timeout: 60_000 },
    async () => {
      const input = png16Bit(3500, 3500, [34, 68, 102]);
      // precondition — input THẬT SỰ 16-bit
      const meta = await sharp(input).metadata();
      expect(meta.bitsPerSample).toBe(16);
      const out = await reencodeImage(input);
      expect(out).toEqual({ ok: false, reason: "TOO_MANY_PIXELS" });
    },
  );

  it(
    "PNG 16-bit 9MP (3000×3000) → ok (16-bit KHÔNG bị chặn hoàn toàn — chỉ cap chặt hơn)",
    { timeout: 60_000 },
    async () => {
      const input = png16Bit(3000, 3000, [34, 68, 102]);
      const out = await reencodeImage(input);
      expect(out.ok).toBe(true);
    },
  );

  it(
    "JPEG giữ cap 50MP — 49.99MP JPEG progressive vẫn qua (recorded choice: JPEG không siết)",
    { timeout: 60_000 },
    async () => {
      const input = await sharp({ create: { width: 8164, height: 6123, channels: 3, background: "#224466" } })
        .jpeg({ progressive: true })
        .toBuffer();
      const meta = await sharp(input).metadata();
      expect(meta.isProgressive).toBe(true);
      const out = await reencodeImage(input);
      expect(out.ok).toBe(true);
    },
  );
});

// ─── Review fix — multi-frame GIF/WebP: CHỈ frame đầu được giữ ─────────────────

describe("reencodeImage — multi-frame input → static WebP frame ĐẦU", () => {
  // 2 frame: frame 1 ĐỎ (palette 0), frame 2 XANH DƯƠNG (palette 1) — nếu
  // pipeline lỡ decode hết các page rồi lấy frame cuối, output sẽ XANH.
  const PALETTE = [255, 0, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255];
  const gif2Frames = () => animatedGif(2, 2, [0, 1], PALETTE);

  it("precondition — fixture là GIF animated 2 frame thật", async () => {
    const gif = gif2Frames();
    const meta = await sharp(gif, { animated: true }).metadata();
    expect(meta.format).toBe("gif");
    expect(meta.pages).toBe(2);
  });

  it("animated GIF → output webp STATIC, pixels LÀ FRAME ĐẦU (đỏ), không phải frame cuối", async () => {
    const out = await reencodeImage(gif2Frames());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.pages ?? 1).toBe(1); // static — không còn animation
    // pixels: frame đầu là ĐỎ (r cao, b thấp) — frame cuối xanh dương bị bỏ
    const raw = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(raw.info.channels).toBeGreaterThanOrEqual(3);
    const [r, g, b] = [raw.data[0]!, raw.data[1]!, raw.data[2]!];
    expect(r).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
    expect(g).toBeLessThan(100);
  });

  it("animated WebP → output webp STATIC, pixels LÀ FRAME ĐẦU (đỏ)", async () => {
    const webpAnim = await sharp(gif2Frames(), { animated: true }).webp().toBuffer();
    const meta = await sharp(webpAnim, { animated: true }).metadata();
    expect(meta.pages).toBe(2); // precondition — input thật sự 2 frame
    const out = await reencodeImage(webpAnim);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const outMeta = await sharp(out.buffer).metadata();
    expect(outMeta.pages ?? 1).toBe(1);
    const raw = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    const [r, g, b] = [raw.data[0]!, raw.data[1]!, raw.data[2]!];
    expect(r).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
    expect(g).toBeLessThan(100);
  });
});

// ─── Review fix — ICC/XMP cũng bị strip (không chỉ EXIF/GPS) ───────────────────

describe("reencodeImage — strip ICC/XMP (Review Focus 1 mở rộng)", () => {
  it("JPEG mang ICC profile → output KHÔNG còn ICC/XMP chunk nào", async () => {
    const input = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#abcdef" } })
      .withIccProfile("srgb")
      .jpeg()
      .toBuffer();
    // precondition — input THẬT SỰ mang ICC (APP2 ICC_PROFILE + metadata icc)
    const inMeta = await sharp(input).metadata();
    expect(inMeta.hasProfile).toBe(true);
    expect(inMeta.icc).toBeDefined();

    const out = await reencodeImage(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // WebP chunk ICCP / XMP — không dạng nào được phép trong output
    expect(out.buffer.includes(Buffer.from("ICCP", "ascii"))).toBe(false);
    expect(out.buffer.includes(Buffer.from("XMP ", "ascii"))).toBe(false);
    expect(out.buffer.includes(Buffer.from("XMP", "ascii"))).toBe(false);
    const outMeta = await sharp(out.buffer).metadata();
    expect(outMeta.hasProfile).toBe(false);
    expect(outMeta.icc).toBeUndefined();
  });
});
