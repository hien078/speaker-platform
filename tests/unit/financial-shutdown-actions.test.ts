/**
 * Financial shutdown — hành vi TẮT MẶC ĐỊNH của mọi server action tài chính
 * (plan Task 3, spec §4.1 "no money path" + §5.1 ranh giới tài chính).
 *
 * Mỗi entry point khi FINANCIAL_FEATURES_ENABLED tắt (mặc định) phải:
 *  - throw error bắt đầu bằng mã ổn định FINANCIAL_FEATURES_DISABLED;
 *  - throw TRƯỚC khi đọc trạng thái vận hành (auth/db) và trước mọi mutation;
 *  - không chạm database finance, ledger, provider, escrow, payout, withdraw.
 *
 * Cơ chế chứng minh: db/auth/notify/redirect bị mock bằng spy NÉM LỖI khi bị
 * gọi — thiếu guard thì action reject bằng lỗi spy (không phải mã tài chính)
 * → test đỏ ngay. Ledger/escrow/momo/wallet/helpers giữ BẢN THẬT để test
 * defense-in-depth ở tầng thư viện (plan: caller tương lai không bypass được).
 *
 * Bật tài chính (dev/test) → ranh giới mở, hành vi legacy giữ nguyên —
 * chứng minh guard là ranh giới, không phải gạch chặn vĩnh viễn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// Session seam (Batch 2 Task 4): admin actions đọc quyền qua rbac →
// getSessionFromCookie — tripwire chứng minh finance assert chạy TRƯỚC auth.
vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(),
}));

/** Chế độ db mock: strict (mặc định) = mọi method ném lỗi khi bị chạm. */
const dbState = vi.hoisted(() => ({ strict: true }));

vi.mock("@/src/prisma/db.client", () => {
  const CHAIN = ["where", "include", "select", "orderBy", "limit"] as const;
  const TERMINAL = [
    "first", "create", "update", "updateAll", "updateAndCount",
    "delete", "deleteAll", "all", "count", "aggregate",
  ] as const;
  type Spy = ReturnType<typeof vi.fn>;
  const makeModel = (name: string): Record<string, Spy> => {
    const obj: Record<string, Spy> = {};
    for (const m of [...CHAIN, ...TERMINAL]) {
      obj[m] = vi.fn(() => {
        if (dbState.strict) {
          throw new Error(`DB_TOUCHED_WHILE_FINANCE_DISABLED: ${name}.${m}`);
        }
        if ((CHAIN as readonly string[]).includes(m)) return obj; // chainable
        switch (m) {
          case "first": return null;
          case "all": return [];
          case "aggregate": return { total: 0, c: 0 };
          case "create": return { id: `mock-${name}` };
          case "updateAll": case "updateAndCount": return [];
          case "count": return 0;
          default: return undefined;
        }
      });
    }
    return obj;
  };
  const MODELS = [
    "User", "Listing", "Cart", "CartItem", "Order", "OrderItem", "Payment",
    "Payout", "WithdrawRequest", "LedgerEntry", "Dispute", "OrderStatusHistory",
    "ExchangeOffer", "Offer", "Conversation", "Category", "PlatformSetting",
    "Notification", "AdminAuditLog", "PriceHistory",
  ];
  const orm = {
    public: Object.fromEntries(MODELS.map((n) => [n, makeModel(n)])),
  };
  const db = {
    orm,
    transaction: vi.fn((cb: (tx: unknown) => unknown) => {
      if (dbState.strict) {
        throw new Error("DB_TRANSACTION_WHILE_FINANCE_DISABLED");
      }
      return cb(db);
    }),
  };
  return { db };
});

vi.mock("@/src/lib/auth", () => ({
  requireUser: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/src/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/src/lib/mock-payment", () => ({ assertMockPaymentsAllowed: vi.fn() }));

import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { getSessionFromCookie } from "@/src/lib/session";
import { notify } from "@/src/lib/notify";
import { assertMockPaymentsAllowed } from "@/src/lib/mock-payment";
import { redirect } from "next/navigation";

import {
  addToCartAction,
  updateCartItemAction,
  removeFromCartAction,
} from "@/src/lib/actions/cart";
import {
  createOrderAction,
  payEscrowAction,
  sellerConfirmPaymentAction,
  shipOrderAction,
  confirmReceiptAction,
  cancelOrderAction,
  openDisputeAction,
} from "@/src/lib/actions/orders";
import {
  createOfferAction,
  respondOfferAction,
  acceptCounterAction,
  cancelOfferAction,
} from "@/src/lib/actions/offers";
import {
  createExchangeOfferAction,
  respondExchangeOfferAction,
  payExchangeTopupAction,
  completeExchangeAction,
  cancelExchangeOfferAction,
} from "@/src/lib/actions/exchange";
import {
  createWithdrawRequestAction,
  processWithdrawAction,
} from "@/src/lib/actions/withdraw";
import {
  resolveDisputeAction,
  updateCommissionAction,
  updateSettingAction,
} from "@/src/lib/actions/admin";
import { markEscrowPaid, markExchangeTopupPaid } from "@/src/lib/escrow";
import { recordLedgerTx, escrowIn, reconcileEscrow } from "@/src/lib/ledger";
import { createMomoPayment } from "@/src/lib/momo";
import { getWalletSummary } from "@/src/lib/wallet";
import { processAutoReleases } from "@/src/lib/actions/helpers";

const requireUserMock = vi.mocked(requireUser);
const getSessionMock = vi.mocked(getSessionFromCookie);
const notifyMock = vi.mocked(notify);
const mockPaymentMock = vi.mocked(assertMockPaymentsAllowed);
const redirectMock = vi.mocked(redirect);

/** Spy của một model method trong db mock — cho assertion not.toHaveBeenCalled(). */
function modelSpy(model: string, method: string) {
  const models = (db as unknown as {
    orm: { public: Record<string, Record<string, ReturnType<typeof vi.fn>>> };
  }).orm.public;
  return models[model]![method]!;
}

function fd(entries: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, String(v));
  return f;
}

/** Chờ action reject với mã ổn định FINANCIAL_FEATURES_DISABLED. */
const expectDenied = (p: Promise<unknown>) =>
  expect(p).rejects.toThrowError(/^FINANCIAL_FEATURES_DISABLED/);

beforeEach(() => {
  // Mặc định test: tài chính TẮT (bỏ trống env = false — spec §5.1)
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANCIAL_FEATURES_ENABLED", undefined);
  dbState.strict = true;

  requireUserMock.mockReset().mockImplementation(() => {
    throw new Error("AUTH_REQUIRE_USER_REACHED_WHILE_FINANCE_DISABLED");
  });
  // rbac (requireAdminUser/requireCapability) đọc session qua seam này —
  // tripwire chứng minh admin auth KHÔNG được chạm khi tài chính tắt.
  getSessionMock.mockReset().mockImplementation(() => {
    throw new Error("AUTH_SESSION_REACHED_WHILE_FINANCE_DISABLED");
  });
  notifyMock.mockReset().mockImplementation(() => {
    throw new Error("NOTIFY_REACHED_WHILE_FINANCE_DISABLED");
  });
  redirectMock.mockReset().mockImplementation(() => {
    throw new Error("NEXT_REDIRECT_REACHED_WHILE_FINANCE_DISABLED");
  });
  // no-op có spy — đo thứ tự: finance assert phải chạy TRƯỚC mock guard
  mockPaymentMock.mockReset().mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("cart actions — deny khi tài chính tắt (spec §4.1: cart-to-order)", () => {
  it("addToCartAction: FINANCIAL_FEATURES_DISABLED trước khi đọc Listing/create CartItem", async () => {
    await expectDenied(addToCartAction(fd({ listingId: "listing-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Listing", "first")).not.toHaveBeenCalled();
    expect(modelSpy("Cart", "first")).not.toHaveBeenCalled(); // getOrCreateCart
    expect(modelSpy("CartItem", "create")).not.toHaveBeenCalled();
    expect(modelSpy("CartItem", "update")).not.toHaveBeenCalled();
  });

  it("updateCartItemAction: deny trước khi update/delete CartItem", async () => {
    await expectDenied(updateCartItemAction(fd({ itemId: "item-1", quantity: 2 })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("CartItem", "update")).not.toHaveBeenCalled();
    expect(modelSpy("CartItem", "delete")).not.toHaveBeenCalled();
  });

  it("removeFromCartAction: deny trước khi delete CartItem", async () => {
    await expectDenied(removeFromCartAction(fd({ itemId: "item-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("CartItem", "delete")).not.toHaveBeenCalled();
  });
});

describe("orders actions — deny khi tài chính tắt (spec §4.1: checkout/payment/escrow)", () => {
  it("createOrderAction (cart-to-order + mua ngay): deny trước mọi Order/Payment/Listing/CartItem", async () => {
    await expectDenied(
      createOrderAction(
        fd({
          paymentMethod: "escrow",
          shippingAddress: "123 Đường Test, TP Test",
          shippingPhone: "0901234567",
          listingId: "listing-1",
        }),
      ),
    );
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Cart", "first")).not.toHaveBeenCalled();
    expect(modelSpy("Order", "create")).not.toHaveBeenCalled();
    expect(modelSpy("OrderItem", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Listing", "update")).not.toHaveBeenCalled(); // đánh dấu sold
    expect(modelSpy("CartItem", "delete")).not.toHaveBeenCalled(); // xóa giỏ
  });

  it("payEscrowAction (mock escrow): finance assert TRƯỚC mock guard, không claim Order/ledger", async () => {
    await expectDenied(payEscrowAction(fd({ orderId: "order-1" })));
    expect(mockPaymentMock).not.toHaveBeenCalled(); // finance trước mock guard
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Order", "updateAll")).not.toHaveBeenCalled(); // claim escrow
    expect(modelSpy("Payment", "update")).not.toHaveBeenCalled();
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled(); // escrowIn
  });

  it("sellerConfirmPaymentAction: deny trước khi giữ Payment/bật đồng hồ escrow", async () => {
    await expectDenied(sellerConfirmPaymentAction(fd({ orderId: "order-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Order", "updateAll")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "update")).not.toHaveBeenCalled();
  });

  it("shipOrderAction: deny trước khi chuyển shipped/bật autoReleaseAt", async () => {
    await expectDenied(shipOrderAction(fd({ orderId: "order-1", tracking: "VN123" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Order", "update")).not.toHaveBeenCalled();
  });

  it("confirmReceiptAction (escrow release): deny trước Payout/Payment/LedgerEntry/PriceHistory", async () => {
    await expectDenied(confirmReceiptAction(fd({ orderId: "order-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Order", "updateAll")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "update")).not.toHaveBeenCalled(); // released
    expect(modelSpy("Payout", "create")).not.toHaveBeenCalled(); // giải ngân
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled(); // escrowRelease
    expect(modelSpy("PriceHistory", "create")).not.toHaveBeenCalled(); // telemetry sold
  });

  it("cancelOrderAction (escrow refund): deny trước hoàn tiền/ledger/trả Listing", async () => {
    await expectDenied(cancelOrderAction(fd({ orderId: "order-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Order", "updateAll")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "update")).not.toHaveBeenCalled(); // refunded
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled(); // escrowRefund
    expect(modelSpy("Listing", "update")).not.toHaveBeenCalled(); // về approved
  });

  it("openDisputeAction (đóng băng escrow): deny trước Dispute.create", async () => {
    await expectDenied(
      openDisputeAction(fd({ orderId: "order-1", reason: "Loa không đúng mô tả, xin mở khiếu nại" })),
    );
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Dispute", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Order", "update")).not.toHaveBeenCalled(); // disputed
  });
});

describe("offers actions — deny khi tài chính tắt (accept/counter tạo Order — spec §4.1)", () => {
  it("createOfferAction: deny trước Offer.create", async () => {
    await expectDenied(createOfferAction({}, fd({ listingId: "listing-1", amount: 500_000 })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Offer", "create")).not.toHaveBeenCalled();
  });

  it("respondOfferAction(accept): deny trước khi tạo Order escrow từ trả giá", async () => {
    await expectDenied(
      respondOfferAction(fd({ offerId: "offer-1", response: "accept" })),
    );
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Offer", "update")).not.toHaveBeenCalled();
    expect(modelSpy("Order", "create")).not.toHaveBeenCalled(); // đơn từ trả giá
    expect(modelSpy("OrderItem", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Listing", "update")).not.toHaveBeenCalled(); // sold
  });

  it("acceptCounterAction: deny trước khi tạo Order escrow tại giá counter", async () => {
    await expectDenied(acceptCounterAction(fd({ offerId: "offer-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Order", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Listing", "update")).not.toHaveBeenCalled();
  });

  it("cancelOfferAction: deny trước Offer.update", async () => {
    await expectDenied(cancelOfferAction(fd({ offerId: "offer-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Offer", "update")).not.toHaveBeenCalled();
  });
});

describe("exchange actions — deny khi tài chính tắt (tiền bù escrow — spec §4.1)", () => {
  it("createExchangeOfferAction: deny trước ExchangeOffer.create/Conversation.create", async () => {
    await expectDenied(
      createExchangeOfferAction(
        {},
        fd({ listingId: "listing-1", myItemDescription: "Loa JBL cũ", cashTopup: 200_000 }),
      ),
    );
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("ExchangeOffer", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Conversation", "create")).not.toHaveBeenCalled();
  });

  it("respondExchangeOfferAction(accept): deny trước khi chờ top-up escrow", async () => {
    await expectDenied(
      respondExchangeOfferAction(fd({ offerId: "offer-1", response: "accept" })),
    );
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("ExchangeOffer", "update")).not.toHaveBeenCalled();
  });

  it("payExchangeTopupAction (mock escrow): finance assert TRƯỚC mock guard, không Payment/ledger", async () => {
    await expectDenied(payExchangeTopupAction(fd({ offerId: "offer-1" })));
    expect(mockPaymentMock).not.toHaveBeenCalled(); // finance trước mock guard
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "create")).not.toHaveBeenCalled(); // held
    expect(modelSpy("ExchangeOffer", "update")).not.toHaveBeenCalled(); // paid
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled(); // escrowIn
  });

  it("completeExchangeAction (giải ngân tiền bù): deny trước Payment.release/Payout/ledger", async () => {
    await expectDenied(completeExchangeAction(fd({ offerId: "offer-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "update")).not.toHaveBeenCalled(); // released
    expect(modelSpy("Payout", "create")).not.toHaveBeenCalled();
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled(); // escrowRelease
    expect(modelSpy("Listing", "update")).not.toHaveBeenCalled(); // sold 2 tin
  });

  it("cancelExchangeOfferAction: deny trước ExchangeOffer.update", async () => {
    await expectDenied(cancelExchangeOfferAction(fd({ offerId: "offer-1" })));
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("ExchangeOffer", "update")).not.toHaveBeenCalled();
  });
});

describe("withdraw actions — deny khi tài chính tắt (spec §4.1: wallet mutation/withdrawal)", () => {
  it("createWithdrawRequestAction: deny trước khi đọc ví và tạo WithdrawRequest", async () => {
    await expectDenied(
      createWithdrawRequestAction(
        {},
        fd({
          amount: 500_000,
          bankName: "Vietcombank",
          bankAccount: "0123456789",
          accountHolder: "Nguyen Van A",
        }),
      ),
    );
    expect(requireUserMock).not.toHaveBeenCalled();
    expect(modelSpy("Payout", "aggregate")).not.toHaveBeenCalled(); // wallet read
    expect(modelSpy("WithdrawRequest", "create")).not.toHaveBeenCalled();
  });

  it("processWithdrawAction (admin): deny trước claim/ledger withdrawPaid/audit", async () => {
    await expectDenied(
      processWithdrawAction(fd({ withdrawId: "wr-1", action: "paid" })),
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(modelSpy("WithdrawRequest", "updateAll")).not.toHaveBeenCalled(); // claim paid
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled(); // withdrawPaid
    expect(modelSpy("AdminAuditLog", "create")).not.toHaveBeenCalled(); // audit
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("admin finance actions — deny khi tài chính tắt (admin KHÔNG phải escape hatch — spec §4.10)", () => {
  it("resolveDisputeAction: cả 3 outcome đều không mutate — deny trước refund/release/payout", async () => {
    for (const outcome of ["resolved_buyer", "resolved_seller", "closed"]) {
      await expectDenied(
        resolveDisputeAction(
          fd({ disputeId: "dispute-1", resolution: "Đối soát xem xét xong", outcome }),
        ),
      );
    }
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(modelSpy("Dispute", "update")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "update")).not.toHaveBeenCalled(); // refunded/released
    expect(modelSpy("Order", "update")).not.toHaveBeenCalled();
    expect(modelSpy("Payout", "create")).not.toHaveBeenCalled();
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled();
    expect(modelSpy("Listing", "update")).not.toHaveBeenCalled();
  });

  it("updateCommissionAction: deny trước Category.commissionRate mutation", async () => {
    await expectDenied(
      updateCommissionAction(fd({ categoryId: "cat-1", commissionRate: 10 })),
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(modelSpy("Category", "update")).not.toHaveBeenCalled();
  });

  it("updateSettingAction: deny trước PlatformSetting upsert (escrow_auto_release_days…)", async () => {
    await expectDenied(
      updateSettingAction(fd({ key: "escrow_auto_release_days", value: "7" })),
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(modelSpy("PlatformSetting", "update")).not.toHaveBeenCalled();
    expect(modelSpy("PlatformSetting", "create")).not.toHaveBeenCalled();
  });
});

describe("defense-in-depth — thư viện finance deny cả khi bị gọi trực tiếp (plan Task 3)", () => {
  it("escrow.markEscrowPaid: deny trước khi đọc Order/claim escrow/ledger", async () => {
    await expectDenied(markEscrowPaid("order-1", "MOMO-1", "momo"));
    expect(modelSpy("Order", "first")).not.toHaveBeenCalled();
    expect(modelSpy("Order", "updateAll")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "updateAndCount")).not.toHaveBeenCalled();
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled();
  });

  it("escrow.markExchangeTopupPaid: deny trước khi đọc ExchangeOffer/ledger", async () => {
    await expectDenied(markExchangeTopupPaid("offer-1", "MOMO-1", "momo"));
    expect(modelSpy("ExchangeOffer", "first")).not.toHaveBeenCalled();
    expect(modelSpy("ExchangeOffer", "updateAll")).not.toHaveBeenCalled();
    expect(modelSpy("Payment", "updateAndCount")).not.toHaveBeenCalled();
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled();
  });

  it("ledger.recordLedgerTx: deny trước khi ghi LedgerEntry — caller tương lai không bypass được", async () => {
    const create = vi.fn(async (data: unknown) => data);
    const tx = { orm: { public: { LedgerEntry: { create } } } };
    await expectDenied(
      recordLedgerTx(tx as never, "payment", "order-1", escrowIn("buyer-1", 150_000, "note")),
    );
    expect(create).not.toHaveBeenCalled(); // không ghi dở dang
  });

  it("momo.createMomoPayment: deny trước khi tạo provider request (không gọi fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expectDenied(
      createMomoPayment({
        orderId: "ORDER-1",
        amount: 100_000,
        orderInfo: "test",
        redirectUrl: "http://localhost:3000/payments/momo/return",
        ipnUrl: "http://localhost:3000/api/payments/momo/ipn",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled(); // không ký/nộp request lên cổng
  });

  it("wallet.getWalletSummary: deny operational read — không aggregate Payout/WithdrawRequest", async () => {
    await expectDenied(getWalletSummary("seller-1"));
    expect(modelSpy("Payout", "aggregate")).not.toHaveBeenCalled();
    expect(modelSpy("WithdrawRequest", "aggregate")).not.toHaveBeenCalled();
  });

  it("helpers.processAutoReleases: deny trước khi quét Order quá hạn — cron bypass không được", async () => {
    await expectDenied(processAutoReleases());
    expect(modelSpy("Order", "where")).not.toHaveBeenCalled();
    expect(modelSpy("Payout", "create")).not.toHaveBeenCalled();
    expect(modelSpy("LedgerEntry", "create")).not.toHaveBeenCalled();
  });

  it("ledger.reconcileEscrow vẫn chạy khi tắt — read-only historical (plan: giữ nguyên)", async () => {
    dbState.strict = false; // cho phép read lành tính để chứng minh không guard
    const r = await reconcileEscrow();
    expect(r).toEqual({ ledgerEscrow: 0, paymentsHeld: 0, balanced: true });
  });
});

describe("finance BẬT (dev/test) — ranh giới mở, hành vi legacy giữ nguyên", () => {
  it("payEscrowAction vượt finance assert → mock guard → auth → db (thứ tự legacy)", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    requireUserMock.mockResolvedValue({
      id: "buyer-1",
      email: "buyer@t.est",
      name: "Buyer",
      role: "buyer",
      avatarUrl: null,
      isVerifiedSeller: false,
      // Batch 2 Task 2: SessionUser thêm adminRole + sessionId (bắt buộc)
      adminRole: null,
      sessionId: "sess-fixture",
    });
    await expect(payEscrowAction(fd({ orderId: "order-1" }))).rejects.toThrowError(
      /DB_TOUCHED_WHILE_FINANCE_DISABLED/, // đi qua hết guard, chạm db thật (mock)
    );
    expect(mockPaymentMock).toHaveBeenCalledTimes(1); // finance TRƯỚC mock guard
    expect(requireUserMock).toHaveBeenCalledTimes(1);
  });

  it("processAutoReleases vượt assert → đọc Order như cũ", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    await expect(processAutoReleases()).rejects.toThrowError(
      /DB_TOUCHED_WHILE_FINANCE_DISABLED/,
    );
  });

  it("recordLedgerTx ghi entry đối xứng như cũ (invariant double-entry)", async () => {
    vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
    const created: unknown[] = [];
    const create = vi.fn(async (data: unknown) => {
      created.push(data);
      return data;
    });
    const tx = { orm: { public: { LedgerEntry: { create } } } };
    const txId = await recordLedgerTx(
      tx as never,
      "payment",
      "order-1",
      escrowIn("buyer-1", 150_000, "note"),
    );
    expect(txId).toMatch(/^TX-/);
    expect(created).toHaveLength(2);
    expect(
      created.reduce((s: number, e) => s + (e as { amount: number }).amount, 0),
    ).toBe(0);
  });
});
