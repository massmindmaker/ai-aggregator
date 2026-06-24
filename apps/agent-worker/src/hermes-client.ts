// Hermes REST client (server #2 via reverse tunnel). OpenAI-compatible: profile = model.
// Auth = static Bearer API_SERVER_KEY; per-tenant isolation = X-Hermes-Session-Key
// (caller derives it from runId, never from the request body).
export function hermesEnabled(): boolean {
  return Boolean(process.env.HERMES_GATEWAY_URL && process.env.HERMES_API_KEY);
}
interface ChatArgs { profile: string; messages: Array<{ role: string; content: string }>; sessionKey: string; signal?: AbortSignal }
export async function hermesChat(args: ChatArgs): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const base = (process.env.HERMES_GATEWAY_URL ?? '').replace(/\/$/, '');
  const key = process.env.HERMES_API_KEY ?? '';
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Hermes-Session-Key': args.sessionKey },
      body: JSON.stringify({ model: args.profile, messages: args.messages, stream: false }),
      signal: args.signal,
    });
  } catch { throw new Error('hermes_unreachable'); }
  if (!res.ok) throw new Error('hermes_unreachable');
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  return {
    content: j.choices?.[0]?.message?.content ?? '',
    usage: { prompt_tokens: j.usage?.prompt_tokens ?? 0, completion_tokens: j.usage?.completion_tokens ?? 0, total_tokens: j.usage?.total_tokens ?? 0 },
  };
}
