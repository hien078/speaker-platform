import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-[50vh] max-w-md place-items-center px-4 py-16 text-center">
      <div>
        <p className="font-sans text-[64px] font-extrabold leading-none text-[var(--accent)]">404</p>
        <h1 className="mt-3 text-xl font-extrabold tracking-tight">Không tìm thấy trang này</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-2)]">
          Trang có thể đã bị xóa, tin đăng đã bán, hoặc đường link gõ sai.
          Thử tìm lại trong chợ loa nhé.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/" className="btn-secondary h-9 px-4 text-sm">Về trang chủ</Link>
          <Link href="/listings" className="btn-primary h-9 px-4 text-sm">Đi xem chợ</Link>
        </div>
      </div>
    </main>
  );
}
