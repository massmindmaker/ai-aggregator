'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

// Same key MembershipPage's "продолжить бесплатно" writes — one gate-show per app
// session for a non-member, not on every relaunch (issue #29 boundary: dismissible,
// not a hard block; catalog/hire stay open regardless).
const MEMBERSHIP_SEEN_KEY = 'aiag_membership_seen';

/**
 * Root → /agents (or /membership) as a CLIENT-side redirect (was a server redirect).
 *
 * Telegram launches the Mini App with the auth payload in the URL fragment
 * (`#tgWebAppData=…`). A server-side redirect (the old `redirect('/agents')`)
 * can DROP that fragment inside Telegram's webview, leaving `WebApp.initData`
 * empty → useAuth shows the «Не открыто в Telegram» gate even inside Telegram.
 *
 * Doing the hop on the client lets the Telegram SDK (loaded beforeInteractive)
 * parse the fragment first; `window.Telegram.WebApp.initData` is then populated
 * in-window and survives the in-app navigation to /agents.
 *
 * Membership-purchase gate (issue #29): once auth resolves, check membership; a
 * non-member who hasn't dismissed the screen this session is routed through
 * /membership first. A member (or anyone who dismissed / already saw it) goes
 * straight to /agents, same as before this issue.
 */
export default function Home() {
  const router = useRouter();
  const { token, loading, error } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (error || !token) {
      // Not authenticated (outside Telegram, etc.) — unchanged prior behavior:
      // /agents itself renders the honest "open via @aiag_bot" state.
      router.replace('/agents');
      return;
    }

    let cancelled = false;
    (async () => {
      let isMember = false;
      try {
        const res = await fetch('/tg/api/tma/membership', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json().catch(() => ({}));
        isMember = !!body.is_member;
      } catch {
        isMember = false;
      }
      if (cancelled) return;

      let seen = false;
      try {
        seen = sessionStorage.getItem(MEMBERSHIP_SEEN_KEY) === '1';
      } catch {
        seen = false;
      }

      router.replace(!isMember && !seen ? '/membership' : '/agents');
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, error, token, router]);

  return null;
}
