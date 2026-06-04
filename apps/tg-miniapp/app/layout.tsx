import type { ReactNode } from 'react';
import Script from 'next/script';
import { Providers } from './providers';
import './globals.css';

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
    <html lang="ru">
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
