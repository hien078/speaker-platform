/**
 * Moderation domain module — vocabularies, transitions, guards, snapshots
 * (Batch 3 plan Task 2, spec §5.5/§5.5.1/§7.8).
 *
 * Hợp đồng (plan Task 2 Step 1):
 *  1. REPORT_REASON_CODES đúng CHÍN giá trị §5.5 verbatim, đúng thứ tự;
 *     MODERATION_CASE_STATES đúng BẢY giá trị; các vocabulary PROVISIONAL (A8)
 *     đúng plan interface; rate limits + caps đúng §7.1.
 *  2. MODERATION_LOCKED_LISTING_STATUSES == ["removed"] (R5) + isModerationLocked.
 *  3. canTransition: mọi cặp hợp pháp true, mọi cặp không liệt kê false,
 *     closed terminal (bảng chuyển trạng thái §5.5).
 *  4. moderation-vocab CLIENT-SAFE (B2): source không import db.client /
 *     server-only / rate-limit — client dialog import được.
 *  5. isUserSuspended/getActiveSuspension chỉ đọc row active (lifted/không có
 *     row → không đình chỉ).
 *  6. getBlockState báo ĐÚNG HƯỚNG (S11): viewer_blocked/other_blocked/none.
 *  7. assertCanStartConversation/assertCanSendMessage — ACTOR-SIDE (P1/A2):
 *     initiator/sender đình chỉ → ACCOUNT_SUSPENDED; counterpart/recipient
 *     đình chỉ → resolve (KHÔNG nằm trong §7.8 minimal set); block hai hướng →
 *     CHAT_BLOCKED; đình chỉ THẮNG block (thứ tự pinned).
 *  8. getCaseSubjectUserId: listing → sellerId, user → targetId, message →
 *     senderId, target biến mất → null (fallback — Task 7 ưu tiên evidence).
 *  9. captureTargetSnapshot (spec §5.5.1): listing mang content fields +
 *     sellerId + imageUrls theo sortOrder; user KHÔNG có email/phone (PII
 *     minimization — moderator không giữ user.view_basic); message mang body +
 *     senderId (body LÀ evidence); target không tồn tại → null.
 *
 * Cơ chế mock: server-only + db.client in-memory (User/UserBlock/UserSuspension/
 * Listing/ListingImage/Message) — cùng phong cách tests/unit/session.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

// ─── db.client mock — in-memory 6 model của moderation domain ─────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  blocks: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  listingImages: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  /**
   * M1 tripwire counters (review fix Task 4): query đếm THEO CLIENT nó chạy
   * trên — global db.orm vs tx.orm. captureTargetSnapshot gọi với tx.orm phải
   * chạy TOÀN BỘ query trên tx client (global = 0) — nếu regress, tx report
   * giữ MỘT pool connection và chờ connection THỨ HAI cho snapshot query →
   * ~10 submit đồng thời deadlock pool (default max 10, connectionTimeout 10s)
   * và starve toàn app.
   */
  globalQueries: 0,
  txQueries: 0,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;
  type SortSpec = Array<{ field: string; dir: "asc" | "desc" }>;

  // Field proxy cho lambda predicate — đánh giá trực tiếp trên row
  // (moderation domain chỉ dùng object where; lambda ops cho đầy đủ như
  // session.test.ts, asc/desc trích spec orderBy).
  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          lt: (v: unknown) => (row[field] as number) < (v as number),
          lte: (v: unknown) => (row[field] as number) <= (v as number),
          gt: (v: unknown) => (row[field] as number) > (v as number),
          gte: (v: unknown) => (row[field] as number) >= (v as number),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
          // spec orderBy: (i) => i.sortOrder.asc() → { field, dir }
          asc: () => ({ field, dir: "asc" as const }),
          desc: () => ({ field, dir: "desc" as const }),
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  /** Spec orderBy từ callback — 1 clause hoặc mảng clause. */
  const orderBySpec = (cb: (ops: unknown) => unknown): SortSpec => {
    const spec = cb(fieldOps({} as Row));
    return (Array.isArray(spec) ? spec : [spec]) as SortSpec;
  };

  const sortRows = (rows: Row[], spec: SortSpec): Row[] =>
    [...rows].sort((a, b) => {
      for (const s of spec) {
        const av = a[s.field] as number;
        const bv = b[s.field] as number;
        const cmp = av === bv ? 0 : av > bv ? 1 : -1;
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });

  const makeModel = (rows: Row[], countKey: "globalQueries" | "txQueries") => {
    const query = (preds: Pred[], sortSpec: SortSpec | null, fields: string[] | null) => ({
      where: (pred: Pred) => query([...preds, pred], sortSpec, fields),
      orderBy: (cb: (ops: unknown) => unknown) => query(preds, orderBySpec(cb), fields),
      select: (...f: string[]) => query(preds, sortSpec, f),
      first: async (filter?: Pred) => {
        dbState[countKey]++;
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        return fields === null
          ? { ...hit }
          : Object.fromEntries(fields.map((f) => [f, hit[f]]));
      },
      all: async () => {
        dbState[countKey]++;
        let hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (sortSpec !== null) hit = sortRows(hit, sortSpec);
        return hit.map((r) =>
          fields === null ? { ...r } : Object.fromEntries(fields.map((f) => [f, r[f]])),
        );
      },
    });
    return {
      first: (filter?: Pred) => query([], null, null).first(filter),
      all: () => query([], null, null).all(),
      where: (pred: Pred) => query([pred], null, null),
      orderBy: (cb: (ops: unknown) => unknown) => query([], orderBySpec(cb), null),
      select: (...f: string[]) => query([], null, f),
    };
  };

  /** ORM theo client — cùng store, counter RIÊNG (global vs tx — M1 tripwire). */
  const mkOrm = (countKey: "globalQueries" | "txQueries") => ({
    public: {
      User: makeModel(dbState.users, countKey),
      UserBlock: makeModel(dbState.blocks, countKey),
      UserSuspension: makeModel(dbState.suspensions, countKey),
      Listing: makeModel(dbState.listings, countKey),
      ListingImage: makeModel(dbState.listingImages, countKey),
      Message: makeModel(dbState.messages, countKey),
    },
  });
  return {
    db: {
      orm: mkOrm("globalQueries"),
      // Tx context — client RIÊNG (đếm riêng) nhưng cùng store: pin M1 rằng
      // captureTargetSnapshot(tx.orm) KHÔNG chạm global client.
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: mkOrm("txQueries") }),
    },
  };
});

// moderation.ts re-export vocab (server consumers import mọi thứ từ đó) —
// import từ moderation.ts pin cả re-export lẫn guard; snapshot riêng.
import {
  REPORT_REASON_CODES,
  REPORT_TARGET_TYPES,
  MODERATION_CASE_STATES,
  MODERATION_PRIORITIES,
  ACTIVE_MODERATION_CASE_STATES,
  MODERATION_TRANSITIONS,
  canTransition,
  MODERATION_DECISION_REASON_CODES,
  MODERATION_ASSIGNMENT_REASON_CODES,
  SUSPENSION_REASON_CODES,
  MODERATION_ACTION_TYPES,
  MODERATION_LOCKED_LISTING_STATUSES,
  isModerationLocked,
  REPORT_RATE_LIMIT,
  BLOCK_ACTION_RATE_LIMIT,
  CHAT_SEND_RATE_LIMIT,
  REPORT_NOTE_MAX_LENGTH,
  APPEAL_STATEMENT_MAX_LENGTH,
  isUserSuspended,
  getActiveSuspension,
  getBlockState,
  assertCanStartConversation,
  assertCanSendMessage,
  getCaseSubjectUserId,
} from "@/src/lib/moderation";
import { captureTargetSnapshot } from "@/src/lib/moderation-snapshot";
import { db } from "@/src/prisma/db.client";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
/** Fixture có id kiểu string — truyền thẳng vào guard không cần cast. */
type Fixture = Row & { id: string };

const BUYER: Fixture = {
  id: "user-buyer",
  email: "buyer@loaviet.test",
  passwordHash: "x",
  name: "Người Mua",
  phone: "0900000001",
  role: "buyer",
  avatarUrl: null,
  city: "Hà Nội",
  bio: null,
  isVerifiedSeller: false,
  adminRole: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const SELLER: Fixture = {
  id: "user-seller",
  email: "seller@loaviet.test",
  passwordHash: "x",
  name: "Người Bán",
  phone: "0900000002",
  role: "seller",
  avatarUrl: null,
  city: "TP. Hồ Chí Minh",
  bio: "Cửa hàng loa cũ uy tín",
  isVerifiedSeller: true,
  adminRole: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const LISTING: Fixture = {
  id: "listing-1",
  sellerId: "user-seller",
  categoryId: "cat-1",
  brandId: "brand-1",
  title: "JBL Charge 5 chính hãng",
  slug: "jbl-charge-5-chinh-hang",
  description: "Loa bluetooth còn bảo hành",
  condition: "good",
  price: 2_500_000,
  negotiable: true,
  acceptExchange: false,
  status: "approved",
  rejectionReason: null,
  city: "TP. Hồ Chí Minh",
  viewCount: 10,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

/** Ảnh chèn NGUYÊN THỨ TỰ NGƯỢC sortOrder — pin contract sắp xếp theo sortOrder. */
const seedListingImages = (): void => {
  dbState.listingImages.push(
    { id: "img-2", listingId: "listing-1", url: "https://cdn.loaviet.test/b.jpg", sortOrder: 2 },
    { id: "img-1", listingId: "listing-1", url: "https://cdn.loaviet.test/a.jpg", sortOrder: 1 },
    { id: "img-3", listingId: "listing-1", url: "https://cdn.loaviet.test/c.jpg", sortOrder: 3 },
  );
};

const MESSAGE: Fixture = {
  id: "msg-1",
  conversationId: "convo-1",
  senderId: "user-seller",
  body: "Giá này là giá tốt nhất rồi bạn ơi",
  imageUrl: null,
  readAt: null,
  createdAt: "2026-09-20T00:00:00.000Z",
};

/** Episode đình chỉ active — status tùy case override. */
const suspension = (userId: string, over?: Partial<Row>): Row => ({
  id: `susp-${userId}`,
  userId,
  status: "active",
  reasonCode: "confirmed_abuse",
  note: null,
  suspendedById: "user-ops",
  suspendedAt: "2026-10-01T00:00:00.000Z",
  liftedById: null,
  liftedAt: null,
  liftReasonCode: null,
  ...over,
});

const block = (blockerId: string, blockedId: string): Row => ({
  id: `blk-${blockerId}-${blockedId}`,
  blockerId,
  blockedId,
  createdAt: "2026-10-01T00:00:00.000Z",
});

beforeEach(() => {
  dbState.users.length = 0;
  dbState.blocks.length = 0;
  dbState.suspensions.length = 0;
  dbState.listings.length = 0;
  dbState.listingImages.length = 0;
  dbState.messages.length = 0;
  dbState.users.push({ ...BUYER }, { ...SELLER });
  dbState.listings.push({ ...LISTING });
  seedListingImages();
  dbState.messages.push({ ...MESSAGE });
});

// ─── 1. Vocabularies — spec §5.5 verbatim + PROVISIONAL (A8) ─────────────────

describe("moderation vocab (spec §5.5 verbatim)", () => {
  it("REPORT_REASON_CODES — đúng chín giá trị §5.5, đúng thứ tự", () => {
    expect(REPORT_REASON_CODES).toEqual([
      "suspected_scam",
      "harassment",
      "spam",
      "counterfeit_claim",
      "misleading_listing",
      "prohibited_content",
      "unsafe_behavior",
      "identity_impersonation",
      "other",
    ]);
  });

  it("MODERATION_CASE_STATES — đúng bảy giá trị §5.5, đúng thứ tự", () => {
    expect(MODERATION_CASE_STATES).toEqual([
      "open",
      "triaged",
      "investigating",
      "actioned",
      "dismissed",
      "appealed",
      "closed",
    ]);
  });

  it("REPORT_TARGET_TYPES + MODERATION_PRIORITIES + ACTIVE_MODERATION_CASE_STATES", () => {
    expect(REPORT_TARGET_TYPES).toEqual(["listing", "user", "message"]);
    expect(MODERATION_PRIORITIES).toEqual(["low", "normal", "high"]);
    // Case còn "đang xử lý" — grouping + dedupe (Scope Decisions)
    expect(ACTIVE_MODERATION_CASE_STATES).toEqual(["open", "triaged", "investigating"]);
  });

  it("vocabulary PROVISIONAL (A8) — decision/assignment/suspension reasons + action types", () => {
    expect(MODERATION_DECISION_REASON_CODES).toEqual([
      "no_violation_found",
      "insufficient_evidence",
      "policy_violation_confirmed",
      "resolved_by_sanction",
      "duplicate_case",
      "appeal_closed",
      "other_reviewed_reason",
    ]);
    expect(MODERATION_ASSIGNMENT_REASON_CODES).toEqual([
      "triage_assignment",
      "reassignment",
      "other_reviewed_reason",
    ]);
    expect(SUSPENSION_REASON_CODES).toEqual([
      "confirmed_abuse",
      "confirmed_scam",
      "confirmed_harassment",
      "confirmed_spam",
      "prohibited_content",
      "terms_violation",
      "other_reviewed_reason",
    ]);
    expect(MODERATION_ACTION_TYPES).toEqual([
      "evidence.captured",
      "case.assigned",
      "case.transitioned",
      "listing.taken_down",
      "user.suspended",
      "user.suspension_lifted",
      "appeal.recorded",
    ]);
  });

  it("rate limits (spec §7.1) + caps note/appeal", () => {
    expect(REPORT_RATE_LIMIT).toEqual({ limit: 5, windowMs: 10 * 60_000 });
    expect(BLOCK_ACTION_RATE_LIMIT).toEqual({ limit: 20, windowMs: 60_000 });
    expect(CHAT_SEND_RATE_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
    expect(REPORT_NOTE_MAX_LENGTH).toBe(2000);
    expect(APPEAL_STATEMENT_MAX_LENGTH).toBe(4000);
  });

  it("MODERATION_LOCKED_LISTING_STATUSES is exactly [\"removed\"] (R5) + isModerationLocked", () => {
    expect(MODERATION_LOCKED_LISTING_STATUSES).toEqual(["removed"]);
    expect(isModerationLocked("removed")).toBe(true);
    // mọi status khác KHÔNG locked — lock không over-block
    for (const status of ["draft", "pending", "approved", "rejected", "hidden", "sold"]) {
      expect(isModerationLocked(status)).toBe(false);
    }
  });

  it("moderation-vocab is client-safe (B2) — no db.client / server-only / rate-limit import", () => {
    const src = read("src/lib/moderation-vocab.ts");
    expect(src).not.toContain("db.client");
    expect(src).not.toContain("server-only");
    expect(src).not.toContain("@/src/lib/rate-limit");
  });
});

// ─── 2. Bảng chuyển trạng thái (spec §5.5 states; mechanics, không policy) ─────

describe("canTransition — bảng chuyển trạng thái hợp pháp", () => {
  const legal: Array<[string, string]> = [
    ["open", "triaged"],
    ["open", "investigating"],
    ["open", "dismissed"],
    ["open", "actioned"],
    ["triaged", "investigating"],
    ["triaged", "actioned"],
    ["triaged", "dismissed"],
    ["investigating", "actioned"],
    ["investigating", "dismissed"],
    ["actioned", "appealed"],
    ["actioned", "closed"],
    ["appealed", "closed"],
    ["dismissed", "closed"],
  ];

  it("mọi cặp liệt kê → true", () => {
    for (const [from, to] of legal) {
      expect(canTransition(from as never, to as never)).toBe(true);
    }
  });

  it("mọi cặp KHÔNG liệt kê → false (kể cả tự chuyển + đi ngược)", () => {
    for (const from of MODERATION_CASE_STATES) {
      for (const to of MODERATION_CASE_STATES) {
        const isLegal = legal.some(([f, t]) => f === from && t === to);
        if (!isLegal) {
          expect(canTransition(from, to)).toBe(false);
        }
      }
    }
  });

  it("closed terminal — không có chuyển đi nào", () => {
    expect(MODERATION_TRANSITIONS.closed).toEqual([]);
  });
});

// ─── 3. Suspension guards — chỉ đọc row active (§7.8) ─────────────────────────

describe("isUserSuspended / getActiveSuspension — chỉ row active", () => {
  it("active → true; lifted → false; không row → false", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    await expect(isUserSuspended(BUYER.id)).resolves.toBe(true);
    await expect(isUserSuspended(SELLER.id)).resolves.toBe(false); // không có row

    // lifted → KHÔNG còn đình chỉ (chỉ active chặn)
    dbState.suspensions[0]!.status = "lifted";
    await expect(isUserSuspended(BUYER.id)).resolves.toBe(false);
  });

  it("getActiveSuspension — shape { id, reasonCode, suspendedAt }; lifted/none → null", async () => {
    await expect(getActiveSuspension(BUYER.id)).resolves.toBeNull();

    dbState.suspensions.push(suspension(BUYER.id));
    await expect(getActiveSuspension(BUYER.id)).resolves.toEqual({
      id: `susp-${BUYER.id}`,
      reasonCode: "confirmed_abuse",
      suspendedAt: "2026-10-01T00:00:00.000Z",
    });

    dbState.suspensions[0]!.status = "lifted";
    await expect(getActiveSuspension(BUYER.id)).resolves.toBeNull();
  });
});

// ─── 4. Block state — hướng (S11) ─────────────────────────────────────────────

describe("getBlockState — báo đúng hướng", () => {
  it("A chặn B → viewer_blocked cho (A,B), other_blocked cho (B,A); không row → none", async () => {
    await expect(getBlockState(BUYER.id, SELLER.id)).resolves.toBe("none");

    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(getBlockState(BUYER.id, SELLER.id)).resolves.toBe("viewer_blocked");
    await expect(getBlockState(SELLER.id, BUYER.id)).resolves.toBe("other_blocked");
    // cặp khác không dính block
    await expect(getBlockState(BUYER.id, "user-ngoaivien")).resolves.toBe("none");
  });
});

// ─── 5. Chat guards — actor-side, fail closed (P1/A2) ──────────────────────────

describe("assertCanStartConversation — initiator-side (spec §7.8 actor)", () => {
  it("initiator đình chỉ → ACCOUNT_SUSPENDED; counterpart đình chỉ → resolve (A2)", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    await expect(
      assertCanStartConversation(BUYER.id, SELLER.id),
    ).rejects.toThrow("ACCOUNT_SUSPENDED");

    // counterpart bị đình chỉ KHÔNG được check — không nằm trong §7.8 minimal
    // set (A2) — guard resolve, không over-block.
    dbState.suspensions.length = 0;
    dbState.suspensions.push(suspension(SELLER.id));
    await expect(
      assertCanStartConversation(BUYER.id, SELLER.id),
    ).resolves.toBeUndefined();
  });

  it("block MỌI hướng → CHAT_BLOCKED (spec §5.5 symmetric enforcement)", async () => {
    // buyer chặn seller — initiator là người chặn
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(
      assertCanStartConversation(BUYER.id, SELLER.id),
    ).rejects.toThrow("CHAT_BLOCKED");
    // ...và ngược hướng — initiator là người BỊ chặn cũng bị chặn
    await expect(
      assertCanStartConversation(SELLER.id, BUYER.id),
    ).rejects.toThrow("CHAT_BLOCKED");
  });

  it("đình chỉ THẮNG block (thứ tự lỗi pinned)", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    dbState.blocks.push(block(SELLER.id, BUYER.id));
    await expect(
      assertCanStartConversation(BUYER.id, SELLER.id),
    ).rejects.toThrow("ACCOUNT_SUSPENDED");
  });

  it("không đình chỉ + không block → resolve", async () => {
    await expect(
      assertCanStartConversation(BUYER.id, SELLER.id),
    ).resolves.toBeUndefined();
  });
});

describe("assertCanSendMessage — sender-side (spec §7.8 actor)", () => {
  it("sender đình chỉ → ACCOUNT_SUSPENDED; recipient đình chỉ → resolve (A2)", async () => {
    dbState.suspensions.push(suspension(SELLER.id));
    await expect(
      assertCanSendMessage(SELLER.id, BUYER.id),
    ).rejects.toThrow("ACCOUNT_SUSPENDED");

    // recipient bị đình chỉ KHÔNG check (A2)
    dbState.suspensions.length = 0;
    dbState.suspensions.push(suspension(BUYER.id));
    await expect(
      assertCanSendMessage(SELLER.id, BUYER.id),
    ).resolves.toBeUndefined();
  });

  it("block MỌI hướng → CHAT_BLOCKED; đình chỉ thắng block", async () => {
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(
      assertCanSendMessage(SELLER.id, BUYER.id),
    ).rejects.toThrow("CHAT_BLOCKED");
    await expect(
      assertCanSendMessage(BUYER.id, SELLER.id),
    ).rejects.toThrow("CHAT_BLOCKED");

    dbState.suspensions.push(suspension(SELLER.id));
    await expect(
      assertCanSendMessage(SELLER.id, BUYER.id),
    ).rejects.toThrow("ACCOUNT_SUSPENDED");
  });
});

// ─── 6. Case subject — map target type (fallback cho Task 7) ──────────────────

describe("getCaseSubjectUserId — map từng target type", () => {
  it("listing → sellerId; user → targetId; message → senderId; biến mất → null", async () => {
    await expect(getCaseSubjectUserId("listing", LISTING.id)).resolves.toBe(SELLER.id);
    await expect(getCaseSubjectUserId("user", SELLER.id)).resolves.toBe(SELLER.id);
    await expect(getCaseSubjectUserId("message", MESSAGE.id)).resolves.toBe(
      MESSAGE.senderId,
    );
    // target đã biến mất → null (fail closed, không crash)
    await expect(getCaseSubjectUserId("listing", "listing-khong-ton-tai")).resolves.toBeNull();
    await expect(getCaseSubjectUserId("user", "user-khong-ton-tai")).resolves.toBeNull();
    await expect(getCaseSubjectUserId("message", "msg-khong-ton-tai")).resolves.toBeNull();
  });
});

// ─── 7. Evidence snapshot (spec §5.5.1) ───────────────────────────────────────

describe("captureTargetSnapshot — evidence JSON tại thời điểm báo cáo", () => {
  it("listing: content fields + sellerId + imageUrls THEO sortOrder; không reporter PII", async () => {
    const captured = await captureTargetSnapshot("listing", LISTING.id);
    expect(captured).not.toBeNull();
    expect(captured!.subjectUserId).toBe(SELLER.id);
    expect(captured!.snapshot).toMatchObject({
      kind: "listing",
      id: LISTING.id,
      slug: LISTING.slug,
      title: LISTING.title,
      description: LISTING.description,
      price: LISTING.price,
      condition: LISTING.condition,
      city: LISTING.city,
      status: LISTING.status,
      categoryId: LISTING.categoryId,
      brandId: LISTING.brandId,
      sellerId: SELLER.id,
    });
    // ảnh sắp xếp theo sortOrder (fixture chèn ngược thứ tự)
    expect(captured!.snapshot.imageUrls).toEqual([
      "https://cdn.loaviet.test/a.jpg",
      "https://cdn.loaviet.test/b.jpg",
      "https://cdn.loaviet.test/c.jpg",
    ]);
    // capturedAt ISO string trong mọi snapshot
    expect(typeof captured!.snapshot.capturedAt).toBe("string");
    expect(Date.parse(captured!.snapshot.capturedAt as string)).not.toBeNaN();
    // snapshot không mang PII của reporter (chỉ của target)
    expect(captured!.snapshot).not.toHaveProperty("email");
    expect(captured!.snapshot).not.toHaveProperty("phone");
  });

  it("user: KHÔNG có key email/phone (PII minimization — moderator không giữ user.view_basic)", async () => {
    const captured = await captureTargetSnapshot("user", SELLER.id);
    expect(captured).not.toBeNull();
    expect(captured!.subjectUserId).toBe(SELLER.id);
    expect(captured!.snapshot).toMatchObject({
      kind: "user",
      id: SELLER.id,
      name: SELLER.name,
      bio: SELLER.bio,
      city: SELLER.city,
      role: SELLER.role,
      isVerifiedSeller: SELLER.isVerifiedSeller,
      createdAt: SELLER.createdAt,
    });
    // hợp đồng PII: KHÔNG email/phone trong snapshot (dù User row có cả hai)
    expect(Object.keys(captured!.snapshot)).not.toContain("email");
    expect(Object.keys(captured!.snapshot)).not.toContain("phone");
    expect(captured!.snapshot).not.toHaveProperty("email");
    expect(captured!.snapshot).not.toHaveProperty("phone");
    expect(captured!.snapshot).not.toHaveProperty("passwordHash");
  });

  it("message: mang body + senderId (body LÀ evidence — §5.5.1, không phải analytics §4.8)", async () => {
    const captured = await captureTargetSnapshot("message", MESSAGE.id);
    expect(captured).not.toBeNull();
    expect(captured!.subjectUserId).toBe(MESSAGE.senderId);
    expect(captured!.snapshot).toMatchObject({
      kind: "message",
      id: MESSAGE.id,
      conversationId: MESSAGE.conversationId,
      senderId: MESSAGE.senderId,
      body: MESSAGE.body,
      imageUrl: MESSAGE.imageUrl,
      createdAt: MESSAGE.createdAt,
    });
    expect(typeof captured!.snapshot.capturedAt).toBe("string");
  });

  it("target không tồn tại → null (caller trả typed NOT_FOUND — fail closed)", async () => {
    await expect(captureTargetSnapshot("listing", "listing-khong-ton-tai")).resolves.toBeNull();
    await expect(captureTargetSnapshot("user", "user-khong-ton-tai")).resolves.toBeNull();
    await expect(captureTargetSnapshot("message", "msg-khong-ton-tai")).resolves.toBeNull();
  });

  // ─── M1 (review fix Task 4): snapshot query PHẢI chạy trên client được truyền ───

  it("M1 tripwire: captureTargetSnapshot(tx.orm) chạy MỌI query TRÊN tx client — global client 0 query (pool-deadlock tripwire)", async () => {
    dbState.globalQueries = 0;
    dbState.txQueries = 0;

    let captured: Awaited<ReturnType<typeof captureTargetSnapshot>> = null;
    await db.transaction(async (tx) => {
      captured = await captureTargetSnapshot("listing", LISTING.id, tx.orm);
    });

    expect(captured).not.toBeNull();
    expect(captured!.snapshot).toMatchObject({ kind: "listing", id: LISTING.id });
    expect(captured!.subjectUserId).toBe(SELLER.id);
    // listing.first + ListingImage.all — TẤT CẢ trên tx client…
    expect(dbState.txQueries).toBeGreaterThanOrEqual(2);
    // …và KHÔNG MỘT query nào trên global client: nếu regress (capture dùng
    // db.orm toàn cục), tx report giữ 1 pool connection + chờ connection thứ
    // hai → ~10 submit đồng thời deadlock pool (max 10) — tripwire này đỏ.
    expect(dbState.globalQueries).toBe(0);
  });

  it("M1 default: KHÔNG truyền orm → dùng global client (non-tx caller giữ nguyên chữ ký cũ)", async () => {
    dbState.globalQueries = 0;
    dbState.txQueries = 0;

    const captured = await captureTargetSnapshot("listing", LISTING.id);

    expect(captured).not.toBeNull();
    expect(dbState.globalQueries).toBeGreaterThanOrEqual(2);
    expect(dbState.txQueries).toBe(0);
  });
});
