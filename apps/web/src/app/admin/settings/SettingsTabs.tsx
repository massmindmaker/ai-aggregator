'use client';

import * as React from 'react';

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
}

interface Props {
  tabs: Tab[];
  defaultTab?: string;
}

export function SettingsTabs({ tabs, defaultTab }: Props) {
  const [active, setActive] = React.useState(defaultTab ?? tabs[0]?.id);

  return (
    <div>
      <div
        className="mb-6 flex gap-1 border-b overflow-x-auto"
        style={{ borderColor: 'var(--line)' }}
        role="tablist"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition-all whitespace-nowrap ${
              active === t.id
                ? 'border-[var(--accent)] text-[var(--ink)] font-medium'
                : 'border-transparent opacity-60 hover:opacity-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>
        {tabs.map((t) => (
          <div key={t.id} role="tabpanel" hidden={active !== t.id}>
            {active === t.id && t.content}
          </div>
        ))}
      </div>
    </div>
  );
}
