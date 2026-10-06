"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { cn, timeAgo } from "@/src/lib/utils";
import { ReportDialog } from "@/src/components/report-dialog";
import { Send, LoaderCircle, CheckCheck } from "lucide-react";

type Message = {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  imageUrl: string | null;
  createdAt: string;
  readAt: string | null;
};

export function ChatWindow({
  conversationId,
  myUserId,
  disabled = false,
}: {
  conversationId: string;
  myUserId: string;
  /** Composer tắt (block/đình chỉ — Batch 3 Task 3). UI-only: route POST là boundary. */
  disabled?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/${conversationId}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { messages: Message[] };
      setMessages(json.messages);
    } catch {
      /* offline — thử lại ở lần poll sau */
    }
  }, [conversationId]);

  useEffect(() => {
    // tránh setState đồng bộ trong effect — đẩy lần poll đầu vào microtask
    const t = setTimeout(poll, 50);
    const interval = setInterval(poll, 3000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [poll]);

  // cuộn xuống khi có tin mới
  useEffect(() => {
    if (messages.length !== lastCount.current) {
      lastCount.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return; // route vẫn tự chặn — đây chỉ là UX
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      await fetch(`/api/chat/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      await poll();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-19rem)] min-h-[420px] flex-col">
      {/* Tin nhắn */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
        {messages.length === 0 && (
          <p className="py-10 text-center text-sm text-[var(--muted)]">
            Chưa có tin nhắn — hãy gửi lời chào trước nào!
          </p>
        )}
        {messages.map((m) => {
          const mine = m.senderId === myUserId;
          return (
            <div
              key={m.id}
              className={cn("flex items-end gap-1.5", mine ? "justify-end" : "justify-start")}
            >
              {/* Báo cáo tin nhắn (Batch 3 Task 4 — spec §5.5) — affordance nhỏ,
                  ẨN trên tin của chính mình (self-report bị chặn server-side). */}
              {!mine && (
                <ReportDialog
                  targetType="message"
                  targetId={m.id}
                  triggerLabel="Báo cáo"
                  className="btn-ghost h-6 shrink-0 px-1.5 text-[10px] text-[var(--muted)] hover:text-[var(--red)]"
                />
              )}
              <div
                className={cn(
                  "max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm",
                  mine
                    ? "rounded-br-md bg-[var(--accent)] text-white"
                    : "rounded-bl-md bg-[var(--paper)] text-[var(--ink)]",
                )}
              >
                {!mine && (
                  <p className="mb-0.5 text-[11px] font-semibold text-[var(--ink-2)]">{m.senderName}</p>
                )}
                {m.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.imageUrl} alt="" className="mb-1.5 max-h-64 rounded-lg object-cover" />
                )}
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", mine ? "text-zinc-800" : "text-[var(--muted)]")}>
                  {timeAgo(m.createdAt)}
                  {mine && m.readAt && <CheckCheck className="size-3" />}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Soạn tin */}
      <form
        onSubmit={send}
        className="flex items-center gap-2 border-t border-[var(--line)] bg-[var(--card)] p-3"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input rounded-full"
          placeholder={disabled ? "Không thể gửi tin nhắn" : "Nhập tin nhắn…"}
          maxLength={2000}
          disabled={disabled}
        />
        <button
          type="submit"
          disabled={!text.trim() || sending || disabled}
          className="btn-primary size-10 shrink-0 rounded-full p-0"
        >
          {sending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </form>
    </div>
  );
}
