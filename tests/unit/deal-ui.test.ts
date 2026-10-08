/**
 * Deal UI — hợp đồng source + drift labels (Batch 6 plan Task 6, PHẦN 6a —
 * spec §6.4/§5.2/§4.2; source-contract style của finance-public-surface.test.ts,
 * không jsdom).
 *
 * Scope 6a (parallelism map Wave 2 — corrections 2026-10-08; panel/forms/page
 * mounts là Task 6b, Wave 4, mở RỘNG file này — không assert gì về chúng ở đây):
 *
 *  1. SafetyGuidance (src/components/safety-guidance.tsx): render đủ 6 điểm
 *     §6.4 + dòng §5.2 ("The UI must state") + dòng trung tính Batch 1 —
 *     byte-identical với plan Task 6 (corrections #18: copy-safety
 *     SAFETY_64_POINTS/SAFETY_52_LINE trên local/b8-early-integration).
 *  2. §4.2/§6.4: KHÔNG có ngôn ngữ hứa hẹn (đảm bảo / bảo đảm / bảo hiểm /
 *     bảo vệ thanh toán / bảo vệ giao dịch / giữ tiền hộ / escrow /
 *     guarantee / insurance) NGOÀI dòng negation trung tính duy nhất
 *     "LoaViet không giữ tiền và không bảo đảm giao dịch." (Review Focus 5 —
 *     scan cả comment, không chỉ text render: copy-safety chỉ strip whole-line
 *     comment, trailing comment VẪN bị quét).
 *  3. B2 hygiene: plain component — KHÔNG "use client", KHÔNG import
 *     db/server; KHÔNG dangerouslySetInnerHTML (stored-XSS contract).
 *  4. src/lib/constants.ts (additive, Task 6a): DEAL_STATUS_LABELS /
 *     DEAL_OUTCOME_LABELS drift hai chiều với vocabulary src/lib/deal-vocab.ts
 *     (mọi giá trị có nhãn, mọi nhãn là giá trị hợp lệ — plan Task 6 drift);
 *     KHÔNG có DEAL_FULFILLMENT_METHOD_LABELS — fulfillment Deal reuse
 *     FULFILLMENT_METHOD_LABELS của Batch 4 (corrections #20).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEAL_STATUS_LABELS,
  DEAL_OUTCOME_LABELS,
  FULFILLMENT_METHOD_LABELS,
} from "@/src/lib/constants";
import {
  DEAL_STATUSES,
  DEAL_OUTCOMES,
  DEAL_FULFILLMENT_METHODS,
} from "@/src/lib/deal-vocab";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ─── Copy §6.4/§5.2 — byte-identical plan Task 6 (corrections #18) ────────────

/** Sáu điểm §6.4 — bản dịch tiếng Việt (copy-safety SAFETY_64_POINTS). */
const SAFETY_64_POINTS = [
  "Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.",
  "Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.",
  "Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.",
  "Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.",
  "Cẩn trọng với các đường link thanh toán đáng ngờ.",
  "Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.",
] as const;

/** Dòng §5.2 — bắt buộc trong UI (copy-safety SAFETY_52_LINE). */
const SAFETY_52_LINE = "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.";

/** Dòng trung tính Batch 1 — negation duy nhất được allowlist (copy-safety). */
const NEUTRAL_LINE = "LoaViet không giữ tiền và không bảo đảm giao dịch.";

/**
 * §4.2/§6.4 — ngôn ngữ hứa hẹn cấm: copy-safety PROMISE_PATTERNS
 * (corrections #18) + "giữ tiền hộ" (plan Task 6 scan). Match ở CẢ comment
 * lẫn text render — chỉ dòng negation trung tính được phép chứa "bảo đảm".
 */
const PROMISE_RE =
  /đảm bảo|bảo đảm|bảo hiểm|bảo vệ thanh toán|bảo vệ giao dịch|giữ tiền hộ|escrow|guarantee|insurance/i;

// ─── 1. SafetyGuidance — source contract (§6.4 + §5.2 + §4.2) ────────────────

describe("SafetyGuidance — §6.4 six points + §5.2 line (source contract)", () => {
  const src = () => read("src/components/safety-guidance.tsx");

  it("render đủ 6 điểm §6.4 — byte-identical plan Task 6 / copy-safety", () => {
    for (const point of SAFETY_64_POINTS) {
      expect(src()).toContain(point);
    }
  });

  it("render dòng §5.2 (bắt buộc trong UI) + dòng trung tính Batch 1", () => {
    expect(src()).toContain(SAFETY_52_LINE);
    expect(src()).toContain(NEUTRAL_LINE);
  });

  it("§4.2: KHÔNG ngôn ngữ hứa hẹn nào NGOÀI dòng negation trung tính", () => {
    // Bỏ dòng chứa negation ("bảo đảm" bên trong "không bảo đảm" — không
    // phải affirmative promise); mọi occurrence pattern còn lại (kể cả trong
    // comment) = vi phạm §4.2/§6.4 "Avoid giving the impression that safety
    // guidance equals transaction insurance".
    const withoutNegation = src()
      .split("\n")
      .filter((line) => !line.includes(NEUTRAL_LINE))
      .join("\n");
    expect(withoutNegation).not.toMatch(PROMISE_RE);
  });

  it("plain component — KHÔNG 'use client', KHÔNG import server/db (B2 hygiene)", () => {
    expect(src()).toContain("export function SafetyGuidance");
    expect(src()).not.toContain('"use client"');
    expect(src()).not.toContain('"use server"');
    expect(src()).not.toContain("db.client");
    expect(src()).not.toContain("server-only");
    expect(src()).not.toContain("next/headers");
    expect(src()).not.toContain("next/cache");
  });

  it("KHÔNG dangerouslySetInnerHTML (stored-XSS contract)", () => {
    expect(src()).not.toContain("dangerouslySetInnerHTML");
  });
});

// ─── 2. constants — deal labels drift (plan Task 6 + corrections #20) ────────

describe("constants — deal status/outcome labels drift", () => {
  const constantsSrc = () => read("src/lib/constants.ts");

  it("DEAL_STATUS_LABELS: keys === DEAL_STATUSES hai chiều (mọi giá trị có nhãn, mọi nhãn hợp lệ)", () => {
    expect(Object.keys(DEAL_STATUS_LABELS).sort()).toEqual([...DEAL_STATUSES].sort());
    // giá trị pin theo plan Task 6 (product copy — PROVISIONAL A9/FD-3,
    // Batch 8 duyệt; đổi label = sửa test một cách có chủ đích)
    expect(DEAL_STATUS_LABELS).toEqual({
      open: "Đang mở",
      completed: "Hoàn tất",
      cancelled: "Đã hủy",
      no_deal: "Không đạt",
    });
  });

  it("DEAL_OUTCOME_LABELS: keys === DEAL_OUTCOMES hai chiều (D3 — marking per party)", () => {
    expect(Object.keys(DEAL_OUTCOME_LABELS).sort()).toEqual([...DEAL_OUTCOMES].sort());
    expect(DEAL_OUTCOME_LABELS).toEqual({
      success: "Thỏa thuận thành công",
      no_deal: "Không đạt thỏa thuận",
      cancelled: "Đã hủy thỏa thuận",
    });
  });

  it("mọi nhãn là chuỗi không rỗng (không bao giờ render key thô)", () => {
    for (const labels of [DEAL_STATUS_LABELS, DEAL_OUTCOME_LABELS]) {
      for (const value of Object.values(labels)) {
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("corrections #20: KHÔNG có DEAL_FULFILLMENT_METHOD_LABELS — Deal reuse FULFILLMENT_METHOD_LABELS của Batch 4", () => {
    expect(constantsSrc()).not.toContain("DEAL_FULFILLMENT_METHOD_LABELS");
    // Map Batch 4 phủ đủ 4 phương thức §5.2 — deal panel dùng lại, không map riêng.
    for (const method of DEAL_FULFILLMENT_METHODS) {
      expect(FULFILLMENT_METHOD_LABELS).toHaveProperty(method);
    }
  });
});
