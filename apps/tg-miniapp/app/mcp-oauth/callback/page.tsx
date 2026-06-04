'use client';

import { useEffect, useState } from 'react';

/**
 * MCP OAuth callback page (the redirect target, /tg/mcp-oauth/callback).
 *
 * This loads in the SYSTEM BROWSER (where the user authorized), NOT inside the
 * Telegram webview — so there is no TMA JWT here. It reads ?code&state from the
 * URL and POSTs them to the public callback route, which validates the single-use
 * `state`, exchanges the code, and stores the encrypted tokens. We never show a
 * token. On success the user just returns to Telegram.
 */
export default function McpOauthCallbackPage() {
  const [status, setStatus] = useState<'working' | 'ok' | 'error'>('working');
  const [reason, setReason] = useState<string>('');

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const err = sp.get('error');
    const code = sp.get('code');
    const state = sp.get('state');
    if (err) {
      setStatus('error');
      setReason(err);
      return;
    }
    if (!code || !state) {
      setStatus('error');
      setReason('missing_code_or_state');
      return;
    }
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/mcp-oauth/callback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, state }),
        });
        if (res.ok) {
          setStatus('ok');
        } else {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setStatus('error');
          setReason(j.error ?? `http_${res.status}`);
        }
      } catch {
        setStatus('error');
        setReason('network_error');
      }
    })();
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
        background: '#0a0a0b',
        color: '#f4f4f5',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      {status === 'working' && <p style={{ opacity: 0.7 }}>Подключаем MCP-сервер…</p>}
      {status === 'ok' && (
        <>
          <div style={{ fontSize: 40 }}>✅</div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Готово</h1>
          <p style={{ opacity: 0.7, margin: 0 }}>Вернитесь в Telegram — MCP-сервер подключён.</p>
        </>
      )}
      {status === 'error' && (
        <>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Не удалось подключить</h1>
          <p style={{ opacity: 0.7, margin: 0 }}>
            Закройте это окно и попробуйте снова в приложении.
          </p>
          <code style={{ fontSize: 11, opacity: 0.5 }}>{reason}</code>
        </>
      )}
    </main>
  );
}
