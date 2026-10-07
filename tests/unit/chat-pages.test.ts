/**
 * Chat pages (b4-holistic round-3 LOW — chat leak) — source-contract: đọc
 * source page, assert redaction của listing KHÔNG còn công khai.
 *
 * Lỗ: /chat + /chat/<id> load convo.listing KHÔNG status filter — seller edit
 * approved → pending ghi đè title/ảnh/giá IN PLACE (không shadow revision),
 * buyer vẫn thấy content CHƯA DUYỆT qua chat (trang detail đã 404 — chat là
 * nơi duy nhất còn lộ); takedown/rejected cũng vậy, vô hạn.
 *
 * Hợp đồng sau fix (verified fix của finding):
 *  1. Cả hai page select status (+ sellerId) của listing.
 *  2. Title/ảnh/giá/link CHỈ render khi viewer là seller CỦA TIN
 *     (convo.sellerId === user.id) HOẶC status ∈ {approved, hidden, sold}.
 *  3. Row không công khai → placeholder trung tính "Tin đăng không còn
 *     hiển thị" — KHÔNG ảnh, KHÔNG title, KHÔNG link.
 *  4. startConversationAction: hội thoại MỚI chỉ cho approved (pin ở
 *     chat-guard.test.ts); existing redirect bất kể status.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const detail = read("app/chat/[id]/page.tsx");
const list = read("app/chat/page.tsx");

describe("chat pages — redaction listing không công khai (b4-holistic round-3)", () => {
  it("/chat/<id>: select status; title/ảnh/giá/link CHỈ render khi visible (seller viewer hoặc approved/hidden/sold)", () => {
    // select có status (điều kiện redaction đọc được)
    expect(detail).toMatch(/l\.select\("id", "title", "slug", "price", "status", "acceptExchange"\)/);
    // điều kiện visible: viewer là seller CỦA TIN hoặc status công khai
    expect(detail).toContain("convo.sellerId === user.id");
    expect(detail).toContain('listing.status === "approved"');
    expect(detail).toContain('listing.status === "hidden"');
    expect(detail).toContain('listing.status === "sold"');
    // block listing CHỈ render khi listingVisible
    expect(detail).toMatch(/\{listing && listingVisible && \(/);
    // placeholder trung tính khi KHÔNG visible — KHÔNG ảnh/title/link
    expect(detail).toMatch(/\{listing && !listingVisible && \(/);
    expect(detail).toContain("Tin đăng không còn hiển thị");
  });

  it("/chat: select status + sellerId; ảnh + title CHỈ khi visible, row khác placeholder", () => {
    expect(list).toMatch(/l\.select\("title", "slug", "status", "sellerId"\)/);
    expect(list).toContain("const listingVisible =");
    expect(list).toContain("l.sellerId === user.id");
    // ảnh lấy qua điều kiện visible (KHÔNG phải convo.listing?.images[0]?.url trực tiếp)
    expect(list).toMatch(/const image = listingVisible\(convo\.listing\) \? convo\.listing\?\.images\[0\]\?\.url : undefined/);
    // title placeholder khi không visible
    expect(list).toContain("Tin đăng không còn hiển thị");
  });

  it("startConversationAction: hội thoại MỚI yêu cầu approved — existing redirect BẤT KỂ status (pin hành vi ở chat-guard.test.ts)", () => {
    const action = read("src/lib/actions/chat.ts");
    // existing-lookup TRƯỚC status gate (lịch sử vẫn mở được)
    const existingIdx = action.indexOf("const existing = await db.orm.public.Conversation");
    const statusIdx = action.indexOf('listing.status !== "approved"');
    expect(existingIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(existingIdx);
    expect(action).toContain('"LISTING_NOT_AVAILABLE"');
  });
});
