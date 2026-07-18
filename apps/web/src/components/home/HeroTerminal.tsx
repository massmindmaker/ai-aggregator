'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

type Part = { text: string; cls?: string; delay: number };

const script: Part[] = [
  { text: '$ ', cls: 'code-prompt', delay: 0 },
  { text: 'curl ', delay: 30 },
  {
    text: 'https://api.ai-aggregator.ru/v1/chat/completions',
    cls: 'code-string',
    delay: 20,
  },
  { text: ' \\\n  -H ', delay: 30 },
  {
    text: '"Authorization: Bearer sk_aiag_live_..."',
    cls: 'code-string',
    delay: 15,
  },
  { text: ' \\\n  -d ', delay: 30 },
  { text: '\'{"model": ', cls: 'code-string', delay: 20 },
  { text: '"gpt-5"', cls: 'code-key', delay: 30 },
  {
    text: ', "stream": true, "messages": [...]}\'\n\n',
    cls: 'code-string',
    delay: 20,
  },
  { text: '// streaming response\n', cls: 'code-comment', delay: 100 },
];

const streamTokens = [
  'Any ', 'AI ', 'model. ', 'One ', 'API. ', 'Payment ', 'in ', '₽. ',
  // No model count here on purpose: this is a client component, so the real
  // number would mean shipping the catalog to the browser. The exact count is
  // rendered in the hero stats (server-side, derived from the catalog).
  '\n\n', 'Вы ', 'получаете ', 'доступ ', 'к ', 'каталогу ', 'моделей ',
  'через ', 'единый ', 'endpoint ', '— ', 'GPT-5, ', 'Claude, ', 'Gemini, ',
  'Flux, ', 'Veo ', 'и ', 'другие.', '\n\n',
  '— AI-Aggregator',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function HeroTerminal() {
  const codeRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const codeEl = codeRef.current;
    if (!codeEl) return;
    cancelledRef.current = false;

    if (reduceMotion) {
      codeEl.textContent =
        '$ curl https://api.ai-aggregator.ru/v1/chat/completions \\\n  -H "Authorization: Bearer sk_aiag_live_..." \\\n  -d \'{"model": "gpt-5", "stream": true, "messages": [...]}\'\n\n// streaming response\nAny AI model. One API. Payment in ₽.';
      return;
    }

    async function run() {
      while (!cancelledRef.current) {
        if (!codeEl) return;
        codeEl.innerHTML = '';
        let span: HTMLSpanElement | null = null;
        for (const part of script) {
          if (cancelledRef.current) return;
          await sleep(part.delay);
          if (part.cls) {
            span = document.createElement('span');
            span.className = part.cls;
            codeEl.appendChild(span);
          }
          for (const ch of part.text) {
            if (cancelledRef.current) return;
            if (part.cls && span) span.textContent += ch;
            else codeEl.appendChild(document.createTextNode(ch));
            await sleep(part.text.length > 20 ? 8 : 18);
          }
        }
        const outputSpan = document.createElement('span');
        outputSpan.className = 'code-output';
        codeEl.appendChild(outputSpan);
        const cursor = document.createElement('span');
        cursor.className = 'aiag-cursor';
        codeEl.appendChild(cursor);
        for (const token of streamTokens) {
          if (cancelledRef.current) return;
          outputSpan.textContent += token;
          await sleep(60 + Math.random() * 80);
        }
        cursor.remove();
        await sleep(4000);
      }
    }
    run();

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return (
    <div
      className="aiag-hero-terminal aiag-fade-up rounded-md overflow-hidden relative"
      style={
        {
          background: '#0f0f11',
          maxWidth: '100%',
          border: '1px solid var(--line)',
          boxShadow:
            '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
          '--fade-delay': '1400ms',
        } as CSSProperties
      }
    >
      <div
        className="flex items-center px-3 py-3 border-b gap-1.5 min-w-0"
        style={{
          borderColor: 'var(--line)',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 10, height: 10, background: '#ff5f57', marginRight: 6 }}
        />
        <span
          className="inline-block rounded-full"
          style={{ width: 10, height: 10, background: '#ffbd2e', marginRight: 6 }}
        />
        <span
          className="inline-block rounded-full"
          style={{ width: 10, height: 10, background: '#28c840', marginRight: 6 }}
        />
        <span
          className="ml-2 flex-1 font-mono text-[12px] truncate min-w-0"
          style={{ color: 'var(--ink-muted)' }}
        >
          terminal — bash
        </span>
        <span
          className="font-mono text-[10px] uppercase font-semibold tracking-wider px-1.5 py-[2px] rounded-sm shrink-0"
          style={{
            background: 'rgba(16,185,129,0.12)',
            color: '#10b981',
            border: '1px solid rgba(16,185,129,0.25)',
            letterSpacing: '0.08em',
          }}
        >
          live
        </span>
      </div>
      <div
        ref={codeRef}
        className="font-mono text-[13px]"
        style={{
          padding: 20,
          lineHeight: 1.7,
          color: '#f4f4f5',
          minHeight: 280,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      />
      <style jsx>{`
        :global(.code-prompt) {
          color: #f59e0b;
        }
        :global(.code-comment) {
          color: #52525b;
          font-style: italic;
        }
        :global(.code-string) {
          color: #a1e89b;
        }
        :global(.code-key) {
          color: #93c5fd;
        }
        :global(.code-output) {
          color: #d4d4d8;
        }
      `}</style>
    </div>
  );
}
