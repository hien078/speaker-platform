/**
 * Hằng số admin role — plain module (Batch 2 Task 11).
 *
 * NguỒN DUY NHẤT cho danh sách role runtime + reason code typed + label
 * tiếng Việt, dùng chung bởi:
 *  - src/lib/actions/admin-identity.ts (zod validate form setAdminRoleAction),
 *  - app/admin/security/page.tsx (role select + reason select),
 *  - scripts/admin-bootstrap.ts (validate --role của CLI offline).
 *
 * Plain module (KHÔNG "server-only", KHÔNG "use server"): script tsx import
 * được runtime value; file "use server" (admin-identity.ts) không được export
 * runtime const (Next chỉ cho export async function trong "use server") nên
 * hằng số sống ở đây. Union `AdminRole` structurally identical với
 * src/lib/rbac.ts (nguồn authorization — KHÔNG đụng trong task này).
 *
 * Reason code là AUDIT TAXONOMY (spec §4.6 "reason" typed) — không phải policy
 * semantics: super_admin chọn một mã khi đổi role, mã đi thẳng vào
 * AuditEvent.reason của "admin.role_set". Danh sách nhỏ/generic có chủ đích;
 * founder có thể mở rộng sau (FD-3 — không bịa semantics quyền, chỉ ghi vết).
 */

/** 5 role admin (spec §5.4) — đúng union src/lib/rbac.ts. */
export const ADMIN_ROLES = [
  "super_admin",
  "operations_admin",
  "moderator",
  "support",
  "analyst",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Label tiếng Việt hiển thị UI (display-only — authorization đọc capability). */
export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super admin",
  operations_admin: "Operations admin",
  moderator: "Điều phối viên",
  support: "Hỗ trợ",
  analyst: "Phân tích",
};

/**
 * Typed reason code cho hành động đổi/cấp role (audit "admin.role_set" —
 * spec §4.6 reason typed, KHÔNG prose tự chế).
 */
export const ADMIN_ROLE_REASON_CODES = [
  "onboarding", // cấp role lần đầu / tuyển thêm quản trị
  "responsibility_change", // điều chuyển trách nhiệm giữa các admin
  "offboarding", // gỡ quyền khi admin rời dự án
  "security_response", // phản ứng sự cố bảo mật (thu hồi quyền nghi vấn)
  "correction", // sửa sai lầm cấu hình trước đó
] as const;

export type AdminRoleReasonCode = (typeof ADMIN_ROLE_REASON_CODES)[number];

/** Label tiếng Việt của reason code cho form select. */
export const ADMIN_ROLE_REASON_LABELS: Record<AdminRoleReasonCode, string> = {
  onboarding: "Tuyển mới / khởi tạo",
  responsibility_change: "Điều chuyển trách nhiệm",
  offboarding: "Rời dự án / gỡ quyền",
  security_response: "Phản ứng sự cố bảo mật",
  correction: "Sửa sai cấu hình",
};
