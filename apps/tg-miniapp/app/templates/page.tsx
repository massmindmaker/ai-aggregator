'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// IA-миграция: каталог шаблонов переехал в /market (сегмент «Агенты»).
// Детальная страница /templates/[id] остаётся — на неё ведут карточки маркета.
export default function TemplatesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/market');
  }, [router]);
  return null;
}
