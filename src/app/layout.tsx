import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Sora } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const sora = Sora({ variable: "--font-sora", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: {
    default: "Cezario's Clips AI",
    template: "%s · Cezario's Clips AI",
  },
  description: "Transforme vídeos longos em cortes verticais com IA — transcrição local, sugestões justificadas e legendas sincronizadas.",
};

export const viewport: Viewport = {
  themeColor: "#050507",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable} ${sora.variable} h-full antialiased`}>
      <body className="min-h-full">
        <div className="ambient" aria-hidden />
        {children}
      </body>
    </html>
  );
}
