/**
 * Policy registry + versioned policy pages — Batch 8 Task 1 (spec §3.1
 * legal/policy readiness, §4.11 Policy Non-Invention, §9 Batch 8 gate:
 * release bị chặn khi còn policy chưa duyệt) — unit tests.
 *
 * Hợp đồng (plan Task 1 Step 1):
 *  1. Registry đủ đúng SÁU policy spec §3.1 (Terms, Privacy, Marketplace
 *     Rules, Seller Rules, Community Rules, Safety Guidance) — không thêm
 *     policy thứ bảy, không thiếu.
 *  2. seller_rules khớp hằng số chấp nhận của Batch 2
 *     (SELLER_RULES_POLICY_KEY/VERSION — PolicyAcceptance ghi theo version
 *     đã publish; registry drift → test fail).
 *  3. Mọi policy có title/version/status/updatedAt hợp lệ.
 *  4. allPoliciesReviewed false khi CÒN BẤT KỲ status DRAFT-NOT-REVIEWED,
 *     true CHỈ khi cả sáu REVIEWED — fixture-driven (Review Focus 1).
 *  5. unreviewedPolicies liệt kê đúng các policy DRAFT.
 *  6. policyContentHash = sha256 hex của nội dung shipped, ổn định qua lần gọi.
 *  7. Mọi content module khớp hợp đồng placeholder (§4.11 — Review Focus 2):
 *     heading DRAFT + banner cơ chế + marker [nội dung chờ founder]; KHÔNG
 *     prose tự soạn — riêng safety_guidance được thêm 6 điểm §6.4 + dòng §5.2
 *     (spec-sourced, bản dịch Batch 6) — ghim BẰNG EQUALITY chặt (không chỉ
 *     presence — review fix).
 *  8. Trang policy: banner DRAFT có điều kiện, KHÔNG dangerouslySetInnerHTML,
 *     generateStaticParams phủ POLICY_KEYS, key lạ → notFound(), công khai
 *     (không auth, không db); nhánh REVIEWED trung tính — flag registry
 *     KHÔNG tự thành claim duyệt công khai (review fix).
 *  9. Footer link đủ sáu policy.
 * 10. scripts/policy-hash.ts --check in đúng format <key> <version>
 *     <sha256> <status> — spawn script thật (release gate Task 9 parse).
 *
 * Cơ chế mock: chỉ đủ để import seller-verification-policy của Batch 2
 * (server-only + db.client — recipe chuẩn; hằng số không chạm db) và page
 * (next/navigation). Registry + content modules là plain module — KHÔNG
 * mock. Source-contract assertions đọc file như text theo pattern
 * tests/unit/finance-public-surface.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Canonical stubbing recipe (chỉ cho import Batch 2 + page) ─────────────────
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// seller-verification-policy import db.client ở top-level — hằng số không chạm
// db; mock throw để mọi truy cập DB vô tình nào trong test là lỗi hợp đồng.
vi.mock("@/src/prisma/db.client", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("DB_ACCESSED_IN_POLICY_REGISTRY_TEST");
      },
    },
  ),
}));

import {
  SELLER_RULES_POLICY_KEY,
  SELLER_RULES_POLICY_VERSION,
} from "../../src/lib/seller-verification-policy";
import {
  POLICIES,
  POLICY_KEYS,
  allPoliciesReviewed,
  policyContent,
  policyContentHash,
  unreviewedPolicies,
  type PolicyKey,
  type PolicyStatus,
} from "../../src/lib/policy-registry";
import * as policyPage from "../../app/policies/[key]/page";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

/** File content module của từng key (src/content/policies/<key>.ts). */
const CONTENT_FILES: Record<PolicyKey, string> = {
  terms: "src/content/policies/terms.ts",
  privacy: "src/content/policies/privacy.ts",
  marketplace_rules: "src/content/policies/marketplace-rules.ts",
  seller_rules: "src/content/policies/seller-rules.ts",
  community_rules: "src/content/policies/community-rules.ts",
  safety_guidance: "src/content/policies/safety-guidance.ts",
};

/** Sáu điểm §6.4 (bản dịch tiếng Việt — Batch 6 plan Q9/Task 6, chờ founder duyệt). */
const SAFETY_64_POINTS = [
  "Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.",
  "Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.",
  "Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.",
  "Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.",
  "Cẩn trọng với các đường link thanh toán đáng ngờ.",
  "Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.",
] as const;

/** Dòng §5.2 (Batch 6 plan Q9 — "The UI must state"). */
const SAFETY_52_LINE = "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.";

// ─── 1–3. Registry: sáu policy, alignment Batch 2, shape ──────────────────────

describe("policy registry — sáu policy spec §3.1 + alignment Batch 2", () => {
  it("registry đủ đúng sáu policy spec §3.1 — không thêm bớt", () => {
    expect([...POLICY_KEYS]).toEqual([
      "terms",
      "privacy",
      "marketplace_rules",
      "seller_rules",
      "community_rules",
      "safety_guidance",
    ]);
    // POLICIES có đúng sáu entry, key trùng POLICY_KEYS
    expect(Object.keys(POLICIES).sort()).toEqual([...POLICY_KEYS].sort());
  });

  it("seller_rules khớp hằng số chấp nhận của Batch 2 (FD-R4)", () => {
    expect(POLICIES.seller_rules.key).toBe(SELLER_RULES_POLICY_KEY);
    expect(POLICIES.seller_rules.version).toBe(SELLER_RULES_POLICY_VERSION);
  });

  it("mọi policy có title/version/status/updatedAt hợp lệ", () => {
    for (const key of POLICY_KEYS) {
      const p = POLICIES[key];
      expect(p.key).toBe(key);
      expect(p.title.trim().length).toBeGreaterThan(0);
      expect(p.version).toMatch(/^v\d+$/);
      expect(["DRAFT-NOT-REVIEWED", "REVIEWED"]).toContain(p.status);
      expect(p.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(p.updatedAt))).toBe(false);
    }
  });
});

// ─── 4–5. allPoliciesReviewed / unreviewedPolicies — fixture theo status ──────

describe("allPoliciesReviewed / unreviewedPolicies — fixture-driven theo status", () => {
  const original = new Map<PolicyKey, PolicyStatus>();

  beforeEach(() => {
    for (const k of POLICY_KEYS) original.set(k, POLICIES[k].status);
  });
  afterEach(() => {
    for (const [k, s] of original) POLICIES[k].status = s;
  });

  it("false khi cả sáu còn DRAFT-NOT-REVIEWED (thực tế hiện tại — FD-3)", () => {
    for (const k of POLICY_KEYS) POLICIES[k].status = "DRAFT-NOT-REVIEWED";
    expect(allPoliciesReviewed()).toBe(false);
    expect(unreviewedPolicies()).toEqual([...POLICY_KEYS]);
  });

  it("false khi MỘT bất kỳ còn DRAFT — duyệt lần lượt từng policy vẫn false", () => {
    // duyệt đúng một policy, còn năm DRAFT
    for (const reviewed of POLICY_KEYS) {
      for (const k of POLICY_KEYS) {
        POLICIES[k].status = k === reviewed ? "REVIEWED" : "DRAFT-NOT-REVIEWED";
      }
      expect(allPoliciesReviewed()).toBe(false);
      expect(unreviewedPolicies()).toEqual(POLICY_KEYS.filter((k) => k !== reviewed));
    }
    // duyệt năm, còn đúng MỘT DRAFT
    for (const drafted of POLICY_KEYS) {
      for (const k of POLICY_KEYS) {
        POLICIES[k].status = k === drafted ? "DRAFT-NOT-REVIEWED" : "REVIEWED";
      }
      expect(allPoliciesReviewed()).toBe(false);
      expect(unreviewedPolicies()).toEqual([drafted]);
    }
  });

  it("true CHỈ khi cả sáu REVIEWED — khi đó không còn policy nào chưa duyệt", () => {
    for (const k of POLICY_KEYS) POLICIES[k].status = "REVIEWED";
    expect(allPoliciesReviewed()).toBe(true);
    expect(unreviewedPolicies()).toEqual([]);
  });
});

// ─── 6. Hash ──────────────────────────────────────────────────────────────────

describe("policyContentHash — sha256 hex của nội dung shipped", () => {
  it("khớp sha256(policyContent(key)) tính độc lập, hex 64 ký tự, ổn định qua lần gọi", () => {
    for (const key of POLICY_KEYS) {
      const expected = createHash("sha256")
        .update(policyContent(key), "utf8")
        .digest("hex");
      const h1 = policyContentHash(key);
      expect(h1).toBe(expected);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(policyContentHash(key)).toBe(h1);
    }
  });

  it("hash là hàm của NỘI DUNG — nội dung khác → hash khác (qua chính policyContentHash)", () => {
    // S1: hash phủ POLICY_TEXT. Sáu policy sáu nội dung khác nhau → sáu hash
    // khác nhau qua CHÍNH policyContentHash (hàm sai — trả hằng số / hash theo
    // key thay vì nội dung — fail ở đây hoặc ở test khớp sha256 độc lập trên).
    const hashes = POLICY_KEYS.map((k) => policyContentHash(k));
    expect(new Set(hashes).size).toBe(POLICY_KEYS.length);
  });
});

// ─── 6b. Script policy-hash — format output release gate (Task 9) parse ───────

describe("scripts/policy-hash.ts --check — format <key> <version> <sha256> <status> (Task 9 parse)", () => {
  it(
    "mỗi dòng đúng 4 cột cách nhau dấu cách, khớp registry + hash, đủ sáu policy theo thứ tự POLICY_KEYS",
    () => {
      // Spawn script THẬT (không mock): release gate Task 9 parse đúng lệnh này
      // — `npx tsx scripts/policy-hash.ts --check` — nên hợp đồng là output
      // CLI thật, kể cả phân tích cờ --check.
      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/policy-hash.ts", "--check"],
        { cwd: root, encoding: "utf8" },
      );
      const lines = out.trim().split("\n");
      expect(lines.length).toBe(POLICY_KEYS.length);
      expect(lines.map((l) => l.split(" ")[0])).toEqual([...POLICY_KEYS]);
      for (const line of lines) {
        const parts = line.split(" ");
        expect(parts.length, `đúng 4 cột: "${line}"`).toBe(4);
        const [key, version, hash, status] = parts as [PolicyKey, string, string, PolicyStatus];
        expect([...POLICY_KEYS]).toContain(key);
        expect(version).toBe(POLICIES[key].version);
        expect(hash).toBe(policyContentHash(key));
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(status).toBe(POLICIES[key].status);
      }
    },
    30_000,
  );
});

// ─── 7. Content modules — hợp đồng placeholder (§4.11 — Review Focus 2) ──────

describe("content modules — hợp đồng placeholder DRAFT-NOT-REVIEWED (§4.11)", () => {
  it("mọi content module: heading DRAFT + banner cơ chế + marker chờ founder", () => {
    for (const key of POLICY_KEYS) {
      const body = policyContent(key);
      // heading mở đầu: "# <title> (DRAFT-NOT-REVIEWED)"
      expect(
        body.startsWith(`# ${POLICIES[key].title} (DRAFT-NOT-REVIEWED)`),
        `${key}: mở đầu bằng heading DRAFT`,
      ).toBe(true);
      // banner cơ chế: founder soạn và duyệt — FD-3, spec §4.11
      expect(body).toContain("BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT");
      expect(body).toContain("founder soạn và duyệt");
      expect(body).toContain("FD-3");
      expect(body).toContain("§4.11");
      // marker chờ founder
      expect(body).toContain("[nội dung chờ founder");
      expect(body).toContain(key);
    }
  });

  it("content module chỉ export POLICY_TEXT — KHÔNG mang status/version (S1)", () => {
    for (const key of POLICY_KEYS) {
      const src = read(CONTENT_FILES[key]);
      const exports = src.match(/^export /gm) ?? [];
      expect(exports.length, `${key}: đúng một export`).toBe(1);
      expect(src).toContain("export const POLICY_TEXT");
    }
  });

  it("năm policy KHÔNG phải safety_guidance: không prose §6.4, không mục con, không list", () => {
    for (const key of POLICY_KEYS) {
      if (key === "safety_guidance") continue;
      const body = policyContent(key);
      for (const point of SAFETY_64_POINTS) {
        expect(body, `${key}: không chứa điểm §6.4 "${point}"`).not.toContain(point);
      }
      expect(body, `${key}: không chứa dòng §5.2`).not.toContain(SAFETY_52_LINE);
      // không section skeleton (## …), không danh sách đánh dấu
      expect(body).not.toContain("\n## ");
      expect(body).not.toContain("\n- ");
      expect(body).not.toContain("\n* ");
      expect(body).not.toContain("\n1. ");
    }
  });

  it("safety_guidance: body ĐÚNG heading + banner + marker + 6 điểm §6.4 + dòng §5.2 — không prose thừa", () => {
    // §4.11: ngoại lệ duy nhất cho placeholder là thành phần spec-sourced
    // (6 điểm §6.4 + dòng §5.2). Equality chặt — mọi dòng implementer thêm
    // vào là vi phạm; founder text thay thế TOÀN BỘ khi duyệt (hash đổi).
    const expected =
      [
        `# ${POLICIES.safety_guidance.title} (DRAFT-NOT-REVIEWED)`,
        "",
        "> ⚠️ BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT. Nội dung pháp lý do founder soạn và duyệt",
        "> (FD-3, spec §4.11) — bản này chưa có hiệu lực cho phiên bản beta.",
        "",
        "[nội dung chờ founder — safety_guidance]",
        "",
        ...SAFETY_64_POINTS.map((p) => `- ${p}`),
        "",
        SAFETY_52_LINE,
      ].join("\n") + "\n";
    expect(policyContent("safety_guidance")).toBe(expected);
  });
});

// ─── 8. Trang policy — app/policies/[key]/page.tsx ────────────────────────────

describe("app/policies/[key]/page.tsx — trang chính sách công khai", () => {
  const src = () => read("app/policies/[key]/page.tsx");

  it("generateStaticParams phủ đủ POLICY_KEYS", () => {
    const params = policyPage.generateStaticParams();
    expect(params.map((p) => p.key)).toEqual([...POLICY_KEYS]);
  });

  it("key lạ → notFound() (typed 404)", async () => {
    const Page = policyPage.default as unknown as (props: {
      params: Promise<{ key: string }>;
    }) => Promise<unknown>;
    await expect(
      Page({ params: Promise.resolve({ key: "khong-ton-tai" }) }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("key hợp lệ render được (không throw)", async () => {
    const Page = policyPage.default as unknown as (props: {
      params: Promise<{ key: string }>;
    }) => Promise<unknown>;
    for (const key of POLICY_KEYS) {
      const el = await Page({ params: Promise.resolve({ key }) });
      expect(el).toBeTruthy();
    }
  });

  it("banner DRAFT có điều kiện — KHÔNG dangerouslySetInnerHTML, render văn bản thuần", () => {
    expect(src()).toContain(
      "BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT. Nội dung này chưa có hiệu lực cho phiên bản beta.",
    );
    expect(src()).toContain('policy.status === "DRAFT-NOT-REVIEWED"');
    expect(src()).not.toContain("dangerouslySetInnerHTML=");
    expect(src()).toContain("whitespace-pre-wrap");
    expect(src()).toContain("policyContent(");
  });

  it("REVIEWED branch trung tính — flag registry KHÔNG tự thành claim duyệt công khai", () => {
    // Review fix: nhánh REVIEWED không được phát ngôn "đã được duyệt" cho công
    // khai — flag registry flip mà không có row duyệt APPROVED phải không thể
    // tạo claim duyệt. Chỉ version + ngày hiệu lực trung tính (render vô điều
    // kiện); claim duyệt sống trong bản ghi review (Decision == APPROVED).
    const page = src();
    expect(page).not.toContain("đã được duyệt");
    expect(page).not.toContain("được founder duyệt");
    expect(page).not.toContain("Trạng thái:");
    // version + ngày hiệu lực trung tính hiển thị vô điều kiện
    expect(page).toContain("cập nhật {policy.updatedAt}");
  });

  it("công khai (§2.1 public visitor): không auth, không db — trang tĩnh", () => {
    expect(src()).not.toContain("getCurrentUser");
    expect(src()).not.toContain("requireCapability");
    expect(src()).not.toContain("requireAdminUser");
    expect(src()).not.toContain("db.client");
    expect(src()).toContain("policy-registry");
  });
});

// ─── 9. Footer — cột Chính sách ───────────────────────────────────────────────

describe("src/components/footer.tsx — cột Chính sách link đủ sáu policy", () => {
  it("link đủ sáu policy (/policies/<key>), không thừa không thiếu", () => {
    const src = read("src/components/footer.tsx");
    const linked = [...src.matchAll(/href="\/policies\/([a-z_]+)"/g)].map((m) => m[1]);
    expect(linked.length).toBe(6);
    expect(new Set(linked)).toEqual(new Set([...POLICY_KEYS]));
  });

  it("giữ nguyên các cột hiện có + dòng disclaimers trung tính (Batch 1)", () => {
    const src = read("src/components/footer.tsx");
    expect(src).toContain("Mua hàng");
    expect(src).toContain("Bán hàng");
    expect(src).toContain("không giữ tiền");
    expect(src).toContain("không bảo đảm giao dịch");
  });
});
