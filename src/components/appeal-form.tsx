"use client";

import { useActionState } from "react";
import { recordAppealAction, type AppealFormState } from "@/src/lib/actions/appeals";
import { APPEAL_STATEMENT_MAX_LENGTH } from "@/src/lib/moderation-vocab";
import { CheckCircle2, LoaderCircle, Scale } from "lucide-react";

/**
 * Form kháng cáo (Batch 3 Task 7 — spec §9 Batch 3 "appeal foundation").
 *
 * B2 (file-conflict rules): import cap CHỈ từ src/lib/moderation-vocab.ts —
 * KHÔNG BAO GIỜ import src/lib/moderation.ts (module đó import db →
 * "server-only" → client build break). recordAppealAction là server action
 * reference ("use server" directive) — import client-side an toàn theo
 * thiết kế Next (implementation ở server).
 *
 * Statement là UNTRUSTED input — hiển thị/lưu qua React text + action cap,
 * KHÔNG render HTML thô (spec §7.4 stored XSS). Sau success form
 * không submit lại (disabled — một appeal / case, action tự dedupe).
 *
 * PLACEHOLDER (FD-3): copy form là founder-authored content pending (Batch 8
 * Founder Decision Register) — bản hiện tại chỉ nêu mechanics (gửi lời trình
 * bày), KHÔNG phát minh quyền kháng cáo.
 */
export function AppealForm({ caseId }: { caseId: string }) {
  const [state, formAction, pending] = useActionState<AppealFormState, FormData>(
    recordAppealAction,
    {},
  );

  if (state.success) {
    return (
      <div className="grid place-items-center gap-2 rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-4 py-6 text-center">
        <CheckCircle2 className="size-8 text-[var(--green)]" />
        <p className="text-sm font-semibold">{state.success}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      {/* case truyền qua hidden field — action tự validate + authorize (IDOR) */}
      <input type="hidden" name="caseId" value={caseId} />

      <div>
        <label className="label" htmlFor="appeal-statement">
          Lời trình bày của bạn
        </label>
        <textarea
          id="appeal-statement"
          name="statement"
          rows={5}
          maxLength={APPEAL_STATEMENT_MAX_LENGTH}
          className="input resize-none"
          placeholder="Trình bày hoàn cảnh của bạn — không chia sẻ thông tin cá nhân của người khác"
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          Tối đa {APPEAL_STATEMENT_MAX_LENGTH} ký tự — không bắt buộc.
        </p>
      </div>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]"
        >
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Scale className="size-4" />
        )}
        Gửi kháng cáo
      </button>
    </form>
  );
}
