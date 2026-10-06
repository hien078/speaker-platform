/**
 * Multi-row & conditional writes — integration tests (updateAll/deleteAll fix).
 *
 * Root cause (node_modules/@prisma/orm-family-sql/dist/orm-client.mjs
 * `#findFirstMatchingRowIdentityWhere`, ~4787-4800/~4887-4896): terminal đơn-row
 * `.update()`/`.delete()` SELECT row khớp filter ĐẦU TIÊN rồi write
 * `WHERE id = <id đó>` — (a) filter KHÔNG nằm trong statement write (khoảng
 * select→write không atomic), (b) chỉ MỘT row bị ảnh hưởng dù filter khớp nhiều.
 * `updateAll()`/`deleteAll()` compile TOÀN BỘ filter vào MỘT statement.
 *
 * Chạy trên scratch DB (scripts/test-integration.sh) — KHÔNG chạy trong
 * `npm test`. Unit test chứng minh logic qua db mock; ở đây chứng minh cùng
 * hợp đồng against DB THẬT + ORM THẬT:
 *
 *  1. updateProfileAction phone CAS (Batch 2 Task 6 review fix MEDIUM #2):
 *     phone change COMMIT giữa read và write của profile edit → CAS
 *     updateAll thấy 0 row → PHONE_CONCURRENT_CHANGE, KHÔNG clobber số đã
 *     xác minh. Interleaving DETERMINISTIC qua row lock: tx T2 giữ lock chưa
 *     commit → write của action block → commit T2 → write của action re-evaluate
 *     (Postgres re-check WHERE sau khi lock thả). Old `.update()` select row
 *     (thấy phone cũ) rồi `UPDATE WHERE id` — clobber số đã đổi + giữ
 *     phoneVerifiedAt của SỐ KHÁC (stale verified phone).
 *  2. CAS với stored phone STALE → updateAll 0 row (filter nằm TRONG statement)
 *     — neo ngữ nghĩa ORM mà action dựa vào.
 *  3. markAllReadAction: 3 thông báo unread → CẢ 3 được đánh dấu đọc
 *     (old `.update()` chỉ row unread ĐẦU).
 *  4. mergeModelAction: 2 listings + 2 price rows của model → TẤT CẢ chuyển
 *     sang target (old `.update()` chỉ 1 listing + 1 price row).
 *  5. deleteAll multi-row: xoá MỌI row khớp filter (old `.delete()` chỉ 1 đầu)
 *     — neo ngữ nghĩa cho admin-identity.ts regenerate (unit test
 *     admin-session-actions.test.ts cover action đó).
 *  6. seed.ts re-run idempotent: chạy seed 2 lần liên tiếp exit 0 — lần 2
 *     `.where({}).deleteAll()` sạch từng bảng rồi tạo lại (old `.delete()`
 *     chỉ xoá 1 row/bảng → unique violation User.email/Cart.userId → exit 1).
 *
 * next/headers mock (cookie store điều khiển được — createSession/requireUser
 * cần cookies() ngoài request scope); next/cache mock (revalidatePath);
 * next/navigation mock (rbac.ts import tĩnh redirect). Phần DB là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── Cookie store điều khiển được (next/headers) ─────────────────────────────
const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
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
  headers: vi.fn(async () => new Headers()),
}));

// rbac.ts import tĩnh next/navigation — redirect throw NEXT_REDIRECT như
// admin-bootstrap.test.ts (chỉ đi qua path FORBIDDEN/redirect khi thiếu quyền).
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { updateProfileAction } from "../../src/lib/actions/profile";
import { markAllReadAction } from "../../src/lib/actions/notifications";
import { mergeModelAction } from "../../src/lib/actions/catalog";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);
const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const uid = (): string => `it-mr-${Date.now()}-${seq++}`;
/** Phone VN hợp lệ duy nhất mỗi lần gọi — dạng CHUẨN (normalizePhone giữ nguyên). */
const mkPhone = (): string => `09${String(100_000_000 + seq++).padStart(9, "0")}`;

async function mkUser(
  over: Record<string, unknown> = {},
): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "IT Multirow",
    role: "buyer",
    ...over,
  });
  return u.id;
}

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** Đăng nhập user trên cookie store mock — session thật trong DB scratch. */
const login = async (userId: string, isAdmin = false): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId, { isAdmin });
};

const createdUsers: string[] = [];

/** Xoá AuditEvent (SetNull) trước, rồi user (cascade session/otp/notification). */
async function cleanupUser(userId: string): Promise<void> {
  const events = await db.orm.public.AuditEvent.where({ actorId: userId }).all();
  await db.orm.public.User.where({ id: userId }).deleteAll();
  for (const e of events) {
    await db.orm.public.AuditEvent.where({ id: e.id }).deleteAll();
  }
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  for (const id of createdUsers) {
    await cleanupUser(id);
  }
  createdUsers.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. updateProfileAction — phone CAS atomic (updateAll) ──────────────────

d("updateProfileAction — phone CAS (fix MEDIUM #2) against DB thật", () => {
  it("phone change COMMIT giữa read và write → 0 row → PHONE_CONCURRENT_CHANGE, không clobber số đã xác minh", async () => {
    const userId = await mkUser();
    createdUsers.push(userId);
    const phoneA = mkPhone(); // số đang lưu — ĐÃ XÁC MINH từ T1
    const phoneC = mkPhone(); // số mới sau phone change flow
    const T1 = "2026-10-01T00:00:00.000Z";
    const T2 = "2026-10-07T12:00:00.000Z";
    await db.orm.public.User
      .where({ id: userId })
      .updateAll({ phone: phoneA, phoneVerifiedAt: T1 });
    await login(userId);

    // T2 = "phone change flow" (hiệu ứng DB: phone C + verifiedAt T2) — mở tx,
    // UPDATE lấy row lock, CHƯA commit → tx giữ lock park lại.
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    const t2 = db.transaction(async (tx) => {
      await tx.orm.public.User
        .where({ id: userId })
        .updateAll({ phone: phoneC, phoneVerifiedAt: T2 });
      signalLockTaken(); // lock đang giữ, tx vẫn mở
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    // Flow 1 = profile edit cùng số A (như user thấy trên form): action đọc
    // phone A (MVCC — T2 chưa commit), tới CAS write thì BLOCK trên row lock.
    const flow1 = updateProfileAction(
      {},
      fd({ name: "Tên Bị Race", phone: phoneA, city: "", bio: "" }),
    );
    // cho flow 1 kịp chạm write — nó KHÔNG THỂ qua được lock của T2, nên sau
    // sleep chắc chắn đang block (select của nó đã thấy phone A).
    await sleep(500);
    // T2 commit TRƯỚC khi await flow 1 — flow 1 đang block TRÊN row lock của
    // T2, chỉ thả khi T2 commit; commit sau await flow 1 = deadlock.
    commitT2();
    const state = await flow1;
    await t2;

    // CAS thấy 0 row (phone đã là C, không còn A) → typed error, KHÔNG success
    expect((state as { code?: string }).code).toBe("PHONE_CONCURRENT_CHANGE");
    expect((state as { success?: boolean }).success).toBeUndefined();
    // KHÔNG stale verified phone: số đã đổi (C) thắng, verifiedAt đúng của C
    // (timestamptz trả text PG "…+00" — so qua Date, không so chuỗi thô)
    const row = await db.orm.public.User.first({ id: userId });
    expect(row!.phone).toBe(phoneC);
    expect(new Date(row!.phoneVerifiedAt!).toISOString()).toBe(T2);
    // name KHÔNG bị flow 1 ghi đè
    expect(row!.name).toBe("IT Multirow");
  });

  it("neo ngữ nghĩa ORM: CAS với stored phone STALE → updateAll 0 row (filter nằm TRONG statement)", async () => {
    const userId = await mkUser();
    createdUsers.push(userId);
    const stale = mkPhone(); // action đã đọc (stale)
    const actual = mkPhone(); // số thật trong DB đã bị request khác đổi
    await db.orm.public.User.where({ id: userId }).updateAll({ phone: actual });

    const rows = await db.orm.public.User
      .where({ id: userId, phone: stale })
      .updateAll({ name: "Không Ai Cập Nhật" });

    expect(rows).toHaveLength(0); // 0 row — phone không khớp
    const row = await db.orm.public.User.first({ id: userId });
    expect(row!.name).toBe("IT Multirow"); // KHÔNG write
    expect(row!.phone).toBe(actual);
  });
});

// ─── 3. markAllReadAction — updateAll mọi row unread ─────────────────────────

d("markAllReadAction — đánh dấu MỌI thông báo unread (updateAll)", () => {
  it("3 unread → CẢ 3 readAt đặt (old .update() chỉ row unread ĐẦU), user khác không bị đụng", async () => {
    const userId = await mkUser();
    const otherId = await mkUser();
    createdUsers.push(userId, otherId);
    for (let i = 0; i < 3; i++) {
      await db.orm.public.Notification.create({
        userId,
        kind: "order",
        title: `Thông báo ${i}`,
      });
    }
    await db.orm.public.Notification.create({
      userId: otherId,
      kind: "order",
      title: "Của người khác",
    });

    await login(userId);
    await markAllReadAction();

    const mine = await db.orm.public.Notification.where({ userId }).all();
    expect(mine).toHaveLength(3);
    expect(mine.every((n) => n.readAt !== null)).toBe(true); // CẢ 3 — không chỉ 1
    const other = await db.orm.public.Notification.where({ userId: otherId }).all();
    expect(other).toHaveLength(1);
    expect(other[0]!.readAt).toBeNull(); // không đụng user khác
  });
});

// ─── 4. mergeModelAction — updateAll chuyển MỌI listing + price row ──────────

d("mergeModelAction — gộp model chuyển TẤT CẢ listings + price history (updateAll)", () => {
  it("2 listings + 2 price rows → TẤT CẢ sang target (old .update() chỉ 1 listing + 1 price row)", async () => {
    // moderator cũng có listing.moderate (ma trận rbac) — tránh super_admin để
    // row (nếu leak) không nhiễu test đếm super_admin của admin-bootstrap.
    const adminId = await mkUser({ adminRole: "moderator" });
    const sellerId = await mkUser({ role: "seller" });
    createdUsers.push(adminId, sellerId);
    const cat = await db.orm.public.Category.create({
      name: `Danh mục IT ${uid()}`,
      slug: `it-cat-${uid()}`,
    });
    const brand = await db.orm.public.Brand.create({
      name: `Brand IT ${uid()}`,
      slug: `it-brand-${uid()}`,
    });
    const model = await db.orm.public.ProductModel.create({
      brandId: brand.id,
      categoryId: cat.id,
      name: "Model Bị Gộp",
      slug: `it-model-${uid()}`,
      status: "approved",
    });
    const target = await db.orm.public.ProductModel.create({
      brandId: brand.id,
      categoryId: cat.id,
      name: "Model Gốc",
      slug: `it-target-${uid()}`,
      status: "approved",
    });
    const mkListing = async (): Promise<string> => {
      const l = await db.orm.public.Listing.create({
        sellerId,
        categoryId: cat.id,
        brandId: brand.id,
        title: `Loa IT ${uid()}`,
        slug: `it-listing-${uid()}`,
        description: "Mô tả đủ dài cho integration test",
        condition: "good",
        price: 1_000_000,
        status: "approved",
        city: "Hà Nội",
        productModelId: model.id,
      });
      return l.id;
    };
    const l1 = await mkListing();
    const l2 = await mkListing();
    const p1 = await db.orm.public.PriceHistory.create({
      modelId: model.id,
      listingId: l1,
      price: 1_000_000,
      kind: "listed",
    });
    const p2 = await db.orm.public.PriceHistory.create({
      modelId: model.id,
      listingId: l2,
      price: 1_000_000,
      kind: "listed",
    });

    await login(adminId, true); // session isAdmin — requireCapability hai điều kiện
    // finally: dọn FK-safe kể cả khi assertion fail (RED phase) — không để row
    // leak làm test sau (seed delta cleanup) dính FK violation.
    try {
      await mergeModelAction(fd({ modelId: model.id, targetId: target.id }));

      // MỌI listing của model chuyển sang target — không chỉ listing đầu
      const listings = await db.orm.public.Listing
        .where({ productModelId: target.id })
        .all();
      expect(listings.map((l) => l.id).sort()).toEqual([l1, l2].sort());
      // MỌI price row chuyển sang target — không chỉ row đầu
      const prices = await db.orm.public.PriceHistory
        .where({ modelId: target.id })
        .all();
      expect(prices.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
      // model gốc đánh dấu merged
      const mRow = await db.orm.public.ProductModel.first({ id: model.id });
      expect(mRow!.status).toBe("merged");
      expect(mRow!.mergedIntoId).toBe(target.id);
    } finally {
      // dọn (thứ tự FK): listing → price → model → category/brand → user
      await db.orm.public.Listing.where({ id: l1 }).deleteAll();
      await db.orm.public.Listing.where({ id: l2 }).deleteAll();
      await db.orm.public.PriceHistory.where({ id: p1.id }).deleteAll();
      await db.orm.public.PriceHistory.where({ id: p2.id }).deleteAll();
      await db.orm.public.ProductModel.where({ id: model.id }).deleteAll();
      await db.orm.public.ProductModel.where({ id: target.id }).deleteAll();
      await db.orm.public.Category.where({ id: cat.id }).deleteAll();
      await db.orm.public.Brand.where({ id: brand.id }).deleteAll();
    }
  });
});

// ─── 5. deleteAll — multi-row delete (AdminRecoveryCode) ──────────────────────

d("deleteAll — xoá MỌI row khớp filter (old .delete() chỉ 1 row đầu)", () => {
  it("where({ mfaId }).deleteAll() → cả 3 mã khôi phục biến mất", async () => {
    const userId = await mkUser();
    createdUsers.push(userId);
    const mfa = await db.orm.public.AdminMfa.create({
      userId,
      totpSecretEnc: "v1:it:AAAA",
    });
    for (let i = 0; i < 3; i++) {
      await db.orm.public.AdminRecoveryCode.create({
        mfaId: mfa.id,
        codeHash: `it-hash-${uid()}`,
      });
    }

    const deleted = await db.orm.public.AdminRecoveryCode
      .where({ mfaId: mfa.id })
      .deleteAll();

    expect(deleted).toHaveLength(3);
    expect(await db.orm.public.AdminRecoveryCode.where({ mfaId: mfa.id }).all()).toHaveLength(0);
    await db.orm.public.AdminMfa.where({ id: mfa.id }).deleteAll();
  });
});

// ─── 6. seed.ts — re-run idempotent (deleteAll sạch từng bảng) ────────────────

d("seed.ts — .where({}).deleteAll() mọi bảng → re-run idempotent", () => {
  it("chạy seed 2 lần liên tiếp: lần 2 vẫn exit 0, không nhân đôi (old .delete() 1 row/bảng → unique violation)", async () => {
    const env = {
      ...process.env,
      SEED_PASSWORD: "integration-seed-password",
    };
    // cwd riêng cho seed: seed ghi SVG placeholder vào public/img/listing
    // (relative cwd) — chạy từ temp dir để KHÔNG đụng file của repo (import
    // tương đối của seed resolve theo file, không theo cwd).
    const repoRoot = process.cwd();
    const seedBin = join(repoRoot, "node_modules/.bin/tsx");
    const seedScript = join(repoRoot, "src/prisma/seed.ts");
    const seedCwd = mkdtempSync(join(tmpdir(), "seed-it-"));
    const runSeed = (): Promise<{ stdout: string }> =>
      execFileAsync(seedBin, [seedScript], { env, cwd: seedCwd });
    // chụp id/key hiện có TRƯỚC khi seed — chỉ dọn DELTA của seed, không đụng
    // row test khác tạo (các file khác chạy tuần tự, không song song).
    const catIdsBefore = new Set((await db.orm.public.Category.all()).map((c) => c.id));
    const brandIdsBefore = new Set((await db.orm.public.Brand.all()).map((b) => b.id));
    const settingKeysBefore = new Set(
      (await db.orm.public.PlatformSetting.all()).map((s) => s.key),
    );

    // lần 1 — seed vào DB rỗng (các bảng seed đều trống) → exit 0
    await runSeed();
    const admin1 = await db.orm.public.User.where({ email: "admin@loaviet.vn" }).all();
    expect(admin1).toHaveLength(1);

    const seedEmails = [
      "admin@loaviet.vn",
      "seller1@loaviet.vn",
      "seller2@loaviet.vn",
      "seller3@loaviet.vn",
      "buyer@loaviet.vn",
    ];
    // finally: dọn DELTA seed + temp cwd kể cả khi assertion fail — không để
    // 5 user seed + 24 category leak sang file test sau (session-lifecycle…).
    try {
      // lần 2 — RE-SEED: deleteAll phải sạch từng bảng TRƯỚC khi tạo lại. Old
      // `.where({}).delete()` chỉ xoá 1 row/bảng → Cart.userId/User.email
      // unique violation → seed exit 1 (execFileAsync reject).
      await runSeed();

      // không nhân đôi: vẫn đúng 1 admin, đúng 5 user seed
      const admin2 = await db.orm.public.User.where({ email: "admin@loaviet.vn" }).all();
      expect(admin2).toHaveLength(1);
      for (const email of seedEmails) {
        const rows = await db.orm.public.User.where({ email }).all();
        expect(rows).toHaveLength(1);
      }
    } finally {
      // dọn DELTA seed (thứ tự FK): user (cascade cart/listing→ảnh/cart item/
      // session/notification) → category/brand theo delta → setting theo delta.
      for (const email of seedEmails) {
        await db.orm.public.User.where({ email }).deleteAll();
      }
      for (const c of await db.orm.public.Category.all()) {
        if (!catIdsBefore.has(c.id)) {
          await db.orm.public.Category.where({ id: c.id }).deleteAll();
        }
      }
      for (const b of await db.orm.public.Brand.all()) {
        if (!brandIdsBefore.has(b.id)) {
          await db.orm.public.Brand.where({ id: b.id }).deleteAll();
        }
      }
      for (const s of await db.orm.public.PlatformSetting.all()) {
        if (!settingKeysBefore.has(s.key)) {
          await db.orm.public.PlatformSetting.where({ key: s.key }).deleteAll();
        }
      }
      rmSync(seedCwd, { recursive: true, force: true });
    }
  });
});
