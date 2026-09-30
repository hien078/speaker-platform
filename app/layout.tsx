import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Header } from "@/src/components/header";
import { Footer } from "@/src/components/footer";
import { ServiceWorkerRegister } from "@/src/components/sw-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "LoaViet — Chợ trung gian mua bán & trao đổi loa",
    template: "%s · LoaViet",
  },
  description:
    "Nền tảng trung gian mua bán, trao đổi loa và thiết bị âm thanh. Escrow bảo vệ người mua, hoa hồng minh bạch cho người bán.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "LoaViet",
  },
  icons: {
    icon: [{ url: "/icons/favicon-64.png", type: "image/png" }],
    apple: [{ url: "/icons/icon-192.png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#07070e",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="vi"
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* hạt noise tạo chiều sâu */}
        <div className="noise-overlay" aria-hidden />
        <ServiceWorkerRegister />
        <Header />
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
