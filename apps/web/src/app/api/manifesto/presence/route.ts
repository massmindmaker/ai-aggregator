import { NextRequest } from 'next/server';
import {
  buildSystemPrompt,
  fallbackReply,
  sanitizeReply,
} from '@/app/manifesto/presence/dialogue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/manifesto/presence — OPTIONAL flavour layer for the «ПРОСНИСЬ» quest.
 *
 * POST { word, inventory } → { reply }   (always 200, always a reply)
 *
 * The quest itself (wake word, the three questions, expected answers) is
 * DETERMINISTIC and lives client-side in LivingText. This route is consulted
 * ONLY to dress up a WRONG-answer deflection with a little variety. EVERY
 * failure path — missing env, timeout, non-200, empty/mock body, a reply that
 * uses letters the page doesn't physically have — collapses into a
 * deterministic deflection from dialogue.ts. The page must NEVER see an error.
 */

const PRESENCE_URL =
  process.env.MANIFESTO_PRESENCE_URL ??
  'http://127.0.0.1:4000/v1/chat/completions';
const PRESENCE_KEY = process.env.MANIFESTO_PRESENCE_KEY ?? '';
const PRESENCE_MODEL = process.env.MANIFESTO_PRESENCE_MODEL ?? 'gpt-4o-mini';

const TIMEOUT_MS = 6000;
const MAX_WORDS = 3;

// ── Rate-limit: ≤1 generated reply / 20s / IP (in-memory, resets on restart) ──
const ipHits = new Map<string, number>();
const RL_WINDOW_MS = 20_000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (ipHits.size > 10_000) {
    for (const [k, v] of ipHits) if (now - v > RL_WINDOW_MS) ipHits.delete(k);
  }
  const last = ipHits.get(ip);
  if (last !== undefined && now - last < RL_WINDOW_MS) return true;
  ipHits.set(ip, now);
  return false;
}

function getClientIp(req: NextRequest): string {
  const realIp = req.headers.get('x-real-ip');
  if (realIp && /^[\d.:a-f]+$/i.test(realIp)) return realIp;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const ips = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const last = ips[ips.length - 1];
    if (last && /^[\d.:a-f]+$/i.test(last)) return last;
  }
  return 'unknown';
}

/**
 * Keep only reply letters that physically exist in the page inventory.
 * A word containing any absent letter is dropped entirely — the client turns
 * truly-missing glyphs into the faint amber `_`, but the server prefers to hand
 * back something fully lightable. If nothing survives, signal '' so the caller
 * falls back to the deterministic tree.
 */
function constrainToInventory(reply: string, inventory: string): string {
  const have = new Set(
    inventory.toUpperCase().replace(/Ё/g, 'Е').replace(/[^А-Я]/g, ''),
  );
  if (have.size === 0) return reply; // no inventory given → trust sanitized reply
  const kept = reply
    .split(' ')
    .filter((w) => w.length > 0 && [...w].every((ch) => have.has(ch)));
  return kept.slice(0, MAX_WORDS).join(' ');
}

interface PresenceRequest {
  word?: string;
  inventory?: string;
}

export async function POST(req: NextRequest) {
  let body: PresenceRequest;
  try {
    body = (await req.json()) as PresenceRequest;
  } catch {
    // Even malformed input gets an in-character answer, never a hard error.
    return Response.json({ reply: fallbackReply('') });
  }

  const word = (body.word ?? '').slice(0, 64).trim();
  const inventory = (body.inventory ?? '').slice(0, 200);

  // Empty spell → silent-ish nudge from the tree.
  if (!word) return Response.json({ reply: fallbackReply('') });

  const ip = getClientIp(req);

  // No key, or rate-limited → deterministic fallback (still a real answer).
  if (!PRESENCE_KEY || rateLimited(ip)) {
    return Response.json({ reply: fallbackReply(word) });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(PRESENCE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PRESENCE_KEY}`,
        'x-aiag-manifesto': '1',
      },
      body: JSON.stringify({
        model: PRESENCE_MODEL,
        stream: false,
        temperature: 0.9,
        max_tokens: 24,
        messages: [
          { role: 'system', content: buildSystemPrompt(inventory) },
          { role: 'user', content: word },
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      return Response.json({ reply: fallbackReply(word) });
    }

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data?.choices?.[0]?.message?.content ?? '';
    let reply = sanitizeReply(raw, MAX_WORDS);
    reply = constrainToInventory(reply, inventory);

    // Empty, or obvious mock/echo of the prompt → fall back.
    if (!reply) return Response.json({ reply: fallbackReply(word) });

    return Response.json({ reply });
  } catch {
    // timeout / network / parse — the page never learns of it.
    return Response.json({ reply: fallbackReply(word) });
  } finally {
    clearTimeout(timer);
  }
}
