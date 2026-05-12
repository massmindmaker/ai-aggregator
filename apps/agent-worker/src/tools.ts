/**
 * MVP tool implementations for the agent-worker.
 *
 * - web_search: simple DuckDuckGo HTML scrape (no API key required)
 * - calc:       sandboxed math expression eval (whitelisted charset)
 * - image_gen:  placeholder stub (real impl via Kie.ai in a later wave)
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
      description: 'Search the public web for up-to-date information. Returns top results with title, url and snippet.',
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
      description: 'Evaluate a basic math expression (digits, + - * / ( ) and decimal points only).',
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
      description: 'Generate an image from a text prompt. Returns a URL placeholder in MVP.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          aspect_ratio: { type: 'string', description: 'e.g. "1:1", "16:9"' },
        },
        required: ['prompt'],
      },
    },
  },
];

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
  // crude regex parse — DDG html version is stable enough for MVP
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
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
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

function decodeDdgUrl(href: string): string {
  // DDG wraps results in /l/?uddg=<encoded>
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return href;
  } catch {
    return href;
  }
}

function calc(expr: string): { result: number | string } {
  if (typeof expr !== 'string' || expr.length > 200) {
    return { result: 'error: invalid expression' };
  }
  // whitelist: digits, decimal, math operators, parens, whitespace
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

function imageGen(prompt: string, aspect_ratio?: string): { url: string; prompt: string; aspect_ratio: string } {
  // MVP stub
  return {
    url: `https://placehold.co/512x512/png?text=${encodeURIComponent(prompt.slice(0, 40))}`,
    prompt,
    aspect_ratio: aspect_ratio ?? '1:1',
  };
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'web_search':
        return await webSearch(String(args.query ?? ''));
      case 'calc':
        return calc(String(args.expr ?? ''));
      case 'image_gen':
        return imageGen(String(args.prompt ?? ''), args.aspect_ratio ? String(args.aspect_ratio) : undefined);
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
}
