"use client";

import { useActionState, useEffect, useState } from "react";
import { submitReportAction, type ReportFormState } from "@/src/lib/actions/reports";
import {
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASON_CODES,
  type ReportTargetType,
} from "@/src/lib/moderation-vocab";
import { REPORT_REASON_LABELS } from "@/src/lib/constants";
import { CheckCircle2, Flag, LoaderCircle, X } from "lucide-react";

/**
 * Dialog báo cáo lạm dụng (Batch 3 Task 4 — spec §5.5).
 *
 * B2 (file-conflict rules): import vocab CHỈ từ src/lib/moderation-vocab.ts +
 * label từ src/lib/constants.ts — KHÔNG BAO GIỜ import src/lib/moderation.ts
 * (module đó import db → "server-only" → client build break).
 * submitReportAction là server action reference ("use server" directive) —
 * import client-side an toàn theo thiết kế Next (implementation ở server).
 *
 * KHÔNG render nội dung target vào dialog (chỉ label) — mọi untrusted content
 * hiển thị qua React text, không dangerouslySetInnerHTML (spec §7.4 stored XSS).
 * Panel unmount khi đóng → useActionState reset — mở lại là form mới.
 */
export function ReportDialog({
  targetType,
  targetId,
  triggerLabel = "Báo cáo",
  className,
}: {
  targetType: ReportTargetType;
  targetId: string;
  triggerLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "btn-secondary h-9 px-3.5 text-xs text-[var(--red)] hover:border-[var(--red)]/40 hover:bg-[var(--red-soft)]"
        }
        title="Báo cáo nội dung này cho đội kiểm duyệt"
      >
        <Flag className="size-3.5" />
        {triggerLabel}
      </button>
    );
  }

  return (
    <ReportDialogPanel
      targetType={targetType}
      targetId={targetId}
      onClose={() => setOpen(false)}
    />
  );
}

function ReportDialogPanel({
  targetType,
  targetId,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<ReportFormState, FormData>(
    submitReportAction,
    {},
  );

  // Đóng dialog sau success (plan Task 4) — hiển thị xác nhận chốc lát rồi đóng;
  // panel unmount → state reset → lần mở sau là form mới.
  useEffect(() => {
    if (!state.success) return;
    const t = setTimeout(onClose, 1500);
    return () => clearTimeout(t);
  }, [state.success, onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-[var(--ink)]/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Báo cáo nội dung vi phạm"
    >
      <div className="card w-full max-w-md overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-extrabold">
            <Flag className="size-4 text-[var(--red)]" />
            Báo cáo nội dung vi phạm
          </p>
          <button type="button" onClick={onClose} className="btn-ghost size-8 p-0" title="Đóng">
            <X className="size-4" />
          </button>
        </div>

        <div className="p-5">
          {state.success ? (
            <div className="grid place-items-center gap-2 py-6 text-center">
              <CheckCircle2 className="size-10 text-[var(--green)]" />
              <p className="text-sm font-semibold">{state.success}</p>
            </div>
          ) : (
            <form action={formAction} className="space-y-4">
              {/* target truyền qua hidden field — action tự validate + authorize */}
              <input type="hidden" name="targetType" value={targetType} />
              <input type="hidden" name="targetId" value={targetId} />

              <div>
                <label className="label" htmlFor={`report-reason-${targetId}`}>
                  Lý do báo cáo
                </label>
                <select
                  id={`report-reason-${targetId}`}
                  name="reasonCode"
                  className="input"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    — Chọn lý do —
                  </option>
                  {REPORT_REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {REPORT_REASON_LABELS[code]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor={`report-note-${targetId}`}>
                  Mô tả thêm (không bắt buộc)
                </label>
                <textarea
                  id={`report-note-${targetId}`}
                  name="note"
                  rows={3}
                  maxLength={REPORT_NOTE_MAX_LENGTH}
                  className="input resize-none"
                  placeholder="Mô tả vấn đề bạn thấy — không chia sẻ thông tin cá nhân của bạn"
                />
              </div>

              {state.error && (
                <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
                  {state.error}
                </p>
              )}

              <div className="flex items-center gap-2">
                <button type="submit" disabled={pending} className="btn-primary flex-1">
                  {pending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Flag className="size-4" />
                  )}
                  Gửi báo cáo
                </button>
                <button type="button" onClick={onClose} className="btn-secondary flex-1 text-sm">
                  Hủy
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
