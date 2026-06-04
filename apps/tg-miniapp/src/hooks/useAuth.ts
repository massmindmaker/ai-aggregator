'use client';
import { useEffect, useState } from 'react';

interface TGUser {
  id: number;
  first_name?: string;
  username?: string;
}

// Re-auth this many seconds before the JWT actually expires, so a request
// started right at the boundary doesn't land with an already-expired token.
const NEAR_EXPIRY_SKEW_SEC = 60;

/**
 * Decode a JWT payload (no signature check — server verifies that) and decide
 * whether it's still safely usable. Returns false on any malformed/expired token.
 */
function isTokenUsable(jwt: string): boolean {
  try {
    const part = jwt.split('.')[1];
    if (!part) return false;
    // base64url → base64
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== 'number') return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return payload.exp - NEAR_EXPIRY_SKEW_SEC > nowSec;
  } catch {
    return false;
  }
}

export function useAuth() {
  const [user, setUser] = useState<TGUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    // Signal Telegram the Mini App is ready + take full height (no-op in a browser).
    try {
      tg?.ready?.();
      tg?.expand?.();
    } catch {
      /* ignore */
    }
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

        if (cached && isTokenUsable(cached)) {
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
