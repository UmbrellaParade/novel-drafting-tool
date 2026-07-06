import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Umbrella Parade 原稿制作ツール",
  description: "KindleとPDF原稿をページ設定に合わせて編集・書き出しするビジュアルエディタ"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
