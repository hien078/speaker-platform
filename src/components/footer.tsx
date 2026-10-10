import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-16 border-t border-[var(--line)] bg-[var(--paper-deep)]">
      <div className="mx-auto max-w-6xl px-4 py-10 lg:px-6">
        <div className="grid gap-8 sm:grid-cols-5">
          <div className="sm:col-span-2">
            <p className="text-[19px] font-extrabold tracking-tight">
              loa<span className="text-[var(--accent)]">viet</span>
            </p>
            <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-[var(--ink-2)]">
              Chợ loa secondhand &amp; mới cho người chơi âm thanh. Người mua và
              người bán gặp nhau, chat và tự thỏa thuận — LoaViet không giữ tiền
              và không bảo đảm giao dịch.
            </p>
            <p className="mt-4 text-[11px] text-[var(--muted)]">
              © {new Date().getFullYear()} LoaViet · dự án beta
            </p>
          </div>

          <div>
            <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--muted)]">Mua hàng</p>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/listings">Tất cả tin đăng</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/wishlist">Tin đã lưu</Link></li>
            </ul>
          </div>

          <div>
            <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--muted)]">Bán hàng</p>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/sell/new">Đăng tin</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/sell/my">Tin của tôi</Link></li>
            </ul>
          </div>

          <div>
            <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--muted)]">Chính sách</p>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/policies/terms">Điều khoản sử dụng</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/policies/privacy">Chính sách bảo mật</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/policies/marketplace_rules">Quy tắc chợ</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/policies/seller_rules">Quy tắc người bán</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/policies/community_rules">Quy tắc cộng đồng</Link></li>
              <li><Link className="text-[var(--ink-2)] hover:text-[var(--accent)]" href="/policies/safety_guidance">Hướng dẫn an toàn giao dịch</Link></li>
            </ul>
          </div>
        </div>

        <div className="rule-double mt-8" />
        <p className="mt-4 text-[11px] leading-relaxed text-[var(--muted)]">
          LoaViet là nền tảng đăng tin, không phải bên bán sản phẩm. Thanh toán
          và giao nhận hàng do người mua và người bán tự thỏa thuận, diễn ra
          độc lập ngoài nền tảng — LoaViet không giữ tiền và không bảo đảm giao dịch.
        </p>
      </div>
    </footer>
  );
}
