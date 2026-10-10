/**
 * Catalog admin actions (b4-holistic round-3 — merge/approve hardening) —
 * hợp đồng qua mock db (multi-row transfer thật pin ở integration
 * multi-row-writes.test.ts; đây pin GATE + CAS + brandId resync + audit tx).
 *
 * Hợp đồng (finding probe:catalog-merge-and-category-admin-vs-publication-gate):
 *  1. mergeModelAction: target KHÔNG approved / KHÁC brand / KHÁC category →
 *     sentinel no-op (KHÔNG write nào) — merge như vậy làm mọi listing chuyển
 *     qua fail canonical gate MODEL_BRAND_MISMATCH/MODEL_INVALID vĩnh viễn.
 *  2. Source đã merged (stale page) → sentinel no-op — KHÔNG merge chéo.
 *  3. Happy path: Listing.brandId RESYNC theo target brand (canonical gate đọc
 *     model.brandId === listing.brandId) + AuditEvent trong CÙNG tx.
 *  4. approveModelAction: CAS theo status pending — stale click (model đã
 *     merged/approved) → 0 rows → NO-OP, KHÔNG audit (KHÔNG resurrect model
 *     đã merged); pending → approved + AuditEvent trong cùng tx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dbState = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  priceHistory: [] as Array<Record<string, unknown>>,
  auditEvents: [] as Array<Record<string, unknown>>,
  adminAuditLogs: [] as Array<Record<string, unknown>>,
}));

/** where-builder mock: hỗ trợ cả predicate object lẫn expression fn (lt/gt). */
const matchRow = (row: Record<string, unknown>, pred: Record<string, unknown>): boolean =>
  Object.entries(pred).every(([k, v]) => row[k] === v);

vi.mock("@/src/prisma/db.client", () => {
  const orm = {
    public: {
      ProductModel: {
        first: vi.fn(async (pred: Record<string, unknown>) =>
          dbState.models.find((r) => matchRow(r, pred)) ?? null),
        where: (pred: Record<string, unknown>) => ({
          first: vi.fn(async () => dbState.models.find((r) => matchRow(r, pred)) ?? null),
          updateAll: vi.fn(async (data: Record<string, unknown>) => {
            const rows = dbState.models.filter((r) => matchRow(r, pred));
            for (const r of rows) Object.assign(r, data);
            return rows;
          }),
        }),
      },
      Listing: {
        where: (pred: Record<string, unknown>) => ({
          updateAll: vi.fn(async (data: Record<string, unknown>) => {
            const rows = dbState.listings.filter((r) => matchRow(r, pred));
            for (const r of rows) Object.assign(r, data);
            return rows;
          }),
        }),
      },
      PriceHistory: {
        where: (pred: Record<string, unknown>) => ({
          updateAll: vi.fn(async (data: Record<string, unknown>) => {
            const rows = dbState.priceHistory.filter((r) => matchRow(r, pred));
            for (const r of rows) Object.assign(r, data);
            return rows;
          }),
        }),
      },
      AuditEvent: {
        create: vi.fn(async (data: Record<string, unknown>) => {
          dbState.auditEvents.push(data);
          return data;
        }),
      },
      AdminAuditLog: {
        create: vi.fn(async (data: Record<string, unknown>) => {
          dbState.adminAuditLogs.push(data);
          return data;
        }),
      },
    },
  };
  const db = {
    orm,
    // transaction: callback nhận tx có cùng orm shape (auditEventTx dùng tx.orm)
    transaction: vi.fn(async (fn: (tx: { orm: typeof orm }) => Promise<unknown>) =>
      fn({ orm })),
  };
  return { db };
});

vi.mock("@/src/lib/rbac", () => ({
  requireCapability: vi.fn(async () => ({
    user: { id: "admin-1" },
    session: { id: "session-1", isAdmin: true },
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { approveModelAction, mergeModelAction } from "@/src/lib/actions/catalog";

const mkModel = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: `model-${dbState.models.length + 1}`,
  brandId: "brand-a",
  categoryId: "cat-a",
  name: "Model",
  slug: `model-${Date.now()}-${dbState.models.length}`,
  status: "approved",
  mergedIntoId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbState.models.length = 0;
  dbState.listings.length = 0;
  dbState.priceHistory.length = 0;
  dbState.auditEvents.length = 0;
  dbState.adminAuditLogs.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mergeModelAction — gate target + CAS + brandId resync (b4-holistic round-3)", () => {
  it("happy path: chuyển listings + price history, brandId RESYNC theo target, AuditEvent TRONG tx", async () => {
    dbState.models.push(
      mkModel({ id: "src", name: "Source", status: "approved" }),
      mkModel({ id: "tgt", name: "Target", status: "approved" }),
    );
    dbState.listings.push({ id: "l1", productModelId: "src", brandId: "brand-cu" });
    dbState.priceHistory.push({ id: "p1", modelId: "src" });

    await mergeModelAction(fd({ modelId: "src", targetId: "tgt" }));

    const src = dbState.models.find((m) => m["id"] === "src")!;
    expect(src).toMatchObject({ status: "merged", mergedIntoId: "tgt" });
    // brandId resync — canonical gate (model.brandId === listing.brandId)
    expect(dbState.listings[0]).toMatchObject({ productModelId: "tgt", brandId: "brand-a" });
    expect(dbState.priceHistory[0]).toMatchObject({ modelId: "tgt" });
    // AuditEvent trong cùng tx (action model.merged) + legacy audit sau commit
    expect(dbState.auditEvents).toHaveLength(1);
    expect(dbState.auditEvents[0]).toMatchObject({
      action: "model.merged",
      resourceId: "src",
      detail: "into=tgt",
    });
    expect(dbState.adminAuditLogs).toHaveLength(1);
  });

  it("target KHÔNG approved (pending/merged) → sentinel no-op — KHÔNG write, KHÔNG audit", async () => {
    dbState.models.push(
      mkModel({ id: "src", status: "approved" }),
      mkModel({ id: "tgt", status: "merged" }), // đã bị gộp vào model khác
    );
    dbState.listings.push({ id: "l1", productModelId: "src", brandId: "brand-cu" });

    await mergeModelAction(fd({ modelId: "src", targetId: "tgt" }));

    expect(dbState.models.find((m) => m["id"] === "src")!["status"]).toBe("approved");
    expect(dbState.listings[0]).toMatchObject({ productModelId: "src" }); // KHÔNG chuyển
    expect(dbState.auditEvents).toHaveLength(0);
    expect(dbState.adminAuditLogs).toHaveLength(0);
  });

  it("target KHÁC brand (hoặc category) → sentinel no-op — merge như vậy brick mọi listing qua MODEL_BRAND_MISMATCH", async () => {
    dbState.models.push(
      mkModel({ id: "src", brandId: "brand-a", categoryId: "cat-a", status: "approved" }),
      mkModel({ id: "tgt", brandId: "brand-khac", categoryId: "cat-a", status: "approved" }),
    );
    dbState.listings.push({ id: "l1", productModelId: "src", brandId: "brand-a" });

    await mergeModelAction(fd({ modelId: "src", targetId: "tgt" }));

    expect(dbState.models.find((m) => m["id"] === "src")!["status"]).toBe("approved");
    expect(dbState.listings[0]).toMatchObject({ productModelId: "src" });
    expect(dbState.auditEvents).toHaveLength(0);
  });

  it("source ĐÃ merged (stale admin page) → sentinel no-op — KHÔNG merge chéo", async () => {
    dbState.models.push(
      mkModel({ id: "src", status: "merged", mergedIntoId: "tgt-cu" }),
      mkModel({ id: "tgt", status: "approved" }),
    );

    await mergeModelAction(fd({ modelId: "src", targetId: "tgt" }));

    // mergedIntoId KHÔNG bị ghi đè — merge chéo bị CAS chặn
    expect(dbState.models.find((m) => m["id"] === "src")!).toMatchObject({
      status: "merged",
      mergedIntoId: "tgt-cu",
    });
    expect(dbState.auditEvents).toHaveLength(0);
  });
});

describe("approveModelAction — CAS theo status pending (b4-holistic round-3)", () => {
  it("pending → approved + AuditEvent trong cùng tx + legacy audit", async () => {
    dbState.models.push(mkModel({ id: "m1", status: "pending" }));

    await approveModelAction(fd({ modelId: "m1" }));

    expect(dbState.models[0]).toMatchObject({ status: "approved" });
    expect(dbState.auditEvents).toHaveLength(1);
    expect(dbState.auditEvents[0]).toMatchObject({ action: "model.approved", resourceId: "m1" });
    expect(dbState.adminAuditLogs).toHaveLength(1);
  });

  it("stale click trên model đã MERGED → 0 rows → NO-OP, KHÔNG resurrect, KHÔNG audit", async () => {
    // Trước fix: updateAll vô điều kiện → merged quay approved (mergedIntoId vẫn
    // set) → trùng lặp sống lại trong seller model picker.
    dbState.models.push(mkModel({ id: "m1", status: "merged", mergedIntoId: "tgt" }));

    await approveModelAction(fd({ modelId: "m1" }));

    expect(dbState.models[0]).toMatchObject({ status: "merged" }); // KHÔNG resurrect
    expect(dbState.auditEvents).toHaveLength(0);
    expect(dbState.adminAuditLogs).toHaveLength(0);
  });

  it("stale click trên model đã APPROVED (admin khác) → 0 rows → NO-OP", async () => {
    dbState.models.push(mkModel({ id: "m1", status: "approved" }));

    await approveModelAction(fd({ modelId: "m1" }));

    expect(dbState.auditEvents).toHaveLength(0);
    expect(dbState.adminAuditLogs).toHaveLength(0);
  });
});

function fd(entries: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
}
