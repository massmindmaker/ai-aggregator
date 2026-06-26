'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// IA-миграция: каталог скиллов переехал в /market (сегмент «Скиллы») — там живой
// каталог возможностей Hermes. Этот роут оставлен только как редирект, чтобы старые
// ссылки/закладки не упирались в мёртвую заглушку.
export default function SkillsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/market?tab=skills');
  }, [router]);
  return null;
}
