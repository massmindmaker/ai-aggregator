'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Root → /agents as a CLIENT-side redirect (was a server redirect).
 *
 * Telegram launches the Mini App with the auth payload in the URL fragment
 * (`#tgWebAppData=…`). A server-side redirect (the old `redirect('/agents')`)
 * can DROP that fragment inside Telegram's webview, leaving `WebApp.initData`
 * empty → useAuth shows the «Не открыто в Telegram» gate even inside Telegram.
 *
 * Doing the hop on the client lets the Telegram SDK (loaded beforeInteractive)
 * parse the fragment first; `window.Telegram.WebApp.initData` is then populated
 * in-window and survives the in-app navigation to /agents.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/agents');
  }, [router]);
  return null;
}
