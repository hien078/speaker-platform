import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { rateLimitRequest } from "@/src/lib/rate-limit";

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

  const body = (await request.json()) as { body?: string; imageUrl?: string };
  const text = (body.body ?? "").trim();
  if (!text && !body.imageUrl) {
    return Response.json({ error: "EMPTY" }, { status: 400 });
  }

  const message = await db.orm.public.Message.create({
    conversationId: id,
    senderId: user.id,
    body: text || "[hình ảnh]",
    imageUrl: body.imageUrl ?? null,
  });

  await db.orm.public.Conversation
    .where({ id })
    .update({ lastMessageAt: new Date().toISOString() });

  // notify người nhận (không phải người gửi)
  const recipientId = convo.sellerId === user.id ? convo.buyerId : convo.sellerId;
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
