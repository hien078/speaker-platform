/** Nhãn tiếng Việt cho các enum — dùng chung toàn app */

export const ROLE_LABELS: Record<string, string> = {
  buyer: "Người mua",
  seller: "Người bán",
  admin: "Quản trị",
};

export const LISTING_STATUS_LABELS: Record<string, string> = {
  draft: "Nháp",
  pending: "Chờ duyệt",
  approved: "Đang bán",
  rejected: "Bị từ chối",
  hidden: "Đã ẩn",
  sold: "Đã bán",
};

export const LISTING_STATUS_BADGE: Record<string, string> = {
  draft: "bg-zinc-700/60 text-zinc-300",
  pending: "bg-amber-500/15 text-amber-400",
  approved: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-red-500/15 text-red-400",
  hidden: "bg-zinc-700/60 text-zinc-300",
  sold: "bg-sky-500/15 text-sky-400",
};

export const CONDITION_LABELS: Record<string, string> = {
  new: "Mới nguyên seal",
  open_box: "Mở hộp chưa dùng",
  like_new: "Gần mới",
  excellent: "Rất tốt",
  good: "Còn tốt",
  fair: "Cũ, còn dùng tốt",
  refurbished: "Tái chế / sửa chính hãng",
  for_parts: "Lấy linh kiện",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  awaiting_payment: "Chờ thanh toán",
  paid_escrow: "Đã trả tiền (escrow)",
  processing: "Seller chuẩn bị hàng",
  shipped: "Đang giao hàng",
  completed: "Hoàn tất",
  cancelled: "Đã hủy",
  refunded: "Đã hoàn tiền",
  disputed: "Có khiếu nại",
};

export const ORDER_STATUS_BADGE: Record<string, string> = {
  awaiting_payment: "bg-amber-500/15 text-amber-400",
  paid_escrow: "bg-violet-500/15 text-violet-400",
  processing: "bg-sky-500/15 text-sky-400",
  shipped: "bg-blue-500/15 text-blue-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  cancelled: "bg-zinc-700/60 text-zinc-300",
  refunded: "bg-orange-500/15 text-orange-400",
  disputed: "bg-red-500/15 text-red-400",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  escrow: "Qua nền tảng (escrow)",
  direct: "Chuyển khoản trực tiếp",
  cod: "COD — trả khi nhận hàng",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Đang chờ",
  held: "Escrow đang giữ",
  released: "Đã giải ngân",
  refunded: "Đã hoàn tiền",
  failed: "Thất bại",
};

export const EXCHANGE_STATUS_LABELS: Record<string, string> = {
  proposed: "Đã gửi đề nghị",
  accepted: "Đã chấp nhận — chờ cọc",
  paid: "Tiền bù trong escrow",
  completed: "Hoàn tất trao đổi",
  rejected: "Bị từ chối",
  cancelled: "Đã hủy",
};

export const DISPUTE_STATUS_LABELS: Record<string, string> = {
  open: "Đang xử lý",
  resolved_buyer: "Nghiêng về người mua",
  resolved_seller: "Nghiêng về người bán",
  closed: "Đã đóng",
};

export const CITIES = [
  "Hà Nội",
  "TP. Hồ Chí Minh",
  "Đà Nẵng",
  "Hải Phòng",
  "Cần Thơ",
  "Bình Dương",
  "Đồng Nai",
  "Khánh Hòa",
  "Lâm Đồng",
  "Nghệ An",
  "Quảng Ninh",
  "Thừa Thiên Huế",
  "Khác",
];
