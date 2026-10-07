/**
 * Alias resolution (Batch 5 Task 5 — spec §5.7) — unit tests qua mock db
 * (hợp đồng guard; hành vi thật trên scratch DB pin ở integration search
 * test của Task 7 — cùng cơ chế resolveSearchQuery).
 *
 * Cổng ALIAS của batch (plan Task 5 Step 1 + corrections #16):
 *  1. EXACT: normalizeSearchText(query) === SearchAlias.alias → target ids
 *     (alias lưu DẠNG CHUẨN HÓA — query chuẩn hóa trước khi tra).
 *  2. SPACING: mỗi spacingVariants(q) (chữ↔số) === alias → target ids.
 *  3. COMPACT (B6): compactForm(q) === compactForm(alias) — ví dụ soundlink↔
 *     "sound link" của spec §5.7 sống Ở ĐÂY (spacingVariants cố tình không
 *     sinh biến thể chữ↔chữ — Task 3).
 *  4. FALLBACK CATALOG (S-3): whole-query equality với Brand.name /
 *     ProductModel.name (approved) → ids. KHÔNG OR toàn bộ brand listings —
 *     chỉ id của chính brand/model được gọi tên.
 *  5. corrections #16: mergeModelAction (Batch 4) KHÔNG viết lại alias —
 *     alias trỏ model đã merge → follow mergedIntoId; model cuối PHẢI
 *     approved (pending/merged-chết không resolve — filter to approved).
 *  6. spec §4.8: resolution KHÔNG chứa query text thô (chỉ 3 mảng structured
 *     ids + textVariants CHUẨN HÓA cho tsquery của Task 7); module KHÔNG log
 *     query/alias (query là free text).
 *  7. S9/A7: seed script idempotent (create-if-absent theo (alias, target)),
 *     dry-run mặc định KHÔNG ghi, content EMPTY/founder-reviewed — implementer
 *     không tự biên alias catalog.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dbState = vi.hoisted(() => ({
  aliases: [] as Array<Record<string, unknown>>,
  brands: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
}));

/**
 * Field-proxy mock cho predicate lambda (`.in`/`.eq`/`isNull`…) — resolveSearchQuery
 * dùng dạng lambda (`m.status.in(...)`, `m.id.in(...)`), seed dùng dạng object.
 */
const fieldProxy = (row: Record<string, unknown>) =>
  new Proxy(row, {
    get: (target: Record<string, unknown>, prop: string) => {
      const value = target[prop];
      return {
        eq: (v: unknown) => value === v,
        neq: (v: unknown) => value !== v,
        in: (arr: readonly unknown[]) => arr.includes(value),
        isNull: () => value === null,
        isNotNull: () => value !== null,
      };
    },
  });

/** where-builder mock: hỗ trợ cả predicate object lẫn expression fn (.in/.eq). */
const matchRow = (row: Record<string, unknown>, pred: unknown): boolean => {
  if (typeof pred === "function") {
    return Boolean((pred as (r: unknown) => unknown)(fieldProxy(row)));
  }
  return Object.entries(pred as Record<string, unknown>).every(([k, v]) => row[k] === v);
};

vi.mock("@/src/prisma/db.client", () => {
  const orm = {
    public: {
      SearchAlias: {
        all: vi.fn(async () => dbState.aliases.map((a) => ({ ...a }))),
        where: (pred: unknown) => ({
          first: vi.fn(async () => {
            const found = dbState.aliases.find((r) => matchRow(r, pred));
            return found ? { ...found } : null;
          }),
        }),
        create: vi.fn(async (data: Record<string, unknown>) => {
          const row = {
            id: `alias-${dbState.aliases.length + 1}`,
            createdAt: new Date().toISOString(),
            note: null,
            ...data,
          };
          dbState.aliases.push(row);
          return { ...row };
        }),
      },
      Brand: {
        all: vi.fn(async () => dbState.brands.map((b) => ({ ...b }))),
        first: vi.fn(async (pred: unknown) => {
          const found = dbState.brands.find((r) => matchRow(r, pred));
          return found ? { ...found } : null;
        }),
      },
      ProductModel: {
        first: vi.fn(async (pred: unknown) => {
          const found = dbState.models.find((r) => matchRow(r, pred));
          return found ? { ...found } : null;
        }),
        where: (pred: unknown) => ({
          all: vi.fn(async () =>
            dbState.models.filter((r) => matchRow(r, pred)).map((m) => ({ ...m })),
          ),
        }),
      },
    },
  };
  const db = {
    orm,
    // transaction: callback nhận tx có cùng orm shape (seed dùng tx.orm)
    transaction: vi.fn(async (fn: (tx: { orm: typeof orm }) => Promise<unknown>) =>
      fn({ orm })),
  };
  return { db };
});

import { resolveSearchQuery, SEARCHABLE_MODEL_STATUSES } from "@/src/lib/search-resolve";
import { seedSearchAliases } from "../../scripts/seed-search-aliases";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const mkBrand = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: `brand-${dbState.brands.length + 1}`,
  name: "Brand",
  slug: `brand-${dbState.brands.length + 1}`,
  logoUrl: null,
  createdAt: new Date().toISOString(),
  ...over,
});

const mkModel = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: `model-${dbState.models.length + 1}`,
  brandId: "brand-jbl",
  categoryId: "cat-beta",
  name: "Model",
  slug: `model-${dbState.models.length + 1}`,
  releaseYear: null,
  description: null,
  specs: null,
  image: null,
  status: "approved",
  mergedIntoId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const mkAlias = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: `alias-${dbState.aliases.length + 1}`,
  alias: "alias",
  target: "model",
  brandId: null,
  productModelId: null,
  note: null,
  createdAt: new Date().toISOString(),
  ...over,
});

/** Fixture chuẩn dùng chung cho các describe resolve: JBL + Charge 5 + SoundLink. */
function seedStandardCatalog(): void {
  dbState.brands.push(
    mkBrand({ id: "brand-jbl", name: "JBL", slug: "jbl" }),
    mkBrand({ id: "brand-bose", name: "Bose", slug: "bose" }),
  );
  dbState.models.push(
    mkModel({ id: "model-charge5", name: "Charge 5", slug: "jbl-charge-5", status: "approved" }),
    mkModel({ id: "model-soundlink", name: "SoundLink", slug: "bose-soundlink", status: "approved" }),
    mkModel({ id: "model-emberton2", name: "Emberton 2", slug: "marshall-emberton-2", status: "pending" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.aliases.length = 0;
  dbState.brands.length = 0;
  dbState.models.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1–3: alias matching (exact / spacing / compact — B6) ───────────────────

describe("resolveSearchQuery — alias matching (exact + spacing + compact, B6)", () => {
  it("EXACT: alias lưu dạng chuẩn hóa khớp query đã chuẩn hóa (case/diacritic-insensitive)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "soundlink", target: "model", productModelId: "model-soundlink" }),
    );

    const res = await resolveSearchQuery("SoundLink");

    expect(res.productModelIds).toContain("model-soundlink");
    // textVariants = dạng chuẩn hóa (cho tsquery Task 7) — KHÔNG phải query thô
    expect(res.textVariants).toContain("soundlink");
  });

  it("SPACING: query 'charge4' khớp alias 'charge 4' qua spacingVariants (chữ↔số)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "charge 4", target: "model", productModelId: "model-charge4" }),
    );
    dbState.models.push(
      mkModel({ id: "model-charge4", name: "Charge 4", slug: "jbl-charge-4", status: "approved" }),
    );

    const res = await resolveSearchQuery("charge4");

    // variant "charge 4" của query khớp alias; id model alias trỏ vào
    expect(res.productModelIds).toContain("model-charge4");
    expect(res.textVariants).toEqual(["charge4", "charge 4"]);
  });

  it("COMPACT (B6): query 'sound link' khớp alias 'soundlink' — ví dụ §5.7 sống ở compact matching", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "soundlink", target: "model", productModelId: "model-soundlink" }),
    );

    const res = await resolveSearchQuery("sound link");

    // compactForm("sound link") === compactForm("soundlink") === "soundlink"
    expect(res.productModelIds).toContain("model-soundlink");
  });

  it("alias trỏ BRAND resolve brand id (target=brand)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "jbl", target: "brand", brandId: "brand-jbl" }),
    );

    const res = await resolveSearchQuery("JBL");

    expect(res.brandIds).toContain("brand-jbl");
  });

  it("query rỗng/blank → resolution rỗng, KHÔNG đụng db (browsing — Task 7 gate malformed)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "soundlink", target: "model", productModelId: "model-soundlink" }),
    );

    const res = await resolveSearchQuery("   ");

    expect(res).toEqual({ textVariants: [], brandIds: [], productModelIds: [] });
  });
});

// ─── 4: fallback catalog (S-3 — whole-query equality) ───────────────────────

describe("resolveSearchQuery — fallback catalog (S-3: whole-query equality, approved only)", () => {
  it("tên brand khớp → brand id; tên model khớp → model id", async () => {
    seedStandardCatalog();

    const byBrand = await resolveSearchQuery("jbl");
    expect(byBrand.brandIds).toContain("brand-jbl");

    const byModel = await resolveSearchQuery("charge 5");
    expect(byModel.productModelIds).toContain("model-charge5");
  });

  it("fallback compact: query 'sound link' khớp model 'SoundLink' (B6 — không cần alias)", async () => {
    seedStandardCatalog();

    const res = await resolveSearchQuery("sound link");

    expect(res.productModelIds).toContain("model-soundlink");
  });

  it("model PENDING KHÔNG resolve (fallback chỉ duyệt approved — SEARCHABLE_MODEL_STATUSES)", async () => {
    seedStandardCatalog();

    const res = await resolveSearchQuery("emberton 2");

    expect(res.productModelIds).not.toContain("model-emberton2");
    expect(SEARCHABLE_MODEL_STATUSES).toEqual(["approved"]);
  });

  it("WHOLE-QUERY equality only (S-3): query gọi tên model KHÔNG kéo thêm brand của model đó", async () => {
    seedStandardCatalog();

    const res = await resolveSearchQuery("charge 5");

    // chỉ id của chính model được gọi tên — KHÔNG OR brand của model
    expect(res.productModelIds).toEqual(["model-charge5"]);
    expect(res.brandIds).toEqual([]);
  });

  it("query không khớp gì → ids rỗng, textVariants vẫn có (search chạy tiếp qua full-text)", async () => {
    seedStandardCatalog();

    const res = await resolveSearchQuery("xyz abc");

    expect(res.brandIds).toEqual([]);
    expect(res.productModelIds).toEqual([]);
    expect(res.textVariants).toEqual(["xyz abc"]);
  });
});

// ─── 5: corrections #16 — alias trỏ model đã merge ───────────────────────────

describe("resolveSearchQuery — corrections #16 (mergeModelAction không viết lại alias)", () => {
  it("alias trỏ model MERGED → follow mergedIntoId → resolve id model GỐC (approved)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "flip", target: "model", productModelId: "model-flip-old" }),
    );
    dbState.models.push(
      mkModel({ id: "model-flip-old", name: "Flip 6 cũ", slug: "jbl-flip-6-cu", status: "merged", mergedIntoId: "model-flip-new" }),
      mkModel({ id: "model-flip-new", name: "Flip 6", slug: "jbl-flip-6", status: "approved" }),
    );

    const res = await resolveSearchQuery("flip");

    // resolve id model gốc (listings đã chuyển sang model gốc lúc merge) —
    // KHÔNG phải id model đã chết
    expect(res.productModelIds).toContain("model-flip-new");
    expect(res.productModelIds).not.toContain("model-flip-old");
  });

  it("chuỗi merge 2 cấp → resolve model gốc CUỐI chuỗi", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "flip", target: "model", productModelId: "model-a" }),
    );
    dbState.models.push(
      mkModel({ id: "model-a", name: "A", slug: "a", status: "merged", mergedIntoId: "model-b" }),
      mkModel({ id: "model-b", name: "B", slug: "b", status: "merged", mergedIntoId: "model-c" }),
      mkModel({ id: "model-c", name: "C", slug: "c", status: "approved" }),
    );

    const res = await resolveSearchQuery("flip");

    expect(res.productModelIds).toEqual(["model-c"]);
  });

  it("alias trỏ model PENDING → KHÔNG resolve (filter to approved)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "emberton", target: "model", productModelId: "model-emberton-pending" }),
    );
    dbState.models.push(
      mkModel({ id: "model-emberton-pending", name: "Emberton", slug: "marshall-emberton", status: "pending" }),
    );

    const res = await resolveSearchQuery("emberton");

    expect(res.productModelIds).toEqual([]);
  });

  it("alias trỏ model merged vào model PENDING → KHÔNG resolve (terminal phải approved)", async () => {
    seedStandardCatalog();
    dbState.aliases.push(
      mkAlias({ alias: "flip", target: "model", productModelId: "model-a" }),
    );
    dbState.models.push(
      mkModel({ id: "model-a", name: "A", slug: "a", status: "merged", mergedIntoId: "model-b" }),
      mkModel({ id: "model-b", name: "B", slug: "b", status: "pending" }),
    );

    const res = await resolveSearchQuery("flip");

    expect(res.productModelIds).toEqual([]);
  });
});

// ─── 6: spec §4.8 — không query text thô trong output, không log ─────────────

describe("resolveSearchQuery — privacy shape (spec §4.8)", () => {
  it("output CHỈ có 3 mảng structured — KHÔNG query text thô", async () => {
    seedStandardCatalog();

    const res = await resolveSearchQuery("Loa JBL Charge 4");

    expect(Object.keys(res).sort()).toEqual(["brandIds", "productModelIds", "textVariants"]);
    // textVariants là dạng CHUẨN HÓA (lowercase, không dấu) — không phải query thô
    expect(res.textVariants).toContain("loa jbl charge 4");
    expect(res.textVariants).not.toContain("Loa JBL Charge 4");
  });

  it("source-contract: module KHÔNG log query/alias (query là free text — spec §4.8)", () => {
    const src = read("src/lib/search-resolve.ts");
    expect(src).not.toMatch(/console\.(log|warn|error|info|debug)/);
    expect(src).not.toMatch(/captureError|captureEvent/);
  });

  it("source-contract: server module (import \"server-only\"), KHÔNG \"use server\" (S-13 posture)", () => {
    const src = read("src/lib/search-resolve.ts");
    expect(src).toMatch(/import "server-only"/);
    expect(src).not.toMatch(/"use server"/);
  });
});

// ─── 7: seed script (S9/A7 — idempotent, dry-run mặc định, founder content) ──

describe("seedSearchAliases — S9/A7 (offline seed, content founder-reviewed)", () => {
  let tmp = "";
  let aliasesFile = "";

  const founderFile = (entries: unknown[]): string => {
    writeFileSync(aliasesFile, JSON.stringify(entries), "utf8");
    return aliasesFile;
  };

  beforeEach(() => {
    // tmp dir MỚI mỗi test (afterEach dọn — writeFileSync cần parent tồn tại)
    tmp = mkdtempSync(join(tmpdir(), "seed-aliases-test-"));
    aliasesFile = join(tmp, "founder-aliases.json");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:5432/scratch");
    seedStandardCatalog();
  });

  afterEach(() => {
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run KHÔNG ghi gì (mặc định — chỉ đọc + báo plan)", async () => {
    const file = founderFile([
      { alias: "SoundLink", target: "model", productModelId: "model-soundlink" },
      { alias: "loa jbl", target: "brand", brandId: "brand-jbl" },
    ]);

    const report = await seedSearchAliases(false, file);

    expect(report.mode).toBe("dry-run");
    expect(report.created).toBe(0);
    expect(report.planned).toBe(2);
    expect(dbState.aliases).toHaveLength(0); // KHÔNG ghi
  });

  it("--apply tạo rows founder-reviewed (alias lưu DẠNG CHUẨN HÓA); lần 2 = 0 created (idempotent)", async () => {
    const file = founderFile([
      { alias: "SoundLink", target: "model", productModelId: "model-soundlink" },
      { alias: "loa jbl", target: "brand", brandId: "brand-jbl" },
    ]);

    const first = await seedSearchAliases(true, file);
    expect(first.mode).toBe("apply");
    expect(first.created).toBe(2);
    expect(dbState.aliases).toHaveLength(2);
    // alias lưu dạng chuẩn hóa (normalizeSearchText) — khóa tra cứu của resolve
    const storedAliases = dbState.aliases.map((a) => a["alias"]);
    expect(storedAliases).toContain("soundlink");
    expect(storedAliases).toContain("loa jbl");
    // target ⇒ id set (corrections #5 — check constraint shape)
    const modelRow = dbState.aliases.find((a) => a["target"] === "model")!;
    expect(modelRow["productModelId"]).toBe("model-soundlink");
    expect(modelRow["brandId"]).toBeNull();

    const second = await seedSearchAliases(true, file);
    expect(second.created).toBe(0); // create-if-absent theo (alias, target)
    expect(dbState.aliases).toHaveLength(2);
  });

  it("KHÔNG --aliases → content EMPTY (S9/A7 — không tạo gì, không lỗi)", async () => {
    const dry = await seedSearchAliases(false);
    expect(dry).toMatchObject({ mode: "dry-run", created: 0, planned: 0, existing: 0 });

    const applied = await seedSearchAliases(true);
    expect(applied).toMatchObject({ mode: "apply", created: 0 });
    expect(dbState.aliases).toHaveLength(0);
  });

  it("từ chối khi thiếu DATABASE_URL (env thật — trước khi nạp db.client)", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const file = founderFile([{ alias: "soundlink", target: "model", productModelId: "model-soundlink" }]);

    await expect(seedSearchAliases(true, file)).rejects.toThrow(/DATABASE_URL/);
    expect(dbState.aliases).toHaveLength(0);
  });

  it("--apply vào DB NON-LOCAL → SEED_REFUSED_NONLOCAL (guard từ đích — seed-beta-catalog posture)", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
    const file = founderFile([{ alias: "soundlink", target: "model", productModelId: "model-soundlink" }]);

    await expect(seedSearchAliases(true, file)).rejects.toThrow(/SEED_REFUSED_NONLOCAL/);
    expect(dbState.aliases).toHaveLength(0);
  });

  it("file founder sai shape → typed error, KHÔNG ghi gì (fail closed trước khi mutate)", async () => {
    const file = founderFile([
      { alias: "soundlink", target: "model" }, // thiếu productModelId
    ]);

    await expect(seedSearchAliases(true, file)).rejects.toThrow(/SEED_ALIASES_FILE_INVALID/);
    expect(dbState.aliases).toHaveLength(0);
  });

  it("target KHÔNG tồn tại trong catalog → typed error, KHÔNG ghi gì", async () => {
    const file = founderFile([
      { alias: "soundlink", target: "model", productModelId: "model-khong-co" },
    ]);

    await expect(seedSearchAliases(true, file)).rejects.toThrow(/SEED_ALIAS_TARGET_MISSING/);
    expect(dbState.aliases).toHaveLength(0);
  });
});
