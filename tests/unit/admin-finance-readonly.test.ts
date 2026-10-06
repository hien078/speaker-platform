/**
 * Admin historical finance views — READ-ONLY contract (plan Task 5, spec §4.3).
 *
 * Khi FINANCIAL_FEATURES_ENABLED=false (mặc định private beta):
 *
 *  1. Ranh giới admin GIỮ NGUYÊN (spec §4.5 — Batch này không mở rộng quyền):
 *     chưa đăng nhập → redirect /login; không có adminRole → redirect /
 *     (Batch 2 Task 4: cổng đọc User.adminRole qua rbac — spec §8.5).
 *  2. Bản ghi tài chính lịch sử VẪN ĐỌC ĐƯỢC sau ranh giới đó (spec §4.3):
 *     dashboard / orders / disputes / withdraws / settings render với dữ liệu
 *     lịch sử (fixture) — không xóa code, không xóa dữ liệu.
 *  3. View finance lịch sử được LABEL dormancy/read-only rõ ràng ("chỉ đọc").
 *  4. Mọi control mutation tài chính BỎ KHỎI UI admin (dispute resolution,
 *     withdrawal processing, commission config, finance platform settings):
 *     rendered tree không chứa <form>; không còn link sang route public
 *     finance đã retire (Task 4) — tránh dead link gây hiểu nhầm.
 *  5. Server action dưới đáy VẪN GIỮ guard assertFinancialFeaturesEnabled()
 *     (spec §4.10 — control vắng mặt ≠ quyền mutate; defense-in-depth).
 *  6. Action admin phi tài chính (listing moderation, seller verification)
 *     KHÔNG bị xóa/guard thêm — seller verification là Batch 2 (§8 A-3).
 *
 * Cơ chế: db mock 2 chế độ — strict (mặc định, mọi truy cập ném lỗi) cho guard
 * test; fixture (bản ghi lịch sử) cho render test. Mutation method (create/
 * update/delete…) ném lỗi LUÔN: admin view read-only không được mutate gì.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// Session seam (Batch 2 Task 4): layout/pages/actions admin đọc quyền qua
// rbac.requireAdminUser/requireCapability → getSessionFromCookie — điều
// khiển được từ test, guard thật chạy qua rbac thật.
vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(),
}));

vi.mock("@/src/lib/auth", () => ({
  getCurrentUser: vi.fn(),
  requireUser: vi.fn(),
}));

/** Chế độ db mock: strict (mặc định) = mọi truy cập ném lỗi; fixture = trả bản ghi lịch sử. */
const dbState = vi.hoisted(() => ({ strict: true }));

vi.mock("@/src/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/src/prisma/db.client", () => {
  // ─── Bản ghi tài chính lịch sử (fixture cho render test) ────────────────
  const ORDER = {
    id: "order-1",
    code: "SP-260101-0001",
    buyerId: "buyer-1",
    sellerId: "seller-1",
    totalAmount: 2_500_000,
    commissionAmount: 125_000,
    commissionRate: 5,
    sellerPayout: 2_375_000,
    status: "completed",
    paymentMethod: "escrow",
    createdAt: "2026-10-01T08:00:00.000Z",
    buyer: { name: "Nguyễn Mua Lịch Sử" },
    seller: { name: "Trần Bán Cũ" },
    payments: [{ status: "released", method: "momo" }],
  };
  const PENDING_LISTING = {
    id: "listing-1",
    title: "Loa JBL Charge 5 cũ",
    price: 1_800_000,
    slug: "loa-jbl-charge-5-cu",
    sellerId: "seller-1",
    status: "pending",
    createdAt: "2026-10-05T09:00:00.000Z",
    seller: { name: "Trần Bán Cũ" },
    images: [{ url: "/uploads/loa.jpg" }],
  };
  const DISPUTE = {
    id: "dispute-1",
    orderId: "order-1",
    openedById: "buyer-1",
    status: "open",
    reason: "Loa không đúng mô tả, xin mở khiếu nại lịch sử",
    resolution: null,
    resolvedAt: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    openedBy: { name: "Nguyễn Mua Lịch Sử" },
    order: {
      id: "order-1",
      code: "SP-260101-0001",
      totalAmount: 2_500_000,
      sellerPayout: 2_375_000,
      commissionAmount: 125_000,
      status: "disputed",
      paymentMethod: "escrow",
      buyer: { name: "Nguyễn Mua Lịch Sử" },
      seller: { name: "Trần Bán Cũ" },
      items: [{ title: "Loa JBL Charge 5 cũ" }],
    },
  };
  const WITHDRAW = {
    id: "wr-1",
    sellerId: "seller-1",
    amount: 500_000,
    status: "requested",
    bankName: "Vietcombank",
    bankAccount: "0123456789",
    accountHolder: "Trần Bán Cũ",
    note: null,
    adminNote: null,
    processedAt: null,
    createdAt: "2026-10-03T07:30:00.000Z",
    seller: {
      name: "Trần Bán Cũ",
      email: "seller@loaviet.test",
      phone: "0901234567",
      isVerifiedSeller: true,
    },
  };
  const CATEGORY = { id: "cat-1", name: "Loa di động", icon: "🔊", commissionRate: 5, sortOrder: 1 };
  const SETTING_ESCROW = { key: "escrow_auto_release_days", value: "7" };
  const SETTING_COMMISSION = { key: "default_commission_rate", value: "5" };
  const AUDIT_LOG = {
    id: "log-1",
    action: "resolve_dispute",
    entity: "Dispute",
    entityId: "dispute-1",
    detail: "Đơn SP-260101-0001: bản ghi lịch sử",
    createdAt: "2026-10-04T11:00:00.000Z",
    admin: { name: "Admin Cũ" },
  };

  const FIXTURES: Record<string, { all: unknown[]; first: unknown; aggregate: unknown }> = {
    User: { all: [], first: null, aggregate: { c: 5 } },
    Listing: { all: [PENDING_LISTING], first: PENDING_LISTING, aggregate: { c: 2 } },
    Order: { all: [ORDER], first: ORDER, aggregate: { total: 30_000_000, c: 3 } },
    Payment: { all: [], first: null, aggregate: { total: 2_000_000 } },
    Payout: { all: [], first: null, aggregate: { total: 1_000_000 } },
    WithdrawRequest: { all: [WITHDRAW], first: WITHDRAW, aggregate: { c: 1, total: 500_000 } },
    Dispute: { all: [DISPUTE], first: DISPUTE, aggregate: { c: 1 } },
    Category: { all: [CATEGORY], first: CATEGORY, aggregate: { total: 0, c: 0 } },
    PlatformSetting: {
      all: [SETTING_ESCROW, SETTING_COMMISSION],
      first: SETTING_ESCROW,
      aggregate: { total: 0, c: 0 },
    },
    AdminAuditLog: { all: [AUDIT_LOG], first: AUDIT_LOG, aggregate: { total: 0, c: 0 } },
  };

  const CHAIN = ["where", "include", "select", "orderBy", "limit", "offset"] as const;
  const makeModel = (name: string) => {
    const fx = FIXTURES[name] ?? { all: [], first: null, aggregate: { total: 0, c: 0 } };
    const obj: Record<string, unknown> = {};
    for (const m of CHAIN) obj[m] = vi.fn(() => obj);
    // Read: strict mode ném lỗi (guard test chứng minh không chạm db);
    // fixture mode trả bản ghi lịch sử (render test).
    obj.first = vi.fn(() => {
      if (dbState.strict) throw new Error(`DB_TOUCHED_${name}.first`);
      return fx.first;
    });
    obj.all = vi.fn(() => {
      if (dbState.strict) throw new Error(`DB_TOUCHED_${name}.all`);
      return fx.all;
    });
    obj.aggregate = vi.fn(() => {
      if (dbState.strict) throw new Error(`DB_TOUCHED_${name}.aggregate`);
      return fx.aggregate;
    });
    obj.count = vi.fn(() => {
      if (dbState.strict) throw new Error(`DB_TOUCHED_${name}.count`);
      return fx.all.length;
    });
    // Mutation: LUÔN ném lỗi — admin view read-only không được mutate gì
    // (kể cả khi fixture mode — đây là hợp đồng của file test này).
    for (const m of ["create", "update", "updateAll", "updateAndCount", "delete", "deleteAll"]) {
      obj[m] = vi.fn(() => {
        throw new Error(`DB_MUTATION_ATTEMPT_${name}.${m}`);
      });
    }
    return obj;
  };
  const orm = {
    public: Object.fromEntries(
      [
        "User", "Listing", "Cart", "CartItem", "Order", "OrderItem", "Payment",
        "Payout", "WithdrawRequest", "LedgerEntry", "Dispute", "OrderStatusHistory",
        "ExchangeOffer", "Offer", "Conversation", "Category", "PlatformSetting",
        "Notification", "AdminAuditLog", "PriceHistory",
      ].map((n) => [n, makeModel(n)]),
    ),
  };
  const db = {
    orm,
    transaction: vi.fn(() => {
      throw new Error("DB_TRANSACTION_ATTEMPT_ON_READ_ONLY_ADMIN_VIEW");
    }),
  };
  return { db };
});

import { getSessionFromCookie } from "@/src/lib/session";
import { DormantFinanceNotice } from "../../app/admin/dormant-notice";
import * as adminLayout from "../../app/admin/layout";
import * as adminDashboard from "../../app/admin/page";
import * as adminOrdersPage from "../../app/admin/orders/page";
import * as adminDisputesPage from "../../app/admin/disputes/page";
import * as adminWithdrawsPage from "../../app/admin/withdraws/page";
import * as adminSettingsPage from "../../app/admin/settings/page";
import {
  resolveDisputeAction,
  updateCommissionAction,
  updateSettingAction,
} from "@/src/lib/actions/admin";
import { processWithdrawAction } from "@/src/lib/actions/withdraw";

const getSessionMock = vi.mocked(getSessionFromCookie);

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

type AnyComponent = (props?: unknown) => Promise<unknown>;
const AdminLayout = adminLayout.default as unknown as AnyComponent;
const AdminDashboardPage = adminDashboard.default as unknown as AnyComponent;
const AdminOrdersPage = adminOrdersPage.default as unknown as AnyComponent;
const AdminDisputesPage = adminDisputesPage.default as unknown as AnyComponent;
const AdminWithdrawsPage = adminWithdrawsPage.default as unknown as AnyComponent;
const AdminSettingsPage = adminSettingsPage.default as unknown as AnyComponent;

const ADMIN_USER = {
  id: "admin-1",
  email: "admin@loaviet.test",
  name: "Admin Cũ",
  role: "admin",
  avatarUrl: null,
  isVerifiedSeller: false,
  // Batch 2 Task 2: SessionUser thêm adminRole + sessionId (bắt buộc)
  adminRole: null,
  sessionId: "sess-fixture",
} as const;

/** Session fixture — shape SessionInfo (Task 2). */
const ADMIN_SESSION = {
  id: "sess-fixture",
  userId: "admin-1",
  isAdmin: true,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-10-06T20:00:00.000Z",
  steppedUpAt: null,
  userAgent: null,
} as const;

/** Admin thật qua rbac: adminRole super_admin → mọi capability trừ pii.export. */
const loginSuperAdmin = () =>
  getSessionMock.mockResolvedValue({
    session: { ...ADMIN_SESSION },
    user: { ...ADMIN_USER, adminRole: "super_admin" as const },
  });

// ─── React element tree helpers (async server component return value) ────────

type ElementLike = { type?: unknown; props?: { children?: unknown } | null };

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
      walk(el.props?.children, visit);
    }
  }
}

/** Toàn bộ text trong tree — assert bản ghi/copy hiển thị ra admin. */
function textOf(node: unknown): string {
  const parts: string[] = [];
  const collect = (n: unknown) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (typeof n === "object" && n !== null) {
      collect((n as ElementLike).props?.children);
    }
  };
  collect(node);
  return parts.join(" ");
}

/** Số <form> trong tree — 0 = không còn control mutation nào được render. */
function formCount(node: unknown): number {
  let count = 0;
  walk(node, (el) => {
    if (el.type === "form") count += 1;
  });
  return count;
}

/**
 * Tree có render component notice dormancy không (so sánh type reference —
 * text bên trong component chỉ hiện khi gọi hàm; ở đây chỉ cần chứng minh
 * notice được render, nội dung notice assert ở hợp đồng nguồn riêng).
 */
function treeContains(node: unknown, type: unknown): boolean {
  let found = false;
  walk(node, (el) => {
    if (el.type === type) found = true;
  });
  return found;
}

function fd(entries: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, String(v));
  return f;
}

beforeEach(() => {
  // Mặc định private beta: tài chính TẮT (env bỏ trống = false — spec §5.1)
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
  dbState.strict = true;
  getSessionMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ─── 1. Ranh giới admin giữ nguyên (spec §4.5 — không mở rộng quyền) ─────────

describe("ranh giới admin giữ nguyên — KHÔNG mở rộng quyền (spec §4.5)", () => {
  it("chưa đăng nhập → redirect /login (như cũ)", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(AdminLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("không có adminRole → redirect / (kể cả legacy role=\"admin\" — spec §8.5)", async () => {
    getSessionMock.mockResolvedValue({
      session: { ...ADMIN_SESSION },
      user: { ...ADMIN_USER, role: "seller" as const },
    });
    await expect(AdminLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("adminRole → render nav; view finance lịch sử vẫn reachable + label chỉ đọc; nav phi tài chính giữ nguyên", async () => {
    loginSuperAdmin();
    const tree = await AdminLayout({ children: null });
    const text = textOf(tree);
    // nav phi tài chính KHÔNG bị thu hẹp (listing/catalog/users là Batch khác)
    expect(text).toContain("Tổng quan");
    expect(text).toContain("Duyệt tin đăng");
    expect(text).toContain("Catalog model");
    expect(text).toContain("Người dùng");
    // view finance lịch sử vẫn reachable (spec §4.3) + label read-only (Task 5)
    expect(text).toContain("Đơn hàng");
    expect(text).toContain("Khiếu nại");
    expect(text).toContain("Rút tiền");
    expect(text).toContain("chỉ đọc");
  });
});

// ─── 2. Bản ghi lịch sử đọc được + control mutation đã bỏ ─────────────────────

describe("bản ghi tài chính lịch sử vẫn đọc được, view read-only (spec §4.3 + plan Task 5)", () => {
  beforeEach(() => {
    dbState.strict = false; // fixture mode: db trả bản ghi lịch sử
    loginSuperAdmin(); // guard page (Task 4) qua rbac thật — super_admin
  });

  it("dashboard: số liệu + đơn gần đây render read-only, có label dormancy", async () => {
    const tree = await AdminDashboardPage();
    const text = textOf(tree);
    expect(text).toContain("SP-260101-0001"); // đơn gần đây (lịch sử)
    expect(text).toContain("Trần Bán Cũ"); // seller
    expect(treeContains(tree, DormantFinanceNotice)).toBe(true); // label dormant/read-only
  });

  it("orders: bảng đơn lịch sử render read-only, có label dormancy", async () => {
    const tree = await AdminOrdersPage({ searchParams: Promise.resolve({}) });
    const text = textOf(tree);
    expect(text).toContain("SP-260101-0001");
    expect(text).toContain("Nguyễn Mua Lịch Sử");
    expect(treeContains(tree, DormantFinanceNotice)).toBe(true);
  });

  it("disputes: khiếu nại lịch sử đọc được — KHÔNG còn form xử lý (control đã bỏ)", async () => {
    const tree = await AdminDisputesPage();
    const text = textOf(tree);
    expect(text).toContain("Loa không đúng mô tả, xin mở khiếu nại lịch sử");
    expect(text).toContain("SP-260101-0001");
    expect(treeContains(tree, DormantFinanceNotice)).toBe(true);
    expect(formCount(tree)).toBe(0); // form xử lý khiếu nại đã bỏ
  });

  it("withdraws: yêu cầu rút tiền lịch sử đọc được — KHÔNG còn form xử lý", async () => {
    const tree = await AdminWithdrawsPage();
    const text = textOf(tree);
    expect(text).toContain("Vietcombank");
    expect(text).toContain("0123456789");
    expect(treeContains(tree, DormantFinanceNotice)).toBe(true);
    expect(formCount(tree)).toBe(0); // form xử lý rút tiền đã bỏ
  });

  it("settings: cấu hình finance lịch sử + audit log đọc được — KHÔNG còn form", async () => {
    const tree = await AdminSettingsPage();
    const text = textOf(tree);
    expect(text).toContain("Loa di động"); // category (commission read-only)
    expect(text).toContain("resolve_dispute"); // audit log vẫn đọc được
    expect(treeContains(tree, DormantFinanceNotice)).toBe(true);
    expect(formCount(tree)).toBe(0); // form hoa hồng + settings đã bỏ
  });
});

// ─── 3. Hợp đồng nguồn — control mutation bỏ khỏi UI, không dead link ──────────

describe("hợp đồng nguồn — bỏ control mutation finance khỏi UI admin (plan Task 5)", () => {
  it("disputes: bỏ resolveDisputeAction + form khỏi page", () => {
    const src = read("app/admin/disputes/page.tsx");
    expect(src).not.toContain("resolveDisputeAction");
    expect(src).not.toContain("<form");
  });

  it("withdraws: bỏ processWithdrawAction + form khỏi page", () => {
    const src = read("app/admin/withdraws/page.tsx");
    expect(src).not.toContain("processWithdrawAction");
    expect(src).not.toContain("<form");
  });

  it("settings: bỏ updateCommissionAction + updateSettingAction + form; audit log giữ", () => {
    const src = read("app/admin/settings/page.tsx");
    expect(src).not.toContain("updateCommissionAction");
    expect(src).not.toContain("updateSettingAction");
    expect(src).not.toContain("<form");
    expect(src).toContain("AdminAuditLog"); // audit log vẫn đọc được
  });

  it("orders/dashboard/disputes: không còn link tới route public finance đã retire (/orders/*)", () => {
    for (const f of [
      "app/admin/orders/page.tsx",
      "app/admin/page.tsx",
      "app/admin/disputes/page.tsx",
    ]) {
      expect(read(f)).not.toContain("/orders/");
    }
  });

  it("mọi view finance admin dùng notice dormancy dùng chung (label rõ ràng)", () => {
    for (const f of [
      "app/admin/page.tsx",
      "app/admin/orders/page.tsx",
      "app/admin/disputes/page.tsx",
      "app/admin/withdraws/page.tsx",
      "app/admin/settings/page.tsx",
    ]) {
      expect(read(f)).toContain("DormantFinanceNotice");
    }
  });

  it("notice dormancy: label rõ ràng — chỉ đọc/dormant + mã FINANCIAL_FEATURES_DISABLED", () => {
    const src = read("app/admin/dormant-notice.tsx");
    expect(src).toContain("chỉ đọc");
    expect(src).toContain("dormant");
    expect(src).toContain("FINANCIAL_FEATURES_DISABLED");
  });
});

// ─── 4. Guard server action giữ nguyên dù control UI đã bỏ (spec §4.10) ────────

describe("server action finance giữ guard dù control UI đã bỏ (spec §4.10 — defense-in-depth)", () => {
  beforeEach(() => {
    // Tripwire: rbac guard đọc session qua seam này — nếu action chạm auth khi
    // tài chính tắt thì spy ném lỗi (không phải mã tài chính) → test đỏ ngay.
    getSessionMock.mockImplementation(() => {
      throw new Error("AUTH_REACHED_WITHOUT_FINANCE_GUARD");
    });
  });

  it("resolveDisputeAction: deny FINANCIAL_FEATURES_DISABLED trước auth/db", async () => {
    await expect(
      resolveDisputeAction(
        fd({ disputeId: "dispute-1", resolution: "Đối soát xong", outcome: "resolved_buyer" }),
      ),
    ).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("updateCommissionAction: deny trước Category mutation", async () => {
    await expect(
      updateCommissionAction(fd({ categoryId: "cat-1", commissionRate: 10 })),
    ).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("updateSettingAction: deny trước PlatformSetting upsert", async () => {
    await expect(
      updateSettingAction(fd({ key: "escrow_auto_release_days", value: "7" })),
    ).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("processWithdrawAction: deny trước WithdrawRequest claim/ledger", async () => {
    await expect(
      processWithdrawAction(fd({ withdrawId: "wr-1", action: "paid" })),
    ).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("guard assert còn nguyên trong source action (retention qua Task 5)", () => {
    const adminSrc = read("src/lib/actions/admin.ts");
    const withdrawSrc = read("src/lib/actions/withdraw.ts");
    // admin.ts: resolveDispute + updateCommission + updateSetting (≥3)
    expect((adminSrc.match(/assertFinancialFeaturesEnabled\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // withdraw.ts: createWithdrawRequest + processWithdraw (≥2)
    expect((withdrawSrc.match(/assertFinancialFeaturesEnabled\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ─── 5. Không xóa code, không mở rộng/thu hẹp quyền ───────────────────────────

describe("không xóa code finance/admin, không đụng scope phi tài chính (plan Task 5)", () => {
  it("action admin phi tài chính giữ nguyên (listing moderation) — legacy toggle ĐÃ XÓA bởi Task 10 (spec §8.2)", () => {
    const src = read("src/lib/actions/admin.ts");
    // listing moderation giữ nguyên (phi finance — không đụng)
    for (const name of ["approveListingAction", "rejectListingAction"]) {
      expect(src).toContain(`export async function ${name}`);
    }
    // Batch 2 Task 10: SellerVerification workflow là canonical — legacy
    // boolean toggle KHÔNG còn (spec §8.2; plan Task 12 scan: 0 hits src/app).
    expect(src).not.toContain("toggleSellerVerificationAction");
    expect(src).not.toMatch(/isVerifiedSeller\s*[:=]/); // không còn đường mutate boolean legacy
  });

  it("admin users page (phi finance) — toggle thay bằng cohort grant + link workflow (Task 10, spec §8.2)", () => {
    const src = read("app/admin/users/page.tsx");
    expect(src).toContain("setBetaMembershipAction"); // grant/suspend founding_seller
    expect(src).toContain("/admin/seller-verification"); // link sang hàng đợi review
    expect(src).not.toContain("toggleSellerVerificationAction"); // workflow canonical
  });
});
