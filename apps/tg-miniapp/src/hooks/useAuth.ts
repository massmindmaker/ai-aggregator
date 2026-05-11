'use client';
import { useEffect, useState } from 'react';

interface TGUser {
  id: number;
  first_name?: string;
  username?: string;
}

export function useAuth() {
  const [user, setUser] = useState<TGUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (!tg?.initData) {
      setError('Не открыто в Telegram');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const cached = await new Promise<string>((resolve) => {
          if (!tg.CloudStorage?.getItem) return resolve('');
          tg.CloudStorage.getItem('aiag_jwt', (_err: any, val: string) => resolve(val ?? ''));
        }).catch(() => '');

        if (cached) {
          // TODO: verify expiry — for MVP just use it
          setToken(cached);
          setUser({
            id: tg.initDataUnsafe?.user?.id ?? 0,
            ...tg.initDataUnsafe?.user,
          });
          setLoading(false);
          return;
        }

        const res = await fetch('/tg/api/tma/auth/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData: tg.initData }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.reason ?? body.error ?? 'auth_failed');
          setLoading(false);
          return;
        }
        const { token: newToken, user: tgUser } = await res.json();
        setToken(newToken);
        setUser(tgUser);
        tg.CloudStorage?.setItem?.('aiag_jwt', newToken, () => {});
      } catch (err) {
        setError(err instanceof Error ? err.message : 'auth_error');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return { user, token, loading, error };
}
