'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { CatalogNav } from '@/components/CatalogNav';

// Screen 29 «Маркет скиллов» v1. A "skill" = a built-in tool, a knowledge/
// instruction doc, or a (own-key) MCP server — a relabel of primitives we
// already ship. Install = the existing PATCH agents/[id] (add tool / prepend
// doc to system_prompt). NO money path. Executable scripts + /команда +
// community submission are «скоро»/R&D (need infra we don't have).

type SkillKind = 'tool' | 'doc' | 'mcp' | 'soon';

interface SkillCard {
  id: string;
  kind: SkillKind;
  name: string;
  title: string;
  description: string;
  tool_id?: string;
  body?: string;
  status: 'live' | 'soon' | 'rnd';
  cost_hint: string | null;
  metadata?: Record<string, string>;
}

interface AgentLite {
  id: string;
  name: string;
  tools: unknown;
  system_prompt: string;
}

// Per-skill accent hue (OKLCH) — the collectible-card signature (DESIGN.md),
// deterministic per id so a card keeps its colour.
const HUES = [28, 235, 340, 165, 60, 290, 200, 130];
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

function monogram(title: string): string {
  const t = (title ?? '?').trim();
  return (t[0] ?? '?').toUpperCase();
}

// Status pill = icon + word, never colour alone (DESIGN.md).
const STATUS_PILL: Record<SkillCard['status'], { cls: string; label: string }> = {
  live: { cls: 'tma-pill--accent', label: '● live' },
  soon: { cls: 'tma-pill--muted', label: '◷ скоро' },
  rnd: { cls: 'tma-pill--muted', label: '⚗ R&D' },
};

type Filter = 'all' | 'tool' | 'doc' | 'mcp';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'tool', label: 'Инструменты' },
  { key: 'doc', label: 'Знания' },
  { key: 'mcp', label: 'MCP' },
];

export default function SkillsPage() {
  const { user, token, loading, error } = useAuth();
  const [skills, setSkills] = useState<SkillCard[] | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  // Inline "add to agent" panel state (one open at a time).
  const [openId, setOpenId] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addedFor, setAddedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [sRes, aRes] = await Promise.all([
          fetch('/tg/api/tma/skills', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/tg/api/tma/agents', { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        if (cancelled) return;
        if (!sRes.ok) {
          setFetchErr(`HTTP ${sRes.status}`);
          return;
        }
        const sData = await sRes.json();
        setSkills(sData.skills ?? []);
        if (aRes.ok) {
          const aData = await aRes.json();
          setAgents(Array.isArray(aData.agents) ? aData.agents : []);
        }
      } catch (e) {
        if (cancelled) return;
        setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  function openPanel(skillId: string) {
    setOpenId(skillId);
    setAgentSel(agents[0]?.id ?? '');
    setAddErr(null);
    setAddedFor(null);
  }

  // Install = PATCH the chosen agent. 'tool' → add tool_id to tools[];
  // 'doc' → prepend the instruction body to system_prompt. Reuses the existing
  // route; no new write path, no money path.
  async function handleAdd(skill: SkillCard) {
    if (!token || !agentSel) return;
    const agent = agents.find((a) => a.id === agentSel);
    if (!agent) return;
    setAdding(true);
    setAddErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (skill.kind === 'tool' && skill.tool_id) {
        const cur = Array.isArray(agent.tools) ? (agent.tools as string[]) : [];
        if (cur.includes(skill.tool_id)) {
          setAddErr('Этот инструмент уже подключён агенту');
          setAdding(false);
          return;
        }
        patch.tools = [...cur, skill.tool_id];
      } else if (skill.kind === 'doc' && skill.body) {
        const header = `# Скилл: ${skill.title}`;
        if (agent.system_prompt.includes(header)) {
          setAddErr('Этот скилл уже добавлен агенту');
          setAdding(false);
          return;
        }
        patch.system_prompt = `${agent.system_prompt}\n\n${header}\n${skill.body}`.slice(0, 8000);
      } else {
        setAdding(false);
        return;
      }

      const res = await fetch(`/tg/api/tma/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAddErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      // Keep local agent snapshot in sync so a second add doesn't duplicate.
      if (data.agent) {
        setAgents((prev) =>
          prev.map((a) =>
            a.id === agent.id
              ? { ...a, tools: data.agent.tools, system_prompt: data.agent.system_prompt }
              : a,
          ),
        );
      }
      setAddedFor(agent.name);
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setAdding(false);
    }
  }

  const visible =
    skills?.filter((s) => {
      if (filter === 'all') return true;
      return s.kind === filter;
    }) ?? [];

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-eyebrow">Каталог</span>
          <h1 className="tma-title">Скиллы</h1>
          <p className="tma-subtitle">
            Скилл — это набор возможностей агента: инструмент, знание-инструкция или
            свой MCP-сервер. Добавьте скилл агенту в один тап.
          </p>
        </header>

        <CatalogNav active="skills" />

        <div className="tma-segment" role="tablist" aria-label="Тип скилла">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`tma-segment-btn${filter === f.key ? ' is-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading && <p className="tma-card-text">Загрузка…</p>}
        {!loading && error && (
          <div className="tma-card">
            <p className="tma-card-text">
              {error === 'Не открыто в Telegram'
                ? 'Откройте через @aiag_bot в Telegram'
                : `Ошибка авторизации: ${error}`}
            </p>
          </div>
        )}

        {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

        {user && !error && !skills && !fetchErr && (
          <p className="tma-card-text">Загрузка каталога…</p>
        )}

        {skills && (
          <div
            className="aiag-stagger"
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {visible.map((s) => {
              const hue = hueFor(s.id);
              const installable = s.kind === 'tool' || s.kind === 'doc';
              const isOpen = openId === s.id;
              return (
                <section key={s.id} className="tma-card aiag-glow-hover">
                  <div className="tma-row" style={{ alignItems: 'flex-start', gap: 12 }}>
                    <div
                      aria-hidden="true"
                      style={{
                        width: 44,
                        height: 44,
                        flexShrink: 0,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: 20,
                        background: `linear-gradient(155deg, oklch(0.32 0.08 ${hue}), oklch(0.18 0.04 ${hue}))`,
                        color: `oklch(0.92 0.10 ${hue})`,
                      }}
                    >
                      {monogram(s.title)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="tma-row" style={{ gap: 8 }}>
                        <h2 className="tma-card-title" style={{ margin: 0 }}>
                          {s.title}
                        </h2>
                        <span className={`tma-pill ${STATUS_PILL[s.status].cls}`}>
                          {STATUS_PILL[s.status].label}
                        </span>
                      </div>
                      <p className="tma-mono tma-text-small" style={{ opacity: 0.6 }}>
                        {s.name}
                      </p>
                    </div>
                  </div>

                  <p className="tma-card-text" style={{ marginTop: 8 }}>
                    {s.description}
                  </p>

                  <div className="tma-row" style={{ marginTop: 8 }}>
                    {s.cost_hint ? (
                      <span className="tma-nft-supply" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {s.cost_hint}
                      </span>
                    ) : (
                      <span className="tma-nft-supply">0 — бесплатно</span>
                    )}
                  </div>

                  {/* Actions */}
                  {s.kind === 'mcp' && (
                    <Link href="/agents" className="tma-btn" style={{ marginTop: 12 }}>
                      Настроить у агента →
                    </Link>
                  )}

                  {s.kind === 'soon' && (
                    <button
                      type="button"
                      className="tma-btn"
                      disabled
                      style={{ marginTop: 12, opacity: 0.5, cursor: 'not-allowed' }}
                    >
                      {s.status === 'rnd' ? 'R&D — недоступно' : 'Скоро'}
                    </button>
                  )}

                  {installable && !isOpen && (
                    <button
                      type="button"
                      className="tma-btn tma-btn--primary"
                      style={{ marginTop: 12 }}
                      onClick={() => openPanel(s.id)}
                    >
                      + Добавить агенту
                    </button>
                  )}

                  {installable && isOpen && (
                    <div
                      style={{
                        marginTop: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        padding: 12,
                        background: 'var(--bg-surface)',
                      }}
                    >
                      {agents.length === 0 ? (
                        <>
                          <p className="tma-card-text tma-text-small">
                            У вас пока нет агентов. Сначала создайте агента.
                          </p>
                          <Link href="/agents/new" className="tma-btn">
                            + Создать агента
                          </Link>
                        </>
                      ) : addedFor ? (
                        <>
                          <div className="tma-success">
                            Скилл добавлен агенту «{addedFor}».
                          </div>
                          <button
                            type="button"
                            className="tma-btn"
                            onClick={() => setOpenId(null)}
                          >
                            Готово
                          </button>
                        </>
                      ) : (
                        <>
                          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <span className="tma-card-text">Выберите агента</span>
                            <select
                              value={agentSel}
                              onChange={(e) => setAgentSel(e.target.value)}
                              style={selectStyle}
                            >
                              {agents.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {addErr && <div className="tma-error">Ошибка: {addErr}</div>}
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              type="button"
                              className="tma-btn"
                              onClick={() => setOpenId(null)}
                              disabled={adding}
                            >
                              Отмена
                            </button>
                            <button
                              type="button"
                              className="tma-btn tma-btn--primary"
                              style={{ flex: 1 }}
                              onClick={() => handleAdd(s)}
                              disabled={adding || !agentSel}
                            >
                              {adding ? 'Добавление…' : 'Добавить'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
      <BottomNav />
    </>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg-surface)',
  color: 'var(--ink)',
  fontSize: 14,
  outline: 'none',
};
