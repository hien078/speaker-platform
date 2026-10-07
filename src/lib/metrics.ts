/**
 * Metric computation engine (Batch 5 Task 9 — spec §5.8.1) — module THUẦN.
 *
 * Các hàm ĐẾM thuần trên mảng event: KHÔNG đọc db, KHÔNG import "server-only",
 * KHÔNG log (dashboard Task 10 nạp ProductEvent rows từ db rồi gọi). Unit test
 * trực tiếp với fixture viết tay — expected value tính tay trong test
 * (tests/unit/metrics-reconciliation.test.ts — cổng reconciliation).
 *
 * Quy ước engine (khớp contract registry src/lib/metric-contracts.ts):
 *  - "Valid search session" (D1) = MỘT row search_submitted đã emit — query
 *    blank/malformed KHÔNG BAO GIỜ được emit (Task 7) nên không bao giờ vào
 *    denominator theo cấu trúc.
 *  - Exclusion internal (S-12) qua row.isInternal — flag tính LÚC EMIT, không
 *    phụ thuộc pseudonym key ổn định qua rotation. `excludeInternal` mặc định
 *    true; `false` để đối chiếu (fixture test) hoặc dashboard nội bộ.
 *  - Actor/session chỉ tồn tại dưới dạng pseudonym (S-10) — engine không bao giờ
 *    chạm raw user id; mọi join qua actorPseudonym/listingId/conversationId/
 *    searchSessionId.
 *  - Window là THAM SỐ (listingToChat.windowMs, sellerResponseRate.responseWindowMs)
 *    — giá trị production PENDING_FOUNDER_DECISION (A1); fixture test dùng
 *    window CÓ NHÃN, không phải policy.
 *  - searchToChat KHÔNG window (S-16/D3): chain click → conversation unbounded.
 *  - medianFirstResponseTime: dedup theo conversationId, loại buyer internal
 *    qua join anchor (internal SELLER không bị loại — S-18), median lẻ = giữa,
 *    chẵn = trung bình 2 giá trị giữa.
 *  - Không có bot rule (A4) — không exclude gì ngoài isInternal.
 */

/** Shape của row ProductEvent mà engine tiêu thụ (định nghĩa tường minh — nit). */
export type ProductEventRow = {
  id: string;
  name: string;
  occurredAt: string;
  /** HMAC-SHA256(userId, dedicated key) — KHÔNG BAO GIỜ raw user id (S-10). */
  actorPseudonym: string | null;
  /** HMAC-SHA256(UserSession.id, dedicated key) — KHÔNG BAO GIỜ raw session id (S-10). */
  sessionPseudonym: string | null;
  /** Internal cohort ∪ adminRole ≠ null, tính LÚC EMIT (S-12). */
  isInternal: boolean;
  searchSessionId: string | null;
  listingId: string | null;
  conversationId: string | null;
  provinceCode: string | null;
  metadata: Record<string, unknown> | null;
};

/** `excludeInternal` mặc định true — lọc theo row.isInternal (S-12). */
export type MetricOpts = { excludeInternal?: boolean };

// ─── helpers (private) ─────────────────────────────────────────────────────────

type ResolvedOpts = { excludeInternal: boolean };

const resolveOpts = (opts?: MetricOpts): ResolvedOpts => ({
  excludeInternal: opts?.excludeInternal ?? true,
});

/** Exclusion internal (S-12): flag isInternal của row, không phụ thuộc key. */
const keep = (row: ProductEventRow, o: ResolvedOpts): boolean =>
  !o.excludeInternal || !row.isInternal;

/** ISO string → epoch ms (row từ db luôn là timestamptz string hợp lệ). */
const toMs = (iso: string): number => Date.parse(iso);

/** rate = numerator/denominator; denominator 0 → null (không render 0/0). */
const rateOf = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

/** metadata.resultCount nếu là số — null khi thiếu/không phải số (row corrupt). */
const resultCountOf = (row: ProductEventRow): number | null =>
  typeof row.metadata?.resultCount === "number" ? row.metadata.resultCount : null;

/** metadata.responseMs nếu là số hợp lệ ≥ 0 — null khi thiếu (row corrupt). */
const responseMsOf = (row: ProductEventRow): number | null => {
  const ms = row.metadata?.responseMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null;
};

// ─── zero_result_rate_v1 ───────────────────────────────────────────────────────

/**
 * Numerator: valid search sessions với zero eligible results (metadata.resultCount
 * === 0 của chính row search_submitted). Denominator: mọi valid submitted search
 * session. Exclusions: blank/malformed (không emit theo cấu trúc — D1), internal
 * (row.isInternal), automated traffic (A4: chưa có rule). Window per-session.
 */
export function zeroResultRate(
  events: ProductEventRow[],
  opts?: MetricOpts,
): { numerator: number; denominator: number; rate: number | null } {
  const o = resolveOpts(opts);
  const searches = events.filter(
    (e) => e.name === "search_submitted" && keep(e, o),
  );
  const denominator = searches.length;
  const numerator = searches.filter((e) => resultCountOf(e) === 0).length;
  return { numerator, denominator, rate: rateOf(numerator, denominator) };
}

// ─── search_result_ctr_v1 ──────────────────────────────────────────────────────

/**
 * Numerator: eligible search sessions có ≥ 1 result click (dedup SESSION-level
 * theo searchSessionId — click 2 kết quả vẫn là 1). Denominator: eligible search
 * sessions có ≥ 1 kết quả hiển thị (resultCount > 0). Click join theo
 * searchSessionId (S-14: click chỉ emit khi listing ∈ result set đã ghi).
 */
export function searchResultCtr(
  events: ProductEventRow[],
  opts?: MetricOpts,
): { numerator: number; denominator: number; rate: number | null } {
  const o = resolveOpts(opts);
  const sessions = events.filter(
    (e) =>
      e.name === "search_submitted" &&
      keep(e, o) &&
      (resultCountOf(e) ?? 0) > 0,
  );
  const clickedSessionIds = new Set(
    events
      .filter(
        (e) =>
          e.name === "search_result_clicked" &&
          keep(e, o) &&
          e.searchSessionId !== null,
      )
      .map((e) => e.searchSessionId as string),
  );
  const denominator = sessions.length;
  const numerator = sessions.filter(
    (s) => s.searchSessionId !== null && clickedSessionIds.has(s.searchSessionId),
  ).length;
  return { numerator, denominator, rate: rateOf(numerator, denominator) };
}

// ─── listing_to_chat_v1 ────────────────────────────────────────────────────────

/**
 * Numerator: qualified unique listing views sinh conversation MỚI trong
 * attribution window. Denominator: qualified unique listing views.
 * "Qualified" (D2): authenticated (actorPseudonym != null) + non-internal +
 * non-owner (metadata.ownerView !== true — flag của event, Task 8 ghi lúc emit).
 *
 * Dedup "viewer + listing + attribution window" (spec §5.8.1): view cùng
 * (viewer, listing) rơi vào CÙNG epoch window của unit trước đó gộp làm MỘT;
 * view sau window trước đó mở unit MỘI. Join conversation_started theo
 * (actorPseudonym, listingId) với occurredAt ∈ [viewedAt, viewedAt + windowMs].
 * windowMs là THAM SỐ — production PENDING (A1).
 */
export function listingToChat(
  events: ProductEventRow[],
  opts: { windowMs: number } & MetricOpts,
): { numerator: number; denominator: number; rate: number | null } {
  const o = resolveOpts(opts);
  const windowMs = opts.windowMs;

  // Views qualified (D2), sort theo thời gian — epoch dedup cần thứ tự.
  const views = events
    .filter(
      (e) =>
        e.name === "listing_viewed" &&
        keep(e, o) &&
        e.actorPseudonym !== null &&
        e.listingId !== null &&
        e.metadata?.ownerView !== true,
    )
    .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));

  // Dedup theo (viewer, listing) + window epoch: giữ view MỚI ĐẦU của mỗi epoch.
  const units: Array<{ actor: string; listing: string; viewedAt: number }> = [];
  const lastKeptAt = new Map<string, number>();
  for (const view of views) {
    const actor = view.actorPseudonym as string;
    const listing = view.listingId as string;
    const viewedAt = toMs(view.occurredAt);
    const key = `${actor}|${listing}`;
    const prev = lastKeptAt.get(key);
    if (prev !== undefined && viewedAt - prev <= windowMs) {
      continue; // trong epoch window của unit trước → cùng unit (dedup)
    }
    units.push({ actor, listing, viewedAt });
    lastKeptAt.set(key, viewedAt);
  }

  // Conversations mới (chỉ emit khi tạo conversation MỚI — Task 8).
  const conversations = events.filter(
    (e) =>
      e.name === "conversation_started" &&
      keep(e, o) &&
      e.actorPseudonym !== null &&
      e.listingId !== null,
  );

  const denominator = units.length;
  const numerator = units.filter((unit) =>
    conversations.some(
      (c) =>
        (c.actorPseudonym as string) === unit.actor &&
        (c.listingId as string) === unit.listing &&
        toMs(c.occurredAt) >= unit.viewedAt &&
        toMs(c.occurredAt) <= unit.viewedAt + windowMs,
    ),
  ).length;
  return { numerator, denominator, rate: rateOf(numerator, denominator) };
}

// ─── search_to_chat_v1 (S-16/D3 — UNBOUNDED click chain) ───────────────────────

/**
 * Numerator: qualified search sessions mà EVENTUALLY sinh conversation mới
 * QUA KẾT QUẢ ĐÃ CLICK — chain: search_result_clicked.listingId →
 * conversation_started (cùng actor pseudonym, cùng listing, tại hoặc sau
 * click) — KHÔNG time bound (S-16: "eventually" của spec là unbounded).
 * Denominator: mọi qualified search session (D1). KHÔNG window parameter.
 */
export function searchToChat(
  events: ProductEventRow[],
  opts?: MetricOpts,
): { numerator: number; denominator: number; rate: number | null } {
  const o = resolveOpts(opts);
  const sessions = events.filter(
    (e) => e.name === "search_submitted" && keep(e, o),
  );
  const clicks = events.filter(
    (e) =>
      e.name === "search_result_clicked" &&
      keep(e, o) &&
      e.searchSessionId !== null &&
      e.actorPseudonym !== null &&
      e.listingId !== null,
  );
  const conversations = events.filter(
    (e) =>
      e.name === "conversation_started" &&
      keep(e, o) &&
      e.actorPseudonym !== null &&
      e.listingId !== null,
  );

  const denominator = sessions.length;
  const numerator = sessions.filter((session) =>
    clicks.some(
      (click) =>
        click.searchSessionId === session.searchSessionId &&
        conversations.some(
          (c) =>
            (c.actorPseudonym as string) === (click.actorPseudonym as string) &&
            (c.listingId as string) === (click.listingId as string) &&
            toMs(c.occurredAt) >= toMs(click.occurredAt), // SAU click (chain order)
        ),
    ),
  ).length;
  return { numerator, denominator, rate: rateOf(numerator, denominator) };
}

// ─── seller_response_rate_v1 ───────────────────────────────────────────────────

/**
 * Denominator: eligible new buyer conversations (D4) = conversation có ≥ 1 tin
 * buyer — tín hiệu conversation_buyer_first_message (event cơ học, chỉ emit cho
 * tin ĐẦU của buyer). Numerator: những conversation có message_first_response
 * (cùng conversationId) trong [anchor, anchor + responseWindowMs] — anchor =
 * occurredAt của tin buyer đầu. responseWindowMs là THAM SỐ — production
 * PENDING (A1). Internal exclusion theo phía BUYER (isInternal của anchor);
 * internal SELLER không bị loại (S-18).
 */
export function sellerResponseRate(
  events: ProductEventRow[],
  opts: { responseWindowMs: number } & MetricOpts,
): { numerator: number; denominator: number; rate: number | null } {
  const o = resolveOpts(opts);
  const responseWindowMs = opts.responseWindowMs;

  // Anchor D4 — dedup theo conversationId, giữ tin buyer ĐẦU (occurredAt sớm nhất).
  const anchors = events
    .filter(
      (e) =>
        e.name === "conversation_buyer_first_message" &&
        keep(e, o) &&
        e.conversationId !== null,
    )
    .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  const seenConversations = new Set<string>();
  const anchorByConversation = new Map<string, number>();
  for (const anchor of anchors) {
    const conversationId = anchor.conversationId as string;
    if (seenConversations.has(conversationId)) continue;
    seenConversations.add(conversationId);
    anchorByConversation.set(conversationId, toMs(anchor.occurredAt));
  }

  // Response seller — KHÔNG lọc isInternal (S-18: internal seller không bị loại).
  const responses = events.filter(
    (e) => e.name === "message_first_response" && e.conversationId !== null,
  );

  const denominator = anchorByConversation.size;
  const numerator = [...anchorByConversation.entries()].filter(
    ([conversationId, anchorAt]) =>
      responses.some(
        (r) =>
          r.conversationId === conversationId &&
          toMs(r.occurredAt) >= anchorAt &&
          toMs(r.occurredAt) <= anchorAt + responseWindowMs,
      ),
  ).length;
  return { numerator, denominator, rate: rateOf(numerator, denominator) };
}

// ─── median_first_response_time_v1 (S-18 — fully specified) ────────────────────

/**
 * Median thời gian từ tin buyer ĐẦU (anchor D4) đến response seller đầu —
 * responseMs đọc từ metadata của message_first_response (tính lúc emit).
 * Dedup theo conversationId (mỗi convo đóng góp MỘT responseMs — event chỉ emit
 * một lần, dedup phòng backfill/đếm đôi; giữ row occurredAt sớm nhất).
 * Exclusion internal qua join anchor conversation_buyer_first_message.isInternal
 * (phía BUYER — internal seller không bị loại, S-18). Response KHÔNG có anchor
 * qualified → bị loại (fail-closed: không xác định được eligibility).
 * Median: lẻ → giá trị giữa; chẵn → trung bình 2 giá trị giữa.
 */
export function medianFirstResponseTime(
  events: ProductEventRow[],
  opts?: MetricOpts,
): { medianMs: number | null; sample: number } {
  const o = resolveOpts(opts);

  // Eligibility (D4): conversation có anchor buyer-first-message không internal.
  const eligibleConversations = new Set<string>();
  for (const e of events) {
    if (e.name !== "conversation_buyer_first_message") continue;
    if (e.conversationId === null) continue;
    if (!keep(e, o)) continue;
    eligibleConversations.add(e.conversationId);
  }

  // Response seller — dedup theo conversationId, giữ occurredAt sớm nhất.
  const responses = events
    .filter((e) => e.name === "message_first_response" && e.conversationId !== null)
    .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  const consumed = new Set<string>();
  const responseMsByConversation = new Map<string, number>();
  for (const r of responses) {
    const conversationId = r.conversationId as string;
    if (consumed.has(conversationId)) continue; // dedup — row sớm nhất đã xử lý
    consumed.add(conversationId);
    if (!eligibleConversations.has(conversationId)) continue; // fail-closed
    const ms = responseMsOf(r);
    if (ms === null) continue; // metadata thiếu responseMs → không đóng góp duration
    responseMsByConversation.set(conversationId, ms);
  }

  const samples = [...responseMsByConversation.values()].sort((a, b) => a - b);
  const sample = samples.length;
  if (sample === 0) return { medianMs: null, sample: 0 };
  const mid = Math.floor(sample / 2);
  const medianMs =
    sample % 2 === 1
      ? samples[mid] // lẻ → giá trị giữa
      : (samples[mid - 1] + samples[mid]) / 2; // chẵn → trung bình 2 giá trị giữa
  return { medianMs, sample };
}

// ─── successful_match_rate_v1 — chỉ COUNT (rate PENDING — A2) ──────────────────

/**
 * Đếm event successful_match (exclusion internal qua isInternal). RATE bị chặn
 * bởi A2 (reconciliation policy/attribution period/duplicate handling chưa
 * định nghĩa) + Deal domain của Batch 6 — dashboard hiển thị COUNT thô,
 * honest zero cho đến khi Batch 6 emit.
 */
export function successfulMatchCount(
  events: ProductEventRow[],
  opts?: MetricOpts,
): number {
  const o = resolveOpts(opts);
  return events.filter((e) => e.name === "successful_match" && keep(e, o)).length;
}
