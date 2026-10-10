import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Định dạng tiền VND: 10500000 → "10.500.000 ₫" */
export function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Định dạng số rút gọn: 10500000 → "10,5tr" */
export function formatCompactVND(amount: number): string {
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1).replace(".", ",")} tỷ`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")} tr`;
  if (amount >= 1_000) return `${Math.round(amount / 1_000)}k`;
  return String(amount);
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatDateShort(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** "Loa JBL Charge 5 chính hãng!!!" → "loa-jbl-charge-5-chinh-hang" */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Slug listing — KHÔNG BAO GIỜ rỗng (b4-holistic round-3 LOW — validation).
 *
 * Title chỉ chứa ký tự slugify strip (CJK/emoji/dấu câu/zero-width — vd
 * "!!!!!!!!" hay "蓝牙音箱") → slugify('') → slug '' → MỌI link
 * (/listings/${slug} trong sell/my, sitemap, card) trỏ vào /listings/ =
 * trang index, trang chi tiết của tin KHÔNG BAO GIỜ mở được (kể cả sau khi
 * duyệt). Fallback: uuid ngắn 8 ký tự (crypto.randomUUID — Web Crypto, có
 * sẵn Node 22 + browser; KHÔNG import node:crypto vào module dùng chung
 * client). Hai đường create (createListingAction + saveListingDraftAction)
 * cùng dùng helper này để không drift.
 */
export function listingSlug(title: string): string {
  const slug = slugify(title);
  return slug !== "" ? slug : `tin-${crypto.randomUUID().slice(0, 8)}`;
}

/** Mã đơn hàng: SP-240930-0001 */
export function generateOrderCode(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `SP-${yy}${mm}${dd}-${rand}`;
}

/** Tính hoa hồng & tiền seller nhận */
export function computeCommission(total: number, ratePercent: number) {
  const commissionAmount = Math.round((total * ratePercent) / 100);
  return {
    commissionAmount,
    sellerPayout: total - commissionAmount,
  };
}

/** Thời gian tương đối: "3 giờ trước" */
export function timeAgo(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "vừa xong";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} tháng trước`;
  return `${Math.floor(months / 12)} năm trước`;
}
