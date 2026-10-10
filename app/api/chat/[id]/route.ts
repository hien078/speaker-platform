import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { rateLimitRequest, checkRateLimit, tooManyRequestsResponse } from "@/src/lib/rate-limit";
import { assertCanSendMessage, CHAT_SEND_RATE_LIMIT } from "@/src/lib/moderation";
import { recordBuyerFirstMessage, recordFirstResponse } from "@/src/lib/telemetry-recorders";
import { captureError } from "@/src/lib/observability";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { CHAT_MESSAGE_MAX_LENGTH } from "@/src/lib/deal-vocab";
import { LISTING_IMAGE_URL_PATTERN } from "@/src/lib/listing-images";

/**
 * GET /api/chat/[id]?after=<iso>
 * Lấy tin nhắn của hội thoại (polling mỗi ~3s từ client).
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/chat/[id]">,
) {
  // polling 3s/client ≈ 20 req/phút — cap 120/phút/IP (nhiều tab vẫn thoải mái)
  const limited = await rateLimitRequest(request, "chat:poll", {
    limit: 120,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const { id } = await ctx.params;
  const convo = await db.orm.public.Conversation.first({ id });
  if (!convo) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  if (convo.buyerId !== user.id && convo.sellerId !== user.id) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const url = new URL(request.url);
  void url.searchParams.get("after"); // client gửi `after` — hiện tại luôn trả full hội thoại

  const messages = await db.orm.public.Message
    .where({ conversationId: id })
    .include("sender", (s) => s.select("id", "name"))
    .orderBy((m) => m.createdAt.asc())
    .limit(200)
    .all();

  // đánh dấu đã đọc các tin của đối phương
  const unread = messages.filter((m) => m.senderId !== user.id && !m.readAt);
  if (unread.length > 0) {
    const now = new Date().toISOString();
    for (const m of unread) {
      await db.orm.public.Message.where({ id: m.id }).update({ readAt: now });
    }
  }

  return Response.json({
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.sender!.name,
      body: m.body,
      imageUrl: m.imageUrl,
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
  });
}

/** POST /api/chat/[id] — gửi tin nhắn */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/chat/[id]">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const { id } = await ctx.params;
  const convo = await db.orm.public.Conversation.first({ id });
  if (!convo) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  if (convo.buyerId !== user.id && convo.sellerId !== user.id) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  // Batch 3 Task 3 (spec §7.1 "chat" + §5.5/§7.8 actor-side) — send rate limit
  // per-user + block/suspension guard, sau participant check, trước
  // Message.create. GET KHÔNG đổi: lịch sử vẫn đọc được khi bị chặn (GET đã có
  // chat:poll limit).
  const recipientId = convo.sellerId === user.id ? convo.buyerId : convo.sellerId;
  const limited = checkRateLimit(`chat:send:${user.id}`, CHAT_SEND_RATE_LIMIT);
  if (!limited.allowed) return tooManyRequestsResponse(limited.retryAfterSec);
  try {
    await assertCanSendMessage(user.id, recipientId);
  } catch (e) {
    // CHỈ hai typed guard error → 403 với code cho client hiển thị banner.
    // Lỗi DB/infra khác PHẢI rethrow (Next trả 500, observability bắt) —
    // đúm bọc thành 403 vừa sai semantics vừa leak message nội bộ ra JSON.
    const message = e instanceof Error ? e.message : String(e);
    if (message !== "CHAT_BLOCKED" && message !== "ACCOUNT_SUSPENDED") throw e;
    return Response.json({ error: message }, { status: 403 });
  }

  // ─── Batch 6 Task 3 — body parse + caps (S4) + imageUrl validation (S3) ────
  // S4: JSON malformed → 400 INVALID_BODY (KHÔNG 500); type của mọi field do
  // client kiểm soát → 400 INVALID_BODY. KHÔNG tin kiểu từ JSON — client gọi
  // route trực tiếp được (action id public trong client bundle).
  let body: { body?: unknown; imageUrl?: unknown };
  try {
    body = (await request.json()) as { body?: unknown; imageUrl?: unknown };
  } catch {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  // JSON hợp lệ nhưng không phải object (null / mảng / số) → 400, không để body.body ném TypeError → 500
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (body.body !== undefined && typeof body.body !== "string") {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const text = String(body.body ?? "").trim();
  // Server-enforced message length (§7.1/§5.5 — client maxLength chỉ là UX)
  if (text.length > CHAT_MESSAGE_MAX_LENGTH) {
    return Response.json({ error: "MESSAGE_TOO_LONG" }, { status: 400 });
  }
  if (body.imageUrl !== undefined && typeof body.imageUrl !== "string") {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  // S3 (Batch 4 reuse — KHÔNG tự chế pattern mới): chỉ ảnh upload strict
  // /uploads/<uuid>.<ext> được gắn vào tin nhắn — chặn scheme (https:/
  // javascript:), traversal "..", và MỌI path ngoài /uploads (không có /img
  // allowance — ChatWindow không gửi imageUrl, không có upload legacy nào
  // trong chat). Pattern gate TRƯỚC lookup ownership nên tra theo basename
  // mà không khớp pattern KHÔNG bao giờ đi vào ownership read.
  let imageUrl: string | null = null;
  if (body.imageUrl !== undefined) {
    const raw = body.imageUrl as string;
    if (!LISTING_IMAGE_URL_PATTERN.test(raw)) {
      return Response.json({ error: "MESSAGE_IMAGE_INVALID" }, { status: 400 });
    }
    // Ownership (Batch 4 rule 1 — cross-account image theft): upload row theo
    // storageKey = basename(url) PHẢI tồn tại VÀ thuộc CHÍNH người gửi.
    const storageKey = raw.slice("/uploads/".length);
    const upload = await db.orm.public.ListingImageUpload.first({ storageKey });
    if (upload === null || upload.ownerUserId !== user.id) {
      return Response.json({ error: "MESSAGE_IMAGE_INVALID" }, { status: 400 });
    }
    imageUrl = raw;
  }
  if (!text && !imageUrl) {
    return Response.json({ error: "EMPTY" }, { status: 400 });
  }

  const message = await db.orm.public.Message.create({
    conversationId: id,
    senderId: user.id,
    body: text || "[hình ảnh]",
    imageUrl,
  });

  await db.orm.public.Conversation
    .where({ id })
    .update({ lastMessageAt: new Date().toISOString() });

  // ─── Telemetry (Batch 5 Task 8 — spec §5.8/D4) ─────────────────────────────
  // MỘT query thêm mỗi tin (beta scale — chấp nhận, plan Task 8 ghi chú): đọc
  // TOÀN BỘ tin của convo theo THỨ TỰ TOÀN PHẦN (createdAt asc, id asc
  // tie-break) và quyết "first" theo VỊ TRÍ — b5-review fix 3 (LOW, race):
  //  - buyer: tin mình là tin buyer ĐẦU (vị trí đầu) → conversation_buyer_first_message
  //    (tín hiệu eligibility D4 — seller_response_rate_v1);
  //  - seller: ≥1 tin buyer VÀ tin mình là tin seller ĐẦU → message_first_response
  //    (responseMs từ tin buyer ĐẦU — D4 anchor).
  // KHÔNG đếm "tin prior TRỪ tin mình" (cách cũ): hai tab gửi đồng thời (per-tab
  // `sending` flag không serialize qua tab) cùng chèn tin rồi cùng đọc — MỖI
  // request thấy tin của request kia là "prior" → CẢ HAI skip → event bị DROP
  // hoàn toàn (conversation rơi khỏi denominator D4). Quyết theo vị trí trong
  // thứ tự toàn phần: request của tin ĐẦU luôn thấy chính mình là đầu (insert
  // autocommit đơn câu, query chạy sau insert của chính mình); request kia thấy
  // tin đầu trong snapshot → skip → ĐÚNG MỘT request emit dưới MỌI interleaving.
  // Metric contracts (D4) đã dedup theo conversationId giữ occurredAt sớm nhất
  // — duplicate residual (không thể sinh từ path này) cũng không skew metric
  // (defense in depth — lựa chọn recorded theo hợp đồng metric). Fail-open:
  // lỗi telemetry KHÔNG phá gửi tin (recorder tự catch; query này được bọc
  // thêm — route vẫn trả 200).
  try {
    const convoMessages = await db.orm.public.Message
      .where({ conversationId: id })
      .orderBy([(m) => m.createdAt.asc(), (m) => m.id.asc()])
      .all();
    const buyerMessages = convoMessages.filter((m) => m.senderId === convo.buyerId);
    const sellerMessages = convoMessages.filter((m) => m.senderId === convo.sellerId);
    if (user.id === convo.buyerId) {
      const firstBuyer = buyerMessages[0];
      if (firstBuyer !== undefined && firstBuyer.id === message.id) {
        await recordBuyerFirstMessage({
          convo: { id: convo.id, listingId: convo.listingId },
          buyerId: convo.buyerId,
          firstBuyerMessageAt: message.createdAt,
        });
      }
    } else {
      const firstBuyer = buyerMessages[0];
      const firstSeller = sellerMessages[0];
      if (
        firstBuyer !== undefined &&
        firstSeller !== undefined &&
        firstSeller.id === message.id
      ) {
        await recordFirstResponse({
          convo: { id: convo.id, listingId: convo.listingId },
          sellerId: convo.sellerId,
          firstBuyerMessageAt: firstBuyer.createdAt,
          sellerRepliedAt: message.createdAt,
        });
      }
    }
  } catch (telemetryError) {
    // KHÔNG log error gốc (message db có thể chứa payload) — chỉ sqlState
    // (correction #17); gửi tin đã thành công, telemetry là best-effort.
    captureError("telemetry", "TELEMETRY_RECORDER_FAILED", {
      name: "chat_message_signals",
      sqlState: SqlQueryError.is(telemetryError) ? telemetryError.sqlState : undefined,
    });
  }

  // notify người nhận (không phải người gửi) — recipientId tính từ participant check phía trên
  const { notify } = await import("@/src/lib/notify");
  await notify(
    recipientId,
    "chat",
    `Tin nhắn mới từ ${user.name}`,
    (text || "[hình ảnh]").slice(0, 80),
    `/chat/${id}`,
  );

  return Response.json({ ok: true, id: message.id });
}
