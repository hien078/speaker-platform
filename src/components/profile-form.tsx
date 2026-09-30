"use client";

import { useActionState } from "react";
import { updateProfileAction, type ProfileFormState } from "@/src/lib/actions/profile";
import { CITIES } from "@/src/lib/constants";
import { LoaderCircle, CheckCircle2 } from "lucide-react";

export function ProfileForm({
  defaults,
}: {
  defaults: { name: string; phone: string; city: string; bio: string };
}) {
  const [state, formAction, pending] = useActionState<ProfileFormState, FormData>(
    updateProfileAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="name">Họ và tên</label>
        <input id="name" name="name" className="input" defaultValue={defaults.name} required />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="phone">Số điện thoại</label>
          <input id="phone" name="phone" className="input" defaultValue={defaults.phone} placeholder="090xxxxxxx" />
        </div>
        <div>
          <label className="label" htmlFor="city">Khu vực</label>
          <select id="city" name="city" className="input" defaultValue={defaults.city}>
            <option value="">— Chọn khu vực —</option>
            {CITIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="bio">Giới thiệu</label>
        <textarea
          id="bio"
          name="bio"
          rows={3}
          className="input resize-none"
          defaultValue={defaults.bio}
          placeholder="VD: Chuyên loa sự kiện 10 năm, uy tín đặt lên hàng đầu…"
        />
      </div>

      {state.error && (
        <p className="rounded-lg border border-[var(--red)]/35 bg-[var(--red-soft)] px-3.5 py-2.5 text-sm text-[var(--red)]">
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="flex items-center gap-2 rounded-lg border border-[var(--green)]/35 bg-[var(--green-soft)] px-3.5 py-2.5 text-sm text-[var(--green)]">
          <CheckCircle2 className="size-4" />
          Đã lưu thông tin cá nhân
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Lưu thay đổi
      </button>
    </form>
  );
}
