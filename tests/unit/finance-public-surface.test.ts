/**
 * Finance public surface — hợp đồng public UI/copy sau shutdown (plan Task 4).
 *
 * Spec §4.2 (no misleading promise), §5.1 (public navigation bỏ mọi finance
 * surface; direct request phải trả unavailable), §6.1 (CTA "Nhắn người bán"):
 *
 * 1. Navigation public (header, user menu, footer) không còn link/CTA tài chính:
 *    cart, checkout, wallet, orders, offers, exchange (tiền bù).
 * 2. Listing detail dẫn vào chat HIỆN CÓ ("Nhắn người bán" → startConversationAction)
 *    kèm copy chính xác: thanh toán + giao nhận hàng diễn ra độc lập NGOÀI
 *    LoaViet; LoaViet không giữ tiền, không bảo đảm giao dịch. Không còn
 *    escrow/commission/payment-protection promise.
 * 3. Mọi finance-only page trả notFound() khi bị gọi trực tiếp — TRƯỚC khi đọc
 *    DB/session (không read operational, không mutation). Code gốc bên dưới guard
 *    giữ nguyên ở dạng dormant (không xóa code/dữ liệu tài chính).
 * 4. Listing form / sell pages / home / seller profile / chat / manifest /
 *    layout metadata / robots / sitemap / README không còn copy hứa escrow,
 *    hoa hồng, giữ tiền hay bảo vệ thanh toán.
 *
 * Lưu ý ownership: app/payments/momo/return/page.tsx thuộc Task 3 (worktree A
 * song song) — Task 4 KHÔNG sửa file đó và không assert gì về nó ở đây.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Mocks dùng cho behavioral test của retired pages ───────────────────────
// next/navigation: notFound/redirect throw sentinel riêng để phân biệt với lỗi thật.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// next/cache: action modules import revalidatePath — không bao giờ được gọi.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// server-only: directive — no-op ngoài runtime Next.
vi.mock("server-only", () => ({}));
// db.client: mọi truy cập DB trên retired page = lỗi hợp đồng (guard phải đứng trước).
vi.mock("@/src/prisma/db.client", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("DB_ACCESSED_ON_RETIRED_FINANCE_PAGE");
      },
    },
  ),
}));

import * as cartPage from "../../app/cart/page";
import * as checkoutPage from "../../app/checkout/page";
import * as ordersPage from "../../app/orders/page";
import * as orderDetailPage from "../../app/orders/[id]/page";
import * as salesPage from "../../app/orders/sales/page";
import * as walletPage from "../../app/wallet/page";
import * as offersPage from "../../app/offers/page";
import * as exchangePage from "../../app/exchange/page";
import * as exchangeOfferPage from "../../app/listings/[slug]/exchange/page";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

/** Finance-only page bị retire theo Task 4 — hành vi trực tiếp nhất quán: notFound(). */
const RETIRED_FINANCE_PAGES = [
  { route: "/cart", file: "app/cart/page.tsx", dormantMarker: "updateCartItemAction" },
  { route: "/checkout", file: "app/checkout/page.tsx", dormantMarker: "CheckoutForm" },
  { route: "/orders", file: "app/orders/page.tsx", dormantMarker: "ORDER_STATUS_LABELS" },
  { route: "/orders/[id]", file: "app/orders/[id]/page.tsx", dormantMarker: "EscrowPayModal" },
  { route: "/orders/sales", file: "app/orders/sales/page.tsx", dormantMarker: "sellerConfirmPaymentAction" },
  { route: "/wallet", file: "app/wallet/page.tsx", dormantMarker: "getWalletSummary" },
  { route: "/offers", file: "app/offers/page.tsx", dormantMarker: "OfferCard" },
  { route: "/exchange", file: "app/exchange/page.tsx", dormantMarker: "respondExchangeOfferAction" },
  { route: "/listings/[slug]/exchange", file: "app/listings/[slug]/exchange/page.tsx", dormantMarker: "ExchangeOfferForm" },
] as const;

type AnyPage = (props?: unknown) => Promise<unknown>;
const PAGE_COMPONENTS: Record<string, AnyPage> = {
  "/cart": cartPage.default as unknown as AnyPage,
  "/checkout": checkoutPage.default as unknown as AnyPage,
  "/orders": ordersPage.default as unknown as AnyPage,
  "/orders/[id]": orderDetailPage.default as unknown as AnyPage,
  "/orders/sales": salesPage.default as unknown as AnyPage,
  "/wallet": walletPage.default as unknown as AnyPage,
  "/offers": offersPage.default as unknown as AnyPage,
  "/exchange": exchangePage.default as unknown as AnyPage,
  "/listings/[slug]/exchange": exchangeOfferPage.default as unknown as AnyPage,
};

/** Props tối thiểu cho từng signature — guard throw trước khi chạm props. */
const PAGE_PROPS: Record<string, unknown> = {
  "/cart": {},
  "/checkout": { searchParams: Promise.resolve({}) },
  "/orders": {},
  "/orders/[id]": { params: Promise.resolve({ id: "unit-test" }) },
  "/orders/sales": {},
  "/wallet": {},
  "/offers": { searchParams: Promise.resolve({}) },
  "/exchange": { searchParams: Promise.resolve({}) },
  "/listings/[slug]/exchange": { params: Promise.resolve({ slug: "unit-test" }) },
};

// ─── 1. Public navigation ────────────────────────────────────────────────────

describe("public navigation — không còn CTA/link tài chính", () => {
  it("header: bỏ icon giỏ hàng + đếm CartItem + nav Trao đổi (finance flow)", () => {
    const src = read("src/components/header.tsx");
    expect(src).not.toContain('href="/cart"');
    expect(src).not.toContain("ShoppingCart");
    expect(src).not.toContain("CartItem");
    expect(src).not.toContain('href="/checkout"');
    expect(src).not.toContain('href="/listings?exchange=1"');
    // giữ lại navigation phi tài chính
    expect(src).toContain('href="/listings"');
    expect(src).toContain('href="/sell/new"');
    expect(src).toContain('href="/chat"');
  });

  it("user menu: bỏ Ví/rút tiền, Trả giá, Đơn đã mua, Đơn bán được", () => {
    const src = read("src/components/header-user-menu.tsx");
    expect(src).not.toContain('href="/wallet"');
    expect(src).not.toContain('href="/offers"');
    expect(src).not.toContain('href="/orders"');
    expect(src).not.toContain('href="/orders/sales"');
    expect(src).not.toContain("rút tiền");
    // giữ lại menu phi tài chính
    expect(src).toContain('href="/sell/new"');
    expect(src).toContain('href="/sell/my"');
    expect(src).toContain('href="/wishlist"');
    expect(src).toContain('href="/profile"');
    expect(src).toContain('href="/chat"');
  });

  it("footer: bỏ link finance + copy hứa giữ hộ/hoa hồng", () => {
    const src = read("src/components/footer.tsx");
    expect(src).not.toContain('href="/orders"');
    expect(src).not.toContain('href="/orders/sales"');
    expect(src).not.toContain('href="/wallet"');
    expect(src).not.toContain('href="/listings?exchange=1"');
    expect(src).not.toContain("được giữ hộ");
    expect(src).not.toContain("trừ hoa hồng");
    expect(src).not.toContain("giữ tiền giao dịch");
    // copy thay thế: chính xác, không cam kết giữ tiền
    expect(src).toContain("không giữ tiền");
    expect(src).toContain("không bảo đảm giao dịch");
  });

  it("chat conversation: bỏ CTA đề nghị trao đổi + tiền bù (link tới page đã retire)", () => {
    const src = read("app/chat/[id]/page.tsx");
    expect(src).not.toContain("/exchange");
  });
});

// ─── 2. Listing detail → chat, không purchase/payment ────────────────────────

describe("listing detail — dẫn vào chat hiện có, không purchase/payment CTA", () => {
  const src = () => read("app/listings/[slug]/page.tsx");

  it("bỏ mọi purchase/payment/exchange CTA", () => {
    expect(src()).not.toContain("/checkout");
    expect(src()).not.toContain("Mua ngay");
    expect(src()).not.toContain("addToCartAction");
    expect(src()).not.toContain("Thêm vào giỏ");
    expect(src()).not.toContain("/exchange");
    expect(src()).not.toContain("OfferForm");
  });

  it("bỏ escrow promise + commission panel", () => {
    expect(src()).not.toContain("vào nền tảng");
    expect(src()).not.toContain("đang được giữ");
    expect(src()).not.toContain("giải ngân");
    expect(src()).not.toContain("Hoa hồng nền tảng");
    expect(src()).not.toContain("commissionRate");
  });

  it('CTA "Nhắn người bán" dùng conversation flow hiện có (startConversationAction)', () => {
    expect(src()).toContain("Nhắn người bán");
    expect(src()).toContain("startConversationAction");
  });

  it("copy chính xác: thanh toán + giao nhận hàng độc lập ngoài LoaViet, không giữ tiền, không bảo đảm", () => {
    expect(src()).toContain("ngoài LoaViet");
    expect(src()).toContain("không giữ tiền");
    expect(src()).toContain("không bảo đảm giao dịch");
  });
});

// ─── 3. Finance-only pages: direct request → notFound() trước mọi read ───────

describe("retired finance pages — direct request trả notFound() trước mọi read/mutation", () => {
  beforeEach(() => {
    // mặc định private beta: tài chính TẮT (env bỏ trống)
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const { route, file, dormantMarker } of RETIRED_FINANCE_PAGES) {
    it(`${route}: gọi trực tiếp → notFound(), không chạm DB/session`, async () => {
      const Page = PAGE_COMPONENTS[route];
      await expect(Page(PAGE_PROPS[route])).rejects.toThrow(
        "NEXT_HTTP_ERROR_FALLBACK;404",
      );
    });

    it(`${route}: guard tài chính đứng trong page (cùng ranh giới Task 2)`, () => {
      const source = read(file);
      expect(source).toContain("financialFeaturesEnabled");
      expect(source).toContain("notFound()");
    });

    it(`${route}: code finance gốc vẫn còn (dormant, không xóa)`, () => {
      expect(read(file)).toContain(dormantMarker);
    });
  }
});

// ─── 4. Copy/metadata sweep ──────────────────────────────────────────────────

describe("public copy & metadata — không còn promise escrow/hoa hồng/giữ tiền", () => {
  it("listing form (seller): bỏ copy hoa hồng + payout example", () => {
    const src = read("src/components/listing-form.tsx");
    expect(src).not.toContain("commissionRate");
    expect(src.toLowerCase()).not.toContain("hoa hồng");
    expect(src).not.toContain("bạn nhận");
    expect(src).toContain("không giữ tiền");
  });

  it("sell pages: bỏ payload commissionRate vào ListingForm", () => {
    for (const file of ["app/sell/new/page.tsx", "app/sell/[id]/edit/page.tsx"]) {
      expect(read(file)).not.toContain("commissionRate");
    }
  });

  it("sell/my: bỏ link /exchange (page đã retire)", () => {
    const src = read("app/sell/my/page.tsx");
    expect(src).not.toContain('href="/exchange"');
    expect(src).not.toContain("targetOffers");
  });

  it("home page: bỏ explainer escrow/MoMo/hoa hồng, thay bằng mô hình classifieds", () => {
    const src = read("app/page.tsx");
    expect(src).not.toContain("vào nền tảng");
    expect(src).not.toContain("MoMo");
    expect(src).not.toContain("7 ngày kiểm tra");
    expect(src).not.toContain("đang được giữ");
    expect(src.toLowerCase()).not.toContain("hoa hồng");
    expect(src).toContain("ngoài LoaViet");
    expect(src).toContain("không giữ tiền");
  });

  it("seller profile: bỏ promise escrow bảo vệ", () => {
    const src = read("app/seller/[id]/page.tsx");
    expect(src).not.toContain("escrow");
    expect(src).not.toContain("nền tảng giữ tiền");
    expect(src).toContain("không giữ tiền");
    expect(src).toContain("không bảo đảm giao dịch");
  });

  it("PWA manifest: description không hứa escrow/hoa hồng", () => {
    const src = read("app/manifest.ts");
    expect(src).not.toContain("Escrow");
    expect(src.toLowerCase()).not.toContain("hoa hồng");
    expect(src).toContain("không giữ tiền");
  });

  it("layout metadata: description không hứa giữ hộ tiền", () => {
    const src = read("app/layout.tsx");
    expect(src).not.toContain("được giữ hộ");
    expect(src).toContain("không giữ tiền");
  });

  it("robots: giữ disallow các route finance đã retire + chặn /payments", () => {
    const src = read("app/robots.ts");
    for (const path of ["/cart", "/checkout", "/orders", "/wallet", "/offers", "/exchange"]) {
      expect(src).toContain(path);
    }
    expect(src).toContain("/payments");
  });

  it("sitemap: không quảng bá exchange filter entry", () => {
    expect(read("app/sitemap.ts")).not.toContain("exchange=1");
  });

  it("notifications: empty state không nhắc finance flow đã retire (trả giá/đơn hàng/khiếu nại)", () => {
    // Private beta: các kind finance (order/dispute/offer/counter/withdraw) không
    // còn phát sinh — mọi notify() nằm trong action đã guard. Empty state chỉ
    // được nhắc thông báo còn sống (tin đăng/tài khoản), không gợi ý flow 404.
    const src = read("app/notifications/page.tsx");
    expect(src).not.toContain("Trả giá, đơn hàng, khiếu nại");
  });

  it("chat empty state: nhãn CTA khớp 'Nhắn người bán' (Task 4 đổi từ 'Chat với người bán')", () => {
    const src = read("app/chat/page.tsx");
    expect(src).not.toContain("Chat với người bán");
    expect(src).toContain("Nhắn người bán");
  });
});

// ─── 5. README ──────────────────────────────────────────────────────────────

describe("README — mô tả private-beta classifieds, finance code label dormant", () => {
  const src = () => read("README.md");

  it("không còn claim escrow/hoa hồng như tính năng đang chạy", () => {
    expect(src()).not.toContain("nền tảng giữ tiền");
    expect(src()).not.toContain("escrow tự động");
    expect(src()).not.toContain("tiền ĐƯỢC GIỮ");
    expect(src()).not.toContain("Luồng escrow");
    expect(src()).not.toContain("hoa hồng minh bạch");
  });

  it("mô tả mô hình classifieds: thanh toán/giao nhận hàng độc lập ngoài LoaViet", () => {
    expect(src()).toContain("ngoài LoaViet");
    expect(src()).toContain("không giữ tiền");
  });

  it("label rõ finance code là dormant + chốt bằng ranh giới server", () => {
    expect(src()).toContain("FINANCIAL_FEATURES_ENABLED");
    expect(src()).toContain("FINANCIAL_FEATURES_DISABLED");
    expect(src()).toContain("dormant");
  });
});
