/**
 * PortableListingForm (Batch 4 Task 5 — spec §6.3/§5.6.3/§4.2/§4.5/§4.7) —
 * source-contract: đọc source component, assert cấu trúc 7 bước + copy trung tính.
 *
 * Không jsdom (repo không có browser/E2E infra — ghi nhận ở verification doc các
 * batch trước); hợp đồng cấu trúc là bằng chứng test được duy trì cùng component
 * (Batch 2/3 source-contract precedent: finance-public-surface, moderation-pages).
 *
 * Hợp đồng (plan Task 5 Step 1):
 *  1. Form render 7 bước §6.3 theo đúng thứ tự: brand/model → nguồn hàng &
 *     tình trạng → giá & thương lượng → khu vực & giao hàng → ảnh → phụ kiện &
 *     lỗi & sửa chữa + mô tả → xem lại & kiểm tra xác minh & gửi.
 *  2. Bước ảnh render đủ 8 slot §5.6.3 TỪ PROP photoSlots (non-invention pin —
 *     giá trị gốc PHOTO_CHECKLIST_SLOTS do PAGE build, pin ở sell-pages.test.ts).
 *  3. Slot label_serial có copy che/làm mờ serial vì ảnh hiển thị công khai.
 *  4. KHÔNG có ngôn ngữ bảo đảm trong copy (§4.2/§4.7).
 *  5. Copy khu vực hướng dẫn KHÔNG nhập địa chỉ nhà riêng (§5.6).
 *  6. Bước 7 hiển thị trạng thái từng yêu cầu (incl. seller_rules) từ prop
 *     verification + link /sell/verification — KHÔNG viết text chấp nhận mới (§6.3).
 *  7. Submit chỉ disable bởi pending — KHÔNG BAO GIỜ bởi verification client-side
 *     (server là gate, §4.5).
 *  8. Nút Lưu nháp gọi saveListingDraftAction; component KHÔNG import
 *     listing-schema.ts / beta-categories.ts (props only — spec §4.5).
 *  9. Sửa draft: KHÔNG dùng updateListingAction (draft→draft, không transition).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PHOTO_CHECKLIST_SLOTS } from "@/src/lib/listing-schema";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const source = read("src/components/portable-listing-form.tsx");

/** Source slice của một bước — từ marker data-step="n" tới marker bước kế tiếp. */
const stepSource = (n: number): string => {
  const start = source.indexOf(`data-step="${n}"`);
  const end = n < 7 ? source.indexOf(`data-step="${n + 1}"`) : source.length;
  expect(start).toBeGreaterThanOrEqual(0);
  if (n < 7) expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("PortableListingForm — 7 bước §6.3 (source-contract)", () => {
  it("render đủ 7 bước theo đúng thứ tự §6.3", () => {
    const positions = [1, 2, 3, 4, 5, 6, 7].map((n) => source.indexOf(`data-step="${n}"`));
    for (const pos of positions) expect(pos).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Step 1: Brand + Canonical model (§6.3 Step 1)
    const s1 = stepSource(1);
    expect(s1).toContain(`name="brandId"`);
    expect(s1).toContain(`name="productModelId"`);

    // Step 2: new/open_box/used + Condition (§6.3 Step 2)
    const s2 = stepSource(2);
    expect(s2).toContain(`name="inventoryContext"`);
    expect(s2).toContain(`name="condition"`);

    // Step 3: Asking price + Negotiable? (§6.3 Step 3)
    const s3 = stepSource(3);
    expect(s3).toContain(`name="price"`);
    expect(s3).toContain(`name="negotiable"`);

    // Step 4: Location (province + display) + Fulfillment (§6.3 Step 4)
    const s4 = stepSource(4);
    expect(s4).toContain(`name="provinceLevelCode"`);
    expect(s4).toContain(`name="locationDisplayName"`);
    expect(s4).toContain(`name="fulfillmentMethods"`);

    // Step 5: Photos (§6.3 Step 5)
    expect(stepSource(5)).toContain("photoSlots");

    // Step 6: Accessories / Known defects / Repair history + description (§6.3 Step 6)
    const s6 = stepSource(6);
    expect(s6).toContain(`name="includedAccessories"`);
    expect(s6).toContain(`name="knownDefects"`);
    expect(s6).toContain(`name="repairHistory"`);
    expect(s6).toContain(`name="description"`);

    // Step 7: Preview + verification check + submit (§6.3 Step 7)
    const s7 = stepSource(7);
    expect(s7).toContain("verification");
    expect(s7).toContain("requirementLabels");
  });

  it("bước ảnh render ĐÚNG 8 slot §5.6.3 từ prop photoSlots (non-invention pin)", () => {
    // 8 slot gốc pin ở tests/unit/listing-schema.test.ts; đây là pin cấu trúc form
    expect(PHOTO_CHECKLIST_SLOTS).toHaveLength(8);
    const s5 = stepSource(5);
    // mỗi slot một ImagePicker gắn slot — imageSlots song song images theo index
    expect(s5).toContain("photoSlots.map");
    expect(s5).toContain(`slotName="imageSlots"`);
    expect(s5).toContain(`name="images"`);
  });

  it("slot label_serial có copy che/làm mờ serial vì ảnh hiển thị công khai (§5.6.3)", () => {
    const s5 = stepSource(5);
    expect(s5).toContain("label_serial");
    expect(s5).toMatch(/Che hoặc làm mờ serial/i);
    expect(s5).toMatch(/hiển thị công khai/i);
  });

  it("KHÔNG có ngôn ngữ bảo đảm trong copy component (§4.2/§4.7)", () => {
    expect(source).not.toMatch(/đảm bảo|bảo đảm|an toàn khu vực|guarantee/i);
  });

  it("copy khu vực hướng dẫn KHÔNG nhập địa chỉ nhà riêng (§5.6)", () => {
    expect(stepSource(4)).toMatch(/địa chỉ nhà riêng/i);
  });

  it("bước 7: trạng thái seller_rules từ prop verification + link /sell/verification, KHÔNG viết text chấp nhận mới (§6.3)", () => {
    const s7 = stepSource(7);
    // trạng thái từng yêu cầu derive từ verification prop (đọc FRESH ở server page)
    expect(s7).toContain("verification.missing");
    expect(s7).toContain("requirementLabels");
    expect(s7).toContain(`href="/sell/verification"`);
    // KHÔNG có control/text chấp nhận mới của form — cơ chế Batch 2 sống ở
    // /sell/verification (PolicyAcceptance), form chỉ hiển thị TRẠNG THÁI.
    expect(s7).not.toContain(`type="checkbox"`);
    expect(s7).not.toMatch(/Tôi đã đọc|Tôi đồng ý|đồng ý với Quy tắc/i);
  });

  it("submit chỉ disable bởi pending — KHÔNG BAO GIỜ bởi verification client-side (§4.5)", () => {
    const disabledExprs = source.match(/disabled=\{[^}]*\}/g) ?? [];
    expect(disabledExprs.length).toBeGreaterThan(0);
    for (const expr of disabledExprs) {
      expect(expr).not.toMatch(/verification/i);
    }
    expect(source).toMatch(/disabled=\{pending\}/);
  });

  it("nút Lưu nháp gọi saveListingDraftAction; KHÔNG import listing-schema/beta-categories (props only)", () => {
    expect(source).toContain("saveListingDraftAction");
    expect(source).not.toContain(`from "@/src/lib/listing-schema"`);
    expect(source).not.toContain(`from "@/src/lib/beta-categories"`);
    // nút draft mang intent để dispatcher route đúng action server
    expect(source).toContain(`name="intent"`);
  });

  it("sửa draft: KHÔNG dùng updateListingAction — intent thường route về lưu nháp (draft→draft)", () => {
    // dispatcher: sửa draft + intent thường (Enter key) → saveListingDraftAction
    const dispatchStart = source.indexOf("async function dispatchSubmit");
    expect(dispatchStart).toBeGreaterThanOrEqual(0);
    const dispatchEnd = source.indexOf("createListingAction", dispatchStart);
    expect(dispatchEnd).toBeGreaterThan(dispatchStart);
    const dispatch = source.slice(dispatchStart, dispatchEnd);
    expect(dispatch).toContain("isDraftEdit");
    expect(dispatch).toContain("saveListingDraftAction");

    // nút submit chính (create/update) KHÔNG render khi sửa draft
    expect(source).toMatch(/\{!isDraftEdit && \(\s*<button type="submit"/);
  });
});
