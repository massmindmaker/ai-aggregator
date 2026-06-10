import type { ReactNode } from 'react';
import Script from 'next/script';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// DESIGN.md: Inter for body, JetBrains Mono for ALL numerics + eyebrow.
// Self-hosted at build time via next/font — no runtime Google dependency
// (matters inside the Telegram webview).
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
  display: 'swap',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata = {
  title: 'AIAG',
  description: 'AI Aggregator Mini App',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0a0a0b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        {/* Telegram WebApp SDK — REQUIRED so window.Telegram.WebApp + initData exist.
            Without it useAuth always errors «Не открыто в Telegram» (the auth gate),
            even inside Telegram. beforeInteractive = loaded before any app JS reads it. */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
