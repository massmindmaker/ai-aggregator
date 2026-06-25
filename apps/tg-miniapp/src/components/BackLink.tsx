'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Ссылка «назад», которая возвращает к фактическому источнику (router.back()),
 * а не к жёстко зашитому экрану. Также подключает нативную BackButton Telegram.
 * href остаётся фолбэком для браузера/без истории.
 */
export function BackLink({
  href,
  children,
  className = 'tma-back-link',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    tg?.BackButton?.show?.();
    const h = () => router.back();
    tg?.BackButton?.onClick?.(h);
    return () => {
      tg?.BackButton?.offClick?.(h);
      tg?.BackButton?.hide?.();
    };
  }, [router]);
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        router.back();
      }}
    >
      {children}
    </Link>
  );
}
