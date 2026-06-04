import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

// Screen 29 «Маркет скиллов» v1 — read-only catalog of installable capability
// bundles. A "skill" here = {a built-in tool} OR {a knowledge/instruction doc}
// OR {a vetted MCP endpoint the user attaches with their own token}. This is a
// RELABEL of primitives we already ship (tools.ts + agent_templates + per-agent
// MCP) onto the agentskills.io SKILL.md frontmatter shape (name + description
// required). NO money path, NO new runtime. See
// docs/specs/research/2026-06-04-R15-skills-hub.md.
//
// Auth: this route is mounted behind the TMA middleware which verifies the
// HS256 JWT and injects x-tma-user-id. We require that header (reject anon) so
// the catalog is only served to an authed Mini-App session.

// The "kind" discriminates how the client installs the skill:
//   'tool'  → add `tool_id` to the agent's tools[] (PATCH agents/[id])
//   'doc'   → prepend the knowledge body to the agent's system_prompt
//   'mcp'   → user attaches their own MCP endpoint + token (info card, «свой ключ»)
//   'soon'  → R&D / «скоро» (executable scripts, slash invocation, community) — not installable
type SkillKind = 'tool' | 'doc' | 'mcp' | 'soon';

interface SkillCard {
  id: string;
  kind: SkillKind;
  // agentskills.io frontmatter shape (name + description required).
  name: string; // slug ([a-z0-9-])
  title: string; // human display (RU)
  description: string;
  // 'tool' cards carry the worker tool id to push into agent.tools[].
  tool_id?: string;
  // 'doc' cards carry the instruction body to prepend to system_prompt.
  body?: string;
  // honesty label (PRODUCT.md): everything shippable today is 'live';
  // unbuilt capability is 'soon' / 'rnd'.
  status: 'live' | 'soon' | 'rnd';
  // free for built-ins/docs/own-MCP; image_gen debits per use (BYOK rule intact).
  cost_hint: string | null;
  metadata?: Record<string, string>;
}

// --- Built-in tools as skill cards (source: apps/agent-worker/src/tools.ts) ---
// These install by adding `tool_id` to the agent's tools[] whitelist.
const BUILTIN_TOOL_SKILLS: SkillCard[] = [
  {
    id: 'tool:web_search',
    kind: 'tool',
    name: 'web-search',
    title: 'Веб-поиск',
    description:
      'Ищет свежую информацию в открытом вебе и возвращает заголовки, ссылки и сниппеты. Используй, когда нужны актуальные данные из интернета.',
    tool_id: 'web_search',
    status: 'live',
    cost_hint: null,
    metadata: { author: 'aiag', version: '1.0.0' },
  },
  {
    id: 'tool:calc',
    kind: 'tool',
    name: 'calc',
    title: 'Калькулятор',
    description:
      'Считает арифметические выражения (числа и + − × ÷ скобки). Используй для точных вычислений вместо прикидки в голове.',
    tool_id: 'calc',
    status: 'live',
    cost_hint: null,
    metadata: { author: 'aiag', version: '1.0.0' },
  },
  {
    id: 'tool:image_gen',
    kind: 'tool',
    name: 'image-gen',
    title: 'Генерация картинок',
    description:
      'Генерирует изображение по текстовому промпту. Используй, когда агенту нужно нарисовать картинку или превью.',
    tool_id: 'image_gen',
    status: 'live',
    cost_hint: '8 кр / картинку',
    metadata: { author: 'aiag', version: '1.0.0' },
  },
  {
    id: 'tool:memory',
    kind: 'tool',
    name: 'memory',
    title: 'Память',
    description:
      'Постоянная память агента: сохраняет и достаёт факты между запусками (имена, предпочтения, заметки). Используй, чтобы агент помнил контекст.',
    tool_id: 'memory',
    status: 'live',
    cost_hint: null,
    metadata: { author: 'aiag', version: '1.0.0' },
  },
];

// --- MCP attach as a skill card (per-agent MCP, read-only v1) ---
// Not installed from the catalog directly — the user attaches their own MCP
// endpoint + token on the agent (free, BYOK). This card explains + deep-links
// to the agent editor.
const MCP_SKILL: SkillCard = {
  id: 'mcp:attach',
  kind: 'mcp',
  name: 'mcp-server',
  title: 'MCP-сервер (свой)',
  description:
    'Подключи к агенту удалённый MCP-сервер по https — его инструменты станут доступны агенту. Свой сервер и токен = 0 комиссии. Настраивается в редакторе агента.',
  status: 'live',
  cost_hint: '0 — свой ключ',
  metadata: { author: 'aiag', version: '1.0.0' },
};

// --- «Скоро» / R&D cards — honest placeholders for unbuilt capability ---
// Executable scripts need a sandbox we don't have; slash-invocation +
// community submission need managed-Hermes. NOT installable.
const SOON_SKILLS: SkillCard[] = [
  {
    id: 'soon:scripts',
    kind: 'soon',
    name: 'scripts',
    title: 'Скилл со скриптами',
    description:
      'Скиллы с исполняемым кодом (scripts/). Появятся, когда заработает безопасная песочница. Пока недоступно.',
    status: 'rnd',
    cost_hint: null,
  },
  {
    id: 'soon:slash',
    kind: 'soon',
    name: 'slash-invoke',
    title: 'Вызов через /команду',
    description:
      'Запуск скилла командой /skill прямо в Telegram. Появится с управляемым рантаймом Hermes. Пока недоступно.',
    status: 'rnd',
    cost_hint: null,
  },
  {
    id: 'soon:community',
    kind: 'soon',
    name: 'community-submit',
    title: 'Свой скилл в каталог',
    description:
      'Публикация своих скиллов в общий каталог с проверкой безопасности. Появится позже. Пока недоступно.',
    status: 'soon',
    cost_hint: null,
  },
];

interface SkillRow {
  id: string;
  name: string;
  title: string | null;
  description: string;
  body: string;
  metadata: Record<string, string> | null;
}

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Published knowledge skills (table 0034). Optional: if the table doesn't
  // exist yet on prod, degrade to the built-in catalog rather than 500.
  let docSkills: SkillCard[] = [];
  try {
    const rows = (await sql`
      SELECT id::text, name, title, description, body, metadata
      FROM skills
      WHERE visibility = 'public'
      ORDER BY install_count DESC, created_at DESC
      LIMIT 100
    `) as unknown as SkillRow[];
    docSkills = rows.map((r) => ({
      id: `doc:${r.id}`,
      kind: 'doc' as const,
      name: r.name,
      title: r.title ?? r.name,
      description: r.description,
      body: r.body,
      status: 'live' as const,
      cost_hint: null,
      metadata: r.metadata ?? undefined,
    }));
  } catch (e) {
    // Table not migrated yet — built-ins still ship.
    console.error('skills doc fetch (non-fatal):', e);
  }

  const skills: SkillCard[] = [
    ...BUILTIN_TOOL_SKILLS,
    ...docSkills,
    MCP_SKILL,
    ...SOON_SKILLS,
  ];

  return NextResponse.json({ skills });
}
