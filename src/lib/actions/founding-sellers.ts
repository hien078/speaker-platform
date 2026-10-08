"use server";

import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { capabilitiesOf, requireCapability } from "@/src/lib/rbac";
import { getCurrentUser } from "@/src/lib/auth";
import { normalizeEmail, normalizePhone } from "@/src/lib/otp";
import { isUserSuspended } from "@/src/lib/moderation";
import { auditEvent, auditEventTx, redactDetail } from "@/src/lib/audit-event";
import { emitProductEvent } from "@/src/lib/product-events";
import { notify } from "@/src/lib/notify";
import { captureError } from "@/src/lib/observability";
import { checkRateLimit, clientIpFromHeaders } from "@/src/lib/rate-limit";
import { isProvinceCode } from "@/src/lib/provinces";
import {
  BETA_INVITE_ACCEPT_RATE,
  BETA_INVITE_COOKIE,
  BETA_INVITE_COOKIE_PATH,
  FOUNDING_SELLER_INVITE_RATE,
  FOUNDING_SELLER_INVITE_TTL_DAYS,
  FOUNDING_SELLER_NOTE_MAX_LENGTH,
  FOUNDING_SELLER_SOURCE_MAX_LENGTH,
  FOUNDING_SELLER_TRANSITION_REASONS,
  MANUALLY_SETTABLE_STATUSES,
  betaInviteTokenHash,
  canTransitionCandidate,
  findActiveInviteToken,
  syncFoundingSellerFunnel,
} from "@/src/lib/founding-sellers";

/**
 * Founding seller invitation + lifecycle actions (Batch 7 Task 3 + Task 4 —
 * spec §9 Batch 7 "invitation flow" + §5.10/§5.10.1 lifecycle, §2.1, §4.5/§4.9,
 * §4.6, §4.8, §4.11, §5.4/§5.4.2, §7.1, §7.3, §7.6, §8.4, §10.1, §12.1;
 * corrections 2026-10-08 items 9/10/12–15/20/21–23/25/26/29/34–36 + P1–P5).
 *
 * Audit action registry (Batch 7 — disjoint với mọi batch trước, spec §4.6;
 * corrections #29: src/lib/audit-event.ts KHÔNG đụng — registry ghi tại đây):
 *   founding_seller.candidate_created, founding_seller.invite_issued,
 *   founding_seller.invite_revoked, founding_seller.invite_accepted,
 *   founding_seller.status_changed, founding_seller.funnel_synced,
 *   founding_seller.operator_assigned, founding_seller.contact_recorded,
 *   founding_seller.notes_updated, founding_seller.quality_count_set.
 * resourceType theo quy ước model-name: "FoundingSellerCandidate" /
 * "BetaInviteToken" (cf. "BetaCohortMembership" — beta-cohort.ts).
 *
 * Authorization (spec §4.5/§4.9): mọi action console dùng
 * requireCapability("beta_cohort.manage") (Batch 2 matrix — super_admin +
 * operations_admin; moderator/support/analyst fail closed A2). KHÔNG
 * step-up — beta_cohort.manage KHÔNG nằm trong STEP_UP_CAPABILITIES và
 * §5.4.2 không nêu cohort (Global Constraints — thêm step-up = phát minh).
 * acceptInviteAction dùng getCurrentUser() (không phải requireUser() —
 * corrections #10: requireUser derive `next` từ Referer; ở đây next luôn
 * tokenless "/invite").
 *
 * Token secrecy (spec §4.8 + §5.3 posture; Review Focus 1): token thô
 * 256-bit chỉ tồn tại trong (a) URL /invite/<token> MỘT lần cho invitee
 * (browser history + nginx log — residual risk đã ghi nhận), (b) cookie
 * HttpOnly sp_invite 15 phút, (c) response state inviteUrl MỘT lần cho
 * operator. DB chỉ lưu HMAC (betaInviteTokenHash — corrections #12, helper
 * ở domain module founding-sellers.ts). KHÔNG BAO GIỜ token thô vào
 * log/audit/telemetry/notify ở bất kỳ môi trường nào.
 *
 * Transaction constraint-violation rule (Global Constraints — Batch 3/6):
 * violation (SQLSTATE 23505) LUÔN throw ra khỏi callback (Postgres abort tx —
 * catch bên trong rồi return là silent-success bug: COMMIT thành ROLLBACK,
 * token bị burn mà không có membership). Mọi write phụ thuộc status đã đọc
 * là COMPARE-AND-SET (updateAll where theo giá trị đọc); re-read guarded row
 * INSIDE tx; classify NGOÀI tx: SqlQueryError.is + sqlState + constraint
 * PREFIX (tên index render kèm hash suffix); rethrow mọi lỗi khác (fail
 * closed — corrections #10: mọi 23505 của accept map về INVITE_INVALID
 * byte-identical; chỉ INVITE_MEMBERSHIP_NOT_ACCEPTABLE / INVITE_CHANNEL_* /
 * INVITE_ACCOUNT_SUSPENDED / INVITE_SELF_ISSUED / RATE_LIMITED là distinct).
 *
 * Telemetry (T5/S7 — chỉ qua emitProductEvent của Batch 5, fail-open, SAU
 * commit; corrections #26: seller_invited/seller_registered/
 * beta_membership_activated là z.strictObject({}) — KHÔNG metadata; sessionId
 * THÔ từ SessionUser — emit core tự HMAC):
 *   - seller_invited (issuance): actorId null — prospect chưa có tài khoản.
 *   - seller_registered (acceptance): actor = user nhận lời mời.
 *   - beta_membership_activated (acceptance): CHỈ khi activated=true
 *     (transition sang active — B3; đường song song với
 *     recordBetaMembershipActivated của Batch 5 trên setBetaMembershipAction).
 *
 * Funnel sync (corrections #22): syncFoundingSellerFunnel chạy SAU tx đã
 * commit với global db (KHÔNG bao giờ trong callback / page render) — bắt
 * kịp verification/listing diễn ra TRƯỚC acceptance; sync không audit ở
 * đường này (founding_seller.funnel_synced thuộc Task 4 — action operator).
 */

/** Form state dùng chung các form useActionState của console (Task 5) + invite. */
export type FoundingSellerFormState = {
  /** Mã lỗi ổn định (client map sang tiếng Việt — không prose tự chế). */
  error?: string;
  success?: string;
  /** URL mời TUYỆT ĐỐI — render MỘT LẦN trong response state này, không persist. */
  inviteUrl?: string;
};

// ─── Validation (zod — schema sống trong action file, không export) ──────────

const contactChannelSchema = z.enum(["email", "phone"], {
  error: () => "Kênh liên hệ phải là email hoặc số điện thoại.",
});
const sourceSchema = z.string().trim().min(1, "Vui lòng ghi kênh tuyển nguồn.").max(
  FOUNDING_SELLER_SOURCE_MAX_LENGTH,
  "Kênh tuyển nguồn quá dài.",
);
const notesSchema = z.string().trim().max(FOUNDING_SELLER_NOTE_MAX_LENGTH, "Ghi chú quá dài.");
const targetCommunitySchema = z.string().trim().min(1, "Vui lòng chọn khu vực.").refine(isProvinceCode, {
  message: "INVALID_PROVINCE",
});

/** Chuẩn hóa contact theo kênh — throw của normalizePhone do caller bắt. */
function normalizeContact(channel: "email" | "phone", raw: string): string {
  return channel === "email" ? normalizeEmail(raw) : normalizePhone(raw);
}

/**
 * (P3 — corrections #20) Contact có phải của CHÍNH operator không — tự mời
 * chính mình là đường leo thang đặc quyền (SELF_GRANT_FORBIDDEN của Batch 2
 * trên đường invite). So trên User FRESH (không tin SessionUser — không có
 * phone/verified fields).
 */
async function contactIsOperator(
  operatorId: string,
  channel: "email" | "phone",
  contactReference: string,
): Promise<boolean> {
  const operator = await db.orm.public.User.first({ id: operatorId });
  if (operator === null) return false;
  if (channel === "email") {
    return operator.email !== null && normalizeEmail(operator.email) === contactReference;
  }
  if (operator.phone === null) return false;
  try {
    return normalizePhone(operator.phone) === contactReference;
  } catch {
    return false; // phone rác của operator — không block sai
  }
}

// ─── 1. Tạo ứng viên (prospect) ───────────────────────────────────────────────

/**
 * Tạo ứng viên founding seller (prospect) — contact ĐÃ chuẩn hóa
 * (normalizeEmail/normalizePhone của Batch 2) + kênh + nguồn + cộng đồng
 * mục tiêu (slug code tỉnh canonical FD-1 — isProvinceCode, không numeric).
 *
 * S7 duplicate pre-check (fail closed): MỘT ứng viên active-funnel (status ∉
 * {inactive, exited}) cho một (contactChannel, contactReference) — ops tìm
 * row cũ thay vì tạo hai ứng viên cho một người. Pre-check application-level
 * (không có unique index trên contact — cố ý: contact là PII, index hóa
 * là oracle); race tạo đôi được tolerate vì ops đọc console.
 *
 * Audit founding_seller.candidate_created trong CÙNG tx với create
 * (Global Constraints) — detail chỉ community code qua redactDetail,
 * KHÔNG contact (§4.8). Response KHÔNG trả về contact đã chuẩn hóa (PII) —
 * console render maskContact (Task 5).
 */
export async function createCandidateAction(
  _prev: FoundingSellerFormState,
  formData: FormData,
): Promise<FoundingSellerFormState> {
  const ctx = await requireCapability("beta_cohort.manage");

  const channelParsed = contactChannelSchema.safeParse(String(formData.get("contactChannel") ?? ""));
  if (!channelParsed.success) {
    return { error: "INVALID_CONTACT_CHANNEL" };
  }
  const channel = channelParsed.data;
  const sourceParsed = sourceSchema.safeParse(String(formData.get("source") ?? ""));
  if (!sourceParsed.success) return { error: "INVALID_SOURCE" };
  const communityParsed = targetCommunitySchema.safeParse(String(formData.get("targetCommunity") ?? ""));
  if (!communityParsed.success) return { error: "INVALID_PROVINCE" };
  const notesRaw = String(formData.get("notes") ?? "").trim();
  const notesParsed = notesSchema.safeParse(notesRaw);
  if (!notesParsed.success) return { error: "NOTE_TOO_LONG" };
  const notes = notesParsed.data === "" ? null : redactDetail(notesParsed.data);

  const contactRaw = String(formData.get("contactReference") ?? "");
  let contactReference: string;
  try {
    contactReference = normalizeContact(channel, contactRaw);
  } catch {
    return { error: "INVALID_PHONE_FORMAT" }; // normalizePhone throw — form error, không 500
  }

  // (P3) contact của chính operator → refuse (corrections #20)
  if (await contactIsOperator(ctx.user.id, channel, contactReference)) {
    return { error: "CANDIDATE_CONTACT_IS_OPERATOR" };
  }

  // S7 duplicate pre-check — ứng viên KHÁC cùng contact còn trong funnel
  const existing = await db.orm.public.FoundingSellerCandidate.where({
    contactChannel: channel,
    contactReference,
  }).all();
  if (existing.some((c) => c.status !== "inactive" && c.status !== "exited")) {
    return { error: "CANDIDATE_CONTACT_EXISTS" };
  }

  await db.transaction(async (tx) => {
    const candidate = await tx.orm.public.FoundingSellerCandidate.create({
      contactReference,
      contactChannel: channel,
      source: sourceParsed.data,
      targetCommunity: communityParsed.data,
      status: "prospect",
      qualityListingCount: 0,
      notes,
    });
    await auditEventTx(tx, {
      actorId: ctx.user.id,
      action: "founding_seller.candidate_created",
      resourceType: "FoundingSellerCandidate",
      resourceId: candidate.id,
      sessionId: ctx.session.id,
      // typed values — KHÔNG contact (§4.8)
      detail: redactDetail(`community:${communityParsed.data}`),
    });
  });

  revalidatePath("/admin/beta-cohort");
  return { success: "Đã tạo ứng viên." };
}

// ─── 2. Mời ứng viên (invite issuance) ───────────────────────────────────────

/**
 * Mời ứng viên: sinh token 256-bit, lưu HMAC, revoke token active cũ
 * (re-invite idempotent), CAS candidate → invited, audit trong cùng tx.
 * Token thô chỉ trả về MỘT lần trong inviteUrl (operator copy vào kênh
 * riêng của họ — §5.10.1 concierge delivery, FD-2: không có provider).
 *
 * corrections #9: (a) revoke bằng isNull() predicate (KHÔNG {col: null});
 * (b) create token; (c) CAS where({ id, status: <đọc trước tx> }) → 0 row =
 * CANDIDATE_ALREADY_MOVED (sentinel); (d) auditEventTx. Classify
 * beta_invite_one_active theo PREFIX NGOÀI tx → INVITE_ALREADY_ISSUED
 * (revoke cũ đã abort cùng tx — KHÔNG silent success); mọi lỗi khác
 * rethrow. Emit seller_invited SAU commit (actorId null — §4.8 KHÔNG contact).
 *
 * corrections #36: NEXT_PUBLIC_APP_URL thiếu → APP_URL_UNCONFIGURED TRƯỚC tx
 * (không issue token mà không có URL để render).
 */
export async function inviteCandidateAction(
  _prev: FoundingSellerFormState,
  formData: FormData,
): Promise<FoundingSellerFormState> {
  const ctx = await requireCapability("beta_cohort.manage");

  // §7.1 — 20 invite/giờ/admin (PROVISIONAL P5)
  const limited = checkRateLimit(`beta-invite:${ctx.user.id}`, FOUNDING_SELLER_INVITE_RATE);
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const candidateId = String(formData.get("candidateId") ?? "").trim();
  const candidate = await db.orm.public.FoundingSellerCandidate.first({ id: candidateId });
  if (candidate === null) return { error: "NOT_FOUND" };
  if (candidate.contactReference === null || candidate.contactChannel === null) {
    return { error: "CONTACT_REQUIRED" }; // prospect chưa có contact — tạo lại candidate
  }
  // Property narrowing KHÔNG sống qua closure (tsc) — bind non-null locals.
  const contactChannel = candidate.contactChannel;
  const contactReference = candidate.contactReference;
  // Invite chỉ cho pre-registration (PROVISIONAL reading — S9): đã registered
  // trở đi KHÔNG mời lại; re-entry là ops decision (A5).
  if (candidate.status !== "prospect" && candidate.status !== "invited") {
    return { error: "INVALID_STATE" };
  }

  // corrections #36 — check TRƯỚC tx: không URL thì không issue
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return { error: "APP_URL_UNCONFIGURED" };

  // (P3) contact của chính operator → refuse (corrections #20)
  if (await contactIsOperator(ctx.user.id, contactChannel, contactReference)) {
    return { error: "CANDIDATE_CONTACT_IS_OPERATOR" };
  }

  const token = randomBytes(32).toString("base64url"); // 256-bit, unguessable
  const tokenHash = betaInviteTokenHash(token);
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + FOUNDING_SELLER_INVITE_TTL_DAYS * 24 * 60 * 60_000,
  ).toISOString();

  try {
    await db.transaction(async (tx) => {
      // (a) revoke mọi token active của candidate — re-invite idempotent
      // (token đã consume/revoke được GIỮ làm audit trail).
      await tx.orm.public.BetaInviteToken.where({ candidateId: candidate.id })
        .where((t) => t.consumedAt.isNull())
        .where((t) => t.revokedAt.isNull())
        .updateAll({ revokedAt: nowIso });
      // (b) issue token mới — HMAC only (BetaInviteToken_tokenHash_key)
      const tokenRow = await tx.orm.public.BetaInviteToken.create({
        candidateId: candidate.id,
        channel: contactChannel,
        target: contactReference,
        tokenHash,
        issuedById: ctx.user.id,
        expiresAt,
      });
      // (c) CAS prospect/invited → invited (re-assert trạng thái đọc trước tx)
      const moved = await tx.orm.public.FoundingSellerCandidate.where({
        id: candidate.id,
        status: candidate.status,
      }).updateAll({ status: "invited", invitedAt: nowIso });
      if (moved.length === 0) throw new Error("CANDIDATE_ALREADY_MOVED");
      // (d) audit sống chết cùng tx
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        action: "founding_seller.invite_issued",
        resourceType: "BetaInviteToken",
        resourceId: tokenRow.id,
        sessionId: ctx.session.id,
        detail: redactDetail(`candidate:${candidate.id}`), // ids only — KHÔNG contact
      });
    });
  } catch (e) {
    if (
      SqlQueryError.is(e) &&
      e.sqlState === "23505" &&
      e.constraint != null &&
      e.constraint.startsWith("beta_invite_one_active")
    ) {
      // Concurrent re-invite: token active khác tồn tại — tx của mình abort
      // (revoke cũ KHÔNG persist), fail closed.
      return { error: "INVITE_ALREADY_ISSUED" };
    }
    if (e instanceof Error && e.message === "CANDIDATE_ALREADY_MOVED") {
      // Candidate di chuyển giữa read và CAS (accept/ops khác) — mời lại từ đầu
      return { error: "INVALID_STATE" };
    }
    throw e; // fail closed — KHÔNG masquerade lỗi infra thành form error
  }

  // Emit SAU commit — fail-open, actorId null (prospect chưa có tài khoản),
  // provinceCode only (§4.8 — KHÔNG contact trong event).
  await emitProductEvent({
    name: "seller_invited",
    actorId: null,
    provinceCode: candidate.targetCommunity,
  });

  revalidatePath("/admin/beta-cohort");
  // URL TUYỆT ĐỐI — raw token hiển thị MỘT LẦN trong state này; mất link →
  // revoke + mời lại. KHÔNG vào db (chỉ tokenHash)/audit/telemetry/log.
  return { success: "Đã tạo lời mời.", inviteUrl: `${appUrl}/invite/${token}` };
}

// ─── 3. Thu hồi lời mời ──────────────────────────────────────────────────────

/**
 * Thu hồi token active (atomic claim — isNull predicate, KHÔNG {col: null}).
 * Idempotent: token đã consume/revoke/không tồn tại → no-op THÀNH CÔNG,
 * không audit churn (chỉ audit khi có thay đổi thật). Token row KHÔNG BAO
 * GIỜ bị delete (audit trail sống qua revocation — Legacy Migration Decisions).
 */
export async function revokeInviteAction(formData: FormData): Promise<void> {
  const ctx = await requireCapability("beta_cohort.manage");
  const tokenId = String(formData.get("tokenId") ?? "").trim();
  if (!tokenId) throw new Error("INVALID_TOKEN_ID");

  const nowIso = new Date().toISOString();
  let revoked = false;
  await db.transaction(async (tx) => {
    const claimed = await tx.orm.public.BetaInviteToken.where({ id: tokenId })
      .where((t) => t.consumedAt.isNull())
      .where((t) => t.revokedAt.isNull())
      .updateAll({ revokedAt: nowIso });
    if (claimed.length === 0) return; // no-op idempotent — KHÔNG audit churn
    revoked = true;
    await auditEventTx(tx, {
      actorId: ctx.user.id,
      action: "founding_seller.invite_revoked",
      resourceType: "BetaInviteToken",
      resourceId: tokenId,
      sessionId: ctx.session.id,
      detail: redactDetail(`token:${tokenId}`), // id only — KHÔNG contact
    });
  });
  if (revoked) revalidatePath("/admin/beta-cohort");
}

// ─── 4. Nhận lời mời (acceptance) ────────────────────────────────────────────

/**
 * Nhận lời mời — ĐƯỜNG DUY NHẤT user nhận membership founding_seller (§8.4:
 * bên cạnh setBetaMembershipAction của Batch 2; KHÔNG auto-membership).
 *
 * Guard order CỐ ĐỊNH (corrections #10):
 *  1. getCurrentUser() — chưa đăng nhập → redirect /login?next=/invite
 *     (TOKENLESS — KHÔNG requireUser: nó derive next từ Referer) NGOÀI try.
 *  2. Rate limit per-user 10/10 phút (§7.1 "beta invite acceptance") + IP
 *     bucket CHỈ khi TRUST_PROXY_HEADERS=true (corrections #15 — không thì
 *     mọi invitee chung bucket "local").
 *  3. Cookie sp_invite → HMAC → lookup (S1: KHÔNG BAO GIỜ tin formData/
 *     next/query cho token; token trong form bị ignore). Mọi lý do token
 *     fail → INVITE_INVALID byte-identical (enumeration-safe).
 *  4. Self-issue refusal (P3): issuedById === user.id → INVITE_SELF_ISSUED
 *     TRƯỚC tx, KHÔNG consume.
 *  5. Channel binding (Review Focus 2): User FRESH (SessionUser không có
 *     phone/verified fields — S3) — email/phone MATCH + VERIFIED
 *     (emailVerifiedAt/phoneVerifiedAt) mới đủ; link lộ KHÔNG gắn membership
 *     vào tài khoản khác. normalizePhone throw/null → MISMATCH (corrections
 *     #14 — không bao giờ 500).
 *  6. isUserSuspended (Batch 3 DELEGATION — S10, §7.3) → INVITE_ACCOUNT_
 *     SUSPENDED, KHÔNG consume.
 *  7. db.transaction — re-read candidate + membership, refusal sentinels
 *     TRƯỚC claim (B3: suspended/exited membership + P4 expired-active →
 *     INVITE_MEMBERSHIP_NOT_ACCEPTABLE, token KHÔNG burn); ATOMIC CLAIM
 *     consumedAt với predicate ĐẦY ĐỦ (isNull consumed + isNull revoked +
 *     expiresAt > now — corrections #10: token revoked/expired giữa pre-read
 *     và tx KHÔNG bị consume); membership upsert theo @@unique(userId, cohort)
 *     (invited → active CAS; active → chỉ fill acceptedAt khi null —
 *     KHÔNG duplicate row, KHÔNG hạ status); candidate link CAS
 *     where({ id, status: invited }).where(userId.isNull()); auditEventTx.
 *  8. Classify NGOÀI tx: sentinels + MỌI 23505 → INVITE_INVALID byte-identical
 *     (corrections #10); chỉ INVITE_MEMBERSHIP_NOT_ACCEPTABLE /
 *     INVITE_CHANNEL_* / INVITE_ACCOUNT_SUSPENDED / INVITE_SELF_ISSUED /
 *     RATE_LIMITED là distinct; mọi lỗi khác rethrow (fail closed).
 *  9. SAU commit: xóa cookie sp_invite → syncFoundingSellerFunnel (global db —
 *     corrections #22) → emit (beta_membership_activated CHỈ khi activated;
 *     seller_registered luôn) → notify (best-effort — corrections #25) →
 *     redirect /sell NGOÀI catch block.
 */
export async function acceptInviteAction(
  _prev: FoundingSellerFormState,
  _formData: FormData, // S1 — token KHÔNG bao giờ đọc từ form (chỉ cookie); param giữ chữ ký useActionState
): Promise<FoundingSellerFormState> {
  // 1. Session — getCurrentUser (KHÔNG requireUser — corrections #10)
  const user = await getCurrentUser();
  if (user === null) {
    redirect("/login?next=/invite"); // throw NEXT_REDIRECT — NGOÀI mọi try
  }

  // 2. Rate limit (§7.1) — per-user bucket luôn; IP bucket chỉ sau proxy tin cậy
  const limited = checkRateLimit(`beta-invite-accept:${user.id}`, BETA_INVITE_ACCEPT_RATE);
  if (!limited.allowed) return { error: "RATE_LIMITED" };
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const ip = clientIpFromHeaders(await headers());
    const ipLimited = checkRateLimit(`beta-invite-accept:ip:${ip}`, BETA_INVITE_ACCEPT_RATE);
    if (!ipLimited.allowed) return { error: "RATE_LIMITED" };
  }

  // 3. Token từ cookie (S1) — KHÔNG bao giờ đọc formData cho token
  const token = (await cookies()).get(BETA_INVITE_COOKIE)?.value ?? null;
  if (token === null) return { error: "INVITE_INVALID" };
  const row = await findActiveInviteToken(token);
  if (row === null) return { error: "INVITE_INVALID" }; // unknown/expired/revoked/consumed — byte-identical

  // 4. Self-issue refusal (P3) — trước tx, không consume
  if (row.issuedById !== null && row.issuedById === user.id) {
    return { error: "INVITE_SELF_ISSUED" };
  }

  // 5. Channel binding — User FRESH (S3: SessionUser không có phone/verified)
  const fresh = await db.orm.public.User.first({ id: user.id });
  if (fresh === null) return { error: "INVITE_INVALID" }; // integrity anomaly — fail closed
  if (row.channel === "email") {
    if (normalizeEmail(fresh.email) !== row.target) return { error: "INVITE_CHANNEL_MISMATCH" };
    if (fresh.emailVerifiedAt === null) return { error: "INVITE_CHANNEL_UNVERIFIED" };
  } else {
    let phone: string;
    try {
      phone = normalizePhone(fresh.phone ?? "");
    } catch {
      return { error: "INVITE_CHANNEL_MISMATCH" }; // corrections #14 — không 500
    }
    if (phone !== row.target) return { error: "INVITE_CHANNEL_MISMATCH" };
    if (fresh.phoneVerifiedAt === null) return { error: "INVITE_CHANNEL_UNVERIFIED" };
  }

  // 6. Suspension — Batch 3 delegation (S10, §7.3)
  if (await isUserSuspended(user.id)) return { error: "INVITE_ACCOUNT_SUSPENDED" };

  // 7. Transaction — sentinels throw ra khỏi callback; classify NGOÀI (Global Constraints)
  const nowIso = new Date().toISOString();
  let activated = false;
  try {
    activated = await db.transaction(async (tx) => {
      // (a) RE-READ candidate INSIDE tx — không tin row đọc trước tx
      const candidate = await tx.orm.public.FoundingSellerCandidate.first({
        id: row.candidateId,
      });
      if (candidate === null) throw new Error("INVITE_INVALID"); // sentinel → byte-identical
      if (candidate.userId !== null && candidate.userId !== user.id) {
        throw new Error("INVITE_LINKED_ELSEWHERE"); // token của ứng viên đã link người khác
      }
      if (candidate.status !== "invited") {
        throw new Error("INVITE_NOT_INVITED"); // inactive/exited/registered — re-entry là ops decision (A5)
      }

      // (b) RE-READ membership INSIDE tx — refusal TRƯỚC claim (B3)
      const membership = await tx.orm.public.BetaCohortMembership.first({
        userId: user.id,
        cohort: "founding_seller",
      });
      if (membership !== null) {
        if (membership.status === "suspended" || membership.status === "exited") {
          // (B3) từ chối TRƯỚC claim — token KHÔNG burn; ops quyết qua
          // /admin/users (Batch 2 action) — acceptance không tự re-activate.
          throw new Error("INVITE_MEMBERSHIP_NOT_ACCEPTABLE");
        }
        if (
          membership.status === "active" &&
          membership.expiresAt !== null &&
          Date.parse(membership.expiresAt) <= Date.now()
        ) {
          // P4 — membership active đã hết hạn: refuse như suspended/exited;
          // acceptance KHÔNG bao giờ clear expiresAt.
          throw new Error("INVITE_MEMBERSHIP_NOT_ACCEPTABLE");
        }
      }

      // (c) ATOMIC CLAIM — predicate ĐẦY ĐỦ (corrections #10): token revoked/
      // expired giữa pre-read và tx KHÔNG bị consume; 0 row = concurrent
      // double-accept → sentinel (tx abort — KHÔNG silent success).
      const claimed = await tx.orm.public.BetaInviteToken.where({ id: row.id })
        .where((t) => t.consumedAt.isNull())
        .where((t) => t.revokedAt.isNull())
        .where((t) => t.expiresAt.gt(nowIso))
        .updateAll({ consumedAt: nowIso });
      if (claimed.length === 0) throw new Error("INVITE_CONSUMED_RACE");

      // (d) Membership upsert theo @@unique(userId, cohort) — SAU claim (B3)
      if (membership === null) {
        await tx.orm.public.BetaCohortMembership.create({
          userId: user.id,
          cohort: "founding_seller",
          status: "active",
          invitedBy: row.issuedById, // provenance issuer
          invitedAt: row.createdAt, // mời từ lúc issue token
          acceptedAt: nowIso,
        });
        activated = true;
      } else if (membership.status === "invited") {
        const moved = await tx.orm.public.BetaCohortMembership.where({
          id: membership.id,
          status: "invited",
        }).updateAll({ status: "active", acceptedAt: nowIso });
        if (moved.length === 0) throw new Error("INVITE_INVALID"); // concurrent grant — fail closed
        activated = true;
      } else {
        // status === "active" (admin-granted, Batch 2) — KHÔNG duplicate row,
        // KHÔNG hạ status, KHÔNG re-emit; chỉ fill acceptedAt khi còn null.
        if (membership.acceptedAt === null) {
          await tx.orm.public.BetaCohortMembership.where({ id: membership.id })
            .where((m) => m.acceptedAt.isNull())
            .updateAll({ acceptedAt: nowIso });
        }
        activated = false;
      }

      // (e) Candidate link — CAS theo status đọc INSIDE tx + userId còn null
      const linked = await tx.orm.public.FoundingSellerCandidate.where({
        id: candidate.id,
        status: "invited",
      })
        .where((c) => c.userId.isNull())
        .updateAll({ userId: user.id, registeredAt: nowIso, status: "registered" });
      if (linked.length === 0) throw new Error("INVITE_LINKED_ELSEWHERE");

      // (f) Audit sống chết cùng tx (Global Constraints)
      await auditEventTx(tx, {
        actorId: user.id,
        subjectId: user.id,
        action: "founding_seller.invite_accepted",
        resourceType: "BetaInviteToken",
        resourceId: row.id,
        sessionId: user.sessionId,
        detail: redactDetail(`candidate:${candidate.id}`), // ids only — KHÔNG contact
      });
      return activated;
    });
  } catch (e) {
    // 8. Classify NGOÀI tx (Global Constraints — KHÔNG bao giờ trong callback)
    if (e instanceof Error) {
      switch (e.message) {
        case "INVITE_CONSUMED_RACE":
        case "INVITE_LINKED_ELSEWHERE":
        case "INVITE_NOT_INVITED":
        case "INVITE_INVALID":
          return { error: "INVITE_INVALID" }; // byte-identical — enumeration-safe
        case "INVITE_MEMBERSHIP_NOT_ACCEPTABLE":
          return { error: "INVITE_MEMBERSHIP_NOT_ACCEPTABLE" }; // distinct — ops cần biết
      }
    }
    if (SqlQueryError.is(e) && e.sqlState === "23505") {
      // beta_invite_one_active / FoundingSellerCandidate_userId_key /
      // BetaCohortMembership_userId_cohort_key / BetaInviteToken_tokenHash_key
      // — concurrent race; tx đã abort (KHÔNG silent success); corrections #10:
      // MỌI 23505 → INVITE_INVALID byte-identical.
      return { error: "INVITE_INVALID" };
    }
    throw e; // fail closed — KHÔNG map mù lỗi infra thành form error
  }

  // 9. SAU commit — cookie clear + funnel sync (global db — corrections #22)
  //    + emission (fail-open) + notify (best-effort) + redirect NGOÀI catch.
  //    Delete với CÙNG path cookie được set (corrections #35): delete(name)
  //    mặc định Path=/ — RFC 6265 coi đó là cookie khác, không clear được
  //    cookie Path=/invite do route handler set.
  (await cookies()).delete({ name: BETA_INVITE_COOKIE, path: BETA_INVITE_COOKIE_PATH });

  // Funnel sync — CHỈ với global db sau tx commit (corrections #22); bắt kịp
  // verification/listing diễn ra TRƯỜC acceptance; idempotent, chỉ tiến.
  // FAIL-OPEN (fix sau review Task 3): acceptance ĐÃ commit — một lỗi db
  // transient trên read/sync post-commit KHÔNG được biến thành error page
  // (retry lúc đó INVITE_INVALID vì token đã burn — user có membership mà
  // tưởng là fail). captureError MÃ CHUỖI (KHÔNG error object — §4.8),
  // candidateAfter = null (provinceCode emission = null), telemetry + notify
  // + redirect tiếp tục. syncCandidateFunnelAction (Task 4) là đường catch-up
  // cho operator.
  let candidateAfter: { targetCommunity: string } | null = null;
  try {
    const candidateRow = await db.orm.public.FoundingSellerCandidate.first({
      userId: user.id,
    });
    if (candidateRow !== null) {
      await syncFoundingSellerFunnel(user.id);
      candidateAfter = candidateRow;
    }
  } catch (e) {
    captureError("cohort", "COHORT_FUNNEL_SYNC_FAILED", {
      sqlState: SqlQueryError.is(e) ? e.sqlState : undefined,
    });
    candidateAfter = null;
  }

  // Telemetry (T5/S7 — corrections #26): sessionId THÔ — emit core tự HMAC.
  if (activated) {
    await emitProductEvent({
      name: "beta_membership_activated",
      actorId: user.id,
      sessionId: user.sessionId,
      provinceCode: candidateAfter?.targetCommunity ?? null,
    });
  }
  await emitProductEvent({
    name: "seller_registered",
    actorId: user.id,
    sessionId: user.sessionId,
    provinceCode: candidateAfter?.targetCommunity ?? null,
  });

  // Notify in-app — kind "cohort" (typed free string; các kind hiện có là
  // order/offer/dispute/withdraw/listing/counter — KHÔNG dùng "moderation");
  // copy trung tính, KHÔNG incentive/cam kết kết quả (§4.2/§4.11). Best-effort
  // (corrections #25): notify throw trên lỗi db → captureError MÃ CHUỖI
  // (KHÔNG error object — §4.8), acceptance đã commit thì KHÔNG thành 500.
  try {
    await notify(
      user.id,
      "cohort",
      "Chào mừng founding seller",
      "Bạn đã nhận tư cách thành viên founding seller của LoaViet trong giai đoạn beta riêng.",
      "/sell",
    );
  } catch (notifyError) {
    captureError("cohort", "COHORT_NOTIFY_FAILED", {
      sqlState: SqlQueryError.is(notifyError) ? notifyError.sqlState : undefined,
    });
  }

  redirect("/sell"); // throw NEXT_REDIRECT — NGOÀI mọi try/catch
}

// ─── 5. Funnel sync — hành động operator (Task 4 — S5, corrections #22) ───────

/**
 * Sync trạng thái funnel của MỘT ứng viên từ ground truth — ĐƯỜNG DUY NHẤT
 * operator chạy sync (S5: console page KHÔNG sync trong render; đường còn
 * lại là acceptInviteAction sau link — tự động, không audit).
 *
 * corrections #22: sync chạy với global db SAU (không có) tx — KHÔNG BAO GIỜ
 * trong tx callback / page render. Sync unchanged (ground truth không cho
 * tiến) → KHÔNG audit (no churn); unlinked (prospect chưa có tài khoản) →
 * no-op. Audit founding_seller.funnel_synced chỉ khi có transition thật,
 * detail from→to — codes only, KHÔNG PII (§4.8).
 */
export async function syncCandidateFunnelAction(formData: FormData): Promise<void> {
  const ctx = await requireCapability("beta_cohort.manage");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) throw new Error("INVALID_CANDIDATE_ID");

  const candidate = await db.orm.public.FoundingSellerCandidate.first({ id: candidateId });
  if (candidate === null) throw new Error("NOT_FOUND");
  if (candidate.userId === null) return; // prospect chưa link — sync không có gì để đọc

  const sync = await syncFoundingSellerFunnel(candidate.userId);
  if (sync !== null && sync.changed) {
    await auditEvent({
      actorId: ctx.user.id,
      action: "founding_seller.funnel_synced",
      resourceType: "FoundingSellerCandidate",
      resourceId: candidate.id,
      sessionId: ctx.session.id,
      detail: redactDetail(`${sync.from}→${sync.to}`), // codes only — KHÔNG PII
    });
  }
  revalidatePath("/admin/beta-cohort");
}

// ─── 6. Manual transitions (Task 4 — spec §5.10, PROVISIONAL FD-3) ───────────

/**
 * Chuyển trạng thái thủ công (concierge_onboarding / active_founding_seller /
 * inactive / exited — MANUALLY_SETTABLE_STATUSES). Còn lại
 * (prospect/invited/registered/verification_pending/verified/first_listing)
 * thuộc invite flow (Task 3) + funnel sync — operator KHÔNG tự set (fail
 * closed chống fake funnel; PROVISIONAL set — S9/Batch 8 register).
 *
 * KHÔNG step-up — beta_cohort.manage KHÔNG thuộc STEP_UP_CAPABILITIES và
 * §5.4.2 không nêu cohort (Global Constraints — thêm step-up = phát minh).
 *
 * corrections #23: mọi write là conditional updateAll — CAS
 * where({ id, status: <đọc> }) → 0 row = CANDIDATE_ALREADY_MOVED (concurrent
 * operator — §10.1); KHÔNG set updatedAt bằng tay (temporal.updatedAtString()
 * tự maintain); note chuyển trạng thái đi CHỌ vào AuditEvent.detail qua
 * redactDetail — KHÔNG append vào candidate.notes (read-modify-write mất
 * note concurrent; notes chỉ được viết bởi updateCandidateNotesAction).
 * toStatus === active_founding_seller KHÔNG tự set qualityListingCount (A3 —
 * count là ops input riêng sau §12.1 manual sampling).
 */
export async function updateCandidateStatusAction(formData: FormData): Promise<void> {
  const ctx = await requireCapability("beta_cohort.manage");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) throw new Error("INVALID_CANDIDATE_ID");

  // Validation TRƯỚC read (plan order) — typed codes, KHÔNG free text
  const toStatusRaw = String(formData.get("toStatus") ?? "").trim();
  const toStatus = MANUALLY_SETTABLE_STATUSES.find((s) => s === toStatusRaw);
  if (toStatus === undefined) throw new Error("STATUS_NOT_MANUALLY_SETTABLE");
  const reasonRaw = String(formData.get("reasonCode") ?? "").trim();
  const reasonCode = FOUNDING_SELLER_TRANSITION_REASONS.find((r) => r === reasonRaw);
  if (reasonCode === undefined) throw new Error("INVALID_REASON_CODE");
  const noteRaw = String(formData.get("note") ?? "").trim();
  const noteParsed = notesSchema.safeParse(noteRaw);
  if (!noteParsed.success) throw new Error("NOTE_TOO_LONG");
  const note = noteParsed.data === "" ? null : redactDetail(noteParsed.data);

  const candidate = await db.orm.public.FoundingSellerCandidate.first({ id: candidateId });
  if (candidate === null) throw new Error("NOT_FOUND");

  // Bảng transition hợp pháp (PROVISIONAL FD-3) — chỉ chi phối MANUAL moves
  // (funnel sync EXEMPT — xem src/lib/founding-sellers.ts).
  if (!canTransitionCandidate(candidate.status, toStatus)) throw new Error("INVALID_TRANSITION");

  // ATOMIC CLAIM — CAS theo status đã đọc; 0 row = operator khác đã move.
  const moved = await db.orm.public.FoundingSellerCandidate.where({
    id: candidate.id,
    status: candidate.status,
  }).updateAll({ status: toStatus });
  if (moved.length === 0) throw new Error("CANDIDATE_ALREADY_MOVED");

  const transition = redactDetail(`${candidate.status}→${toStatus}`);
  await auditEvent({
    actorId: ctx.user.id,
    action: "founding_seller.status_changed",
    resourceType: "FoundingSellerCandidate",
    resourceId: candidate.id,
    sessionId: ctx.session.id,
    reason: reasonCode, // typed reason code — không prose tự chế
    detail: note === null ? transition : `${transition} note:${note}`,
  });
  revalidatePath("/admin/beta-cohort");
}

// ─── 7. Operator assignment (Task 4 — corrections #23) ─────────────────────────

/**
 * Gán/gỡ operator phụ trách ứng viên. Eligibility: adminRole của operator
 * PHẢI có beta_cohort.manage (capabilitiesOf — Batch 3 assign precedent:
 * analyst làm operator → ASSIGNEE_NOT_ELIGIBLE). operatorId rỗng = unassign
 * (null) — cũng được audit (corrections #23). Conditional updateAll
 * where({ id }) → 0 row = NOT_FOUND.
 */
export async function assignCandidateOperatorAction(formData: FormData): Promise<void> {
  const ctx = await requireCapability("beta_cohort.manage");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) throw new Error("INVALID_CANDIDATE_ID");
  const operatorIdRaw = String(formData.get("operatorId") ?? "").trim();
  const operatorId = operatorIdRaw === "" ? null : operatorIdRaw;

  if (operatorId !== null) {
    const operator = await db.orm.public.User.first({ id: operatorId });
    if (
      operator === null ||
      !capabilitiesOf(operator.adminRole).includes("beta_cohort.manage")
    ) {
      throw new Error("ASSIGNEE_NOT_ELIGIBLE");
    }
  }

  const moved = await db.orm.public.FoundingSellerCandidate.where({ id: candidateId }).updateAll({
    assignedOperatorId: operatorId,
  });
  if (moved.length === 0) throw new Error("NOT_FOUND");

  await auditEvent({
    actorId: ctx.user.id,
    action: "founding_seller.operator_assigned",
    resourceType: "FoundingSellerCandidate",
    resourceId: candidateId,
    sessionId: ctx.session.id,
    detail: redactDetail(`operator:${operatorId ?? "unassigned"}`), // ids only — KHÔNG PII
  });
  revalidatePath("/admin/beta-cohort");
}

// ─── 8. Contact tracking (Task 4 — §5.10 "last seller activity") ──────────────

/**
 * Ghi nhận đã liên hệ ứng viên (lastContactAt = now — input cho heuristic
 * "seller needing assistance" D2). Note ops đi CHỌ vào AuditEvent.detail qua
 * redactDetail (§4.8 — KHÔNG raw email/phone); KHÔNG đụng candidate.notes
 * (corrections #23). Conditional updateAll where({ id }) → 0 row = NOT_FOUND.
 */
export async function recordCandidateContactAction(formData: FormData): Promise<void> {
  const ctx = await requireCapability("beta_cohort.manage");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) throw new Error("INVALID_CANDIDATE_ID");
  const noteRaw = String(formData.get("note") ?? "").trim();
  const noteParsed = notesSchema.safeParse(noteRaw);
  if (!noteParsed.success) throw new Error("NOTE_TOO_LONG");
  const note = noteParsed.data === "" ? null : redactDetail(noteParsed.data);

  const nowIso = new Date().toISOString();
  const moved = await db.orm.public.FoundingSellerCandidate.where({ id: candidateId }).updateAll({
    lastContactAt: nowIso,
  });
  if (moved.length === 0) throw new Error("NOT_FOUND");

  const base = redactDetail(`candidate:${candidateId}`);
  await auditEvent({
    actorId: ctx.user.id,
    action: "founding_seller.contact_recorded",
    resourceType: "FoundingSellerCandidate",
    resourceId: candidateId,
    sessionId: ctx.session.id,
    detail: note === null ? base : `${base} note:${note}`,
  });
  revalidatePath("/admin/beta-cohort");
}

// ─── 9. Notes (Task 4 — useActionState form của console Task 5) ──────────────

/**
 * Ghi đè ghi chú ops trên ứng viên — writer DUY NHẤT của candidate.notes
 * (corrections #23). Free text untrusted: cap FOUNDING_SELLER_NOTE_MAX_LENGTH
 * + redactDetail TRƯỚC khi lưu (§4.8 — belt-and-braces); console render React
 * text only (KHÔNG dangerouslySetInnerHTML). Audit detail = ids only —
 * KHÔNG note content. Conditional updateAll where({ id }) → 0 row = NOT_FOUND
 * (form error — không throw: form useActionState render inline).
 */
export async function updateCandidateNotesAction(
  _prev: FoundingSellerFormState,
  formData: FormData,
): Promise<FoundingSellerFormState> {
  const ctx = await requireCapability("beta_cohort.manage");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) return { error: "INVALID_CANDIDATE_ID" };
  const notesRaw = String(formData.get("notes") ?? "").trim();
  const notesParsed = notesSchema.safeParse(notesRaw);
  if (!notesParsed.success) return { error: "NOTE_TOO_LONG" };
  const notes = notesParsed.data === "" ? null : redactDetail(notesParsed.data);

  const moved = await db.orm.public.FoundingSellerCandidate.where({ id: candidateId }).updateAll({
    notes,
  });
  if (moved.length === 0) return { error: "NOT_FOUND" };

  await auditEvent({
    actorId: ctx.user.id,
    action: "founding_seller.notes_updated",
    resourceType: "FoundingSellerCandidate",
    resourceId: candidateId,
    sessionId: ctx.session.id,
    detail: redactDetail(`candidate:${candidateId}`), // ids only — KHÔNG note content
  });
  revalidatePath("/admin/beta-cohort");
  return { success: "Đã lưu ghi chú." };
}

// ─── 10. Quality listing count (Task 4 — A3, §12.1 manual sampling) ───────────

/**
 * Set đếm listing "quality" của seller — GIÁ TRỊ OPS đặt thủ công sau §12.1
 * manual sampling; hệ thống KHÔNG BAO GIỜ auto-compute (A3: không có định
 * nghĩa "quality listing" — Batch 4 A1/A2 founder-gated, Batch 5 A5 đã ghi
 * nhận; source-contract pin: writer duy nhất của trường này). count int ≥ 0
 * (zod — pattern deals.ts); conditional updateAll where({ id }) → 0 row =
 * NOT_FOUND. Audit detail ids + count — KHÔNG PII.
 */
export async function updateQualityListingCountAction(formData: FormData): Promise<void> {
  const ctx = await requireCapability("beta_cohort.manage");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) throw new Error("INVALID_CANDIDATE_ID");
  const countRaw = String(formData.get("count") ?? "").trim();
  if (countRaw === "") throw new Error("INVALID_COUNT");
  const countParsed = z.number().int().min(0).safeParse(Number(countRaw));
  if (!countParsed.success) throw new Error("INVALID_COUNT");

  const moved = await db.orm.public.FoundingSellerCandidate.where({ id: candidateId }).updateAll({
    qualityListingCount: countParsed.data,
  });
  if (moved.length === 0) throw new Error("NOT_FOUND");

  await auditEvent({
    actorId: ctx.user.id,
    action: "founding_seller.quality_count_set",
    resourceType: "FoundingSellerCandidate",
    resourceId: candidateId,
    sessionId: ctx.session.id,
    detail: redactDetail(`candidate:${candidateId} count:${countParsed.data}`),
  });
  revalidatePath("/admin/beta-cohort");
}
