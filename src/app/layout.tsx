import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Umbrella Parade 原稿制作ツール",
  description: "Kindleと印刷用PDFの原稿をページ設定に合わせて編集するビジュアルエディタ"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
