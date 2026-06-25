import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /tg/api/tma/hermes-catalog
 *
 * Live capability catalog for the «Скиллы» tab in /market. Server-side proxy to
 * the founder's Hermes runtime (HERMES_GATEWAY_URL + HERMES_API_KEY): we read
 * BOTH /v1/toolsets and /v1/skills, normalize, and return the catalog. NO money
 * path, NO new runtime — read-only display data.
 *
 * Auth-gated (x-tma-user-id, set by middleware after JWT verify, stripped at
 * nginx) — same as the other tma routes.
 *
 * Graceful degradation: on ANY error / missing env / non-2xx the route returns
 * { toolsets:[], skills:[], source:'fallback' } with status 200 (never 500), so
 * the client can fall back to its built-in list without an error scare.
 *
 * Cache: module-level in-memory cache (~5-min TTL) protects the small Hermes box
 * from being hammered. Module scope persists across requests in the Next server,
 * so a successful fetch is served from memory until it goes stale.
 *
 * The API key is NEVER returned — only the normalized catalog leaves the server.
 */

interface ToolsetOut {
  name: string;
  label: string;
  description: string;
  tools: string[];
  enabled: boolean;
}
interface SkillOut {
  name: string;
  description: string;
}
interface Catalog {
  toolsets: ToolsetOut[];
  skills: SkillOut[];
  source: 'hermes' | 'fallback';
}

// Module-level cache. Persists across requests within a server instance.
const TTL_MS = 5 * 60 * 1000; // 5 минут — щадим маленький бокс Hermes.
let cache: { data: Catalog; exp: number } | null = null;

const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url: string, apiKey: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeToolsets(raw: unknown): ToolsetOut[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((t): ToolsetOut | null => {
      const o = t as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : '';
      if (!name) return null;
      const tools = Array.isArray(o.tools)
        ? o.tools.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        name,
        label: typeof o.label === 'string' && o.label ? o.label : name,
        description: typeof o.description === 'string' ? o.description : '',
        tools,
        enabled: o.enabled !== false,
      };
    })
    .filter((x): x is ToolsetOut => x !== null);
}

function normalizeSkills(raw: unknown): SkillOut[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((s): SkillOut | null => {
      const o = s as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : '';
      if (!name) return null;
      return { name, description: typeof o.description === 'string' ? o.description : '' };
    })
    .filter((x): x is SkillOut => x !== null);
}

const FALLBACK: Catalog = { toolsets: [], skills: [], source: 'fallback' };

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Serve fresh cache without touching the box.
  if (cache && cache.exp > Date.now()) {
    return NextResponse.json(cache.data);
  }

  const base = process.env.HERMES_GATEWAY_URL;
  const apiKey = process.env.HERMES_API_KEY;
  if (!base || !apiKey) {
    return NextResponse.json(FALLBACK);
  }

  const root = base.replace(/\/+$/, '');
  const [toolsetsRes, skillsRes] = await Promise.allSettled([
    fetchJson(`${root}/v1/toolsets`, apiKey),
    fetchJson(`${root}/v1/skills`, apiKey),
  ]);

  const toolsets =
    toolsetsRes.status === 'fulfilled' ? normalizeToolsets(toolsetsRes.value) : [];
  const skills = skillsRes.status === 'fulfilled' ? normalizeSkills(skillsRes.value) : [];

  // If both calls failed, degrade to fallback (and don't cache the empty result
  // long — let the next request retry the box).
  if (toolsetsRes.status === 'rejected' && skillsRes.status === 'rejected') {
    return NextResponse.json(FALLBACK);
  }

  const data: Catalog = { toolsets, skills, source: 'hermes' };
  cache = { data, exp: Date.now() + TTL_MS };
  return NextResponse.json(data);
}
