import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Cormorant_Garamond } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@/components/ThemeProvider';
import { Providers } from '@/components/providers/Providers';
import { rtlLocales, type Locale } from '@/i18n/config';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

/**
 * Cormorant Garamond — display serif used exclusively by the cinematic
 * /manifesto surface (scene titles, refrain). Loaded here because next/font
 * must run at module scope; surfaced everywhere via the `--font-cormorant`
 * CSS variable but only referenced inside the manifesto styles.
 */
const cormorant = Cormorant_Garamond({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-cormorant',
});

export const metadata: Metadata = {
  title: {
    default: 'AI Aggregator — Маркетплейс алгоритмов ИИ',
    template: '%s | AI Aggregator',
  },
  description:
    'Маркетплейс алгоритмов искусственного интеллекта. Алгоритмы ИИ — быстро, просто, недорого.',
  keywords: [
    'AI',
    'ИИ',
    'API',
    'LLM',
    'машинное обучение',
    'маркетплейс',
    'алгоритмы',
  ],
  authors: [{ name: 'AI Aggregator Team' }],
  openGraph: {
    type: 'website',
    locale: 'ru_RU',
    siteName: 'AI Aggregator',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  const dir = rtlLocales.includes(locale) ? 'rtl' : 'ltr';

  return (
    <html
      lang={locale}
      dir={dir}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrains.variable} ${cormorant.variable}`}
    >
      <body className="font-sans antialiased bg-background text-foreground">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            <Providers>{children}</Providers>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
