'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// IA-миграция: /profile упразднён в пользу /wallet (баланс + кошелёк) и
// /account (профиль). Под-роуты /profile/topup и /profile/income живут дальше —
// на них ссылаются /wallet и /account. Здесь только редирект индекса.
export default function ProfileRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/wallet');
  }, [router]);
  return null;
}
