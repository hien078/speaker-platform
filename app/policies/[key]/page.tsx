/**
 * Trang chính sách công khai — /policies/[key] (Batch 8 Task 1, spec §3.1
 * legal/policy readiness + §2.1 public visitor: "read public safety
 * guidance" — KHÔNG auth, KHÔNG db: trang tĩnh).
 *
 * Render: title, version ("Phiên bản v1 · cập nhật <date>"), status; khi
 * status === "DRAFT-NOT-REVIEWED" → banner hiển thị rõ. POLICY_TEXT render
 * dạng văn bản thuần (React text node + whitespace-pre-wrap) — KHÔNG
 * dangerouslySetInnerHTML, KHÔNG markdown-as-HTML.
 *
 * Nhánh REVIEWED trung tính (review fix): KHÔNG phát ngôn duyệt công khai từ
 * flag registry — flag flip mà không có row duyệt APPROVED trong
 * docs/operations/policy-review-record.md phải KHÔNG THỂ tạo claim duyệt
 * công khai; chỉ version + ngày hiệu lực trung tính (render vô điều kiện).
 * Claim duyệt sống trong bản ghi review (Decision == APPROVED), không render
 * từ flag.
 *
 * Key lạ → notFound() (typed route params — guard trước mọi render).
 * generateStaticParams phủ POLICY_KEYS — sáu trang tĩnh theo registry.
 */
import { notFound } from "next/navigation";
import {
  POLICIES,
  POLICY_KEYS,
  policyContent,
} from "@/src/lib/policy-registry";

export function generateStaticParams() {
  return POLICY_KEYS.map((key) => ({ key }));
}

export default async function PolicyPage({
  params,
}: PageProps<"/policies/[key]">) {
  const { key } = await params;

  // Key lạ → 404 (guard trước mọi render — typed route params).
  if (!(POLICY_KEYS as readonly string[]).includes(key)) {
    notFound();
  }
  const policyKey = key as (typeof POLICY_KEYS)[number];
  const policy = POLICIES[policyKey];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 lg:px-6">
      <h1 className="text-2xl font-extrabold tracking-tight">{policy.title}</h1>
      <p className="mt-2 text-[13px] text-[var(--muted)]">
        Phiên bản {policy.version} · cập nhật {policy.updatedAt}
      </p>

      {policy.status === "DRAFT-NOT-REVIEWED" ? (
        <p className="mt-6 border border-[var(--line-2)] bg-[var(--accent-soft)] px-4 py-3 text-[13px] font-bold text-[var(--ink-2)]">
          BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT. Nội dung này chưa có hiệu lực cho phiên bản beta.
        </p>
      ) : null}

      {/* Văn bản thuần — KHÔNG dangerouslySetInnerHTML, KHÔNG markdown-as-HTML */}
      <div className="mt-6 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--ink-2)]">
        {policyContent(policyKey)}
      </div>
    </main>
  );
}
