/**
 * Seller Verification Policy v1 — publication gate (plan Task 10, spec §5.3.3
 * + §4.4/§4.9/§2.1; Batch 3 Task 5 mở rộng 8 yêu cầu — spec §7.8) — unit tests.
 *
 * Tám yêu cầu tối thiểu để MỘT tin đăng chuyển vào duyệt/công khai:
 *   verified email + verified phone + declared seller type + canonical
 *   operating location + Seller Rules accepted (v1) + active founding_seller
 *   membership + operations review = verified + TÀI KHOẢN KHÔNG BỊ ĐÌNH CHỈ
 *   (Batch 3 — account_not_suspended, spec §7.8 suspension).
 *
 * Hợp đồng (plan Task 10 Step 1 — seller publication-gate gate; Batch 3
 * Task 5 Step 1 mở rộng):
 *  1. check ok chỉ khi CẢ TÁM yêu cầu giữ — table-driven: bỏ đúng MỘT
 *     fixture field → đúng requirement đó (và chỉ nó) xuất hiện trong missing.
 *  2. founding_seller membership SUSPENDED → missing founding_seller_membership_active
 *     (beta-cohort bypass, spec §7.3/§2.1).
 *  3. SellerVerification REVOKED → missing operations_review_verified
 *     (revoked-seller bypass, spec §7.3).
 *  4. UserSuspension ACTIVE → missing account_not_suspended (spec §7.8);
 *     episode LIFTED → KHÔNG missing (chỉ active chặn).
 *  5. assertSellerPublicationAllowed throw SELLER_PUBLICATION_BLOCKED:<missing>
 *     với đủ danh sách missing.
 *  6. Legacy User.isVerifiedSeller=true KHÔNG thỏa mãn yêu cầu nào (spec §8.2 —
 *     boolean legacy chỉ hiển thị, workflow là canonical).
 *
 * Cơ chế mock: server-only + db.client in-memory (User/PolicyAcceptance/
 * BetaCohortMembership/SellerVerification/UserSuspension) — policy module chạy
 * THẬT, đọc FRESH từ store mỗi lần gọi.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── db.client mock — in-memory 4 model của gate ──────────────────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  acceptances: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  verifications: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[]) => ({
    first: async (filter?: Pred) => {
      const hit = rows.find((r) => matches(r, filter ?? {}));
      return hit === undefined ? null : { ...hit };
    },
    all: async () => rows.map((r) => ({ ...r })),
    where: (pred: Pred) => ({
      first: async () => {
        const hit = rows.find((r) => matches(r, pred));
        return hit === undefined ? null : { ...hit };
      },
      all: async () => rows.filter((r) => matches(r, pred)).map((r) => ({ ...r })),
    }),
  });

  const models = {
    User: makeModel(dbState.users),
    PolicyAcceptance: makeModel(dbState.acceptances),
    BetaCohortMembership: makeModel(dbState.memberships),
    SellerVerification: makeModel(dbState.verifications),
    UserSuspension: makeModel(dbState.suspensions),
  };
  return { db: { orm: { public: models } } };
});

import {
  checkSellerPublicationRequirements,
  assertSellerPublicationAllowed,
  SELLER_VERIFICATION_POLICY_VERSION,
  SELLER_RULES_POLICY_KEY,
  SELLER_RULES_POLICY_VERSION,
  SELLER_VERIFICATION_REASON_CODES,
  SELLER_VERIFICATION_DECISIONS,
  SELLER_VERIFICATION_DECISION_REASON_CODES,
  SELLER_PUBLICATION_REQUIREMENT_LABELS,
  PROVINCE_CODES,
} from "@/src/lib/seller-verification-policy";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const SELLER_ID = "seller-1";

/** Fixture seller ĐỦ cả 7 yêu cầu — mỗi case bỏ/thay đúng 1 mảnh. */
const fullSeller = (): Row => ({
  id: SELLER_ID,
  email: "seller@loaviet.test",
  passwordHash: "x",
  name: "Seller",
  role: "seller",
  emailVerifiedAt: "2026-10-01T00:00:00.000Z",
  phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
  sellerType: "individual",
  sellerOperatingProvinceCode: "ha-noi",
  isVerifiedSeller: false,
});

const fullAcceptance = (): Row => ({
  userId: SELLER_ID,
  policyKey: "seller_rules",
  policyVersion: "v1",
});

const fullMembership = (): Row => ({
  userId: SELLER_ID,
  cohort: "founding_seller",
  status: "active",
});

const fullVerification = (): Row => ({
  userId: SELLER_ID,
  status: "verified",
  method: "operations_review",
  policyVersion: "v1",
});

/** Nạp đủ 4 fixture vào store — case nào bỏ/thay mảnh thì truyền override. */
const seedFull = (over?: {
  seller?: Partial<Row>;
  acceptance?: Row | null;
  membership?: Row | null;
  verification?: Row | null;
}): void => {
  dbState.users.length = 0;
  dbState.acceptances.length = 0;
  dbState.memberships.length = 0;
  dbState.verifications.length = 0;
  dbState.suspensions.length = 0;
  dbState.users.push({ ...fullSeller(), ...over?.seller });
  if (over?.acceptance !== null) dbState.acceptances.push(over?.acceptance ?? fullAcceptance());
  if (over?.membership !== null) dbState.memberships.push(over?.membership ?? fullMembership());
  if (over?.verification !== null) dbState.verifications.push(over?.verification ?? fullVerification());
};

beforeEach(() => {
  seedFull();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Hằng số policy ──────────────────────────────────────────────────────────

describe("policy constants (spec §5.3.3)", () => {
  it("version v1 + key seller_rules; reason codes + decisions typed", () => {
    expect(SELLER_VERIFICATION_POLICY_VERSION).toBe("v1");
    expect(SELLER_RULES_POLICY_KEY).toBe("seller_rules");
    expect(SELLER_RULES_POLICY_VERSION).toBe("v1");
    expect(SELLER_VERIFICATION_REASON_CODES).toContain("requirements_met");
    expect(SELLER_VERIFICATION_REASON_CODES).toContain("migrated_legacy_verified");
    expect(SELLER_VERIFICATION_DECISIONS).toEqual(["verified", "needs_review", "rejected", "revoked"]);
  });

  it("PROVINCE_CODES delegate sang registry 34 đơn vị (FD-1)", () => {
    expect(Object.keys(PROVINCE_CODES)).toHaveLength(34);
    expect(PROVINCE_CODES["ho-chi-minh"]).toBe("TP. Hồ Chí Minh");
  });

  it("PROVISIONAL map decision→reason (review fix L2): migrated_legacy_verified KHÔNG thuộc quyết định người nào", () => {
    for (const decision of SELLER_VERIFICATION_DECISIONS) {
      expect(SELLER_VERIFICATION_DECISION_REASON_CODES[decision]).not.toContain("migrated_legacy_verified");
    }
  });

  it("PROVISIONAL map: verified không mang reason tiêu cực; requirements_met chỉ dành cho verified", () => {
    expect(SELLER_VERIFICATION_DECISION_REASON_CODES.verified).not.toContain("duplicate_account_risk");
    expect(SELLER_VERIFICATION_DECISION_REASON_CODES.verified).not.toContain("active_suspension");
    for (const decision of SELLER_VERIFICATION_DECISIONS) {
      if (decision !== "verified") {
        expect(SELLER_VERIFICATION_DECISION_REASON_CODES[decision]).not.toContain("requirements_met");
      }
    }
  });
});

// ─── 1. Table-driven: bỏ đúng 1 yêu cầu → đúng requirement đó missing ────────

describe("checkSellerPublicationRequirements — 8 yêu cầu (spec §5.3.3 + §7.8 Batch 3)", () => {
  const cases: Array<{ name: string; mutate: () => void; missing: string }> = [
    {
      name: "email chưa xác minh → missing email_verified",
      mutate: () => void (dbState.users[0]!.emailVerifiedAt = null),
      missing: "email_verified",
    },
    {
      name: "phone chưa xác minh → missing phone_verified",
      mutate: () => void (dbState.users[0]!.phoneVerifiedAt = null),
      missing: "phone_verified",
    },
    {
      name: "chưa khai báo seller type → missing seller_type_declared",
      mutate: () => void (dbState.users[0]!.sellerType = null),
      missing: "seller_type_declared",
    },
    {
      name: "chưa khai báo tỉnh hoạt động → missing operating_location_declared",
      mutate: () => void (dbState.users[0]!.sellerOperatingProvinceCode = null),
      missing: "operating_location_declared",
    },
    {
      name: "mã tỉnh không hợp lệ (63 tỉnh cũ) → missing operating_location_declared",
      mutate: () => void (dbState.users[0]!.sellerOperatingProvinceCode = "Thừa Thiên Huế"),
      missing: "operating_location_declared",
    },
    {
      name: "chưa đồng ý Seller Rules v1 → missing seller_rules_accepted",
      mutate: () => dbState.acceptances.length = 0,
      missing: "seller_rules_accepted",
    },
    {
      name: "không có founding_seller membership → missing founding_seller_membership_active",
      mutate: () => dbState.memberships.length = 0,
      missing: "founding_seller_membership_active",
    },
    {
      name: "chưa có SellerVerification → missing operations_review_verified",
      mutate: () => dbState.verifications.length = 0,
      missing: "operations_review_verified",
    },
    {
      // Batch 3 Task 5 (spec §7.8): suspension là yêu cầu publication thứ 8
      name: "đang bị đình chỉ (episode active) → missing account_not_suspended",
      mutate: () =>
        void dbState.suspensions.push({
          id: "susp-1",
          userId: SELLER_ID,
          status: "active",
          reasonCode: "confirmed_abuse",
        }),
      missing: "account_not_suspended",
    },
  ];

  // mỗi case bỏ ĐÚNG 1 mảnh → missing chứa ĐÚNG requirement đó (không thừa)
  it.each(cases)("%s", async ({ mutate, missing }) => {
    seedFull();
    mutate();
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([missing]);
  });

  it("đủ cả 8 → { ok: true, missing: [] }", async () => {
    seedFull();
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check).toEqual({ ok: true, missing: [] });
  });

  it("nhiều yêu cầu thiếu cùng lúc → đầy đủ danh sách theo thứ tự khai báo", async () => {
    seedFull({
      seller: { emailVerifiedAt: null, phoneVerifiedAt: null, sellerType: null },
      verification: null,
    });
    dbState.suspensions.push({
      id: "susp-1",
      userId: SELLER_ID,
      status: "active",
      reasonCode: "confirmed_abuse",
    });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([
      "email_verified",
      "phone_verified",
      "seller_type_declared",
      "operations_review_verified",
      "account_not_suspended",
    ]);
  });

  it("seller KHÔNG tồn tại → fail closed: thiếu cả 8", async () => {
    seedFull();
    dbState.users.length = 0;
    const check = await checkSellerPublicationRequirements("khong-ton-tai");
    expect(check.ok).toBe(false);
    expect(check.missing).toHaveLength(8);
  });
});

// ─── 1b. Suspension — yêu cầu thứ 8 (Batch 3 Task 5, spec §7.8) ───────────────

describe("UserSuspension — chỉ episode ACTIVE chặn publication (spec §7.8)", () => {
  it("episode LIFTED → KHÔNG missing (lift khôi phục quyền publication NGAY)", async () => {
    seedFull();
    dbState.suspensions.push({
      id: "susp-1",
      userId: SELLER_ID,
      status: "lifted",
      reasonCode: "confirmed_abuse",
      liftReasonCode: "other_reviewed_reason",
    });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check).toEqual({ ok: true, missing: [] });
  });

  it("suspension của user KHÁC → KHÔNG ảnh hưởng seller này", async () => {
    seedFull();
    dbState.suspensions.push({
      id: "susp-1",
      userId: "seller-khac",
      status: "active",
      reasonCode: "confirmed_abuse",
    });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check).toEqual({ ok: true, missing: [] });
  });

  it("(review fix Task 5) label yêu cầu thứ 8 ĐỌC NHƯ MỘT YÊU CẦU — 'Tài khoản không bị đình chỉ' (không phải mô tả trạng thái)", () => {
    // Label dùng trong checklist (app/sell/verification) + thông báo lỗi missing
    // — phải là danh từ yêu cầu ("không bị đình chỉ"), không phải câu trạng thái
    // ("đang bị đình chỉ") — seller đọc thông báo thiếu hiểu mình CẦN GÌ.
    expect(SELLER_PUBLICATION_REQUIREMENT_LABELS.account_not_suspended).toBe(
      "Tài khoản không bị đình chỉ",
    );
  });
});

// ─── 2. Beta-cohort bypass (spec §7.3/§2.1) ───────────────────────────────────

describe("founding_seller membership — trạng thái khác active đều chặn", () => {
  it.each(["invited", "suspended", "exited"])(
    "membership %s → missing founding_seller_membership_active",
    async (status) => {
      seedFull({ membership: { ...fullMembership(), status } });
      const check = await checkSellerPublicationRequirements(SELLER_ID);
      expect(check.ok).toBe(false);
      expect(check.missing).toEqual(["founding_seller_membership_active"]);
    },
  );

  it("membership của cohort KHÁC (private_beta_buyer) không tính", async () => {
    seedFull({ membership: { ...fullMembership(), cohort: "private_beta_buyer" } });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["founding_seller_membership_active"]);
  });

  it("membership expiresAt ĐÃ QUA HẠN → inactive (review fix L4 — hết hạn = không còn hoạt động)", async () => {
    seedFull({ membership: { ...fullMembership(), expiresAt: "2020-01-01T00:00:00.000Z" } });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["founding_seller_membership_active"]);
  });

  it("membership expiresAt còn hạn → active (gate không chặn hạn còn sống)", async () => {
    seedFull({ membership: { ...fullMembership(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check).toEqual({ ok: true, missing: [] });
  });
});

// ─── 3. Revoked-seller bypass (spec §7.3) ─────────────────────────────────────

describe("SellerVerification — chỉ status=verified thỏa operations_review_verified", () => {
  it.each(["pending", "rejected", "needs_review", "revoked"])(
    "status %s → missing operations_review_verified",
    async (status) => {
      seedFull({ verification: { ...fullVerification(), status } });
      const check = await checkSellerPublicationRequirements(SELLER_ID);
      expect(check.ok).toBe(false);
      expect(check.missing).toEqual(["operations_review_verified"]);
    },
  );
});

// ─── 4. assertSellerPublicationAllowed ────────────────────────────────────────

describe("assertSellerPublicationAllowed — throw SELLER_PUBLICATION_BLOCKED:<missing>", () => {
  it("đủ yêu cầu → KHÔNG throw", async () => {
    seedFull();
    await expect(assertSellerPublicationAllowed(SELLER_ID)).resolves.toBeUndefined();
  });

  it("thiếu → throw với danh sách missing (dấu phẩy)", async () => {
    seedFull({
      seller: { emailVerifiedAt: null },
      membership: { ...fullMembership(), status: "suspended" },
    });
    await expect(assertSellerPublicationAllowed(SELLER_ID)).rejects.toThrowError(
      /^SELLER_PUBLICATION_BLOCKED:email_verified,founding_seller_membership_active$/,
    );
  });
});

// ─── 5. Legacy boolean không cấp quyền gì (spec §8.2) ─────────────────────────

describe("legacy User.isVerifiedSeller KHÔNG thỏa yêu cầu nào (spec §8.2)", () => {
  it("isVerifiedSeller=true một mình → thiếu cả 7 yêu cầu Batch 2 (boolean chỉ hiển thị; yêu cầu thứ 8 — không bị đình chỉ — vẫn THỎA vì user tồn tại và không có suspension)", async () => {
    seedFull({
      seller: {
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        sellerType: null,
        sellerOperatingProvinceCode: null,
        isVerifiedSeller: true,
      },
      acceptance: null,
      membership: null,
      verification: null,
    });
    const check = await checkSellerPublicationRequirements(SELLER_ID);
    expect(check.ok).toBe(false);
    // 7 yêu cầu Batch 2 đều thiếu; account_not_suspended KHÔNG thiếu (không có
    // suspension nào — absence là bằng chứng thỏa yêu cầu thứ 8)
    expect(check.missing).toHaveLength(7);
    expect(check.missing).not.toContain("account_not_suspended");
  });
});
