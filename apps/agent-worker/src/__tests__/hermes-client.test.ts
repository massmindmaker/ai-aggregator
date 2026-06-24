import { describe, it, expect, vi, beforeEach } from 'vitest';
beforeEach(() => { process.env.HERMES_GATEWAY_URL='http://127.0.0.1:8642'; process.env.HERMES_API_KEY='k'; vi.restoreAllMocks(); });
import { hermesChat, hermesEnabled } from '../hermes-client';
it('hermesEnabled reflects env', () => { expect(hermesEnabled()).toBe(true); });
it('hermesChat posts profile-as-model + session-key, parses usage', async () => {
  const spy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(new Response(
    JSON.stringify({ choices:[{message:{content:'hi'}}], usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7} }),
    { status:200, headers:{'content-type':'application/json'} }));
  const r = await hermesChat({ profile:'backend-eng', messages:[{role:'user',content:'q'}], sessionKey:'run_1' });
  expect(r.content).toBe('hi'); expect(r.usage.total_tokens).toBe(7);
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:8642/v1/chat/completions');
  expect((init.headers as Record<string,string>)['X-Hermes-Session-Key']).toBe('run_1');
  expect(JSON.parse(init.body as string).model).toBe('backend-eng');
});
it('hermesChat throws hermes_unreachable on non-2xx', async () => {
  vi.spyOn(globalThis,'fetch' as any).mockResolvedValue(new Response('e',{status:502}));
  await expect(hermesChat({ profile:'x', messages:[], sessionKey:'r' })).rejects.toThrow('hermes_unreachable');
});
