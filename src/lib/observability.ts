import "server-only";

/**
 * Seam báo lỗi/log vendor-neutral — MẶT PUBLIC server-only của app.
 *
 * Thân hàm sống ở src/lib/observability-core.ts (plain module — Task 11 tách
 * ra để src/lib/admin-mfa.ts import được từ offline bootstrap script tsx mà
 * không kéo "server-only" vào chuỗi import; admin-mfa.ts là code server nên
 * posture không đổi). Mọi import app hiện tại (`@/src/lib/observability`)
 * giữ nguyên qua re-export — hành vi GIỮ NGUYÊN.
 *
 * "server-only" ở đây giữ vai trò gốc: chặn module logging bị import nhầm vào
 * client component (Next fail build thay vì im lặng).
 */
export { captureError, captureEvent } from "@/src/lib/observability-core";
