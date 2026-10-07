/**
 * Product-event taxonomy + emit core (Batch 5 Task 6 — spec §5.8/§4.8) — unit tests.
 *
 * CỔNG validation + PII rejection của batch (Review Focus 1):
 *  - mọi event validate theo per-event zod schema (.strict()) — sai schema →
 *    KHÔNG row, log chỉ mang event name + rule (KHÔNG BAO GIỜ payload/value);
 *  - PII guard (B8) quét shape CHỈ trên free string field (schema khai báo
 *    z.string() tự do); field đã zod TYPED (z.uuid()/z.enum/number/boolean/
 *    array) MIỄN NHIỄM — 1000 random UUID không bao giờ bị reject;
 *  - actor/session lưu DUY NHẤT dạng HMAC-SHA256 dưới key dedicated
 *    PRODUCT_EVENT_PSEUDONYM_KEY (S-10/S-11) — không bao giờ id thô;
 *  - fail-open: lỗi db/key KHÔNG phá product flow (telemetry KHÔNG phải ranh
 *    giới sản phẩm); fail-closed: lỗi validation/PII → không row.
 *
 * Cơ chế mock: db.client in-memory (ProductEvent/BetaCohortMembership/User)
 * theo kiểu tests/unit/beta-cohort.test.ts; observability spy để assert log
 * rejection KHÔNG mang value; env stub key test base64 của đúng 32 byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";

vi.mock("server-only", () => ({}));

// captureError spy — rejection log PHẢI mang event name + rule, KHÔNG BAO GIỜ value.
vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── db.client mock — in-memory ProductEvent/BetaCohortMembership/User ────────

const dbState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  fail: {} as {
    eventCreate?: unknown;
    membershipFirst?: unknown;
    userFirst?: unknown;
    membershipAll?: unknown;
  },
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = Record<string, unknown>;
  const matches = (row: Row, pred: Pred) =>
    Object.entries(pred).every(([k, v]) => row[k] === v);

  const membershipModel = {
    first: async (filter?: Pred) => {
      if (dbState.fail.membershipFirst) throw dbState.fail.membershipFirst;
      const hit = dbState.memberships.find((r) => filter === undefined || matches(r, filter));
      return hit === undefined ? null : { ...hit };
    },
    where: (pred: Pred) => ({
      all: async () => {
        if (dbState.fail.membershipAll) throw dbState.fail.membershipAll;
        return dbState.memberships.filter((r) => matches(r, pred)).map((r) => ({ ...r }));
      },
    }),
  };

  const userModel = {
    first: async (filter?: Pred) => {
      if (dbState.fail.userFirst) throw dbState.fail.userFirst;
      const hit = dbState.users.find((r) => filter === undefined || matches(r, filter));
      return hit === undefined ? null : { ...hit };
    },
  };

  const productEventModel = {
    create: async (data: Row) => {
      if (dbState.fail.eventCreate) throw dbState.fail.eventCreate;
      const row = {
        id: `pe-${dbState.events.length + 1}`,
        occurredAt: new Date().toISOString(),
        ...data,
      };
      dbState.events.push(row);
      return { ...row };
    },
  };

  return {
    db: {
      orm: {
        public: {
          ProductEvent: productEventModel,
          BetaCohortMembership: membershipModel,
          User: userModel,
        },
      },
    },
  };
});

import {
  EVENT_SCHEMAS,
  METADATA_KEY_DENYLIST,
  PRODUCT_EVENT_NAMES,
  PRODUCT_EVENT_SCHEMA_VERSION,
  actorPseudonymFor,
  cohortPseudonyms,
  emitProductEvent,
  isDenylistedMetadataKey,
  isInternalActor,
  sessionPseudonymFor,
  type ProductEventName,
} from "@/src/lib/product-events";
import { captureError } from "@/src/lib/observability";

const captureErrorMock = vi.mocked(captureError);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Key test hợp lệ — base64 của đúng 32 byte (như ADMIN_MFA_ENCRYPTION_KEY test). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

const mkUser = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "user-x",
  email: "x@loaviet.test",
  name: "X",
  role: "buyer",
  adminRole: null,
  ...over,
});

const resetStores = () => {
  dbState.events.length = 0;
  dbState.memberships.length = 0;
  dbState.users.length = 0;
  dbState.fail = {};
};

beforeEach(() => {
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  vi.stubEnv("NODE_ENV", "test");
  resetStores();
  captureErrorMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Pseudonym — dedicated key HMAC (S-10/S-11) ───────────────────────────────

describe("pseudonym dưới key dedicated (S-10/S-11)", () => {
  it("actorPseudonymFor: 64-hex, ổn định per user, khác per user, !== userId", () => {
    const p1 = actorPseudonymFor("user-a");
    expect(p1).toMatch(/^[0-9a-f]{64}$/);
    expect(actorPseudonymFor("user-a")).toBe(p1); // ổn định per user per key version
    expect(actorPseudonymFor("user-b")).not.toBe(p1);
    expect(p1).not.toBe("user-a");
  });

  it("sessionPseudonymFor: 64-hex, ổn định, khác per session, !== raw session id", () => {
    const s1 = sessionPseudonymFor("sess-1");
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionPseudonymFor("sess-1")).toBe(s1);
    expect(sessionPseudonymFor("sess-2")).not.toBe(s1);
    expect(s1).not.toBe("sess-1");
  });

  it("actor ≠ session pseudonym cho cùng id (HKDF info khác nhau — domain separation)", () => {
    expect(actorPseudonymFor("same-id")).not.toBe(sessionPseudonymFor("same-id"));
  });

  it("đổi key dedicated → pseudonym đổi (KHÔNG derive từ AUTH_SECRET — S-11)", () => {
    const before = actorPseudonymFor("user-a");
    vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", OTHER_KEY);
    expect(actorPseudonymFor("user-a")).not.toBe(before);
    // về key cũ → pseudonym về lại (định danh ổn định theo key version)
    vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
    expect(actorPseudonymFor("user-a")).toBe(before);
  });
});

// ─── isInternalActor (S-12) ───────────────────────────────────────────────────

describe("isInternalActor (S-12 — tính LÚC emit, không phụ thuộc key)", () => {
  it("internal cohort ACTIVE → true; invited/suspended → false; founding_seller → false", async () => {
    dbState.memberships.push(
      { id: "m1", userId: "u-int", cohort: "internal", status: "active" },
      { id: "m2", userId: "u-inv", cohort: "internal", status: "invited" },
      { id: "m3", userId: "u-sus", cohort: "internal", status: "suspended" },
      { id: "m4", userId: "u-fs", cohort: "founding_seller", status: "active" },
    );
    await expect(isInternalActor("u-int")).resolves.toBe(true);
    await expect(isInternalActor("u-inv")).resolves.toBe(false);
    await expect(isInternalActor("u-sus")).resolves.toBe(false);
    // founding_seller KHÔNG phải internal — exclusion chỉ theo cohort internal
    await expect(isInternalActor("u-fs")).resolves.toBe(false);
  });

  it("adminRole != null → true (mọi role admin); user thường → false", async () => {
    dbState.users.push(
      mkUser({ id: "u-analyst", adminRole: "analyst" }),
      mkUser({ id: "u-mod", adminRole: "moderator" }),
      mkUser({ id: "u-plain", adminRole: null }),
    );
    await expect(isInternalActor("u-analyst")).resolves.toBe(true);
    await expect(isInternalActor("u-mod")).resolves.toBe(true);
    await expect(isInternalActor("u-plain")).resolves.toBe(false);
  });
});

// ─── emitProductEvent — row hợp lệ ────────────────────────────────────────────

describe("emitProductEvent — row hợp lệ", () => {
  it("ghi name/schemaVersion/occurredAt/pseudonym/pseudonymKeyVersion/isInternal — KHÔNG id thô (S-10)", async () => {
    dbState.users.push(mkUser({ id: "user-9" }));
    await emitProductEvent({
      name: "listing_viewed",
      actorId: "user-9",
      sessionId: "sess-9",
      listingId: "listing-9",
      provinceCode: "ha-noi",
      metadata: { ownerView: false, fromSearch: true },
    });
    expect(dbState.events).toHaveLength(1);
    const row = dbState.events[0]!;
    expect(row["name"]).toBe("listing_viewed");
    expect(row["schemaVersion"]).toBe(PRODUCT_EVENT_SCHEMA_VERSION);
    expect(typeof row["occurredAt"]).toBe("string");
    expect(row["actorPseudonym"]).toBe(actorPseudonymFor("user-9"));
    expect(row["sessionPseudonym"]).toBe(sessionPseudonymFor("sess-9"));
    expect(row["pseudonymKeyVersion"]).toBe("1");
    expect(row["isInternal"]).toBe(false);
    expect(row["listingId"]).toBe("listing-9");
    expect(row["provinceCode"]).toBe("ha-noi");
    expect(row["searchSessionId"]).toBeNull();
    // KHÔNG id thô ở bất kỳ cột/metadata nào (S-10)
    expect(JSON.stringify(row)).not.toContain("user-9");
    expect(JSON.stringify(row)).not.toContain("sess-9");
  });

  it("actor internal → isInternal true; anonymous → pseudonym null + isInternal false", async () => {
    dbState.memberships.push({ id: "m", userId: "u-int", cohort: "internal", status: "active" });
    await emitProductEvent({
      name: "listing_viewed",
      actorId: "u-int",
      metadata: { ownerView: true, fromSearch: false },
    });
    expect(dbState.events[0]!["isInternal"]).toBe(true);

    await emitProductEvent({ name: "search_result_clicked", searchSessionId: "ss-1", listingId: "l-1" });
    const anon = dbState.events[1]!;
    expect(anon["actorPseudonym"]).toBeNull();
    expect(anon["sessionPseudonym"]).toBeNull();
    expect(anon["isInternal"]).toBe(false);
    expect(anon["metadata"]).toBeNull(); // schema {} + không metadata → null
  });

  it("search_submitted hợp lệ → metadata lưu resultCount + resultListingIds (không query text)", async () => {
    const ids = [randomUUID(), randomUUID()];
    await emitProductEvent({
      name: "search_submitted",
      actorId: "u-1",
      searchSessionId: "ss-1",
      provinceCode: "ha-noi",
      metadata: {
        resultCount: 2,
        resultListingIds: ids,
        categorySlug: "portable_bluetooth_speaker",
        brandSlug: "jbl",
        conditionFilter: "good",
        priceMin: 100,
        priceMax: 900,
        sort: "relevance",
      },
    });
    const row = dbState.events[0]!;
    expect(row["searchSessionId"]).toBe("ss-1");
    expect(row["metadata"]).toEqual({
      resultCount: 2,
      resultListingIds: ids,
      categorySlug: "portable_bluetooth_speaker",
      brandSlug: "jbl",
      conditionFilter: "good",
      priceMin: 100,
      priceMax: 900,
      sort: "relevance",
    });
  });

  it("search_zero_result hợp lệ → resolved ids (demand record — KHÔNG raw text)", async () => {
    await emitProductEvent({
      name: "search_zero_result",
      searchSessionId: "ss-2",
      metadata: { resolvedBrandIds: [randomUUID()], resolvedModelIds: [] },
    });
    expect(dbState.events).toHaveLength(1);
  });
});

// ─── Schema validation — fail-closed (S-9) ────────────────────────────────────

describe("emitProductEvent — schema validation fail-closed (S-9)", () => {
  it("event name ngoài taxonomy → rejected, KHÔNG row", async () => {
    await emitProductEvent({ name: "money_moved" as ProductEventName, metadata: {} });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [scope, code, meta] = captureErrorMock.mock.calls[0]!;
    expect(scope).toBe("telemetry");
    expect(code).toBe("TELEMETRY_SCHEMA_REJECTED");
    expect(meta).toMatchObject({ name: "money_moved" });
  });

  it("resultCount sai type → rejected, KHÔNG row", async () => {
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: "many", resultListingIds: [] },
    });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock.mock.calls[0]![1]).toBe("TELEMETRY_SCHEMA_REJECTED");
    expect(captureErrorMock.mock.calls[0]![2]).toMatchObject({ name: "search_submitted" });
  });

  it("extra metadata key → rejected (strict schema — closed struct)", async () => {
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: 0, resultListingIds: [], zzz: 1 },
    });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock.mock.calls[0]![1]).toBe("TELEMETRY_SCHEMA_REJECTED");
  });

  it("sort ngoài enum → rejected (z.enum — S-9)", async () => {
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: 0, resultListingIds: [], sort: "weird" },
    });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock.mock.calls[0]![1]).toBe("TELEMETRY_SCHEMA_REJECTED");
  });

  it("resultListingIds chứa string non-uuid → rejected (z.uuid())", async () => {
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: 1, resultListingIds: ["not-a-uuid"] },
    });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock.mock.calls[0]![1]).toBe("TELEMETRY_SCHEMA_REJECTED");
  });

  it("listing_viewed thiếu ownerView/fromSearch → rejected (required field)", async () => {
    await emitProductEvent({ name: "listing_viewed", metadata: { ownerView: false } });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock.mock.calls[0]![1]).toBe("TELEMETRY_SCHEMA_REJECTED");
  });

  it("schema rejection log KHÔNG mang value/path — chỉ event name + issue codes (correction #17)", async () => {
    const secret = "0901234567";
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: secret, resultListingIds: [] },
    });
    expect(dbState.events).toHaveLength(0);
    const call = captureErrorMock.mock.calls[0]!;
    expect(call[1]).toBe("TELEMETRY_SCHEMA_REJECTED");
    expect(JSON.stringify(call)).not.toContain(secret);
    expect(JSON.stringify(call)).toContain("search_submitted");
  });
});

// ─── PII guard — fail-closed (B8, spec §4.8) ──────────────────────────────────

describe("emitProductEvent — PII guard fail-closed (B8, spec §4.8)", () => {
  /** Emit search_submitted hợp lệ + override metadata — expect PII reject + 0 row. */
  const expectPiiRejected = async (
    metadata: Record<string, unknown>,
    rule: string | RegExp,
  ): Promise<void> => {
    captureErrorMock.mockClear(); // một emit = một rejection — đếm per-call
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: 0, resultListingIds: [], ...metadata },
    });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [scope, code, meta] = captureErrorMock.mock.calls[0]!;
    expect(scope).toBe("telemetry");
    expect(code).toBe("TELEMETRY_PII_REJECTED");
    expect(meta).toMatchObject({ name: "search_submitted" });
    if (typeof rule === "string") expect(meta).toMatchObject({ rule });
    else expect(String(meta?.["rule"])).toMatch(rule);
  };

  it("email-shape trong free string field (categorySlug) → rejected", async () => {
    await expectPiiRejected({ categorySlug: "lienhe@example.com" }, "email_shape");
  });

  it("phone-shape trong free string field (brandSlug) → rejected", async () => {
    await expectPiiRejected({ brandSlug: "0901234567" }, "phone_shape");
  });

  it("OTP-6-digit-shape trong free string field → rejected", async () => {
    await expectPiiRejected({ categorySlug: "123456" }, "otp_shape");
  });

  it("IP-shape trong free string field → rejected", async () => {
    await expectPiiRejected({ categorySlug: "10.0.13.37" }, "ip_shape");
  });

  it("IPv6-shape trong free string field → rejected", async () => {
    await expectPiiRejected({ categorySlug: "2001:db8:1234:5678:9abc:def0:1234:5678" }, "ip_shape");
  });

  it("string > 120 ký tự trong free string field → rejected", async () => {
    await expectPiiRejected({ categorySlug: "x".repeat(121) }, "overlength");
  });

  it("key denylist: note/phone/ip/body → rejected dù value vô hại", async () => {
    await expectPiiRejected({ note: "hello" }, "denylisted_key:note");
    await expectPiiRejected({ phone: "0901234567" }, "denylisted_key:phone");
    await expectPiiRejected({ ip: "10.0.13.37" }, "denylisted_key:ip");
    await expectPiiRejected({ body: "y".repeat(121) }, "denylisted_key:body");
  });

  it("key ngoài schema + value PII shape → rejected ({ code: '123456' } — OTP shape)", async () => {
    await expectPiiRejected({ code: "123456" }, "otp_shape");
  });

  it("rejection log KHÔNG BAO GIỜ mang value — chỉ event name + rule (Review Focus 1)", async () => {
    const secret = "lienhe@example.com";
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: 0, resultListingIds: [], categorySlug: secret },
    });
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const call = captureErrorMock.mock.calls[0]!;
    expect(JSON.stringify(call)).not.toContain(secret);
    expect(JSON.stringify(call)).toContain("search_submitted");
    expect(JSON.stringify(call)).toContain("TELEMETRY_PII_REJECTED");
  });

  it("1000 random UUID trong id-typed fields KHÔNG BAO GIỜ bị reject (B8)", async () => {
    for (let i = 0; i < 1000; i++) {
      await emitProductEvent({
        name: "search_submitted",
        actorId: randomUUID(),
        sessionId: randomUUID(),
        searchSessionId: randomUUID(),
        listingId: randomUUID(),
        productModelId: randomUUID(),
        conversationId: randomUUID(),
        metadata: { resultCount: 1, resultListingIds: [randomUUID()] },
      });
    }
    expect(dbState.events).toHaveLength(1000);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});

// ─── Key denylist — exact/word match, KHÔNG substring (nit) ────────────────────

describe("key denylist — exact/word match (nit — không substring)", () => {
  it("isDenylistedMetadataKey: ranh giới từ, KHÔNG substring", () => {
    expect(isDenylistedMetadataKey("ip")).toBe(true);
    expect(isDenylistedMetadataKey("user_ip")).toBe(true); // ranh giới `_`
    expect(isDenylistedMetadataKey("ip_address")).toBe(true);
    expect(isDenylistedMetadataKey("shipping")).toBe(false); // "ip" KHÔNG khớp substring
    expect(isDenylistedMetadataKey("membership")).toBe(false);
    expect(isDenylistedMetadataKey("note")).toBe(true);
    expect(isDenylistedMetadataKey("categorySlug")).toBe(false);
    expect(isDenylistedMetadataKey("brandSlug")).toBe(false);
  });

  it("hành vi: key 'shipping' KHÔNG bị denylist 'ip' ăn — rơi về schema rejection", async () => {
    await emitProductEvent({
      name: "search_submitted",
      metadata: { resultCount: 0, resultListingIds: [], shipping: "ok" },
    });
    expect(dbState.events).toHaveLength(0);
    const [, code] = captureErrorMock.mock.calls[0]!;
    // "shipping" không denylisted → schema reject (unknown key) — chứng minh
    // denylist KHÔNG substring match (nếu substring, code là PII_REJECTED).
    expect(code).toBe("TELEMETRY_SCHEMA_REJECTED");
  });

  it("METADATA_KEY_DENYLIST là word-list đóng — không chứa key của schema nào", () => {
    const denylistRe = new RegExp(
      `(^|[^A-Za-z0-9])(${METADATA_KEY_DENYLIST.join("|")})([^A-Za-z0-9]|$)`,
      "i",
    );
    for (const schema of Object.values(EVENT_SCHEMAS)) {
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      for (const key of Object.keys(shape)) {
        // assert KEY (tên event "message_first_response" là của spec §5.8 —
        // không phải metadata key, không thuộc phạm vi denylist)
        expect(key).not.toMatch(denylistRe);
      }
    }
  });
});

// ─── Structural — taxonomy đóng, không field free-text/query ───────────────────

describe("structural — taxonomy (spec §5.8 + D4)", () => {
  it("EVENT_SCHEMAS đủ 20 event: 19 của spec §5.8 + conversation_buyer_first_message (D4)", () => {
    expect(PRODUCT_EVENT_NAMES).toHaveLength(20);
    expect(Object.keys(EVENT_SCHEMAS)).toHaveLength(20);
    expect(Object.fromEntries(Object.entries(EVENT_SCHEMAS).map(([k, _v]) => [k, k]))).toEqual(
      Object.fromEntries(PRODUCT_EVENT_NAMES.map((n) => [n, n])),
    );
    // 12 event initial của spec §5.8 verbatim
    for (const name of [
      "search_submitted",
      "search_zero_result",
      "search_result_clicked",
      "listing_viewed",
      "conversation_started",
      "message_first_response",
      "deal_created",
      "deal_outcome_marked",
      "successful_match",
      "listing_marked_sold",
      "report_submitted",
      "user_returned",
    ]) {
      expect(PRODUCT_EVENT_NAMES).toContain(name);
    }
    // 7 beta-operations events của spec §5.8
    for (const name of [
      "seller_invited",
      "seller_registered",
      "seller_verified",
      "seller_first_listing_published",
      "listing_rejected",
      "listing_removed",
      "beta_membership_activated",
    ]) {
      expect(PRODUCT_EVENT_NAMES).toContain(name);
    }
    // + 1 event tín hiệu cơ học (D4 — flagged cho founder, schema-versioned)
    expect(PRODUCT_EVENT_NAMES).toContain("conversation_buyer_first_message");
  });

  it("KHÔNG schema nào có key khớp /query|text|body|message|note|email|phone|address|name/i", () => {
    const banned = /query|text|body|message|note|email|phone|address|name/i;
    for (const schema of Object.values(EVENT_SCHEMAS)) {
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      for (const key of Object.keys(shape)) {
        // assert KEY — tên EVENT "message_first_response" là của spec §5.8
        // verbatim (không phải metadata key), ngoài phạm vi banned.
        expect(key).not.toMatch(banned);
      }
    }
  });

  it("report_submitted: targetType/reasonCode typed enum — KHÔNG targetId (PII rule, corrections #6)", () => {
    const shape = (EVENT_SCHEMAS["report_submitted"] as unknown as { shape: Record<string, unknown> })
      .shape;
    expect(Object.keys(shape).sort()).toEqual(["reasonCode", "targetType"]);
  });
});

// ─── Fail-open — telemetry KHÔNG phá product flow ────────────────────────────

describe("emitProductEvent — fail-open (correction #9)", () => {
  it("db insert throw → emit resolves KHÔNG throw, log chỉ sqlState (correction #17)", async () => {
    dbState.fail.eventCreate = new SqlQueryError("insert failed", { sqlState: "53300" });
    await expect(
      emitProductEvent({
        name: "listing_viewed",
        actorId: "u-1",
        metadata: { ownerView: false, fromSearch: true },
      }),
    ).resolves.toBeUndefined();
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [scope, code, meta] = captureErrorMock.mock.calls[0]!;
    expect(scope).toBe("telemetry");
    expect(code).toBe("TELEMETRY_EMIT_FAILED");
    expect(meta).toMatchObject({ name: "listing_viewed", sqlState: "53300" });
    // log KHÔNG mang message lỗi db (có thể chứa payload) — chỉ sqlState
    expect(JSON.stringify(captureErrorMock.mock.calls[0]!)).not.toContain("insert failed");
  });

  it("isInternalActor db throw → row VẪN ghi với isInternal=false + log", async () => {
    dbState.fail.membershipFirst = new Error("membership read failed");
    await expect(
      emitProductEvent({
        name: "listing_viewed",
        actorId: "u-1",
        metadata: { ownerView: false, fromSearch: true },
      }),
    ).resolves.toBeUndefined();
    expect(dbState.events).toHaveLength(1);
    expect(dbState.events[0]!["isInternal"]).toBe(false);
    expect(captureErrorMock).toHaveBeenCalledWith(
      "telemetry",
      "TELEMETRY_INTERNAL_LOOKUP_FAILED",
      expect.objectContaining({ name: "listing_viewed" }),
    );
  });

  it("key chưa cấu hình NGOÀI production → silent no-op, KHÔNG captureError", async () => {
    vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", undefined);
    await expect(
      emitProductEvent({
        name: "listing_viewed",
        actorId: "u-1",
        metadata: { ownerView: false, fromSearch: true },
      }),
    ).resolves.toBeUndefined();
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("key chưa cấu hình Ở production → KHÔNG row + captureError typed code (fail-open)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", undefined);
    await expect(
      emitProductEvent({
        name: "listing_viewed",
        actorId: "u-1",
        metadata: { ownerView: false, fromSearch: true },
      }),
    ).resolves.toBeUndefined();
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [scope, code, meta] = captureErrorMock.mock.calls[0]!;
    expect(scope).toBe("telemetry");
    expect(String(code)).toContain("TELEMETRY_KEY_UNAVAILABLE");
    expect(meta).toMatchObject({ name: "listing_viewed", code: "PRODUCT_EVENT_KEY_UNCONFIGURED" });
  });

  it("key SAI dạng (không base64-32) ở production → KHÔNG row + typed INVALID", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", "not-base64!!!");
    await expect(
      emitProductEvent({
        name: "listing_viewed",
        metadata: { ownerView: false, fromSearch: true },
      }),
    ).resolves.toBeUndefined();
    expect(dbState.events).toHaveLength(0);
    expect(captureErrorMock.mock.calls[0]![2]).toMatchObject({
      code: "PRODUCT_EVENT_KEY_INVALID",
    });
  });
});

// ─── cohortPseudonyms — segmentation (KHÔNG phải exclusion) ─────────────────────

describe("cohortPseudonyms — segmentation theo cohort (Task 10)", () => {
  it("trả pseudonym của member ACTIVE của cohort — khớp actorPseudonymFor", async () => {
    dbState.memberships.push(
      { id: "m1", userId: "u-a", cohort: "founding_seller", status: "active" },
      { id: "m2", userId: "u-b", cohort: "founding_seller", status: "active" },
      { id: "m3", userId: "u-c", cohort: "founding_seller", status: "invited" },
      { id: "m4", userId: "u-d", cohort: "internal", status: "active" },
    );
    const pseudonyms = await cohortPseudonyms("founding_seller");
    expect(pseudonyms.sort()).toEqual(
      [actorPseudonymFor("u-a"), actorPseudonymFor("u-b")].sort(),
    );
    expect(pseudonyms).not.toContain(actorPseudonymFor("u-c")); // invited ≠ active
    expect(pseudonyms).not.toContain(actorPseudonymFor("u-d")); // cohort khác
  });

  it("db throw → fail-open [] + captureError (dashboard không vỡ)", async () => {
    dbState.fail.membershipAll = new SqlQueryError("read failed", { sqlState: "53300" });
    await expect(cohortPseudonyms("internal")).resolves.toEqual([]);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0]![1]).toBe("TELEMETRY_COHORT_READ_FAILED");
  });
});

// ─── Source-contract (S-13) ────────────────────────────────────────────────────

describe("source-contract (S-13)", () => {
  const read = (p: string): string =>
    readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  /** Directive "use server" tồn tại ở DÒNG nào đó (không phải nhắc trong comment). */
  const hasUseServerDirective = (src: string): boolean =>
    src.split("\n").some((line) => /^\s*["']use server["']\s*;?\s*$/.test(line));

  /** Directive import "server-only" tồn tại ở DÒNG nào đó. */
  const hasServerOnlyImport = (src: string): boolean =>
    src.split("\n").some((line) => /^\s*import\s+["']server-only["']\s*;?\s*$/.test(line));

  it("product-events.ts: import 'server-only', KHÔNG directive 'use server'", () => {
    const src = read("../../src/lib/product-events.ts");
    expect(hasServerOnlyImport(src)).toBe(true);
    expect(hasUseServerDirective(src)).toBe(false);
  });

  it("product-event-key.ts: PLAIN module — KHÔNG 'server-only', KHÔNG 'use server'", () => {
    const src = read("../../src/lib/product-event-key.ts");
    expect(hasServerOnlyImport(src)).toBe(false);
    expect(hasUseServerDirective(src)).toBe(false);
  });

  it("product-events.ts KHÔNG viết audit log bảo mật của Batch 2 (S10 — domain riêng)", () => {
    const src = read("../../src/lib/product-events.ts");
    expect(src).not.toMatch(/AuditEvent|auditEvent/);
  });

  it("seam sessionId THÔ (b5-review T6): input CHỈ có sessionId — KHÔNG input sessionPseudonym (HMAC kép)", () => {
    // Plan Task 6 (L650): `sessionId?: string | null; // UserSession.id — tự
    // pseudonymize thành sessionPseudonym (S-10)` + corrections #15 (emitters
    // dùng getCurrentUser().sessionId — KHÔNG lookup session lần hai). Emitters
    // Task 7/8 KHÔNG được truyền pseudonym precomputed: emit input không có
    // field sessionPseudonym, và pseudonym hóa xảy ra MỘT lớp trong emit core.
    const src = read("../../src/lib/product-events.ts");
    expect(src).toMatch(/sessionId\?: string \| null/); // input là session id thô
    expect(src).not.toMatch(/sessionPseudonym\?:/); // KHÔNG có input pseudonym precomputed
    expect(src).toMatch(/sessionPseudonymFor\(sessionId\)/); // MỘT lớp HMAC, trong emit core
  });
});
