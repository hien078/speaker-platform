import "server-only";
import { redirect } from "next/navigation";
import { getSessionFromCookie, type SessionInfo, type SessionUser } from "@/src/lib/session";

/**
 * Capability RBAC (Batch 2 Task 4 — spec §5.4/§5.4.1) — thay check role rộng
 * của Batch 1 bằng ma trận capability typed, enforce ở MỌI ranh giới
 * server action / page admin (spec §4.5: hidden nav không phải authorization).
 *
 * Nguồn quyền duy nhất: `User.adminRole` (spec §8.5) — KHÔNG bao giờ đọc
 * `user.role` (chỉ còn display) hay `isVerifiedSeller` (legacy, chỉ hiển thị)
 * để quyết định quyền.
 *
 * Fail closed trên mọi ô ma trận chưa định nghĩa (Ambiguities A2 — spec §5.4.1
 * các ô Scoped / Exceptional + audited / Limited / Explicit permission):
 * Batch 2 chỉ cấp các cell ✓ rõ ràng; `pii.export` KHÔNG cấp cho ai;
 * moderator/support chỉ được những gì ma trận cho.
 *
 * KHÔNG có guard step-up trong task này — `requireCapabilityWithStepUp` +
 * `STEP_UP_CAPABILITIES` được Task 8 THÊM vào module này như interface hoàn
 * chỉnh (verifyAdminMfaCode thật), cùng commit với module MFA.
 */

export type AdminRole = "super_admin" | "operations_admin" | "moderator" | "support" | "analyst";

export type Capability =
  | "admin.access" // vào khu vực admin (layout)
  | "analytics.read"
  | "beta_cohort.manage"
  | "seller.verify" // review + approve/reject seller verification
  | "seller.verification.revoke"
  | "listing.moderate"
  | "report.resolve" // Batch 3 dùng — định nghĩa sẵn trong matrix
  | "user.suspend" // Batch 3 dùng — định nghĩa sẵn trong matrix
  | "user.view_basic" // trang danh sách người dùng (thông tin hỗ trợ cơ bản)
  | "pii.view_sensitive" // step-up (guard thuộc Task 8)
  | "pii.export" // KHÔNG cấp cho ai trong Batch 2 (fail closed — Ambiguities A2)
  | "session.revoke"
  | "admin.role_manage" // step-up (guard thuộc Task 8)
  | "security.config" // step-up (guard thuộc Task 8) — chưa có surface dùng trong Batch 2
  | "audit.read";

/**
 * Ma trận role → capability — ĐÚNG từng ô plan Task 4 (spec §5.4.1).
 * Ô "Scoped"/"Exceptional + audited"/"Limited"/"Explicit permission" của spec
 * fail closed cho tới khi founder định nghĩa semantics (Ambiguities A2):
 * moderator/support `user.suspend` Scoped → không cấp; moderator/support
 * `pii.view_sensitive` Exceptional → không cấp; moderator analytics Limited →
 * không cấp; super_admin `pii.export` Explicit permission → không cấp.
 */
export const ROLE_CAPABILITIES: Record<AdminRole, readonly Capability[]> = {
  super_admin: [
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
    "session.revoke",
    "admin.role_manage",
    "security.config",
    "audit.read",
  ],
  operations_admin: [
    "admin.access",
    "analytics.read",
    "beta_cohort.manage",
    "seller.verify",
    "seller.verification.revoke",
    "listing.moderate",
    "report.resolve",
    "user.suspend",
    "user.view_basic",
    "session.revoke",
  ],
  moderator: ["admin.access", "listing.moderate", "report.resolve"],
  support: ["admin.access"],
  analyst: ["admin.access", "analytics.read"],
};

/**
 * Capability của một role — null/undefined → rỗng (fail closed, spec §8.5).
 *
 * Runtime có thể nhận DB string ngoài union (legacy/typo/enum thêm sau này —
 * TS không mô tả được giá trị DB cũ) → fail closed TƯỜNG MINH: chỉ own
 * property của matrix mới được capability (key lạ kể cả key prototype như
 * "constructor" → rỗng), không để `.includes` trên undefined ném TypeError
 * thay vì deny (review follow-up Task 4).
 */
export function capabilitiesOf(role: AdminRole | null | undefined): readonly Capability[] {
  if (role === null || role === undefined) return [];
  return Object.hasOwn(ROLE_CAPABILITIES, role) ? ROLE_CAPABILITIES[role] : [];
}

/** Context admin sau guard — action/page dùng user.id (audit) + session (step-up Task 8). */
export type AdminContext = { user: SessionUser; session: SessionInfo };

/**
 * Cổng vào /admin — BẤT KỲ adminRole nào (layout + dormant finance pages +
 * các action finance mà ranh giới tài chính đã deny trước đó).
 *
 * Redirect (không throw): chưa đăng nhập → /login; đăng nhập nhưng không có
 * adminRole (kể cả legacy role="admin") → / — đúng hành vi layout cũ, nhưng
 * quyết định đọc adminRole thay vì role (spec §8.5).
 */
export async function requireAdminUser(): Promise<AdminContext> {
  const current = await getSessionFromCookie();
  if (!current) redirect("/login");
  if (current.user.adminRole == null) redirect("/");
  return { user: current.user, session: current.session };
}

/**
 * Đòi capability cụ thể — throw Error("FORBIDDEN") khi thiếu (spec §4.5).
 * Chỉ đọc `user.adminRole` qua ma trận — không bao giờ đọc `user.role`.
 */
export async function requireCapability(cap: Capability): Promise<AdminContext> {
  const current = await getSessionFromCookie();
  if (!current) throw new Error("FORBIDDEN");
  if (!capabilitiesOf(current.user.adminRole).includes(cap)) {
    throw new Error("FORBIDDEN");
  }
  return { user: current.user, session: current.session };
}
