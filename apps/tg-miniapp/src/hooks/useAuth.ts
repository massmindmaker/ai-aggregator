'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface TGUser {
  id: number;
  first_name?: string;
  username?: string;
}

// Re-auth this many seconds before the JWT actually expires, so a request
// started right at the boundary doesn't land with an already-expired token.
const NEAR_EXPIRY_SKEW_SEC = 60;

// CloudStorage key holding the cached JWT (mirrored by account/page.tsx logout).
const JWT_KEY = 'aiag_jwt';

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

// Best-effort token wipe — mirror of account/page.tsx clearAuthToken(). The JWT
// lives in Telegram CloudStorage under `aiag_jwt`; we also clear a localStorage
// mirror as a fallback.
function clearCachedToken() {
  try {
    const tg = (
      window as {
        Telegram?: { WebApp?: { CloudStorage?: { removeItem?: (k: string, cb?: () => void) => void } } };
      }
    ).Telegram?.WebApp;
    tg?.CloudStorage?.removeItem?.(JWT_KEY, () => {});
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(JWT_KEY);
  } catch {
    /* ignore */
  }
}

// Server error codes that mean "this token is dead, re-auth" (denylist / expiry /
// malformed). A plain 401 without a body also counts.
const REAUTH_ERRORS = new Set(['token_revoked', 'token_expired', 'invalid_token']);

export function useAuth() {
  const [user, setUser] = useState<TGUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string | null>(null);
  // Set once, only on the verify that actually applied the one-time welcome grant
  // → lets the UI show a "300 кр на старт" hint exactly once for a new user.
  const [freeGrantCredits, setFreeGrantCredits] = useState<number | null>(null);

  // The live token, kept in a ref so authFetch (a stable callback) always reads
  // the freshest value without being re-created on every token change.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  // Coalesce concurrent re-auths: many in-flight requests can 401 at once; we want
  // exactly ONE verify call, and the rest await its result.
  const reauthInFlight = useRef<Promise<string | null> | null>(null);

  // Run the verify(initData) flow once and apply the new token. Returns the fresh
  // token, or null on failure. Shared by the initial auth and by authFetch's
  // recovery path. Does NOT read the cache — callers decide.
  const runVerify = useCallback(async (): Promise<string | null> => {
    const tg = (window as any).Telegram?.WebApp;
    if (!tg?.initData) return null;
    const res = await fetch('/tg/api/tma/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.reason ?? body.error ?? 'auth_failed');
    }
    const {
      token: newToken,
      user: tgUser,
      freeGrant,
      freeGrantCredits: grantAmount,
    } = await res.json();
    setToken(newToken);
    tokenRef.current = newToken;
    setUser(tgUser);
    if (freeGrant && typeof grantAmount === 'number') setFreeGrantCredits(grantAmount);
    tg.CloudStorage?.setItem?.(JWT_KEY, newToken, () => {});
    return newToken;
  }, []);

  // Clear the dead token and re-run verify ONCE (coalesced across callers). On
  // failure surfaces the auth error so the page shows the normal error screen.
  const reauth = useCallback(async (): Promise<string | null> => {
    if (reauthInFlight.current) return reauthInFlight.current;
    const p = (async () => {
      clearCachedToken();
      setToken(null);
      tokenRef.current = null;
      try {
        return await runVerify();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'auth_error');
        return null;
      } finally {
        reauthInFlight.current = null;
      }
    })();
    reauthInFlight.current = p;
    return p;
  }, [runVerify]);

  // fetch wrapper that injects the Bearer header and recovers from a rejected
  // token: on 401 (token_revoked / invalid_token / expiry, or a bare 401) it
  // clears the cache, re-auths ONCE, then retries the original request once with
  // the fresh token. If re-auth fails, the original 401 response is returned and
  // the hook's error state is set.
  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const withAuth = (tok: string | null): RequestInit => {
        const headers = new Headers(init.headers);
        if (tok) headers.set('Authorization', `Bearer ${tok}`);
        return { ...init, headers };
      };

      const first = await fetch(input, withAuth(tokenRef.current));
      if (first.status !== 401) return first;

      // Inspect the body without consuming it for the caller (clone first).
      let code: string | undefined;
      try {
        const j = (await first.clone().json()) as { error?: string };
        code = j?.error;
      } catch {
        /* no/!json body → treat a bare 401 as a re-auth trigger */
      }
      if (code !== undefined && !REAUTH_ERRORS.has(code)) {
        // 401 with an unrelated error code (e.g. a route-level auth gate) — don't
        // nuke the session; let the caller handle it.
        return first;
      }

      const fresh = await reauth();
      if (!fresh) return first; // re-auth failed; error state already set
      return fetch(input, withAuth(fresh));
    },
    [reauth],
  );

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    // Signal Telegram the Mini App is ready + take full height (no-op in a browser).
    // disableVerticalSwipes — иначе свайп-скролл в TG iOS сворачивает приложение.
    // Optional-chaining защищает старые клиенты, где метода ещё нет.
    try {
      tg?.ready?.();
      tg?.expand?.();
      tg?.disableVerticalSwipes?.();
    } catch {
      /* ignore */
    }
    if (!tg?.initData) {
      // Temporary diagnostic: shows WHY initData is missing (SDK not loaded vs
      // Telegram didn't pass the launch hash vs the SDK didn't parse it).
      const hasHash =
        typeof window !== 'undefined' &&
        /tgWebAppData/.test(window.location.hash + window.location.search);
      setDebug(
        `sdk=${!!(window as any).Telegram} wa=${!!tg} initData=${tg?.initData?.length ?? 0} hash=${hasHash ? 'есть' : 'нет'}`,
      );
      setError('Не открыто в Telegram');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const cached = await new Promise<string>((resolve) => {
          if (!tg.CloudStorage?.getItem) return resolve('');
          tg.CloudStorage.getItem(JWT_KEY, (_err: any, val: string) => resolve(val ?? ''));
        }).catch(() => '');

        if (cached && isTokenUsable(cached)) {
          setToken(cached);
          tokenRef.current = cached;
          setUser({
            id: tg.initDataUnsafe?.user?.id ?? 0,
            ...tg.initDataUnsafe?.user,
          });
          setLoading(false);
          return;
        }

        await runVerify();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'auth_error');
      } finally {
        setLoading(false);
      }
    })();
  }, [runVerify]);

  return { user, token, loading, error, debug, freeGrantCredits, authFetch, reauth };
}
