/**
 * Seed beta catalog — guard từ ĐÍCH (b4-holistic round-3 LOW: guard
 * --allow-production không bao giờ cháy nơi nó chạy).
 *
 * Trên VPS production, seed CHỈ chạy được trong container migrate (db không
 * publish port) — stage migrate KHÔNG set NODE_ENV (chỉ runner stage) nên
 * guard NODE_ENV cũ không bao giờ cháy. Guard mới quyết từ host ĐÍCH:
 * --apply vào DB non-local → SEED_REFUSED_NONLOCAL trừ khi --allow-production.
 * (Hành vi seed thật trên DB local pin ở integration beta-catalog-seed.test.ts.)
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isLocalSeedTarget, seedBetaCatalog } from "../../scripts/seed-beta-catalog";

describe("isLocalSeedTarget — host đích local (b4-holistic round-3)", () => {
  it("localhost/127.0.0.1/::1 → local (dev/test scratch thoải mái)", () => {
    expect(isLocalSeedTarget("postgresql://u:p@localhost:5432/loaviet")).toBe(true);
    expect(isLocalSeedTarget("postgresql://u:p@127.0.0.1:5432/loaviet")).toBe(true);
    expect(isLocalSeedTarget("postgresql://u:p@[::1]:5432/loaviet")).toBe(true);
  });

  it("host compose 'db' / VPS domain / IP remote → NON-local", () => {
    expect(isLocalSeedTarget("postgresql://loaviet:pw@db:5432/loaviet")).toBe(false);
    expect(isLocalSeedTarget("postgresql://u:p@10.0.0.5:5432/loaviet")).toBe(false);
    expect(isLocalSeedTarget("postgresql://u:p@loaviet.internal:5432/loaviet")).toBe(false);
  });

  it("URL parse fail → NON-local (fail closed)", () => {
    expect(isLocalSeedTarget("not a url")).toBe(false);
    expect(isLocalSeedTarget("")).toBe(false);
  });
});

describe("seedBetaCatalog — guard --apply từ ĐÍCH (b4-holistic round-3)", () => {
  it("--apply vào DB NON-LOCAL (compose migrate → db:5432) → SEED_REFUSED_NONLOCAL, KHÔNG chạm DB", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
    // KHÔNG stub NODE_ENV=production — đúng ngữ cảnh lỗ: migrate container
    // KHÔNG set NODE_ENV (chỉ runner stage) nên guard NODE_ENV cũ không cháy;
    // guard đích phải tự chặn. Throw TRƯỚC dynamic import db.client (nhanh).
    vi.stubEnv("NODE_ENV", "test");
    await expect(seedBetaCatalog(true)).rejects.toThrowError(/SEED_REFUSED_NONLOCAL/);
  });

  it("--apply vào DB LOCAL (127.0.0.1 scratch) → KHÔNG bị guard đích chặn", async () => {
    // Port 1 — chắc chắn không có gì nghe (connection refused NGAY, không
    // timeout) và KHÔNG bao giờ dính DB thật của máy.
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/scratch");
    vi.stubEnv("NODE_ENV", "test");
    // Guard đích pass — đi tiếp tới dynamic import DB (không có DB → lỗi kết
    // nối, KHÔNG phải SEED_REFUSED_NONLOCAL; hành vi seed thật trên DB local
    // pin ở integration beta-catalog-seed.test.ts).
    const err = await seedBetaCatalog(true).then(
      () => null,
      (e) => e,
    );
    expect(err?.message ?? "").not.toMatch(/SEED_REFUSED_NONLOCAL/);
  });
});

