/**
 * Report evidence — integration tests (Batch 3 plan Task 4, spec §5.5.1
 * evidence lifecycle + §5.5 case grouping) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + `prisma db migrate --to
 * production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/report-actions.test.ts) chứng minh logic với db mock;
 * ở đây chứng minh CÙNG hợp đồng against DB THẬT với module THẬT (session,
 * auth, captureTargetSnapshot, rate limit, submitReportAction, partial unique
 * index `moderation_case_one_active_per_target_reason`, @@unique
 * [caseId, reporterId]):
 *
 *  1. Review Focus 2 — evidence BẤT BIẾN qua source edit: report → edit listing
 *     qua db TRỰC TIẾP (không qua updateListingAction — invariant là source ROW
 *     thay đổi, ai thay đổi cũng được) → ModerationEvidence.relevantSnapshot
 *     deep-equal (jsonb) với capture trước edit.
 *  2. Review Focus 2 — evidence sống qua source DELETE: xóa listing bị báo cáo
 *     → evidence row vẫn tồn tại deep-equal; ModerationCase + AbuseReport vẫn
 *     đọc được (KHÔNG cascade — sourceResourceId là string, không FK).
 *  3. Message evidence sống + deep-equal sau khi conversation có tin mới —
 *     tin mới KHÔNG đụng evidence cũ.
 *  4. Grouping + concurrency trên DB thật: hai reporter cùng target+reason →
 *     MỘT case; khác reason → case thứ hai; hai submit ĐỒNG THỜI của cùng
 *     reporter (Promise.all) → đúng MỘT report row persist (loser violation
 *     throw ra khỏi tx, classify NGOÀI → REPORT_ALREADY_SUBMITTED — không có
 *     path silent-success/aborted-tx); hai submit ĐỒNG THỜI hai reporter cùng
 *     target+reason → MỘT case, hai report (loser case-create violation →
 *     RETRY → re-read thấy case người thắng).
 *
 *     (Review fix L3) Các test "đồng thời" là BEST-EFFORT scheduling —
 *     Promise.all trên một event loop có thể serialize; đường race
 *     DETERMINISTIC (23505 → throw → classify ngoài → retry → JOIN; repeat
 *     race → REPORT_RETRY_FAILED) được pin ở tests/unit/report-actions.test.ts
 *     (mock mô phỏng 23505 + rollback snapshot/restore). Integration test
 *     giữ bất biến against DB thật với scheduling tốt nhất có thể.
 *
 * ModerationEvidence KHÔNG bao giờ bị delete (spec §5.5.1 immutable từ product
 * flow) — các case giữ evidence được BỎ QUA khi dọn (DB scratch bị vứt sau
 * run); AbuseReport/ModerationAction/ModerationCase cũng giữ lại (SetNull FK
 * khi user bị dọn — không chặn gì, dữ liệu mỗi test unique theo uid).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));

// ─── Cookie store điều khiển được (next/headers) — session THẬT ──────────────
//
// `queue`: khi ≠ rỗng, get() shift MỘT token mỗi lần gọi — mô phỏng hai request
// ĐỒNG THỜI với hai session khác nhau (mỗi action đọc cookie đúng MỘT lần trong
// requireUser → getSessionFromCookie; thứ tự pop không quan trọng — các assertion
// đối xứng theo reporter).

const cookieState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  queue: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      if (cookieState.queue.length > 0) {
        return { name, value: cookieState.queue.shift()! };
      }
      const value = cookieState.store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
}));

import { db } from "../../src/prisma/db.client";
import { SESSION_COOKIE, createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { submitReportAction } from "../../src/lib/actions/reports";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `b3-rep-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B3 rep ${role} ${seq}`,
    role,
  });
  created.users.push(u.id);
  return u.id;
}

async function mkListing(sellerId: string): Promise<string> {
  const cat = await db.orm.public.Category.create({
    name: `Danh mục ${uid()}`,
    slug: `cat-${uid()}`,
  });
  created.categories.push(cat.id);
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.id,
    title: `Loa ${uid()}`,
    slug: `loa-${uid()}`,
    description: "integration test listing",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
  });
  created.listings.push(l.id);
  return l.id;
}

async function mkConversation(listingId: string, buyerId: string, sellerId: string): Promise<string> {
  const c = await db.orm.public.Conversation.create({ listingId, buyerId, sellerId });
  created.conversations.push(c.id);
  return c.id;
}

async function mkMessage(conversationId: string, senderId: string, body: string): Promise<string> {
  const m = await db.orm.public.Message.create({ conversationId, senderId, body });
  return m.id;
}

/** Session THẬT cho user — trả token cookie để switch giữa các user. */
async function loginAs(userId: string): Promise<string> {
  await createSession(userId);
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

const setSession = (token: string): void => {
  cookieState.store.set(SESSION_COOKIE, token);
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const submit = (entries: Record<string, string>) => submitReportAction({}, fd(entries));

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK. Moderation rows (case/evidence/report/action) GIỮ LẠI:
// evidence không có delete path (spec §5.5.1), case bị evidence chặn (FK
// Restrict), report/action SetNull khi user bị dọn — không chặn gì, dữ liệu
// mỗi test unique theo uid (DB scratch bị vứt sau run).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  conversations: [] as string[],
};

afterEach(async () => {
  for (const id of created.conversations) {
    await db.orm.public.Conversation.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  created.conversations.length = 0;
  created.listings.length = 0;
  created.categories.length = 0;
  created.users.length = 0;
  cookieState.store.clear();
  cookieState.queue.length = 0;
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1/2. Evidence bất biến qua source edit + delete (Review Focus 2) ───────

d("report evidence trên DB thật (spec §5.5.1)", () => {
  it("report → edit source → evidence deep-equal với capture trước edit", async () => {
    const seller = await mkUser("seller");
    const reporter = await mkUser("buyer");
    const listing = await mkListing(seller);

    // (Review fix L3) đọc giá trị seed TRƯỚC khi report — snapshot phải chứa ĐÚNG
    // các giá trị pre-edit này (không chỉ "không đổi qua edit").
    const preEdit = await db.orm.public.Listing.first({ id: listing });
    expect(preEdit).not.toBeNull();

    const reporterTok = await loginAs(reporter);
    setSession(reporterTok);
    const res = await submit({
      targetType: "listing",
      targetId: listing,
      reasonCode: "suspected_scam",
      note: "nghi lừa đảo",
    });
    expect(res.success).toBeTruthy();

    const evidence = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: listing })
      .first();
    expect(evidence).not.toBeNull();
    const captured = evidence!.relevantSnapshot as Record<string, unknown>;
    expect(captured).toMatchObject({ kind: "listing", id: listing });
    const capturedTitle = captured.title as string;
    const capturedPrice = captured.price as number;

    // (Review fix L3) snapshot chứa ĐÚNG title/price/description seed pre-edit
    // — chứng minh capture chụp nội dung THẬT tại report time, không chỉ chứng
    // minh sau edit nó "vẫn giống chính nó".
    expect(captured.title).toBe(preEdit!.title);
    expect(captured.price).toBe(preEdit!.price);
    expect(captured.description).toBe(preEdit!.description);
    expect(captured.description).toBe("integration test listing");
    expect(captured.price).toBe(1_000_000);
    expect(captured).toMatchObject({
      condition: "good",
      city: "Hà Nội",
      status: "approved",
      sellerId: seller,
    });

    // edit source QUA DB TRỰC TIẾP (không qua updateListingAction — invariant là
    // source ROW thay đổi; action đó route qua publication gate + redirect())
    await db.orm.public.Listing.where({ id: listing }).update({
      title: "TIÊU ĐỀ MỚI SAU BÁO CÁO",
      price: 999_999,
      description: "mô tả mới sau báo cáo",
    });

    // listing row THẬT SỰ đổi (title/price khác capture — không phải test giả)
    const edited = await db.orm.public.Listing.first({ id: listing });
    expect(edited!.title).toBe("TIÊU ĐỀ MỚI SAU BÁO CÁO");
    expect(edited!.title).not.toBe(capturedTitle);
    expect(edited!.price).not.toBe(capturedPrice);

    // evidence deep-equal (jsonb) — snapshot giữ nguyên title/price/description cũ
    const after = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: listing })
      .first();
    expect(after).not.toBeNull();
    expect(after!.relevantSnapshot).toEqual(captured);
  });

  it("b4-holistic — snapshot chứa Batch 4 public free-text; edit sau report KHÔNG xoá evidence (spec §5.5.1)", async () => {
    const seller = await mkUser("seller");
    const reporter = await mkUser("buyer");
    // Listing BETA với đầy đủ field công khai Batch 4 — các field này render
    // công khai trên /listings/<slug> nên là moderation material: thiếu chúng
    // trong snapshot, seller edit field sau khi bị báo cáo thì nội dung vi phạm
    // (PIC/spam) không còn ở DB LẪN evidence.
    const cat = await db.orm.public.Category.create({
      name: `Danh mục ${uid()}`,
      slug: `cat-${uid()}`,
    });
    created.categories.push(cat.id);
    const listingRow = await db.orm.public.Listing.create({
      sellerId: seller,
      categoryId: cat.id,
      title: `Loa beta ${uid()}`,
      slug: `loa-beta-${uid()}`,
      description: "integration test beta listing",
      condition: "good",
      price: 2_000_000,
      status: "approved",
      city: "Hà Nội",
      inventoryContext: "used",
      includedAccessories: "Sạc, cáp, hộp",
      knownDefects: "Vết xước mặt bên, loa bass rè nhẹ",
      repairHistory: "Đã thay pin tại cửa hàng X",
      fulfillmentMethods: ["shipping", "cod"],
      provinceLevelCode: "01",
      locationDisplayName: "Gần chợ Bến Thành",
    });
    const listing = listingRow.id;
    created.listings.push(listing);
    const img = await db.orm.public.ListingImage.create({
      listingId: listing,
      url: "/uploads/00000000-0000-0000-0000-00000000000a.webp",
      sortOrder: 0,
      checklistSlot: "front",
    });
    void img; // cascade theo listing khi dọn — không cần track

    const reporterTok = await loginAs(reporter);
    setSession(reporterTok);
    const res = await submit({
      targetType: "listing",
      targetId: listing,
      reasonCode: "suspected_scam",
      note: "nghi lừa đảo — số điện thoại trong phần lỗi",
    });
    expect(res.success).toBeTruthy();

    const evidence = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: listing })
      .first();
    expect(evidence).not.toBeNull();
    const snap = evidence!.relevantSnapshot as Record<string, unknown>;

    // snapshot chứa ĐÚNG các field Batch 4 tại report time
    expect(snap).toMatchObject({
      inventoryContext: "used",
      includedAccessories: "Sạc, cáp, hộp",
      knownDefects: "Vết xước mặt bên, loa bass rè nhẹ",
      repairHistory: "Đã thay pin tại cửa hàng X",
      fulfillmentMethods: ["shipping", "cod"],
      provinceLevelCode: "01",
      locationDisplayName: "Gần chợ Bến Thành",
    });
    // ảnh kèm checklistSlot (Batch 4) — imageUrls giữ cho row cũ
    expect(snap.images).toMatchObject([
      { url: "/uploads/00000000-0000-0000-0000-00000000000a.webp", checklistSlot: "front" },
    ]);
    expect(snap.imageUrls).toEqual(["/uploads/00000000-0000-0000-0000-00000000000a.webp"]);

    // seller edit các field này (xóa nội dung vi phạm) — evidence PHẢI giữ nguyên
    await db.orm.public.Listing.where({ id: listing }).update({
      knownDefects: null,
      repairHistory: null,
      includedAccessories: null,
      locationDisplayName: null,
    });
    const edited = await db.orm.public.Listing.first({ id: listing });
    expect(edited!.knownDefects).toBeNull();

    const after = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: listing })
      .first();
    expect(after!.relevantSnapshot).toEqual(snap);
    // moderator vẫn thấy nội dung gốc qua snapshot (case page render —
    // missing key = rỗng cho snapshot cũ, field có giá trị thì hiển thị)
    const afterSnap = after!.relevantSnapshot as Record<string, unknown>;
    expect(afterSnap.knownDefects).toBe("Vết xước mặt bên, loa bass rè nhẹ");
  });

  it("report → delete source → evidence sống, case + report vẫn đọc được (không cascade)", async () => {
    const seller = await mkUser("seller");
    const reporter = await mkUser("buyer");
    const listing = await mkListing(seller);

    const reporterTok = await loginAs(reporter);
    setSession(reporterTok);
    const res = await submit({ targetType: "listing", targetId: listing, reasonCode: "misleading_listing" });
    expect(res.success).toBeTruthy();

    const evidence = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: listing })
      .first();
    expect(evidence).not.toBeNull();
    const captured = evidence!.relevantSnapshot;
    const caseId = evidence!.caseId;

    // xóa source — evidence KHÔNG cascade (sourceResourceId là string, không FK)
    await db.orm.public.Listing.where({ id: listing }).delete();
    expect(await db.orm.public.Listing.first({ id: listing })).toBeNull();
    created.listings = created.listings.filter((id) => id !== listing);

    // evidence row vẫn tồn tại, deep-equal với capture (Review Focus 2)
    const after = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: listing })
      .first();
    expect(after).not.toBeNull();
    expect(after!.relevantSnapshot).toEqual(captured);

    // case + report vẫn đọc được — KHÔNG cascade
    const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
    expect(caseRow).not.toBeNull();
    expect(caseRow!.targetId).toBe(listing);
    expect(caseRow!.state).toBe("open");
    const reports = await db.orm.public.AbuseReport.where({ caseId }).all();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reasonCode).toBe("misleading_listing");
    expect(reports[0]!.reporterId).toBe(reporter);
  });

  it("message evidence sống + deep-equal sau khi conversation có tin mới", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    const listing = await mkListing(seller);
    const convo = await mkConversation(listing, buyer, seller);
    const msg = await mkMessage(convo, seller, "tin cần báo cáo");

    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);
    const res = await submit({ targetType: "message", targetId: msg, reasonCode: "harassment" });
    expect(res.success).toBeTruthy();

    const evidence = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: msg })
      .first();
    expect(evidence).not.toBeNull();
    const captured = evidence!.relevantSnapshot as Record<string, unknown>;
    expect(captured).toMatchObject({ kind: "message", id: msg, body: "tin cần báo cáo" });
    expect(evidence!.subjectUserId).toBe(seller);
    expect(evidence!.sourceResourceType).toBe("message");

    // conversation có tin mới — evidence cũ KHÔNG bị đụng
    await mkMessage(convo, buyer, "tin mới sau báo cáo");
    await mkMessage(convo, seller, "tin mới nữa sau báo cáo");

    const after = await db.orm.public.ModerationEvidence
      .where({ sourceResourceId: msg })
      .first();
    expect(after).not.toBeNull();
    expect(after!.relevantSnapshot).toEqual(captured);
  });
});

// ─── 4. Grouping + concurrency trên DB thật ──────────────────────────────────
//
// (Review fix L3) Các test "đồng thời" dưới đây là BEST-EFFORT scheduling —
// Promise.all trên MỘT event loop có thể serialize hai action, nên race
// (violation 23505) KHÔNG đợi được ở đây. Đường race DETERMINISTIC được pin
// ở UNIT test (tests/unit/report-actions.test.ts — mock mô phỏng 23505 đúng
// semantics Postgres: violation throw ra khỏi tx, classify NGOÀI theo
// constraint name, retry re-read JOIN case người thắng, repeat-race →
// REPORT_RETRY_FAILED). Ở đây chứng minh CÙNG bất biến against DB THẬT với
// scheduling tốt nhất có thể: dù interleaving nào, đúng MỘT report/reporter/
// case, MỘT case active per key, KHÔNG silent-success.

d("grouping + concurrency trên DB thật (spec §5.5 + Global Constraints)", () => {
  it("hai reporter cùng target+reason → MỘT case, hai report, hai evidence; khác reason → case thứ hai", async () => {
    const seller = await mkUser("seller");
    const reporter1 = await mkUser("buyer");
    const reporter2 = await mkUser("buyer");
    const listing = await mkListing(seller);

    const tok1 = await loginAs(reporter1);
    setSession(tok1);
    const res1 = await submit({ targetType: "listing", targetId: listing, reasonCode: "suspected_scam" });
    expect(res1.success).toBeTruthy();

    const tok2 = await loginAs(reporter2);
    setSession(tok2);
    const res2 = await submit({ targetType: "listing", targetId: listing, reasonCode: "suspected_scam" });
    expect(res2.success).toBeTruthy();

    // MỘT case — reporter thứ hai JOIN (grouping key (target, reason))
    const cases = await db.orm.public.ModerationCase
      .where({ targetType: "listing", targetId: listing, reasonCategory: "suspected_scam" })
      .all();
    expect(cases).toHaveLength(1);
    const caseId = cases[0]!.id;

    const reports = await db.orm.public.AbuseReport.where({ caseId }).all();
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.reporterId).sort()).toEqual([reporter1, reporter2].sort());

    const evidence = await db.orm.public.ModerationEvidence.where({ caseId }).all();
    expect(evidence).toHaveLength(2);

    // khác reason → case RIÊNG (grouping key gồm reasonCategory)
    setSession(tok1);
    const res3 = await submit({ targetType: "listing", targetId: listing, reasonCode: "counterfeit_claim" });
    expect(res3.success).toBeTruthy();
    const casesAll = await db.orm.public.ModerationCase
      .where({ targetType: "listing", targetId: listing })
      .all();
    expect(casesAll).toHaveLength(2);
    expect(casesAll.map((c) => c.reasonCategory).sort()).toEqual(["counterfeit_claim", "suspected_scam"]);
  });

  it("hai submit GẦN ĐỒNG THỜI của cùng reporter (best-effort race) → bất kể interleaving: đúng MỘT report row, loser REPORT_ALREADY_SUBMITTED (không silent-success)", async () => {
    const seller = await mkUser("seller");
    const reporter = await mkUser("buyer");
    const listing = await mkListing(seller);

    const tok = await loginAs(reporter);
    setSession(tok);

    // Promise.all — hai action trên cùng (target, reason), cùng reporter.
    // Race path DETERMINISTIC (violation partial index → retry → re-read thấy
    // case → AbuseReport violation → ALREADY_SUBMITTED) được pin ở UNIT test
    // (tests/unit/report-actions.test.ts); ở đây bất kể interleaving thật
    // (race HOẶC serialize — request sau đi qua dedupe step 5), bất biến
    // phải giữ: đúng MỘT report row persist, KHÔNG có path nào cả hai cùng
    // persist (partial index + @@unique đóng race — S4).
    const [r1, r2] = await Promise.all([
      submit({ targetType: "listing", targetId: listing, reasonCode: "suspected_scam" }),
      submit({ targetType: "listing", targetId: listing, reasonCode: "suspected_scam" }),
    ]);

    const results = [r1, r2];
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.error === "REPORT_ALREADY_SUBMITTED")).toHaveLength(1);

    // đọc lại SAU khi cả hai settle — đúng MỘT report row, MỘT case, MỘT evidence
    const cases = await db.orm.public.ModerationCase
      .where({ targetType: "listing", targetId: listing, reasonCategory: "suspected_scam" })
      .all();
    expect(cases).toHaveLength(1);
    const reports = await db.orm.public.AbuseReport.where({ caseId: cases[0]!.id }).all();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reporterId).toBe(reporter);
    const evidence = await db.orm.public.ModerationEvidence
      .where({ caseId: cases[0]!.id })
      .all();
    expect(evidence).toHaveLength(1);
  });

  it("hai submit GẦN ĐỒNG THỜI hai reporter cùng target+reason (best-effort race) → bất kể interleaving: MỘT case, hai report (race path deterministic pin ở unit test)", async () => {
    const seller = await mkUser("seller");
    const reporter1 = await mkUser("buyer");
    const reporter2 = await mkUser("buyer");
    const listing = await mkListing(seller);

    // hai session THẬT khác nhau; queue phát MỘT token cho mỗi action — mô phỏng
    // hai request đồng thời từ hai người (mỗi action đọc cookie đúng một lần).
    // Race path DETERMINISTIC (loser case-create violation → retry → re-read
    // JOIN case người thắng) được pin ở UNIT test; ở đây bất kể interleaving
    // thật (race HOẶC serialize — request sau đi qua re-read thấy case), bất
    // biến phải giữ: MỘT case active per (target, reason), hai report, hai evidence.
    const tok1 = await loginAs(reporter1);
    const tok2 = await loginAs(reporter2);
    cookieState.queue.push(tok1, tok2);

    const [r1, r2] = await Promise.all([
      submit({ targetType: "listing", targetId: listing, reasonCode: "spam" }),
      submit({ targetType: "listing", targetId: listing, reasonCode: "spam" }),
    ]);
    // cả hai thành công — tx thua case-create retry rồi JOIN case người thắng
    // (hoặc serialize: request sau re-read thấy case của request trước)
    expect(r1.success).toBeTruthy();
    expect(r2.success).toBeTruthy();

    // MỘT case — tx thua case-create (partial index) retry rồi JOIN case người thắng
    const cases = await db.orm.public.ModerationCase
      .where({ targetType: "listing", targetId: listing, reasonCategory: "spam" })
      .all();
    expect(cases).toHaveLength(1);
    const caseId = cases[0]!.id;

    const reports = await db.orm.public.AbuseReport.where({ caseId }).all();
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.reporterId).sort()).toEqual([reporter1, reporter2].sort());

    const evidence = await db.orm.public.ModerationEvidence.where({ caseId }).all();
    expect(evidence).toHaveLength(2);
    const actions = await db.orm.public.ModerationAction.where({ caseId }).all();
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.actionType === "evidence.captured")).toBe(true);
  });
});
