import type { Metadata } from "next";
import "../src/styles.css";

export const metadata: Metadata = {
  title: "WhiteMood · 让心情，有处安放",
  description: "中文、English、한국어。点一下开始，按自己的节奏说话。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
