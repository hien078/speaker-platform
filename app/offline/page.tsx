export const metadata = { title: "Mất kết nối" };

export default function OfflinePage() {
  return (
    <main className="mesh-hero grid min-h-[60vh] place-items-center px-4 text-center">
      <div>
        <p className="text-6xl">🔇</p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">Mất kết nối mạng</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-500">
          Không tải được trang này do không có internet. Các trang đã xem gần đây vẫn mở
          được — kết nối lại mạng rồi thử tiếp nhé!
        </p>
      </div>
    </main>
  );
}
