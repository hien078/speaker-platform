import Link from "next/link";
import { db } from "@/src/prisma/db.client";
import { requireCapability, capabilitiesOf } from "@/src/lib/rbac";
import { formatDateShort, cn } from "@/src/lib/utils";
import { ROLE_LABELS } from "@/src/lib/constants";
import { setBetaMembershipAction } from "@/src/lib/actions/beta-cohort";
import { revokeAllUserSessionsAction } from "@/src/lib/actions/admin-identity";
import { suspendUserAction, liftSuspensionAction } from "@/src/lib/actions/moderation";
import { SUSPENSION_REASON_CODES, SUSPENSION_NOTE_MAX_LENGTH, type SuspensionReasonCode } from "@/src/lib/moderation-vocab";
import { Users, BadgeCheck, Search, History, Ban, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Người dùng" };

/**
 * PROVISIONAL (A8 — FD-3): nhãn lý do đình chỉ cho form select. Vocabulary
 * implementation thỏa yêu cầu "typed reasons" (spec §5.5) — GIÁ TRỊ không
 * spec-sourced; founder-acknowledged trước beta (Batch 8 register).
 * (SUSPENSION_REASON_LABELS canonical thuộc Task 6 — src/lib/constants.ts;
 * map cục bộ ở đây vì constants.ts do Task 4/6 sở hữu theo file-conflict rules.)
 */
const SUSPENSION_REASON_LABELS: Record<SuspensionReasonCode, string> = {
  confirmed_abuse: "Lạm dụng đã được xác nhận",
  confirmed_scam: "Lừa đảo đã được xác nhận",
  confirmed_harassment: "Quấy rối đã được xác nhận",
  confirmed_spam: "Spam đã được xác nhận",
  prohibited_content: "Đăng nội dung bị cấm",
  terms_violation: "Vi phạm điều khoản",
  other_reviewed_reason: "Lý do khác (đã review)",
};

/**
 * Batch 2 Task 10 (spec §8.2/§2.1/§8.4): cột "Xác minh" giờ là hiển thị
 * LEGACY (User.isVerifiedSeller — badge "legacy", KHÔNG còn nút mutate; workflow
 * SellerVerification là canonical). Thao tác trên từng user:
 *  - founding_seller membership grant/suspend (setBetaMembershipAction —
 *    beta_cohort.manage; nút lọc theo capability là CONVENIENCE, action tự guard);
 *  - link sang hàng đợi review /admin/seller-verification?q=<userId>;
 *  - thu hồi phiên (Task 9).
 *
 * Batch 3 Task 5 (spec §7.8 + §5.4.2): cột "Đình chỉ" — badge episode active +
 * form suspend (reason typed + note + mã TOTP step-up — A9 "destructive account
 * action") / lift (reason typed, KHÔNG step-up — hướng khôi phục). Render chỉ
 * khi viewer có capability `user.suspend` (super/ops — ma trận §5.4.1) — UI
 * CONVENIENCE; suspendUserAction/liftSuspensionAction tự requireCapability.
 */
export default async function AdminUsersPage({
  searchParams,
}: PageProps<"/admin/users">) {
  // Guard server-side (spec §4.5) — user.view_basic: super/ops (ma trận §5.4.1).
  const admin = await requireCapability("user.view_basic");
  // Nút lọc theo capability — CONVENIENCE (spec §4.5); action tự requireCapability.
  const canRevokeSessions = capabilitiesOf(admin.user.adminRole).includes("session.revoke");
  const canManageCohort = capabilitiesOf(admin.user.adminRole).includes("beta_cohort.manage");
  const canSuspend = capabilitiesOf(admin.user.adminRole).includes("user.suspend");
  const sp = (await searchParams) as { q?: string; role?: string };
  const q = sp.q?.trim() ?? "";
  type UserRole = "buyer" | "seller" | "admin";
  const role = sp.role && ROLE_LABELS[sp.role] ? (sp.role as UserRole) : undefined;

  let query = db.orm.public.User
    .select("id", "name", "email", "phone", "role", "city", "isVerifiedSeller", "createdAt")
    .orderBy((u) => u.createdAt.desc())
    .limit(100);

  if (role) query = query.where({ role });
  if (q) {
    // tìm theo tên hoặc email
    const like = `%${q}%`;
    query = query.where((u) => u.email.ilike(like));
    // tên riêng query thứ hai bên dưới
  }

  let users = await query.all();
  if (q) {
    const like = `%${q}%`;
    const byName = await db.orm.public.User
      .where((u) => u.name.ilike(like))
      .select("id", "name", "email", "phone", "role", "city", "isVerifiedSeller", "createdAt")
      .all();
    const seen = new Set(users.map((u) => u.id));
    users = [...users, ...byName.filter((u) => !seen.has(u.id))];
  }

  // đếm listing & đơn + founding_seller membership + suspension active của từng user
  // b4-holistic-2 (LOW): cột "Tin đăng" KHÔNG đếm draft (Batch 4 draft không
  // qua seller gate — applicant stack nháp thổi phồng count); draft đếm riêng
  // hiển thị kèm "(+M nháp)" — cùng tín hiệu như /admin/seller-verification.
  const enriched = await Promise.all(
    users.map(async (u) => {
      const [listings, drafts, orders, founding, suspension] = await Promise.all([
        db.orm.public.Listing.where({ sellerId: u.id }).where((l) => l.status.neq("draft")).aggregate((a) => ({ c: a.count() })),
        db.orm.public.Listing.where({ sellerId: u.id, status: "draft" }).aggregate((a) => ({ c: a.count() })),
        db.orm.public.Order
          .where({ sellerId: u.id })
          .where({ status: "completed" })
          .aggregate((a) => ({ c: a.count() })),
        db.orm.public.BetaCohortMembership.first({ userId: u.id, cohort: "founding_seller" }),
        // Batch 3 Task 5 (spec §7.8): episode đình chỉ active — badge + form lift
        db.orm.public.UserSuspension.first({ userId: u.id, status: "active" }),
      ]);
      return {
        ...u,
        listingCount: listings.c,
        draftCount: drafts.c,
        completedSales: orders.c,
        foundingStatus: founding?.status ?? null,
        activeSuspension: suspension === null ? null : {
          id: suspension.id,
          reasonCode: suspension.reasonCode,
          suspendedAt: suspension.suspendedAt,
        },
      };
    }),
  );

  return (
    <div>
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Users className="size-6 text-[var(--accent)]" />
        Người dùng
      </h1>

      {/* Bộ lọc */}
      <form action="/admin/users" className="mt-5 flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
          <input name="q" defaultValue={q} className="input pl-9 text-sm" placeholder="Tên hoặc email…" />
        </div>
        <select name="role" defaultValue={role ?? ""} className="input w-40 text-sm">
          <option value="">Tất cả vai trò</option>
          {Object.entries(ROLE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <button type="submit" className="btn-secondary px-4 text-sm">Lọc</button>
      </form>

      <div className="table-wrap mt-5">
        <table className="table-base">
          <thead>
            <tr>
              <th>Người dùng</th>
              <th>Vai trò</th>
              <th>Khu vực</th>
              <th>Tin đăng</th>
              <th>Đã bán</th>
              <th>Xác minh (legacy)</th>
              <th>founding_seller</th>
              <th>Đình chỉ</th>
              <th>Tham gia</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-10 text-center text-[var(--muted)]">Không tìm thấy người dùng</td>
              </tr>
            ) : (
              enriched.map((u) => (
                <tr key={u.id}>
                  <td>
                    <p className="text-sm font-semibold">{u.name}</p>
                    <p className="text-xs text-[var(--muted)]">{u.email}{u.phone ? ` · ${u.phone}` : ""}</p>
                  </td>
                  <td>
                    <span className={cn(
                      "badge",
                      u.role === "admin" ? "bg-[var(--red-soft)] text-[var(--red)]" :
                      u.role === "seller" ? "bg-[var(--accent-soft)] text-[var(--accent)]" :
                      "bg-[#eaf2fb] text-[#2563a8]",
                    )}>
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td className="text-xs text-[var(--ink-2)]">{u.city ?? "—"}</td>
                  <td className="text-sm">
                    {u.listingCount}
                    {/* b4-holistic-2: draft hiển thị kèm — KHÔNG đếm vào số chính */}
                    {u.draftCount > 0 && (
                      <span className="ml-1 text-[11px] text-[var(--muted)]">(+{u.draftCount} nháp)</span>
                    )}
                  </td>
                  <td className="text-sm">{u.completedSales}</td>
                  <td>
                    {u.isVerifiedSeller ? (
                      <span className="badge bg-[var(--green-soft)] text-[var(--green)]">
                        <BadgeCheck className="size-3" />
                        Đã xác minh
                        <span className="ml-1 rounded bg-black/10 px-1 text-[9px] uppercase">legacy</span>
                      </span>
                    ) : (
                      <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">Chưa</span>
                    )}
                  </td>
                  <td>
                    <span className={cn(
                      "badge",
                      u.foundingStatus === "active" ? "bg-[var(--green-soft)] text-[var(--green)]" :
                      u.foundingStatus ? "bg-amber-500/15 text-amber-600" :
                      "bg-[var(--paper-deep)] text-[var(--ink-2)]",
                    )}>
                      {u.foundingStatus ?? "—"}
                    </span>
                  </td>
                  <td>
                    {u.activeSuspension ? (
                      <span
                        className="badge bg-[var(--red-soft)] text-[var(--red)]"
                        title={`Đình chỉ từ ${formatDateShort(u.activeSuspension.suspendedAt)} — ${SUSPENSION_REASON_LABELS[u.activeSuspension.reasonCode as SuspensionReasonCode] ?? u.activeSuspension.reasonCode}`}
                      >
                        <Ban className="size-3" />
                        Đình chỉ
                      </span>
                    ) : (
                      <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDateShort(u.createdAt)}</td>
                  <td>
                    <div className="flex flex-col gap-1.5">
                      <Link
                        href={`/admin/seller-verification?q=${u.id}`}
                        className="btn-secondary flex h-8 items-center gap-1 px-3 text-xs"
                        title="Xem hồ sơ SellerVerification của người dùng này"
                      >
                        <History className="size-3.5" />
                        Hồ sơ xác minh
                      </Link>
                      {canManageCohort && (
                        <>
                          {u.foundingStatus !== "active" ? (
                            <form action={setBetaMembershipAction}>
                              <input type="hidden" name="userId" value={u.id} />
                              <input type="hidden" name="cohort" value="founding_seller" />
                              <input type="hidden" name="status" value="active" />
                              <button
                                type="submit"
                                className="btn h-8 bg-[var(--green)] px-3 text-xs text-white hover:opacity-90"
                                title="Cấp founding_seller active — điều kiện publication (spec §2.1)"
                              >
                                Cấp founding_seller
                              </button>
                            </form>
                          ) : (
                            <form action={setBetaMembershipAction}>
                              <input type="hidden" name="userId" value={u.id} />
                              <input type="hidden" name="cohort" value="founding_seller" />
                              <input type="hidden" name="status" value="suspended" />
                              <button
                                type="submit"
                                className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
                                title="Tạm dừng founding_seller — chặn publication NGAY (gate đọc FRESH)"
                              >
                                Tạm dừng
                              </button>
                            </form>
                          )}
                        </>
                      )}
                      {canRevokeSessions && (
                        <form action={revokeAllUserSessionsAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <button
                            type="submit"
                            className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
                            title="Đăng xuất mọi thiết bị của người dùng này (audit session.revoked_all)"
                          >
                            Thu hồi phiên
                          </button>
                        </form>
                      )}
                      {canSuspend && !u.activeSuspension && (
                        // Suspend — step-up (A9 spec §5.4.2 "destructive account
                        // action"): mã TOTP bắt buộc khi step-up stale; action
                        // tự requireCapabilityWithStepUp (UI chỉ CONVENIENCE).
                        <form action={suspendUserAction} className="flex flex-col gap-1">
                          <input type="hidden" name="userId" value={u.id} />
                          <select name="reasonCode" required className="input h-8 px-2 text-xs" aria-label="Lý do đình chỉ">
                            {SUSPENSION_REASON_CODES.map((code) => (
                              <option key={code} value={code}>{SUSPENSION_REASON_LABELS[code]}</option>
                            ))}
                          </select>
                          <input
                            name="note"
                            className="input h-8 px-2 text-xs"
                            placeholder="Ghi chú (tuỳ chọn — đã redact PII)"
                            maxLength={SUSPENSION_NOTE_MAX_LENGTH} // review fix Task 5 — action tự chặn server-side (typed error)
                          />
                          <input
                            name="totpCode"
                            className="input h-8 px-2 text-xs"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="Mã TOTP (step-up)"
                          />
                          <button
                            type="submit"
                            className="btn h-8 bg-[var(--red)] px-3 text-xs text-white hover:opacity-90"
                            title="Đình chỉ tài khoản — chặn publication + chat (spec §7.8); đòi step-up"
                          >
                            <Ban className="size-3.5" />
                            Đình chỉ
                          </button>
                        </form>
                      )}
                      {canSuspend && u.activeSuspension && (
                        // Lift — KHÔNG step-up (hướng khôi phục — recorded
                        // decision); action tự requireCapability("user.suspend").
                        <form action={liftSuspensionAction} className="flex flex-col gap-1">
                          <input type="hidden" name="suspensionId" value={u.activeSuspension.id} />
                          <select name="reasonCode" required className="input h-8 px-2 text-xs" aria-label="Lý do gỡ đình chỉ">
                            {SUSPENSION_REASON_CODES.map((code) => (
                              <option key={code} value={code}>{SUSPENSION_REASON_LABELS[code]}</option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="btn h-8 bg-[var(--green)] px-3 text-xs text-white hover:opacity-90"
                            title="Gỡ đình chỉ — mở lại publication + chat (spec §7.8)"
                          >
                            <ShieldCheck className="size-3.5" />
                            Gỡ đình chỉ
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
