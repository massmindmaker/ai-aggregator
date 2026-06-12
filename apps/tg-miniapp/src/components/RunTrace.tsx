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
// Tool-call sub-cards ARE rendered when present: the run row carries a `tool_calls`
// jsonb array (agent_runs.tool_calls, default []) that the worker writes per agent
// step — each becomes a collapsible <details> card (tool name + duration + cost +
// status). Empty/legacy runs have [] → the block silently degrades to nothing.
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
  /** Per-step trace the worker writes into agent_runs.tool_calls (jsonb, default []). */
  tool_calls?: Array<{
    name: string;
    args?: unknown;
    result?: string | null;
    cost_credits?: number;
    duration_ms?: number;
    status?: string;
  }>;
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

// Tool-step status → pill (icon + word + colour; never colour alone — DESIGN.md).
function toolStatusMeta(status?: string): { label: string; tone: Tone; icon: string } {
  if (status === 'error') return { label: 'ошибка', tone: 'err', icon: '✗' };
  return { label: 'ok', tone: 'ok', icon: '✓' };
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

              {!!r.tool_calls?.length && (
                <ul className="tma-trace-tools">
                  {r.tool_calls.map((tc, i) => {
                    const ts = toolStatusMeta(tc.status);
                    const hasArgs =
                      tc.args !== undefined && tc.args !== null;
                    const hasResult =
                      typeof tc.result === 'string' && tc.result.length > 0;
                    const result = hasResult ? tc.result!.slice(0, 400) : '';
                    return (
                      <li key={i} className="tma-trace-tool">
                        <details>
                          <summary className="tma-trace-tool-head">
                            <span className="tma-trace-tool-icon" aria-hidden>
                              🔧
                            </span>
                            <span className="tma-trace-tool-name tma-num">
                              {tc.name}
                            </span>
                            {typeof tc.duration_ms === 'number' && (
                              <span className="tma-trace-tool-badge tma-num">
                                {tc.duration_ms} мс
                              </span>
                            )}
                            {typeof tc.cost_credits === 'number' && (
                              <span className="tma-trace-tool-cost tma-num">
                                {fmtCredits(String(tc.cost_credits))} кр
                              </span>
                            )}
                            <span
                              className={`tma-pill tma-pill--${ts.tone} tma-trace-tool-pill`}
                            >
                              {ts.icon} {ts.label}
                            </span>
                          </summary>
                          {hasArgs && (
                            <pre className="tma-trace-tool-body tma-mono">
                              {typeof tc.args === 'string'
                                ? tc.args
                                : JSON.stringify(tc.args, null, 2)}
                            </pre>
                          )}
                          {hasResult && (
                            <pre className="tma-trace-tool-body tma-mono">
                              {result}
                            </pre>
                          )}
                        </details>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
