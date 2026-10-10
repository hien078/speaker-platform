/**
 * Ledger double-entry — financial invariants (§17, §118).
 * recordLedgerTx là thuần đối với tx context → test với fake in-memory.
 *
 * Private beta (plan Task 3): recordLedgerTx có defense-in-depth assert —
 * bộ invariant legacy này bật tài chính NGÔI LẬP (FINANCIAL_FEATURES_ENABLED=true,
 * dev/test) để vẫn chứng minh thuật toán; hành vi tắt mặc định được test riêng
 * ở tests/unit/financial-shutdown-actions.test.ts (không yếu hóa ranh giới).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  escrowIn,
  escrowRefund,
  escrowRelease,
  recordLedgerTx,
  withdrawPaid,
} from "../../src/lib/ledger";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

function fakeTx() {
  const created: Row[] = [];
  const tx = {
    orm: {
      public: {
        LedgerEntry: {
          create: async (data: Row) => {
            created.push(data);
            return data;
          },
        },
      },
    },
  };
  return { tx: tx as never, created };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANCIAL_FEATURES_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recordLedgerTx — invariant tổng = 0", () => {
  it("ghi được các entry đối xứng (escrowIn)", async () => {
    const { tx, created } = fakeTx();
    const txId = await recordLedgerTx(tx, "payment", "order-1", escrowIn("buyer-1", 150_000, "note"));
    expect(txId).toMatch(/^TX-/);
    expect(created).toHaveLength(2);
    const sum = created.reduce((s, e) => s + (e.amount as number), 0);
    expect(sum).toBe(0); // escrow +150000, buyer −150000
    expect(created[0]).toMatchObject({ account: "escrow", amount: 150_000, refType: "payment", refId: "order-1" });
    expect(created[1]).toMatchObject({ account: "buyer:buyer-1", amount: -150_000 });
  });

  it("throw LEDGER_NOT_BALANCED khi entries lệch — KHÔNG ghi gì", async () => {
    const { tx, created } = fakeTx();
    await expect(
      recordLedgerTx(tx, "payment", "o", [
        { account: "escrow", amount: 100 },
        { account: "buyer:x", amount: -90 }, // lệch 10
      ]),
    ).rejects.toThrowError(/LEDGER_NOT_BALANCED/);
    expect(created).toHaveLength(0); // không ghi dở dang
  });
});

describe("entry builders — mọi tổ hợp phải cân bằng", () => {
  const sum = (entries: { amount: number }[]) => entries.reduce((s, e) => s + e.amount, 0);

  it("escrowIn / escrowRefund / withdrawPaid cân bằng 0", () => {
    expect(sum(escrowIn("b", 500, "n"))).toBe(0);
    expect(sum(escrowRefund("b", 500, "n"))).toBe(0);
    expect(sum(withdrawPaid("s", 500, "n"))).toBe(0);
  });

  it("escrowRelease: escrow −total = seller payout + commission", () => {
    const entries = escrowRelease("s", 1_000_000, 50_000, "n");
    expect(sum(entries)).toBe(0);
    const byAcc = Object.fromEntries(entries.map((e) => [e.account, e.amount]));
    expect(byAcc["escrow"]).toBe(-1_000_000);
    expect(byAcc["seller:s"]).toBe(950_000);
    expect(byAcc["platform_revenue"]).toBe(50_000);
  });

  it("escrowRelease với commission 0 vẫn cân bằng", () => {
    expect(sum(escrowRelease("s", 123_456, 0, "n"))).toBe(0);
  });
});
