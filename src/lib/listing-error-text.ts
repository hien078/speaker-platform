/**
 * Listing ?error= banner text + own-property-safe label lookup (Batch 4
 * Task 5 review fix LOW-1) — PLAIN MODULE.
 *
 * Lỗ được fix: `SUBMIT_ERROR_TEXT[submitError]` với submitError lấy từ
 * ?error= (USER-controlled query param) resolve được key PROTOTYPE —
 * `?error=__proto__` trả `Object.prototype` (object — React child crash
 * cả trang), `?error=constructor` trả function (render rỗng/crash).
 * Lookup nhãn keyed bởi data NGƯỜI DÙNG/DB phải là own-property-safe
 * (Object.hasOwn) + fallback generic fail-closed — KHÔNG bao giờ trả
 * giá trị từ prototype chain, KHÔNG phản chiếu query text.
 *
 * Dùng chung: banner ?error= của app/sell/[id]/edit (submitErrorText) +
 * mọi label map lookup keyed bởi user/DB data trong các file Task 5 chạm
 * (labelOf — status badge, condition, inventory context, fulfillment,
 * photo slot…). Key từ hằng số nội bộ (không phải user data) cũng đi qua
 * labelOf cho thống nhất — own-property luôn true với key hằng số.
 */

/**
 * Text thông báo tiếng Việt cho ?error= typed code — đích redirect của
 * submitListingAction (Batch 4 Task 4/5). CHỈ cho phép typed code cố định;
 * giá trị lạ → generic CONTENT_INVALID (fail closed — KHÔNG phản chiếu
 * query text).
 *
 * Ghi chú nguồn code:
 *  - content codes + RATE_LIMITED + CONTENT_INVALID: các code submitListingAction
 *    redirect về /sell/<id>/edit?error= (SUBMIT_ERROR_PARAM_CODES — listings.ts).
 *  - CONCURRENT_CHANGE: submitListingAction CAS claim 0 row → redirect
 *    ?error=CONCURRENT_CHANGE (typed code); updateListingAction/
 *    saveListingDraftAction trả CÙNG text qua form error (b4-holistic —
 *    KHÔNG throw ra error boundary).
 *  - LISTING_HAS_ORDERS: deleteListingAction (có đơn HOẶC ExchangeOffer
 *    trao đổi tham chiếu + status ≠ approved — b4-holistic-2) redirect
 *    /sell/my?error=LISTING_HAS_ORDERS (b4-holistic — KHÔNG throw);
 *    banner /sell/my đọc qua submitErrorText (allowlist này).
 *  - LISTING_MODERATION_LOCKED (b4-holistic round-3): deleteListingAction/
 *    toggleListingVisibilityAction/submitListingAction trên tin bị takedown
 *    redirect /sell/my?error=LISTING_MODERATION_LOCKED (void form action —
 *    KHÔNG throw ra error boundary); saveListingDraftAction/
 *    updateListingAction trả CÙNG text qua form error (useActionState).
 *  - CONCURRENT_CHANGE cũng là đích CAS 0-rows của toggle/delete (row đổi tay
 *    giữa read và write — b4-holistic round-3: KHÔNG masquerade thành lock).
 */
export const SUBMIT_ERROR_TEXT: Record<string, string> = {
  CONCURRENT_CHANGE: "Tin vừa thay đổi trạng thái — tải lại trang và kiểm tra lại",
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
  CONTENT_INVALID: "Nội dung tin chưa hợp lệ — kiểm tra lại các bước",
  CATEGORY_NOT_PUBLICATION_ALLOWED: "Danh mục chưa mở cho đăng tin trong giai đoạn beta",
  CATEGORY_NOT_FOUND: "Danh mục không hợp lệ",
  CATEGORY_REQUIRED: "Chọn danh mục",
  BRAND_REQUIRED: "Chọn thương hiệu",
  MODEL_REQUIRED: "Chọn model sản phẩm",
  MODEL_INVALID: "Model sản phẩm không hợp lệ",
  MODEL_BRAND_MISMATCH: "Model không thuộc thương hiệu đã chọn",
  IMAGE_REQUIRED: "Thêm ít nhất 1 ảnh sản phẩm",
  IMAGE_TOO_MANY: "Tối đa 8 ảnh",
  IMAGE_NOT_OWNED: "Ảnh không thuộc về bạn — tải ảnh lại từ thiết bị",
  IMAGE_URL_INVALID: "Đường dẫn ảnh không hợp lệ",
  IMAGE_DUPLICATE: "Ảnh bị trùng lặp",
  IMAGE_SLOT_INVALID: "Slot ảnh không hợp lệ",
  IMAGE_SLOT_MISMATCH: "Số ảnh và số slot không khớp",
  TITLE_INVALID: "Tiêu đề từ 8–120 ký tự",
  DESCRIPTION_INVALID: "Mô tả từ 20–4.000 ký tự",
  PRICE_INVALID: "Giá từ 100.000₫ đến 2 tỷ ₫",
  CONDITION_REQUIRED: "Chọn tình trạng sản phẩm",
  CONDITION_INVALID: "Tình trạng sản phẩm không hợp lệ",
  INVENTORY_CONTEXT_REQUIRED: "Chọn nguồn hàng (mới / mở hộp / đã qua sử dụng)",
  INVENTORY_CONTEXT_INVALID: "Nguồn hàng không hợp lệ",
  FREE_TEXT_INVALID: "Nội dung quá dài (tối đa 2.000 ký tự)",
  FULFILLMENT_REQUIRED: "Chọn ít nhất 1 phương thức giao hàng",
  FULFILLMENT_INVALID: "Phương thức giao hàng không hợp lệ",
  FULFILLMENT_DUPLICATE: "Phương thức giao hàng bị trùng",
  PROVINCE_REQUIRED: "Chọn tỉnh/thành phố",
  PROVINCE_INVALID: "Mã tỉnh/thành phố không hợp lệ",
  LOCATION_DISPLAY_REQUIRED: "Nhập khu vực hiển thị (không nhập địa chỉ nhà riêng)",
  LOCATION_DISPLAY_INVALID: "Khu vực hiển thị quá dài (tối đa 120 ký tự)",
  LISTING_HAS_ORDERS: "Tin đang có đơn hàng liên quan — không thể thao tác",
  LISTING_MODERATION_LOCKED: "Tin đang bị khóa bởi kiểm duyệt — không thể thao tác",
};

/**
 * Label lookup own-property-safe (LOW-1): CHỈ resolve own property của map
 * — key prototype ("__proto__", "constructor", "toString"…) và key lạ đều
 * → fallback, KHÔNG bao giờ trả giá trị từ prototype chain (object/function
 * render crash React). Key null/undefined → fallback.
 */
export function labelOf(
  map: Record<string, string>,
  key: string | null | undefined,
  fallback: string,
): string {
  if (key == null) return fallback;
  return Object.hasOwn(map, key) ? map[key] : fallback;
}

/**
 * Text banner ?error= — own-property-safe qua labelOf; code lạ/prototype
 * key → generic CONTENT_INVALID (fail closed — KHÔNG phản chiếu query text).
 */
export function submitErrorText(code: string | null | undefined): string {
  return labelOf(SUBMIT_ERROR_TEXT, code, SUBMIT_ERROR_TEXT.CONTENT_INVALID);
}
