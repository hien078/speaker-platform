/**
 * Capability RBAC — ma trận quyền + guards (plan Task 4, spec §5.4/§5.4.1/§8.5).
 *
 * Cơ chế mock: `server-only` + `next/navigation` (redirect throw NEXT_REDIRECT)
 * + `@/src/lib/session` (getSessionFromCookie điều khiển được — đúng seam mà
 * requireCapability/requireAdminUser tiêu thụ) — cùng phong cách finance tests.
 *
 * Hợp đồng (plan Task 4 Step 1 — authorization matrix gate):
 *  1. ROLE_CAPABILITIES asserted TỪNG Ô như dữ liệu — đúng ma trận plan
 *     (spec §5.4.1), fail closed trên mọi ô Scoped/Exceptional/Limited/
 *     Explicit-permission chưa định nghĩa (Ambiguities A2): pii.export KHÔNG
 *     cấp cho ai; moderator/support chỉ được những gì ma trận ✓.
 *  2. requireCapability deny: không session → FORBIDDEN; buyer → FORBIDDEN;
 *     support gọi seller.verify → FORBIDDEN (Review Focus 4 — support→admin
 *     escalation qua gọi action trực tiếp); analyst gọi beta_cohort.manage →
 *     FORBIDDEN.
 *  3. requireCapability grant đúng role → trả về context { user, session }.
 *  4. Legacy role="admin" + adminRole=null → KHÔNG cấp gì (spec §8.5: boolean
 *     cũ không phải authorization thường trực); adminRole là DB string lạ
 *     (legacy/typo ngoài union) cũng deny sạch — fail closed TƯỜNG MINH,
 *     không để `.includes` trên undefined ném TypeError thay vì FORBIDDEN
 *     (review follow-up Task 4).
 *  5. requireAdminUser — cổng vào /admin: chưa đăng nhập → redirect /login;
 *     adminRole null → redirect /; adminRole bất kỳ → context.
 *
 * KHÔNG có guard step-up ở đây — requireCapabilityWithStepUp + STEP_UP_CAPABILITIES
 * thuộc Task 8 (thêm vào rbac.ts như interface hoàn chỉnh cùng module MFA).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// redirect() throw NEXT_REDIRECT — như admin-finance-readonly.test.ts
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// Session seam — guards đọc qua getSessionFromCookie (Task 2)
const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
}));

vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(async () => sessionState.current),
}));

import { getSessionFromCookie } from "@/src/lib/session";
import {
  ROLE_CAPABILITIES,
  capabilitiesOf,
  requireCapability,
  requireAdminUser,
  type AdminRole,
  type Capability,
} from "@/src/lib/rbac";

const getSessionMock = vi.mocked(getSessionFromCookie);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION = {
  id: "sess-1",
  userId: "user-1",
  isAdmin: true,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-10-06T20:00:00.000Z",
  steppedUpAt: null,
  userAgent: null,
} as const;

/** SessionUser fixture — role chỉ là display (spec §8.5), adminRole là nguồn quyền. */
const userWith = (adminRole: AdminRole | null, role: "buyer" | "seller" | "admin" = "buyer") => ({
  id: "user-1",
  email: "u@loaviet.test",
  name: "U",
  role,
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole,
  sessionId: "sess-1",
});

const login = (user: Record<string, unknown>): void => {
  sessionState.current = { session: { ...SESSION }, user };
};

/**
 * Session user với adminRole là DB string ngoài union — TS không mô tả được
 * runtime (legacy/typo/enum thêm sau này); guard phải deny sạch, không crash.
 */
const userWithUnknownRole = (raw: string): Record<string, unknown> => ({
  ...userWith(null),
  adminRole: raw,
});

const ROLES: AdminRole[] = ["super_admin", "operations_admin", "moderator", "support", "analyst"];

const ALL_CAPS: Capability[] = [
  "admin.access",
  "analytics.read",
  "beta_cohort.manage",
  "seller.verify",
  "seller.verification.revoke",
  "listing.moderate",
  "report.resolve",
  "user.suspend",
  "user.view_basic",
  "pii.view_sensitive",
  "pii.export",
  "session.revoke",
  "admin.role_manage",
  "security.config",
  "audit.read",
];

// Ma trận kỳ vọng — ĐÚNG từng ô plan Task 4 (spec §5.4.1). Ô "—" trong spec
// (Scoped / Exceptional + audited / Limited / Explicit permission) fail closed
// cho tới khi founder định nghĩa semantics (Ambiguities A2).
const EXPECTED: Record<Capability, Record<AdminRole, boolean>> = {
  "admin.access": { super_admin: true, operations_admin: true, moderator: true, support: true, analyst: true },
  "analytics.read": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: true },
  "beta_cohort.manage": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: false },
  "seller.verify": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: false },
  "seller.verification.revoke": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: false },
  "listing.moderate": { super_admin: true, operations_admin: true, moderator: true, support: false, analyst: false },
  "report.resolve": { super_admin: true, operations_admin: true, moderator: true, support: false, analyst: false },
  "user.suspend": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: false },
  "user.view_basic": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: false },
  "pii.view_sensitive": { super_admin: true, operations_admin: false, moderator: false, support: false, analyst: false },
  "pii.export": { super_admin: false, operations_admin: false, moderator: false, support: false, analyst: false },
  "session.revoke": { super_admin: true, operations_admin: true, moderator: false, support: false, analyst: false },
  "admin.role_manage": { super_admin: true, operations_admin: false, moderator: false, support: false, analyst: false },
  "security.config": { super_admin: true, operations_admin: false, moderator: false, support: false, analyst: false },
  "audit.read": { super_admin: true, operations_admin: false, moderator: false, support: false, analyst: false },
};

beforeEach(() => {
  sessionState.current = null;
  getSessionMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 1. Ma trận — từng ô như dữ liệu (spec §5.4.1, fail-closed A2) ────────────

describe("ROLE_CAPABILITIES — ma trận §5.4.1 từng ô (fail closed trên mọi ô A2)", () => {
  it("mỗi ô (role × capability) đúng kỳ vọng của ma trận plan", () => {
    for (const role of ROLES) {
      const granted = new Set(ROLE_CAPABILITIES[role]);
      for (const cap of ALL_CAPS) {
        // message rõ ô nào sai — ma trận là dữ liệu, không phải if-chains
        expect(granted.has(cap), `${role} × ${cap}`).toBe(EXPECTED[cap]![role]);
      }
    }
  });

  it("pii.export KHÔNG cấp cho AI — fail closed (ô Explicit permission chưa định nghĩa)", () => {
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role], `pii.export phải vắng trong ${role}`).not.toContain("pii.export");
    }
  });

  it("mọi role có admin.access (vào được /admin); support chỉ được admin.access (A2)", () => {
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role]).toContain("admin.access");
    }
    expect([...ROLE_CAPABILITIES.support]).toEqual(["admin.access"]);
  });

  it("moderator chỉ được listing.moderate + report.resolve ngoài admin.access (A2)", () => {
    expect([...ROLE_CAPABILITIES.moderator].sort()).toEqual(["admin.access", "listing.moderate", "report.resolve"]);
  });

  it("capabilitiesOf: null/undefined → rỗng (fail closed); role → đúng ROLE_CAPABILITIES", () => {
    expect(capabilitiesOf(null)).toEqual([]);
    expect(capabilitiesOf(undefined)).toEqual([]);
    for (const role of ROLES) {
      expect(capabilitiesOf(role)).toEqual(ROLE_CAPABILITIES[role]);
    }
  });

  it("capabilitiesOf: DB string lạ (legacy/typo/enum mới hơn app) → rỗng — fail closed, không TypeError", () => {
    // Runtime: adminRole đến từ DB dưới dạng string — TS không mô tả được giá
    // trị ngoài union (review follow-up Task 4). Key prototype ("constructor")
    // cũng không lọt qua own-property check của matrix.
    expect(capabilitiesOf("admin" as unknown as AdminRole)).toEqual([]);
    expect(capabilitiesOf("auditor" as unknown as AdminRole)).toEqual([]);
    expect(capabilitiesOf("constructor" as unknown as AdminRole)).toEqual([]);
  });
});

// ─── 2+3. requireCapability — deny sai role, grant đúng role (spec §4.5) ─────

describe("requireCapability — deny/grant (spec §4.5 — backend authorization)", () => {
  it("không có session → FORBIDDEN (fail closed)", async () => {
    await expect(requireCapability("listing.moderate")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("buyer (adminRole null) → FORBIDDEN", async () => {
    login(userWith(null, "buyer"));
    await expect(requireCapability("listing.moderate")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("support gọi seller.verify → FORBIDDEN (Review Focus 4 — support→admin escalation)", async () => {
    login(userWith("support"));
    await expect(requireCapability("seller.verify")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("analyst gọi beta_cohort.manage → FORBIDDEN", async () => {
    login(userWith("analyst"));
    await expect(requireCapability("beta_cohort.manage")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("legacy role=\"admin\" + adminRole=null → KHÔNG cấp capability nào (spec §8.5)", async () => {
    login(userWith(null, "admin"));
    for (const cap of ALL_CAPS) {
      await expect(requireCapability(cap), `legacy admin × ${cap}`).rejects.toThrowError(/^FORBIDDEN$/);
    }
  });

  it("adminRole là DB string lạ (legacy/typo) → FORBIDDEN — fail closed, không TypeError 500", async () => {
    // Giá trị adminRole ngoài union (TS không mô tả được runtime) phải deny
    // sạch (review follow-up Task 4) — không crash `.includes` trên undefined.
    login(userWithUnknownRole("admin"));
    await expect(requireCapability("listing.moderate")).rejects.toThrowError(/^FORBIDDEN$/);
    await expect(requireCapability("admin.access")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("grant đúng role → trả về context { user, session }", async () => {
    login(userWith("operations_admin"));
    const ctx = await requireCapability("seller.verify");
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.user.adminRole).toBe("operations_admin");
    expect(ctx.session.id).toBe("sess-1");
  });

  it("super_admin được MỌI capability trừ pii.export (đúng ma trận)", async () => {
    login(userWith("super_admin"));
    for (const cap of ALL_CAPS.filter((c) => c !== "pii.export")) {
      const ctx = await requireCapability(cap);
      expect(ctx.user.adminRole).toBe("super_admin");
    }
    await expect(requireCapability("pii.export")).rejects.toThrowError(/^FORBIDDEN$/);
  });

  it("đọc qua getSessionFromCookie — KHÔNG đọc user.role/isVerifiedSeller làm quyền", async () => {
    login(userWith("moderator"));
    await requireCapability("listing.moderate");
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 4b. Admin authority bind vào session MFA (review fix #1) ────────────────
// adminRole là quyền TIỀM NĂNG của user; session.isAdmin là BẰNG CHỨNG session
// đã qua MFA (login path duy nhất set isAdmin=true). User được promote
// (SQL/bootstrap/Task 11) khi đang giữ session consumer 30 ngày KHÔNG được
// hưởng capability admin nào cho tới khi đăng nhập lại qua MFA.

describe("admin authority bind vào session MFA — session consumer + adminRole → KHÔNG quyền (review fix #1)", () => {
  /** Đăng nhập với session CONSUMER (isAdmin false) — user có adminRole. */
  const loginConsumerSession = (user: Record<string, unknown>): void => {
    sessionState.current = { session: { ...SESSION, isAdmin: false }, user };
  };

  it("adminRole set + session consumer → FORBIDDEN trên MỌI capability (không MFA, không quyền)", async () => {
    loginConsumerSession(userWith("super_admin"));
    for (const cap of ALL_CAPS) {
      await expect(requireCapability(cap), `promoted × ${cap}`).rejects.toThrowError(/^FORBIDDEN$/);
    }
  });

  it("adminRole set + session consumer → requireAdminUser redirect / (layout coi như non-admin)", async () => {
    loginConsumerSession(userWith("operations_admin"));
    await expect(requireAdminUser()).rejects.toThrowError("NEXT_REDIRECT:/");
  });

  it("session MFA (isAdmin true) + đúng role → được như thường (hành vi cũ giữ nguyên)", async () => {
    login(userWith("operations_admin")); // SESSION fixture: isAdmin true
    const ctx = await requireCapability("seller.verify");
    expect(ctx.user.adminRole).toBe("operations_admin");
    const layout = await requireAdminUser();
    expect(layout.session.isAdmin).toBe(true);
  });

  it("adminRole null + session isAdmin true (data lạ) → vẫn FORBIDDEN — CẬP HAI điều kiện", async () => {
    // isAdmin=true một mình KHÔNG đủ — capability vẫn đọc adminRole qua ma trận.
    login(userWith(null, "buyer"));
    await expect(requireCapability("listing.moderate")).rejects.toThrowError(/^FORBIDDEN$/);
  });
});

// ─── 5. requireAdminUser — cổng vào /admin (redirect, không throw) ─────────────

describe("requireAdminUser — cổng vào /admin (bất kỳ adminRole nào)", () => {
  it("chưa đăng nhập → redirect /login", async () => {
    await expect(requireAdminUser()).rejects.toThrowError("NEXT_REDIRECT:/login");
  });

  it("đăng nhập nhưng adminRole null → redirect / (kể cả legacy role=\"admin\")", async () => {
    login(userWith(null, "admin"));
    await expect(requireAdminUser()).rejects.toThrowError("NEXT_REDIRECT:/");
  });

  it("adminRole bất kỳ → trả về context { user, session }", async () => {
    login(userWith("support"));
    const ctx = await requireAdminUser();
    expect(ctx.user.adminRole).toBe("support");
    expect(ctx.session.id).toBe("sess-1");
  });
});
