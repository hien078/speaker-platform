import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-16 border-t border-[var(--line)] bg-[var(--paper-deep)]">
      <div className="mx-auto max-w-6xl px-4 py-10 lg:px-6">
        <div className="grid gap-8 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <p className="text-[19px] font-extrabold tracking-tight">
              loa<span className="text-[var(--accent)]">viet</span>
            </p>
            <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-[var(--ink-2)]">
              Chợ trung gian mua bán và trao đổi loa. Tiền của người mua được giữ hộ
              đến khi nhận hàng — người bán chỉ bị trừ hoa hồng khi bán được.
            </p>
            <p className="mt-4 text-[11px] text-[var(--muted)]">
              © {new Date().getFullYear()} LoaViet · dự án beta
            </p>
          </div>

          <div>
            <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--muted)]">Mua hàng</p>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/listings">Tất cả tin đăng</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/listings?exchange=1">Loa nhận đổi</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/wishlist">Tin đã lưu</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/orders">Đơn của tôi</Link></li>
            </ul>
          </div>

          <div>
            <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--muted)]">Bán hàng</p>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/sell/new">Đăng tin</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/sell/my">Tin của tôi</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/wallet">Ví &amp; rút tiền</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/orders/sales">Đơn bán được</Link></li>
            </ul>
          </div>
        </div>

        <div className="rule-double mt-8" />
        <p className="mt-4 text-[11px] leading-relaxed text-[var(--muted)]">
          LoaViet là bên trung gian cung cấp nền tảng và giữ tiền giao dịch, không phải
          bên bán sản phẩm. Mọi tranh chấp được xử lý dựa trên mô tả tin đăng, ảnh
          thực tế và biên bản giao hàng.
        </p>
      </div>
    </footer>
  );
}
