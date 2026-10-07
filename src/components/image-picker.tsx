"use client";

import { Fragment, useRef, useState } from "react";
import { LoaderCircle, ImagePlus, X } from "lucide-react";
import { cn } from "@/src/lib/utils";

/**
 * ImagePicker (Batch 4 Task 5) — b4-holistic (round-1 LOW form-action-contract):
 *
 * Trước fix: 8 picker độc lập (mỗi slot một instance) → mỗi picker tự POST
 * /api/upload song song → đâm lock 1-upload-in-flight/user (route H1c trả
 * 429 UPLOAD_IN_PROGRESS), file bị DROP, và error hiển thị RAW CODE tiếng
 * Anh ("UPLOAD_IN_PROGRESS"/"TOO_BUSY") không retry dù route gửi Retry-After.
 *
 * Sau fix:
 *  - MỌI upload trong tab đi qua HÀNG ĐỢI module-level (enqueueUpload) —
 *    chỉ 1 request in-flight trên toàn tab, mọi picker chia sẻ → 429
 *    UPLOAD_IN_PROGRESS không còn là kết quả bình thường của form 8 slot.
 *  - 429 UPLOAD_IN_PROGRESS / 503 TOO_BUSY → retry theo Retry-After (thất
 *    bại vẫn hiển thị message) — bounded MAX_UPLOAD_ATTEMPTS.
 *  - Mã lỗi typed → text tiếng Việt qua map own-property-safe
 *    (Object.hasOwn — ?error=__proto__ không resolve prototype); chuỗi
 *    tiếng Việt có sẵn từ route hiển thị nguyên văn; lạ/rỗng → generic.
 *  - res.json() bọc try/catch — body không phải JSON (proxy 413/502) →
 *    generic, KHÔNG crash.
 *  - onCountChange: báo số ảnh hiện tại lên parent (PortableListingForm
 *    giữ cap TOÀN TIN — b4-holistic: 8/picker × 8 slot = 64 ảnh trong khi
 *    server cap 8/tin; parent truyền `max` = ngân sách còn lại).
 */

/** Text tiếng Việt cho typed code của route upload — own-property-safe lookup. */
const UPLOAD_ERROR_TEXT: Record<string, string> = {
  UPLOAD_IN_PROGRESS: "Đang tải ảnh khác lên — vui lòng đợi chút",
  TOO_BUSY: "Máy chủ đang bận — thử lại sau ít giây",
  RATE_LIMITED: "Bạn tải ảnh quá nhanh — thử lại sau ít phút",
  ACCOUNT_SUSPENDED: "Tài khoản đang bị tạm đình chỉ",
  UNAUTHENTICATED: "Phiên đăng nhập hết hạn — tải lại trang rồi thử lại",
  CONTENT_LENGTH_REQUIRED: "Yêu cầu tải ảnh không hợp lệ",
  INVALID_CONTENT_LENGTH: "Yêu cầu tải ảnh không hợp lệ",
  INVALID_BODY: "Yêu cầu tải ảnh không hợp lệ",
  UPLOAD_FAILED: "Không tải được ảnh lên — thử lại",
  // b4-holistic round-4 (LOW regression ×2): 429 UPLOAD_QUOTA (quota 24h/user
  // — app/api/upload/route.ts) thiếu trong map → picker hiển thị RAW CODE
  // tiếng Anh "UPLOAD_QUOTA" — đúng lớp lỗi raw-code round-1 đã fix, tái xuất
  // qua commit quota. Route gửi kèm message tiếng Việt có số liệu thật
  // ("Bạn đã tải tối đa 60 ảnh trong 24 giờ.") — uploadErrorText ưu tiên
  // message đó; map là belt-and-braces khi message vắng.
  UPLOAD_QUOTA: "Bạn đã đạt giới hạn ảnh tải lên trong 24 giờ — thử lại sau",
};

/** Số lần thử tối đa cho một file (lần đầu + retry theo Retry-After). */
const MAX_UPLOAD_ATTEMPTS = 3;
/** Fallback khi Retry-After thiếu/không hợp lệ (giây). */
const RETRY_AFTER_FALLBACK_SEC = 5;
/** Trần chờ Retry-After (giây) — không treo UI vì header bị thổi phồng. */
const RETRY_AFTER_MAX_SEC = 15;

/**
 * Hàng đợi upload module-level — serialize MỌI fetch /api/upload trong tab
 * (dùng chung bởi mọi ImagePicker instance). Request bị từ chối (fn throw)
 * vẫn nhả chuỗi cho request kế tiếp (then(fn, fn) + reset chain).
 */
let uploadChain: Promise<unknown> = Promise.resolve();
function enqueueUpload<T>(fn: () => Promise<T>): Promise<T> {
  const p = uploadChain.then(fn, fn);
  uploadChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** POST một file qua hàng đợi chung, kèm retry bounded cho 429/503 typed. */
async function uploadFile(file: File): Promise<{ url?: string; error?: string; message?: string }> {
  return enqueueUpload(async () => {
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      let json: { url?: string; error?: string; message?: string } = {};
      try {
        json = (await res.json()) as { url?: string; error?: string; message?: string };
      } catch {
        json = {}; // body không phải JSON (proxy 413/502…) → generic dưới
      }
      if (res.ok && typeof json.url === "string" && json.url !== "") return json;
      const code = typeof json.error === "string" ? json.error : "";
      const retryable =
        (res.status === 429 && code === "UPLOAD_IN_PROGRESS") ||
        (res.status === 503 && code === "TOO_BUSY");
      if (retryable && attempt < MAX_UPLOAD_ATTEMPTS) {
        const ra = Number(res.headers.get("retry-after"));
        const sec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, RETRY_AFTER_MAX_SEC) : RETRY_AFTER_FALLBACK_SEC;
        await new Promise((r) => setTimeout(r, sec * 1000));
        continue;
      }
      return json;
    }
    return { error: "UPLOAD_FAILED" };
  });
}

/**
 * Text hiển thị cho error — own-property-safe, KHÔNG raw code tiếng Anh.
 * b4-holistic round-4: ƯU TIÊN message tiếng Việt của route (kèm số liệu thật
 * — vd "Bạn đã tải tối đa 60 ảnh trong 24 giờ.") TRƯỚC map/code — text từ
 * route của chính app (same-origin), không phải input người dùng.
 */
function uploadErrorText(json: { error?: string; message?: string }): string {
  if (typeof json.message === "string" && json.message !== "") return json.message;
  const code = typeof json.error === "string" ? json.error : "";
  if (Object.hasOwn(UPLOAD_ERROR_TEXT, code)) return UPLOAD_ERROR_TEXT[code]!;
  // Chuỗi tiếng Việt có sẵn của route ("Ảnh tối đa 5MB"…) hiển thị nguyên văn;
  // rỗng (body không JSON) → generic.
  return code !== "" ? code : "Upload thất bại — thử lại";
}

export function ImagePicker({
  name = "images",
  max = 8,
  initialUrls = [],
  slotName,
  slotValue,
  onCountChange,
}: {
  name?: string;
  max?: number;
  initialUrls?: string[];
  /**
   * Batch 4 Task 5 — slot-aware variant: khi có slotName, MỖI ảnh post kèm một
   * hidden input song song (giá trị slotValue hoặc "" = không gán slot) để
   * formData.getAll("images") zip theo index với getAll(slotName) — action
   * đọc hai mảng song song (imageSlots lệch độ dài → IMAGE_SLOT_MISMATCH).
   */
  slotName?: string;
  /** Giá trị slot gắn cho MỌI ảnh của picker này (null/"" = không gán slot). */
  slotValue?: string | null;
  /**
   * b4-holistic: báo count ảnh hiện tại mỗi khi thay đổi (thêm/xoá) —
   * parent (PortableListingForm) cộng dồn cap TOÀN TIN và truyền `max`
   * = ngân sách còn lại cho picker này.
   */
  onCountChange?: (count: number) => void;
}) {
  const [urls, setUrls] = useState<string[]>(initialUrls);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Số file ĐANG upload (chưa vào urls) — b4-holistic round-4 (LOW partial):
   * reservation budget toàn tin. Trước fix: count chỉ publish sau TOÀN BỘ
   * file xong (re-encode mất vài giây/file) → parent totalImages vẫn cũ
   * trong lúc upload → pick slot khác cùng lúc vượt cap toàn tin (mỗi save
   * IMAGE_TOO_MANY sau khi đốt n× budget upload token). Sau fix: reserve
   * NGAY khi pick; pendingFiles giữ reservation qua remove() giữa chừng
   * (không nhả budget khi vẫn còn file đang upload).
   */
  const [pendingFiles, setPendingFiles] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  function publish(next: string[]): void {
    setUrls(next);
    // count báo lên parent = ảnh ĐÃ gắn + file đang upload (reservation) —
    // tổng đúng ngân sách đã CHI trong mọi khoảnh khắc.
    onCountChange?.(next.length + pendingFiles);
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (urls.length + files.length > max) {
      setError(`Vượt quá số ảnh cho phép (${max - urls.length} ảnh còn lại)`);
      return;
    }

    setUploading(true);
    // RESERVE budget NGAY khi pick (trước khi file đầu chạy upload) —
    // parent totalImages tăng ngay → slotBudget các picker KHÁC thu lại →
    // pick ở slot khác trong lúc upload không vượt cap toàn tin.
    setPendingFiles(files.length);
    onCountChange?.(urls.length + files.length);
    const uploaded: string[] = [];
    for (const file of files) {
      const json = await uploadFile(file);
      if (typeof json.url === "string" && json.url !== "") uploaded.push(json.url);
      else setError(uploadErrorText(json));
    }
    // xong TOÀN BỘ file → count THẬT (upload fail → nhả budget thừa)
    setPendingFiles(0);
    publish([...urls, ...uploaded]);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function remove(url: string) {
    publish(urls.filter((u) => u !== url));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {urls.map((url) => (
          <div key={url} className="group relative size-24 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-deep)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="size-full object-cover" />
            <button
              type="button"
              onClick={() => remove(url)}
              className="absolute inset-0 grid place-items-center bg-[var(--ink)]/60 opacity-0 transition group-hover:opacity-100"
            >
              <X className="size-5 text-[var(--red)]" />
            </button>
          </div>
        ))}

        {urls.length < max && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className={cn(
              "grid size-24 place-items-center gap-1 rounded-lg border-2 border-dashed border-[var(--line)] text-[var(--muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--accent)]",
              uploading && "opacity-50",
            )}
          >
            {uploading ? (
              <LoaderCircle className="size-5 animate-spin" />
            ) : (
              <>
                <ImagePlus className="size-5" />
                <span className="text-[10px] font-medium">Thêm ảnh</span>
              </>
            )}
          </button>
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
      {urls.map((u) => (
        <Fragment key={u}>
          <input type="hidden" name={name} value={u} />
          {slotName !== undefined && (
            <input type="hidden" name={slotName} value={slotValue ?? ""} />
          )}
        </Fragment>
      ))}
      {error && <p className="mt-2 text-xs text-[var(--red)]">{error}</p>}
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        {urls.length}/{max} ảnh · JPEG/PNG/WebP tối đa 5MB
      </p>
    </div>
  );
}
