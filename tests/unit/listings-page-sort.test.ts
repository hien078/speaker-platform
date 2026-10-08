/**
 * /listings sidebar sort select — RENDER test (b5-review fix 1, Task 7 MEDIUM).
 *
 * Finding: select "Sắp xếp" của sidebar KHÔNG có option relevance/default và
 * remap `plan.sort === "relevance" ? "newest" : plan.sort` → MỌI submit sidebar
 * (refine sau header search HAY gõ thẳng query vào box) gửi sort=newest →
 * describeSearchQuery coi đó là sort tường minh → ranking rơi về newest ngầm
 * sau lần refine đầu; search_submitted cũng ghi sort "newest" (sai sort thật).
 *
 * Hợp đồng RENDER (pattern admin-listings-guard.test.ts — gọi page component
 * trực tiếp, inspect element tree thật, KHÔNG render string):
 *  (a) select name="sort" có option mặc định value RỖNG ("Phù hợp nhất")
 *      đứng ĐẦU + 4 sort cụ thể — form chỉ mang sort buyer CHỌN TƯỜNG MINH;
 *  (b) sidebar CÓ query (không sort tường minh) → defaultValue = "" → submit
 *      sort='' → describeSearchQuery derive → plan.sort "relevance" GIỮ
 *      (relevance preserved);
 *  (c) KHÔNG query (browsing) → defaultValue = "" → submit sort='' →
 *      plan.sort "newest";
 *  (d) buyer CHỌN sort cụ thể (URL sort=newest) → defaultValue giữ lựa chọn;
 *  (e) URL sort=relevance → defaultValue "" (relevance KHÔNG phải giá trị
 *      select tường minh — về mặc định, submit để server derive).
 *
 * Cơ chế mock: page là thin shell (S-7) — runSearchWithTelemetry được thay bằng
 * delegate gọi describeSearchQuery THẬT (plan thật từ searchParams thật —
 * wiring page→params→plan là thứ render test pin); db query + emit core không
 * thuộc phạm vi file này (pin ở search-telemetry.test.ts + search.test.ts
 * integration). resolveSearchQuery stub rỗng (chỉ pin sort select). getCurrentUser
 * THẬT qua cookies() mock rỗng → null (browsing ẩn danh). Category/Brand load
 * của form trả [] (select sort là option TĨNH — không phụ thuộc catalog).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
    has: () => false,
    getAll: () => [],
  })),
}));

// Resolution rỗng — render test pin SORT SELECT, không pin resolution arm (Task 5).
vi.mock("@/src/lib/search-resolve", () => ({
  resolveSearchQuery: vi.fn(async () => ({ textVariants: [], brandIds: [], productModelIds: [] })),
}));

// runSearchWithTelemetry → delegate describeSearchQuery THẬT (plan thật từ
// params thật); listings rỗng — emit/db không thuộc phạm vi (S-7 chia lớp).
vi.mock("@/src/lib/search-telemetry", async () => {
  const { describeSearchQuery } = await import("@/src/lib/search-query");
  return {
    runSearchWithTelemetry: vi.fn(
      async (input: { params: Record<string, string | undefined>; resolution: unknown }) => ({
        plan: describeSearchQuery(input.params, input.resolution as never),
        listings: [],
        resultCount: 0,
        searchSessionId: null,
        throttled: false,
        eventsEmitted: { submitted: false, zeroResult: false },
      }),
    ),
  };
});

// db: chỉ Category/Brand load của form — rỗng là đủ (select sort là option tĩnh).
vi.mock("@/src/prisma/db.client", () => {
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    all: async () => [] as Array<Record<string, unknown>>,
  };
  return { db: { orm: { public: { Category: chain, Brand: chain } } } };
});

import * as listingsPage from "../../app/listings/page";
import { describeSearchQuery } from "@/src/lib/search-query";
import type { SearchResolution } from "@/src/lib/search-resolve";

const EMPTY: SearchResolution = { textVariants: [], brandIds: [], productModelIds: [] };

type PageFn = (props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;
const ListingsPage = listingsPage.default as unknown as PageFn;
const render = (sp: Record<string, string | undefined>): Promise<unknown> =>
  ListingsPage({ searchParams: Promise.resolve(sp) });

// ─── React element tree helpers (async server component return value) ────────

type ElementLike = { type?: unknown; props?: Record<string, unknown> | null };

/** Đệ quy duyệt element tree — không render, chỉ inspect cấu trúc tĩnh. */
function walk(node: unknown, visit: (el: ElementLike) => void): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === "object" && node !== null) {
    const el = node as ElementLike;
    if (el.type !== undefined) {
      visit(el);
      walk(el.props?.["children"], visit);
    }
  }
}

/** Text của option (children có thể là string hoặc element lồng). */
const textOf = (c: unknown): string => {
  if (c == null || typeof c === "boolean") return "";
  if (typeof c === "string" || typeof c === "number") return String(c);
  if (Array.isArray(c)) return c.map(textOf).join("");
  return textOf((c as ElementLike).props?.["children"]);
};

/** <select name="sort"> — defaultValue + options (value + text) theo thứ tự render. */
function sortSelectOf(
  node: unknown,
): { defaultValue: unknown; options: Array<{ value: unknown; text: string }> } | null {
  let found: { defaultValue: unknown; options: Array<{ value: unknown; text: string }> } | null =
    null;
  walk(node, (el) => {
    if (found !== null || el.type !== "select" || el.props?.["name"] !== "sort") return;
    const options: Array<{ value: unknown; text: string }> = [];
    walk(el.props?.["children"], (o) => {
      if (o.type === "option") {
        options.push({ value: o.props?.["value"], text: textOf(o.props?.["children"]) });
      }
    });
    found = { defaultValue: el.props?.["defaultValue"], options };
  });
  return found;
}

// ─── Hợp đồng render (a)–(e) ─────────────────────────────────────────────────

describe("/listings sidebar sort select — relevance/default option (b5-review fix 1)", () => {
  it("(a) option mặc định value rỗng ĐỨNG ĐẦU + 4 sort cụ thể (đủ 5 option)", async () => {
    const tree = await render({ q: "loa jbl" });
    const sel = sortSelectOf(tree);
    expect(sel).not.toBeNull();
    expect(sel!.options.map((o) => o.value)).toEqual([
      "",
      "newest",
      "price_asc",
      "price_desc",
      "popular",
    ]);
    expect(sel!.options[0]!.text).toBe("Phù hợp nhất");
  });

  it("(b) sidebar CÓ query, không sort tường minh → defaultValue '' → submit GIỮ relevance", async () => {
    const tree = await render({ q: "loa jbl charge 4" });
    const sel = sortSelectOf(tree)!;
    // select mặc định option rỗng — KHÔNG remap "relevance" → hiển thị "newest"
    expect(sel.defaultValue).toBe("");
    // round-trip: giá trị select sẽ submit (sort='') → plan.sort relevance
    expect(describeSearchQuery({ q: "loa jbl charge 4", sort: "" }, EMPTY).sort).toBe("relevance");
  });

  it("(c) KHÔNG query (browsing) → defaultValue '' → submit → newest", async () => {
    const tree = await render({});
    const sel = sortSelectOf(tree)!;
    expect(sel.defaultValue).toBe("");
    expect(describeSearchQuery({ sort: "" }, EMPTY).sort).toBe("newest");
  });

  it("(d) buyer CHỌN sort cụ thể (URL sort=newest) → select giữ lựa chọn", async () => {
    const tree = await render({ q: "loa", sort: "newest" });
    const sel = sortSelectOf(tree)!;
    expect(sel.defaultValue).toBe("newest");
  });

  it("(e) URL sort=relevance → defaultValue '' (relevance không phải giá trị select tường minh)", async () => {
    const tree = await render({ q: "loa", sort: "relevance" });
    const sel = sortSelectOf(tree)!;
    expect(sel.defaultValue).toBe("");
    // submit sort='' → derive lại relevance (hasQuery)
    expect(describeSearchQuery({ q: "loa", sort: "" }, EMPTY).sort).toBe("relevance");
  });
});
