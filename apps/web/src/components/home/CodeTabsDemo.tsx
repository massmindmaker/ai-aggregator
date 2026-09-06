'use client';

import { useState, useEffect } from 'react';

const SAMPLES = {
  curl: `curl https://ai-aggregator.ru/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role":"user","content":"Привет!"}]
  }'`,

  openai: `from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://ai-aggregator.ru/v1",
)

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Привет!"}],
)
print(response.choices[0].message.content)`,

  python: `import requests

r = requests.post(
    "https://ai-aggregator.ru/v1/chat/completions",
    headers={"Authorization": "Bearer YOUR_API_KEY"},
    json={
        "model": "openai/gpt-4o-mini",
        "messages": [{"role": "user", "content": "Привет!"}],
    },
)
print(r.json()["choices"][0]["message"]["content"])`,
} as const;

type TabKey = keyof typeof SAMPLES;

const TAB_LABELS: Record<TabKey, string> = {
  curl: 'curl',
  openai: 'OpenAI SDK',
  python: 'Python',
};

const DEMO_OUTPUT =
  'Привет! Я работаю через AI-Aggregator — единый шлюз ко всем популярным LLM-провайдерам. Чем могу помочь?';

export function CodeTabsDemo() {
  const [tab, setTab] = useState<TabKey>('curl');
  const [out, setOut] = useState('');

  useEffect(() => {
    setOut('');
    let i = 0;
    const id = setInterval(() => {
      i += Math.random() < 0.5 ? 1 : 2;
      if (i >= DEMO_OUTPUT.length) {
        setOut(DEMO_OUTPUT);
        clearInterval(id);
      } else {
        setOut(DEMO_OUTPUT.slice(0, i));
      }
    }, 35);
    return () => clearInterval(id);
  }, [tab]);

  return (
    <section className="container mx-auto max-w-6xl px-4 py-20">
      <div className="text-center mb-10">
        <div
          className="font-mono uppercase mb-3.5"
          style={{
            fontSize: 11,
            color: 'var(--accent)',
            letterSpacing: '0.12em',
          }}
        >
          {'// Drop-in API'}
        </div>
        <h2
          className="font-bold"
          style={{
            fontSize: 'clamp(28px, 3.6vw, 44px)',
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
            margin: '0 0 12px',
          }}
        >
          Drop-in замена OpenAI SDK
        </h2>
        <p
          style={{
            fontSize: 16,
            color: 'var(--ink-muted)',
            maxWidth: 560,
            margin: '0 auto',
          }}
        >
          Совместимый API. Меняешь <code className="font-mono" style={{ color: 'var(--accent)' }}>base_url</code> — получаешь доступ к ко всем моделям каталога.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Code side */}
        <div
          className="rounded-md overflow-hidden"
          style={{
            border: '1px solid var(--line)',
            background: 'var(--bg-elev)',
          }}
        >
          <div
            className="flex"
            style={{ borderBottom: '1px solid var(--line)' }}
          >
            {(Object.keys(SAMPLES) as TabKey[]).map((t) => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className="font-mono uppercase tracking-wider transition-colors"
                  style={{
                    padding: '10px 16px',
                    fontSize: 11,
                    letterSpacing: '0.1em',
                    color: active ? 'var(--accent)' : 'var(--ink-muted)',
                    background: active ? 'rgba(245,158,11,0.06)' : 'transparent',
                    borderBottom: active
                      ? '2px solid var(--accent)'
                      : '2px solid transparent',
                  }}
                >
                  {TAB_LABELS[t]}
                </button>
              );
            })}
          </div>
          <pre
            className="overflow-x-auto leading-relaxed font-mono"
            style={{
              padding: 18,
              fontSize: 12.5,
              color: 'var(--ink)',
              margin: 0,
              minHeight: 280,
            }}
          >
            <code>{SAMPLES[tab]}</code>
          </pre>
        </div>

        {/* Output side */}
        <div
          className="rounded-md flex flex-col"
          style={{
            border: '1px solid var(--line)',
            background: 'var(--bg-elev)',
            minHeight: 320,
            padding: 18,
          }}
        >
          <div
            className="uppercase tracking-widest flex items-center gap-2 font-mono mb-4"
            style={{ fontSize: 11, color: 'var(--ink-muted)', letterSpacing: '0.12em' }}
          >
            <span
              className="aiag-pulse inline-block rounded-full"
              style={{
                width: 6,
                height: 6,
                background: 'var(--success, #22c55e)',
              }}
            />
            Stream · openai/gpt-4o-mini
          </div>
          <div
            className="flex-1 font-mono leading-relaxed whitespace-pre-wrap break-words"
            style={{ fontSize: 13.5, color: 'var(--ink)' }}
          >
            {out}
            {/* Blink comes from the .aiag-cursor class (issue #23) — an inline
                `animation` cannot be switched off by the reduced-motion rule.
                Geometry stays inline; only the animation had to move. */}
            <span
              className="aiag-cursor"
              style={{
                height: 16,
                marginLeft: 2,
                verticalAlign: 'text-bottom',
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
