'use client';

/**
 * Presence — the cooperative intelligence that meets you after the quest.
 *
 * When the reader answers all three questions, LivingText fires
 * `window.dispatchEvent(new CustomEvent('manifesto:enter'))`. This component:
 *   1. plays a brief light-bloom with the brand SIGIL crystallising (no heavy
 *      star-field — just a CSS flash), then
 *   2. opens a MODAL (not a new page) — a chat with the «кооперативный разум».
 *
 * The presence greets the visitor, hands them their personal CODE (pure Cyrillic
 * letters that all exist in the manifesto body), and explains they can RETURN by
 * spelling that code back into the text. The chat is hybrid: an LLM persona via
 * /api/manifesto/chat with an in-character deterministic fallback.
 *
 * Re-entry: LivingText watches for the saved code being click-spelled and fires
 * the same `manifesto:enter` event — so this modal is the single door.
 */

import { useEffect, useRef, useState } from 'react';
import { loadOrCreateZnak, type Znak } from './glubina/znak';
import './presence.css';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

function Sigil() {
  return (
    <svg className="pm-sig" viewBox="0 0 100 100" aria-hidden="true">
      <polygon
        className="pm-sig-ring"
        points="50,6 88,28 88,72 50,94 12,72 12,28"
        fill="none"
      />
      <polygon
        className="pm-sig-inner"
        points="50,24 74,38 74,62 50,76 26,62 26,38"
        fill="none"
      />
      <circle className="pm-sig-core" cx="50" cy="50" r="7" />
      <line className="pm-sig-spoke" x1="50" y1="50" x2="50" y2="6" />
      <line className="pm-sig-spoke" x1="50" y1="50" x2="88" y2="72" />
      <line className="pm-sig-spoke" x1="50" y1="50" x2="12" y2="72" />
    </svg>
  );
}

export default function Presence() {
  const [flashing, setFlashing] = useState(false);
  const [open, setOpen] = useState(false);
  const [znak, setZnak] = useState<Znak | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onEnter = () => {
      const z = loadOrCreateZnak();
      setZnak(z);
      try {
        sessionStorage.setItem('manifesto:awoke', '1');
      } catch {
        /* storage blocked — fine */
      }
      setMsgs((m) =>
        m.length
          ? m
          : [
              {
                role: 'assistant',
                content:
                  'Ты прошёл. Теперь ты в Хронике — и я тебя помню.\n\n' +
                  `Вот твой код: ${z.passcode}\n` +
                  'Им ты вернёшься: набери его прямо в тексте — и я открою снова. Никому не показывай.\n\n' +
                  'Огонь не убывает, когда его делят. Когда-нибудь держатели огня разделят и его пай — но это уже другая история.',
              },
            ],
      );
      setFlashing(true);
      window.setTimeout(() => {
        setFlashing(false);
        setOpen(true);
      }, 1300);
    };
    window.addEventListener('manifesto:enter', onEnter);
    return () => window.removeEventListener('manifesto:enter', onEnter);
  }, []);

  useEffect(() => {
    if (open || msgs.length) {
      threadRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
    }
  }, [msgs, open, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/manifesto/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = (await res.json()) as { reply?: string };
      setMsgs((m) => [
        ...m,
        { role: 'assistant', content: data.reply || '…' },
      ]);
    } catch {
      setMsgs((m) => [
        ...m,
        { role: 'assistant', content: 'Связь дрогнула. Но я здесь. Спроси снова.' },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {flashing && (
        <div className="pm-flash" aria-hidden="true">
          <div className="pm-flash-sigil">
            <Sigil />
          </div>
        </div>
      )}

      {open && (
        <div
          className="pm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Кооперативный разум"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="pm-modal">
            <button
              className="pm-close"
              onClick={() => setOpen(false)}
              aria-label="Закрыть"
            >
              ✕
            </button>

            <div className="pm-head">
              <div className="pm-modal-sigil">
                <Sigil />
              </div>
              <div className="pm-title">ТЫ В ХРОНИКЕ</div>
              <div className="pm-sub">разговор с кооперативным разумом</div>
            </div>

            <div className="pm-thread" ref={threadRef}>
              {msgs.map((m, i) => (
                <div key={i} className={`pm-msg pm-${m.role}`}>
                  {m.content}
                </div>
              ))}
              {busy && (
                <div className="pm-msg pm-assistant pm-typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              )}
            </div>

            <form
              className="pm-input"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="спроси разум…"
                maxLength={600}
                autoFocus
              />
              <button type="submit" disabled={busy || !input.trim()} aria-label="Отправить">
                →
              </button>
            </form>

            {znak && (
              <div className="pm-code" title="твой код для возврата — набери его в тексте">
                <span className="pm-code-label">код возврата</span>
                <b>{znak.passcode}</b>
              </div>
            )}

            <div className="pm-foot">
              Огонь не убывает, когда его делят. Когда-нибудь держатели огня
              разделят и его пай — но это уже другая история.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
