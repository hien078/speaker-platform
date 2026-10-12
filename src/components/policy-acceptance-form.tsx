"use client";

import { useActionState, useTransition } from "react";
import Link from "next/link";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import {
  acceptCurrentPoliciesAction,
  type PolicyAcceptanceFormState,
} from "@/src/lib/actions/policy-acceptance";

/**
 * PolicyAcceptanceForm — form đồng ý terms + privacy tại version hiện hành
 * (zero-cost launch Task D — founder decision 2026-10-12). Mount DUY NHẤT ở
 * /account/policies (app/account/policies/page.tsx) khi còn policy chưa
 * chấp nhận.
 *
 * FORM RESET (React 19 — pattern deal-create-form.tsx / founding-seller-forms.tsx):
 * KHÔNG gắn action prop — dispatch thủ công onSubmit + startTransition để
 * requestFormReset KHÔNG wipe checkbox sau khi action trả {error}.
 *
 * Import client-safe ONLY (B2 hygiene): action reference + next/link.
 * Enforcement sống ở ACTION (requireUser + consent check + idempotent
 * PolicyAcceptance theo cơ chế Batch 2) — form chỉ là UX.
 */
export function PolicyAcceptanceForm() {
  const [state, formAction, pending] = useActionState<PolicyAcceptanceFormState, FormData>(
    acceptCurrentPoliciesAction,
    {},
  );
  const [, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => {
          void formAction(fd);
        });
      }}
      className="space-y-4"
    >
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-2)]">
        <input
          type="checkbox"
          name="acceptPolicies"
          required
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
        <span>
          Tôi đã đọc và đồng ý với{" "}
          <Link
            href="/policies/terms"
            target="_blank"
            rel="noopener"
            className="font-semibold text-[var(--accent)] hover:underline"
          >
            Điều khoản sử dụng
          </Link>{" "}
          và{" "}
          <Link
            href="/policies/privacy"
            target="_blank"
            rel="noopener"
            className="font-semibold text-[var(--accent)] hover:underline"
          >
            Chính sách quyền riêng tư
          </Link>{" "}
          của LoaViet (phiên bản hiện hành).
        </span>
      </label>

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2.5 text-sm text-[var(--green)]">
          ✓ {state.success}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <ShieldCheck className="size-4" />
        )}
        Đồng ý
      </button>
    </form>
  );
}
