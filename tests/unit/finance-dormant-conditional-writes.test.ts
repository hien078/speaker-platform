/**
 * Finance dormant paths (b4-holistic round-3 — LATENT: finance TẮT trong beta,
 * assertFinancialFeaturesEnabled chặn mọi entry point) — source-contract pin
 * các write 'sold' CÓ ĐIỀU KIỆN, để lần bật lại không quên.
 *
 * Hợp đồng (finding probe:legacy-listing-edit-and-toggle-state-machine):
 *  1. completeExchangeAction: offer transition CAS theo status đã đọc; CẢ HAI
 *     listing (offer.listingId + offer.myListingId) claim 'sold' CÓ ĐIỀU KIỆN
 *     theo approved — takedown 'removed' / edit 'pending' giữa read và write
 *     KHÔNG bị clobber (moderation lock mất + unreviewed content vào binding).
 *  2. createOrderAction: claim 'sold' CÓ ĐIỀU KIỀN theo approved TRONG tx (0
 *     rows → sentinel → rollback Order/OrderItem/Payment), classify NGOÀI tx.
 *  3. Audit listing.sold auditEventTx TRONG cùng tx (KHÔNG fire-after-commit).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const exchange = read("src/lib/actions/exchange.ts");
const orders = read("src/lib/actions/orders.ts");

describe("finance dormant — write 'sold' CÓ ĐIỀU KIỆN theo approved (b4-holistic round-3, LATENT)", () => {
  it("completeExchangeAction: offer CAS + CẢ HAI listing claim theo approved + sentinel + audit tx", () => {
    // offer transition CAS theo status đã đọc
    expect(exchange).toMatch(
      /\.where\(\{ id: offerId, status: offer\.status \}\)[\s\S]*?updateAll\(\{ status: "completed" \}\)/,
    );
    // listing chính — claim CÓ ĐIỀU KIỆN (KHÔNG .update() đơn-row vô điều kiện)
    expect(exchange).toMatch(
      /\.where\(\{ id: offer\.listingId, status: "approved" \}\)[\s\S]*?updateAll\(\{ status: "sold" \}\)/,
    );
    // listing đổi chủ của buyer — cùng điều kiện
    expect(exchange).toMatch(
      /\.where\(\{ id: offer\.myListingId, status: "approved" \}\)[\s\S]*?updateAll\(\{ status: "sold" \}\)/,
    );
    // sentinel throw ra khỏi callback, classify NGOÀI tx (KHÔNG catch trong callback)
    expect(exchange).toContain('throw new Error("OFFER_CONCURRENT_CHANGE")');
    expect(exchange).toContain('throw new Error("LISTING_NOT_SELLABLE")');
    expect(exchange).toMatch(/} catch \(e\) \{[\s\S]*exchange\.complete/);
    // audit listing.sold trong cùng tx
    expect(exchange).toMatch(/auditEventTx\(tx, \{[\s\S]*action: "listing\.sold"/);
  });

  it("createOrderAction: claim 'sold' theo approved TRONG tx + sentinel + classify NGOÀI tx + audit tx", () => {
    expect(orders).toMatch(
      /\.where\(\{\s*id: listing\.id,\s*status: "approved",?\s*\}\)\s*\.updateAll\(\{ status: "sold" \}\)/,
    );
    expect(orders).toContain('throw new Error("LISTING_UNAVAILABLE")');
    // classify NGOÀI tx — map sang message tiếng Việt cùng style check ngoài tx
    expect(orders).toMatch(
      /} catch \(e\) \{[\s\S]*LISTING_UNAVAILABLE[\s\S]*Có sản phẩm không còn khả năng/,
    );
    expect(orders).toMatch(/auditEventTx\(tx, \{[\s\S]*action: "listing\.sold"/);
    // KHÔNG còn .update() đơn-row vô điều kiện cho 'sold'
    expect(orders).not.toMatch(/\.update\(\{ status: "sold" \}\)/);
  });

  it("finance vẫn hard-off — sentinel không mở đường nào mới (flag giữ nguyên)", () => {
    // cả hai action vẫn chặn qua flag TRƯỚC mọi read/mutation
    expect(exchange).toMatch(/assertFinancialFeaturesEnabled\(\);[\s\S]*?const user = await requireUser/);
    expect(orders).toMatch(/assertFinancialFeaturesEnabled\(\);[\s\S]*?const user = await requireUser/);
  });
});
