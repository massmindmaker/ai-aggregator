'use client';

import { fmtCredits } from '@/lib/credits';

// ─────────────────────────────────────────────────────────────────────────────
// RunTrace — the "what did my agent do" surface (DESIGN.md signature component).
// A vertical step timeline of past runs; each step carries a status pill and a
// metrics strip: cost (кр), duration (сек), and a status. This is the single
// surface that makes the credit economy legible — the user finally SEES what a
// run cost («почему это стоило 12 кр»), instead of a faceless chat bubble.
//
// Read-only render of agent_runs (input/output/status/cost/error/timestamps).
// No tool-call sub-cards yet — the stateless runner does not emit per-tool steps
// (apps/agent-worker), so we render the run as the step and stay honest.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunItem {
  id: string;
  input: string;
  output: string | null;
  status: string;
  /** cost in CREDITS (DB column cost_credits, aliased cost_rub in the route). */
  cost_rub: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

type Tone = 'ok' | 'run' | 'err';

function statusMeta(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'completed':
      return { label: 'готово', tone: 'ok' };
    case 'failed':
    case 'error':
      return { label: 'ошибка', tone: 'err' };
    case 'running':
      return { label: 'работает', tone: 'run' };
    case 'pending':
    default:
      return { label: 'в очереди', tone: 'run' };
  }
}

// КАНОН: cost_rub приходит в ЦЕНТАХ США (D-1). Показ = центы ÷ 100 через общий
// lib/credits.fmtCredits — локальная копия без ÷100 врала в 100× (баг #3 аудита).

function fmtDuration(start: string, end: string | null): string | null {
  if (!end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  const sec = (b - a) / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} с`;
  return `${Math.round(sec / 60)} мин`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RunTrace({ runs }: { runs: RunItem[] }) {
  if (runs.length === 0) {
    return (
      <p className="tma-card-text">
        Запусков ещё нет. Напишите агенту первое задание ниже.
      </p>
    );
  }

  return (
    <ol className="tma-trace">
      {runs.map((r) => {
        const meta = statusMeta(r.status);
        const active = r.status === 'pending' || r.status === 'running';
        const dur = fmtDuration(r.created_at, r.completed_at);
        return (
          <li key={r.id} className="tma-trace-step">
            <span
              className={`tma-trace-dot tma-trace-dot--${meta.tone}${
                active ? ' aiag-pulse-dot' : ''
              }`}
              aria-hidden
            />
            <div className="tma-trace-card">
              <div className="tma-trace-head">
                <span className={`tma-pill tma-pill--${meta.tone}`}>
                  {meta.label}
                </span>
                <span className="tma-trace-time">{fmtTime(r.created_at)}</span>
              </div>

              <p className="tma-trace-input">{r.input}</p>

              {r.output && <p className="tma-trace-output">{r.output}</p>}

              {active && !r.output && (
                <p className="tma-trace-thinking">
                  <span className="aiag-pulse-dot tma-trace-thinking-dot" />
                  агент работает…
                </p>
              )}

              {r.error && <div className="tma-error">{r.error}</div>}

              <div className="tma-trace-metrics">
                <span className="tma-trace-metric">
                  <span className="tma-num">{fmtCredits(r.cost_rub)}</span>
                  <span className="tma-trace-metric-unit">кр</span>
                </span>
                {dur && (
                  <span className="tma-trace-metric">
                    <span className="tma-num">{dur}</span>
                  </span>
                )}
                <span className="tma-trace-id" title={r.id}>
                  #{r.id.slice(0, 8)}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
