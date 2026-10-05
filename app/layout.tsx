import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro } from "next/font/google";
import "./globals.css";
import { Header } from "@/src/components/header";
import { Footer } from "@/src/components/footer";
import { ServiceWorkerRegister } from "@/src/components/sw-register";

const beVietnam = Be_Vietnam_Pro({
  variable: "--font-be-vietnam",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: {
    default: "LoaViet — Chợ loa cho người chơi âm thanh",
    template: "%s · LoaViet",
  },
  description:
    "Chợ loa secondhand và mới — tìm kiếm, nhắn người bán và tự thỏa thuận. LoaViet không giữ tiền và không bảo đảm giao dịch.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "LoaViet",
  },
  icons: {
    icon: [{ url: "/icons/favicon-64.png", type: "image/png" }],
    apple: [{ url: "/icons/icon-192.png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#f6f4ef",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${beVietnam.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ServiceWorkerRegister />
        <Header />
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
