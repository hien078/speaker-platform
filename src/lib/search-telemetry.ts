import "server-only";
import { randomUUID } from "node:crypto";

import { db } from "@/src/prisma/db.client";
import { captureError } from "@/src/lib/observability";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { emitProductEvent } from "@/src/lib/product-events";
import {
  describeSearchQuery,
  runSearchQuery,
  type SearchListingRow,
  type SearchQueryParams,
  type SearchQueryPlan,
} from "@/src/lib/search-query";
import type { SearchResolution } from "@/src/lib/search-resolve";

/**
 * Search telemetry + rate limit (Batch 5 Task 7 — spec §5.8/§7.1/§4.8,
 * S-5/S-6/S-7/S-8/S-9) — tách khỏi page component để unit test không phải render
 * async page (S-7). Page = thin shell: load categories/brands, resolve session,
 * đọc prefetch header, gọi `runSearchWithTelemetry`, render.
 *
 * RATE LIMIT (§7.1, S-5): endpoint-specific, in-memory (src/lib/rate-limit.ts —
 * cùng topology caveats: 1 instance, restart reset, TRUST_PROXY_HEADERS=false →
 * bucket "local" CHUNG cho mọi anonymous — CGNAT nhiều user thật chung bucket,
 * chấp nhận ở P0, ghi trong verification doc). CHỈ áp cho request mang query
 * HỢP LỆ: blank/malformed là browsing — không tốn budget, không emit (exclusion
 * "malformed query" cấu trúc, spec §5.8.1). Denied → soft-throttle (page render
 * state "Bạn đang tìm nhanh quá…"), KHÔNG query, KHÔNG emit.
 *
 * EMISSION (spec §4.8 — KHÔNG query text thô): search_submitted mang structured
 * facets đã validate (resultCount, resultListingIds ≤ 60 — S-14 tập kết quả cho
 * click attribution, categorySlug/brandSlug CHỈ khi khớp row đã load — S-9,
 * condition/sort zod enum, price int) + province buyer chọn đi CỘT TYPED
 * provinceCode. search_zero_result (spec §5.7.1 demand record) mang
 * resolvedBrandIds/resolvedModelIds — brand/model canonical ĐƯỢC TÌM, không bao
 * giờ raw text. Actor/session truyền id THÔ cho emit core (b5-review T6 — core
 * HMAC MỘT lớp dưới key dedicated, S-10/S-11; KHÔNG BAO GIỜ pseudonym kép).
 *
 * eventsEmitted (S-6 — §4.2 no-misleading-promise): dòng "Chúng tôi đã ghi nhận
 * nhu cầu này" của page render CHỈ KHI event THẬT SỰ được ghi — emit core fail-open
 * (db lỗi/key thiếu → KHÔNG row, im lặng) nên "đã gọi emit" KHÔNG đủ; đọc lại sự
 * tồn tại của row theo searchSessionId sau khi emit. Đọc fail → false (fail closed
 * cho lời hứa, fail open cho flow).
 *
 * PREFETCH (S-8): header `next-router-prefetch` BỊ PROXY STRIP (Next 16
 * proxy.md ~L474 — corrections #14) → guard deterministic là `prefetch={false}`
 * trên link kết quả (listing-card.tsx); header check ở đây là best-effort thêm.
 *
 * `import "server-only"`, KHÔNG "use server" (S-13) — module server thuần.
 */

/** §7.1 — search rate limit (tunable ops parameter; per user/ip, window 60s). */
export const SEARCH_RATE = { limit: 60, windowMs: 60_000 } as const;

/**
 * S-5: authed → `search:user:<userId>`; anonymous → `search:ip:<ip>` (ip do
 * caller tính qua clientIpFromHeaders — TRUST_PROXY_HEADERS=false → "local",
 * MỘT bucket chung mọi anonymous, fail-safe hiện có).
 */
export function searchRateLimitKey(input: { userId: string | null; ip: string }): string {
  return input.userId !== null ? `search:user:${input.userId}` : `search:ip:${input.ip}`;
}

/** Context render search — page truyền vào (S-7: page không chứa logic emit). */
export type SearchTelemetryContext = {
  /** Id THÔ — emit core tự HMAC (b5-review T6); null = anonymous. */
  user: { id: string | null; sessionId: string | null };
  /** Từ request headers (best-effort — bị Proxy strip, xem S-8 ở đầu module). */
  isPrefetch: boolean;
  /** IP client (clientIpFromHeaders) — khóa rate limit anonymous. */
  ip: string;
  /** Resolution của query (Task 5) — rỗng khi browsing. */
  resolution: SearchResolution;
};

/** Kết quả một lần chạy search + telemetry cho page render. */
export type SearchRunResult = {
  plan: SearchQueryPlan;
  listings: SearchListingRow[];
  resultCount: number;
  /** uuid server sinh — ?ss= trên link kết quả (S-14); null khi browsing/throttle. */
  searchSessionId: string | null;
  /** Soft-throttle (§7.1) — page render "Bạn đang tìm nhanh quá…". */
  throttled: boolean;
  /** S-6: event THẬT SỰ được ghi (đọc lại row) — không phải "đã gọi emit". */
  eventsEmitted: { submitted: boolean; zeroResult: boolean };
};

/**
 * Đọc lại sự tồn tại của event theo searchSessionId (§4.2 — eventsEmitted trung
 * thực). Fail (db lỗi) → false: KHÔNG hứa "đã ghi nhận" khi không chắc.
 */
async function productEventExists(name: string, searchSessionId: string): Promise<boolean> {
  try {
    const row = await db.orm.public.ProductEvent.first({ name, searchSessionId });
    return row !== null;
  } catch (e) {
    captureError("telemetry", "SEARCH_EVENT_READBACK_FAILED", {
      name,
      sqlState: (e as { sqlState?: string }).sqlState,
    });
    return false;
  }
}

/**
 * Chạy search + rate limit + telemetry (S-5/S-6/S-7):
 *  1. Query malformed/blank (browsing) → KHÔNG rate limit, KHÔNG emit — vẫn
 *     chạy search;
 *  2. Query hợp lệ → checkRateLimit → denied → soft-throttle (throttled: true,
 *     KHÔNG query, KHÔNG emit);
 *  3. searchSessionId = randomUUID(); runSearchQuery(plan);
 *  4. !isPrefetch → emit search_submitted (facets đã validate S-9 — KHÔNG query
 *     text; province đi cột typed; actor/session id thô → core HMAC);
 *  5. resultCount === 0 → emit search_zero_result (demand record §5.7.1);
 *  6. eventsEmitted = đọc lại row (§4.2) — page chỉ render dòng "ghi nhận nhu
 *     cầu" khi zeroResult === true.
 */
export async function runSearchWithTelemetry(
  input: SearchTelemetryContext & {
    params: SearchQueryParams;
    /** S-9: chỉ emit slug khớp row đã load (page đã load cho form). */
    loadedCategories: { slug: string }[];
    loadedBrands: { slug: string }[];
  },
): Promise<SearchRunResult> {
  const plan = describeSearchQuery(input.params, input.resolution);

  // 1. Browsing (blank/malformed) — KHÔNG rate limit, KHÔNG emit, vẫn chạy search.
  if (!plan.hasQuery) {
    const { listings, resultCount } = await runSearchQuery(plan);
    return {
      plan,
      listings,
      resultCount,
      searchSessionId: null,
      throttled: false,
      eventsEmitted: { submitted: false, zeroResult: false },
    };
  }

  // 2. Rate limit — CHỈ request mang query hợp lệ tốn budget (S-5).
  const key = searchRateLimitKey({ userId: input.user.id, ip: input.ip });
  const decision = checkRateLimit(key, SEARCH_RATE);
  if (!decision.allowed) {
    return {
      plan,
      listings: [],
      resultCount: 0,
      searchSessionId: null,
      throttled: true,
      eventsEmitted: { submitted: false, zeroResult: false },
    };
  }

  // 3. Session id server sinh + query thật.
  const searchSessionId = randomUUID();
  const { listings, resultCount } = await runSearchQuery(plan);

  // 4+5. Emission — KHÔNG bao giờ trong db.transaction (search không có tx) và
  // KHÔNG bao giờ throw ra caller (emit core fail-open; telemetry không phá flow).
  if (!input.isPrefetch) {
    // S-9: slug CHỈ emit khi khớp row đã load — slug lạ từ URL là input không tin.
    const categorySlug = input.loadedCategories.some((c) => c.slug === plan.categorySlug)
      ? plan.categorySlug
      : null;
    const brandSlug = input.loadedBrands.some((b) => b.slug === plan.brandSlug)
      ? plan.brandSlug
      : null;

    await emitProductEvent({
      name: "search_submitted",
      actorId: input.user.id,
      sessionId: input.user.sessionId, // id THÔ — core HMAC một lớp (b5-review T6)
      searchSessionId,
      provinceCode: plan.provinceFilter,
      metadata: {
        resultCount,
        resultListingIds: listings.map((l) => l.id).slice(0, 60), // S-14 — tập kết quả
        ...(categorySlug !== null ? { categorySlug } : {}),
        ...(brandSlug !== null ? { brandSlug } : {}),
        ...(plan.condition !== null ? { conditionFilter: plan.condition } : {}),
        ...(plan.minPrice !== null ? { priceMin: plan.minPrice } : {}),
        ...(plan.maxPrice !== null ? { priceMax: plan.maxPrice } : {}),
        sort: plan.sort,
      },
    });

    // Demand record (spec §5.7.1) — brand/model canonical được tìm, KHÔNG raw text.
    if (resultCount === 0) {
      await emitProductEvent({
        name: "search_zero_result",
        actorId: input.user.id,
        sessionId: input.user.sessionId,
        searchSessionId,
        provinceCode: plan.provinceFilter,
        metadata: {
          resolvedBrandIds: input.resolution.brandIds,
          resolvedModelIds: input.resolution.productModelIds,
        },
      });
    }
  }

  // 6. eventsEmitted trung thực (§4.2): đọc lại row — emit core fail-open có thể
  // đã im lặng không ghi (db lỗi / key chưa cấu hình ngoài production).
  const eventsEmitted = input.isPrefetch
    ? { submitted: false, zeroResult: false }
    : {
        submitted: await productEventExists("search_submitted", searchSessionId),
        zeroResult:
          resultCount === 0 && (await productEventExists("search_zero_result", searchSessionId)),
      };

  return { plan, listings, resultCount, searchSessionId, throttled: false, eventsEmitted };
}
