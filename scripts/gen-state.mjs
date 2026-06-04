#!/usr/bin/env node
/**
 * gen-state.mjs — regenerate docs/specs/STATUS.html (the living status page) from
 * the SINGLE SOURCE OF TRUTH .planning/STATE.json.
 *
 * Workflow: on every ship, edit .planning/STATE.json, then run:
 *     node scripts/gen-state.mjs
 * The dashboard's «живой статус» card already points at the generated STATUS.html,
 * so the project state stays current with ZERO hand-editing of HTML.
 *
 * No dependencies — plain Node + fs. Also prints a compact summary that can be
 * synced into memory (memgraph / auto-memory / LightRAG-wiki).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(readFileSync(join(root, '.planning/STATE.json'), 'utf8'));
const OUT = join(root, 'docs/specs/STATUS.html');

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const code = (s) => `<code>${esc(s)}</code>`;
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function li(inner, cls = '') {
  return `<li${cls ? ` class="${cls}"` : ''}>${inner}</li>`;
}
function section(eyebrow, title, body) {
  return `<section>\n  <div class="eyebrow">${esc(eyebrow)}</div>\n  <h2>${esc(title)}</h2>\n  ${body}\n</section>`;
}

const m = state.meta ?? {};
const scores = m.scores_108 ?? {};

// --- shipped --------------------------------------------------------------
const shipped = arr(state.shipped)
  .map((s) =>
    li(
      `<b>${esc(s.title)}</b> <span class="mono">${esc(s.date ?? '')}${s.commit ? ' · ' + esc(s.commit) : ''}${s.migration ? ' · mig ' + esc(s.migration) : ''}</span>` +
        (s.note ? `<div class="note">${esc(s.note)}</div>` : ''),
    ),
  )
  .join('\n    ');

// --- in progress ----------------------------------------------------------
const inprog = arr(state.in_progress)
  .map((s) => li(`<b>${esc(s.title)}</b>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}`))
  .join('\n    ');

// --- blocked --------------------------------------------------------------
const blocked = arr(state.blocked)
  .map((s) =>
    li(
      `<b>${esc(s.title)}</b><div class="note">⛔ ${esc(s.blocker)} · <b>${esc(s.owner ?? '')}</b>` +
        (s.signal ? `<br>🆕 ${esc(s.signal)}` : '') +
        (s.go_no_go ? `<br>go/no-go: ${esc(s.go_no_go)}` : '') +
        (s.doc ? `<br><a href="${esc(s.doc.replace(/^docs\//, '../'))}">${esc(s.doc)}</a>` : '') +
        `</div>`,
      'block',
    ),
  )
  .join('\n    ');

// --- decisions ------------------------------------------------------------
const decisions = arr(state.decisions_pending)
  .map((d) =>
    li(
      `<b>${esc(d.id)}</b> — ${esc(d.question)}${d.blocks ? `<div class="note">блокирует: ${esc(d.blocks)}</div>` : ''}`,
      'need',
    ),
  )
  .join('\n    ');

// --- backlog --------------------------------------------------------------
const backlog = arr(state.backlog)
  .map((b) =>
    li(
      `<b>${esc(b.title)}</b> <span class="tag">${esc(b.risk ?? '')}</span>` +
        (b.needs ? ` <span class="note-inline">нужно: ${esc(b.needs)}</span>` : '') +
        (b.note ? `<div class="note">${esc(b.note)}</div>` : ''),
    ),
  )
  .join('\n    ');

// --- founder tasks --------------------------------------------------------
const founder = arr(state.founder_tasks)
  .map((t) =>
    li(
      `<b>${esc(t.title)}</b> <span class="tag">${esc(t.status ?? '')}</span>` +
        (t.provided ? `<div class="note">✅ дано: ${arr(t.provided).map(esc).join(' · ')}</div>` : '') +
        (t.remaining ? `<div class="note">⏳ осталось: ${arr(t.remaining).map(esc).join(' · ')}</div>` : '') +
        (t.unblocks ? `<div class="note">разблокирует: ${esc(t.unblocks)}</div>` : ''),
      'need',
    ),
  )
  .join('\n    ');

// --- assets ---------------------------------------------------------------
const assets = arr(state.assets)
  .map((a) => {
    const href = a.path?.startsWith('docs/') ? a.path.replace(/^docs\//, '../') : a.path;
    return `<a class="file" href="${esc(href)}"><div class="t">${esc(a.type)} · ${esc(a.status)}</div>${esc(a.name)}</a>`;
  })
  .join('\n    ');

// --- checkpoints ----------------------------------------------------------
const checkpoints = arr(state.checkpoints)
  .map((c) =>
    li(
      `<b>${esc(c.milestone)}</b> <span class="mono">${esc(c.date ?? '')}</span> ${c.verified ? '<span class="ok">✓ проверено</span>' : '<span class="tag">не проверено</span>'}`,
      'done',
    ),
  )
  .join('\n    ');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AIAG — живой статус (генерируется из STATE.json)</title>
<style>
  :root{
    --bg:oklch(0.17 0.012 70);--bg2:oklch(0.21 0.014 70);--line:oklch(0.32 0.015 70);
    --ink:oklch(0.94 0.01 80);--dim:oklch(0.72 0.015 75);--faint:oklch(0.56 0.015 75);
    --amber:oklch(0.80 0.15 75);--good:oklch(0.80 0.14 155);--soon:oklch(0.78 0.10 245);--red:oklch(0.70 0.17 25);
    --mono:'JetBrains Mono',ui-monospace,Menlo,monospace;--sans:-apple-system,'Segoe UI',Roboto,system-ui,sans-serif;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.6;padding:0 24px 100px}
  .wrap{max-width:860px;margin:0 auto}
  a{color:var(--amber);text-decoration:none}a:hover{text-decoration:underline}
  header{padding:56px 0 28px;border-bottom:1px solid var(--line)}
  .kick{font-family:var(--mono);font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--amber);margin-bottom:14px}
  h1{font-size:36px;letter-spacing:-.02em;margin-bottom:12px}
  .lead{color:var(--dim);max-width:70ch}
  .pillrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .pill{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-radius:20px;padding:4px 11px;color:var(--dim);background:var(--bg2)}
  section{padding:30px 0;border-bottom:1px solid var(--line)}
  h2{font-size:19px;margin-bottom:6px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
  ul{list-style:none;display:flex;flex-direction:column;gap:10px;margin-top:10px}
  li{padding-left:22px;position:relative;color:var(--dim)}
  li::before{content:"";position:absolute;left:0;top:9px;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--amber)}
  li.done::before{border-color:var(--good);background:var(--good)}
  li.block::before{border-color:var(--red);background:var(--red)}
  li.need::before{border-color:var(--soon)}
  li b{color:var(--ink)}
  .note{color:var(--faint);font-size:13.5px;margin-top:3px}
  .note-inline{color:var(--faint);font-size:12.5px}
  .mono{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
  .ok{color:var(--good);font-family:var(--mono);font-size:11px}
  .tag{font-family:var(--mono);font-size:10px;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--faint)}
  code{font-family:var(--mono);font-size:12.5px;color:var(--amber);background:var(--bg2);padding:1px 5px;border-radius:4px}
  .files{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
  .file{border:1px solid var(--line);border-radius:10px;padding:11px 13px;background:var(--bg2);font-size:14px;color:var(--ink)}
  .file .t{font-size:10px;color:var(--faint);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
  .meta{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:10px}
  @media(max-width:640px){.files{grid-template-columns:1fr}}
</style>
</head>
<body><div class="wrap">

<header>
  <div class="kick">AIAG · живой статус · авто-генерируется</div>
  <h1>Статус проекта</h1>
  <p class="lead">Эта страница рисуется из <code>.planning/STATE.json</code> — единственного источника правды. Каждый шип двигает STATE.json, генератор перерисовывает эту страницу. Руками HTML не трогается → ничего не устаревает.</p>
  <div class="pillrow">
    <span class="pill">обновлено ${esc(m.updated ?? '')}</span>
    <span class="pill">ветка ${esc(m.branch ?? '')}</span>
    <span class="pill">${m.merged_to_master ? 'в master' : 'не в master'}</span>
    <span class="pill">dream-path ${esc(m.dream_path ?? '')}</span>
    <span class="pill">/108 · tech ${esc(scores.tech ?? '?')} · func ${esc(scores.functional ?? '?')} · design ${esc(scores.design ?? '?')}</span>
  </div>
  <p class="meta">${esc(m.prod ?? '')}</p>
</header>

${section('Выкачено + проверено', '🟢 Shipped', `<ul>\n    ${shipped}\n  </ul>`)}

${inprog ? section('В работе', '🔨 In progress', `<ul>\n    ${inprog}\n  </ul>`) : ''}

${blocked ? section('Заблокировано', '⛔ Blocked', `<ul>\n    ${blocked}\n  </ul>`) : ''}

${decisions ? section('Решения от тебя', '🔑 Нужно решение', `<ul>\n    ${decisions}\n  </ul>`) : ''}

${founder ? section('Задачи основателя', '👤 На тебе', `<ul>\n    ${founder}\n  </ul>`) : ''}

${backlog ? section('Бэклог (без блокеров)', '📋 Backlog', `<ul>\n    ${backlog}\n  </ul>`) : ''}

${checkpoints ? section('Вехи', '🏁 Checkpoints', `<ul>\n    ${checkpoints}\n  </ul>`) : ''}

${assets ? section('Ассеты', '📦 Assets', `<div class="files">\n    ${assets}\n  </div>`) : ''}

<section style="border-bottom:none">
  <p class="meta">Сгенерировано из <code>.planning/STATE.json</code> командой <code>node scripts/gen-state.mjs</code>. Не редактировать вручную — правь STATE.json.</p>
</section>

</div></body></html>
`;

writeFileSync(OUT, html, 'utf8');

// --- memory automation: also emit a clean, AI/human-readable CURRENT-STATE.md ---
// One command (node scripts/gen-state.mjs) now refreshes BOTH the dashboard's
// STATUS.html AND this flat summary, so "what the founder sees" stays in sync with a
// memory-ingestable doc. (memgraph/LightRAG are MCP servers — not callable from a
// standalone script — so their push stays a periodic manual step that reads THIS file.)
const sec = (title, items) => (items.length ? `\n## ${title}\n${items.join('\n')}\n` : '');
const md =
  `# AIAG — current state (AUTO-GENERATED from .planning/STATE.json — do NOT edit by hand)\n\n` +
  `> updated ${m.updated ?? ''} · branch ${m.branch ?? ''} · ${m.merged_to_master ? 'in master' : 'not in master'} · ` +
  `scores/108: func ${scores.functional ?? '?'} / tech ${scores.tech ?? '?'} / design ${scores.design ?? '?'}\n` +
  `> ${m.prod ?? ''}\n` +
  sec('✅ Shipped', arr(state.shipped).map((s) => `- **${s.title}**${s.note ? ` — ${s.note}` : ''}`)) +
  sec('🔨 In progress', arr(state.in_progress).map((s) => `- **${s.title}**${s.note ? ` — ${s.note}` : ''}`)) +
  sec('⛔ Blocked', arr(state.blocked).map((s) => `- **${s.title}** — ${s.blocker} (${s.owner ?? ''})`)) +
  sec('🔑 Decisions pending', arr(state.decisions_pending).map((d) => `- **${d.id}** — ${d.question}`)) +
  sec('📋 Backlog', arr(state.backlog).map((b) => `- ${b.title} [${b.risk ?? ''}]`)) +
  sec('👤 Founder tasks', arr(state.founder_tasks).map((t) => `- ${t.title} [${t.status ?? ''}]`)) +
  `\n---\n_Source of truth: .planning/STATE.json · dashboard: docs/DASHBOARD.html · regenerate: node scripts/gen-state.mjs_\n`;
const MD_OUT = join(root, 'docs/specs/CURRENT-STATE.md');
writeFileSync(MD_OUT, md, 'utf8');

// Compact summary for memory sync (stdout).
const count = (k) => arr(state[k]).length;
console.log(`✓ generated ${OUT}`);
console.log(`✓ generated ${MD_OUT} (memory-readable)`);
console.log(
  `STATE: shipped=${count('shipped')} in_progress=${count('in_progress')} blocked=${count('blocked')} ` +
    `decisions=${count('decisions_pending')} backlog=${count('backlog')} founder_tasks=${count('founder_tasks')} ` +
    `assets=${count('assets')} checkpoints=${count('checkpoints')} · updated ${m.updated} · ${m.branch}`,
);
