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
 */
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIM,
  IMAGE_MAX_PIXELS,
  IMAGE_OUTPUT_MAX_BYTES,
  IMAGE_RESIZE_MAX,
  reencodeImage,
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
