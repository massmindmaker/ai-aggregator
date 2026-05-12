/**
 * Tool implementations for the agent-worker.
 *
 * - web_search: DuckDuckGo HTML scrape (no API key required)
 * - calc:       sandboxed math expression eval (whitelisted charset)
 * - image_gen:  Kie.ai nano-banana-pro async task (createTask → poll → URL)
 */

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web for up-to-date information. Returns top results with title, url and snippet.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc',
      description:
        'Evaluate a basic math expression (digits, + - * / ( ) and decimal points only).',
      parameters: {
        type: 'object',
        properties: { expr: { type: 'string', description: 'Math expression, e.g. "2+2*3"' } },
        required: ['expr'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_gen',
      description:
        'Generate an image from a text prompt via Kie.ai (Gemini 3 nano-banana-pro). Synchronous: waits up to 60s for the rendered URL.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          aspect_ratio: {
            type: 'string',
            description: 'Image aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4',
          },
        },
        required: ['prompt'],
      },
    },
  },
];

/**
 * Filter TOOL_DEFS by an agent's tools[] whitelist. An empty whitelist
 * disables tools entirely — model answers from its own knowledge.
 */
export function pickToolDefs(allowed: string[] | null | undefined): ToolDef[] {
  if (!allowed || allowed.length === 0) return [];
  const set = new Set(allowed);
  return TOOL_DEFS.filter((t) => set.has(t.function.name));
}

// -- web_search ----------------------------------------------------------

interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

async function webSearch(query: string): Promise<{ results: WebResult[] }> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      accept: 'text/html',
    },
  });
  if (!res.ok) {
    return { results: [{ title: 'error', url: '', snippet: `DDG ${res.status}` }] };
  }
  const html = await res.text();
  const results: WebResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < 5) {
    const href = m[1];
    const title = stripTags(m[2]).trim();
    const snippet = stripTags(m[3]).trim();
    if (href && title) {
      results.push({ title, url: decodeDdgUrl(href), snippet });
    }
  }
  return { results };
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

function decodeDdgUrl(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return href;
  } catch {
    return href;
  }
}

// -- calc ----------------------------------------------------------------

function calc(expr: string): { result: number | string } {
  if (typeof expr !== 'string' || expr.length > 200) {
    return { result: 'error: invalid expression' };
  }
  if (!/^[\d+\-*/().\s]+$/.test(expr)) {
    return { result: 'error: only digits and + - * / ( ) allowed' };
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${expr});`);
    const v = fn();
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { result: 'error: non-finite result' };
    }
    return { result: v };
  } catch (e) {
    return { result: `error: ${(e as Error).message}` };
  }
}

// -- image_gen via Kie.ai ------------------------------------------------

const KIE_BASE = 'https://api.kie.ai';
const KIE_MODEL = 'google/nano-banana-pro';
// Approx Kie pricing for nano-banana-pro (per image, RUB).
const KIE_COST_RUB = 6.5;

interface KieCreateResp {
  code?: number;
  msg?: string;
  data?: { taskId?: string };
}
interface KieStatusResp {
  code?: number;
  data?: {
    state?: string;          // 'waiting' | 'queuing' | 'generating' | 'success' | 'fail'
    resultJson?: string;     // JSON-encoded { resultUrls: string[] }
    failMsg?: string;
  };
}

async function kieCreateTask(prompt: string, aspect: string): Promise<string> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY not set');
  const res = await fetch(`${KIE_BASE}/api/v1/playground/createTask`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: KIE_MODEL,
      input: { prompt, aspect_ratio: aspect, output_format: 'png' },
    }),
  });
  if (!res.ok) throw new Error(`Kie createTask ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as KieCreateResp;
  if (j.code !== 200 || !j.data?.taskId) {
    throw new Error(`Kie createTask err: ${j.msg ?? JSON.stringify(j)}`);
  }
  return j.data.taskId;
}

async function kiePoll(taskId: string, timeoutMs = 60_000): Promise<string> {
  const apiKey = process.env.KIE_API_KEY!;
  const t0 = Date.now();
  let delay = 1500;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.3, 4000);
    const res = await fetch(
      `${KIE_BASE}/api/v1/playground/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) continue;
    const j = (await res.json()) as KieStatusResp;
    const state = j.data?.state;
    if (state === 'success' && j.data?.resultJson) {
      try {
        const parsed = JSON.parse(j.data.resultJson) as { resultUrls?: string[] };
        const url = parsed.resultUrls?.[0];
        if (url) return url;
      } catch {
        /* ignore parse */
      }
    }
    if (state === 'fail') {
      throw new Error(`Kie task failed: ${j.data?.failMsg ?? 'unknown'}`);
    }
  }
  throw new Error('Kie task timeout');
}

interface ImageGenResult {
  url: string;
  prompt: string;
  aspect_ratio: string;
  cost_rub: number;
}

async function imageGen(prompt: string, aspectRaw?: string): Promise<ImageGenResult> {
  const aspect = normaliseAspect(aspectRaw);
  if (!process.env.KIE_API_KEY) {
    // Graceful fallback for envs without Kie configured
    return {
      url: `https://placehold.co/512x512/png?text=${encodeURIComponent(prompt.slice(0, 40))}`,
      prompt,
      aspect_ratio: aspect,
      cost_rub: 0,
    };
  }
  const taskId = await kieCreateTask(prompt, aspect);
  const url = await kiePoll(taskId);
  return { url, prompt, aspect_ratio: aspect, cost_rub: KIE_COST_RUB };
}

function normaliseAspect(a?: string): string {
  if (!a) return '1:1';
  const allowed = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
  return allowed.has(a) ? a : '1:1';
}

// -- dispatcher ----------------------------------------------------------

export interface ToolExecResult {
  result: unknown;
  cost_rub: number;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  try {
    switch (name) {
      case 'web_search':
        return { result: await webSearch(String(args.query ?? '')), cost_rub: 0 };
      case 'calc':
        return { result: calc(String(args.expr ?? '')), cost_rub: 0 };
      case 'image_gen': {
        const r = await imageGen(
          String(args.prompt ?? ''),
          args.aspect_ratio ? String(args.aspect_ratio) : undefined,
        );
        return { result: { url: r.url, aspect_ratio: r.aspect_ratio }, cost_rub: r.cost_rub };
      }
      default:
        return { result: { error: `unknown tool: ${name}` }, cost_rub: 0 };
    }
  } catch (e) {
    return { result: { error: (e as Error).message }, cost_rub: 0 };
  }
}
