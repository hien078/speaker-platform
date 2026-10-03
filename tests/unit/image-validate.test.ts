/**
 * Upload image validation — magic bytes + sharp decode + dimension caps.
 * Yêu cầu: chỉ nhận JPEG/PNG/WebP/GIF THẬT (chống SVG/script/spoof MIME),
 * chặn file quá lớn, chặn ảnh kích thước vô lý (resource exhaustion).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import sharp from "sharp";
import { validateImage } from "../../src/lib/image-validate";

const MAX = 5 * 1024 * 1024;

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } })
    .png()
    .toBuffer();
}

describe("validateImage — chấp nhận ảnh thật", () => {
  it("PNG 1x1 hợp lệ", async () => {
    const buf = await tinyPng();
    const res = await validateImage(buf, "image/png", MAX);
    expect(res).toMatchObject({ ok: true, ext: "png", width: 1, height: 1 });
  });

  it("JPEG hợp lệ", async () => {
    const buf = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#f00" } })
      .jpeg()
      .toBuffer();
    const res = await validateImage(buf, "image/jpeg", MAX);
    expect(res).toMatchObject({ ok: true, ext: "jpg", width: 2, height: 3 });
  });

  it("WebP hợp lệ", async () => {
    const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#0f0" } })
      .webp()
      .toBuffer();
    const res = await validateImage(buf, "image/webp", MAX);
    expect(res).toMatchObject({ ok: true, ext: "webp" });
  });

  it("GIF hợp lệ (GIF89a 1x1)", async () => {
    const buf = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    const res = await validateImage(buf, "image/gif", MAX);
    expect(res).toMatchObject({ ok: true, ext: "gif", width: 1, height: 1 });
  });
});

describe("validateImage — từ chối payload nguy hiểm", () => {
  it("text thường giả MIME png → từ chối", async () => {
    const res = await validateImage(Buffer.from("hello world"), "image/png", MAX);
    expect(res.ok).toBe(false);
  });

  it("SVG (script payload) khai báo image/svg+xml → MIME không cho phép", async () => {
    const svg = Buffer.from(`<svg onload="alert(1)"><script>alert(1)</script></svg>`);
    const res = await validateImage(svg, "image/svg+xml", MAX);
    expect(res.ok).toBe(false);
  });

  it("SVG nội dung nhưng khai báo image/png → magic bytes không khớp", async () => {
    const svg = Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    const res = await validateImage(svg, "image/png", MAX);
    expect(res.ok).toBe(false);
  });

  it("PNG bị cắt cụt (magic đúng, thiếu thân) → sharp decode fail → từ chối", async () => {
    const full = await tinyPng();
    const truncated = full.subarray(0, 20);
    const res = await validateImage(truncated, "image/png", MAX);
    expect(res.ok).toBe(false);
  });

  it("vượt quá maxBytes → từ chối không decode", async () => {
    const buf = await tinyPng();
    const res = await validateImage(buf, "image/png", 4); // max 4 bytes
    expect(res).toMatchObject({ ok: false });
  });

  it("buffer rỗng → từ chối", async () => {
    const res = await validateImage(Buffer.alloc(0), "image/png", MAX);
    expect(res.ok).toBe(false);
  });

  it("MIME khai báo không khớp định dạng thật (gif khai báo png) → từ chối", async () => {
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    const res = await validateImage(gif, "image/png", MAX);
    expect(res.ok).toBe(false);
  });
});
