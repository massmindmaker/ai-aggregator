import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentRow } from '../db.js';

// Mock the DB + crypto seams so resolveUpstream's provider branch runs without
// a live database. loadProviderCredential returns a fixture; decryptSecret is
// a passthrough that proves the ciphertext Buffer reaches it.
vi.mock('../db.js', () => ({
  loadProviderCredential: vi.fn(),
}));
vi.mock('../crypto.js', () => ({
  decryptSecret: vi.fn((buf: Buffer) => `decrypted:${buf.toString('utf8')}`),
}));

import { resolveUpstream, callWithFallback } from '../agent-runner.js';
import { loadProviderCredential } from '../db.js';
import { decryptSecret } from '../crypto.js';

const mockLoadCred = vi.mocked(loadProviderCredential);
const mockDecrypt = vi.mocked(decryptSecret);

/** Build a full AgentRow fixture with every field from the extended interface. */
function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'a1',
    tg_user_id: '111',
    name: 'Test Agent',
    system_prompt: 'be helpful',
    tools: [],
    model_slug: null,
    budget_rub_monthly: '1000',
    daily_budget_rub: '100',
    spent_today_rub: '0',
    spent_today_date: '2026-06-02',
    status: 'active',
    connection_type: 'aiag',
    external_base_url: null,
    external_api_key_encrypted: null,
    external_model_slug: null,
    provider_id: null,
    model_id: null,
    auth_ref: null,
    base_url_override: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveUpstream', () => {
  it('aiag + provider_id NULL with AIAG_GATEWAY_KEY set → routes to the :4000 gateway', async () => {
    vi.stubEnv('AIAG_GATEWAY_KEY', 'sk_aiag_live_test');
    const u = await resolveUpstream(makeAgent({ connection_type: 'aiag' }));
    expect(u.url).toBe('http://127.0.0.1:4000/v1/chat/completions');
    expect(u.apiKey).toBe('sk_aiag_live_test');
    expect(u.isExternal).toBe(false);
  });

  it('aiag with AIAG_GATEWAY_KEY unset → throws', async () => {
    vi.stubEnv('AIAG_GATEWAY_KEY', '');
    await expect(resolveUpstream(makeAgent({ connection_type: 'aiag' }))).rejects.toThrow(
      'AIAG_GATEWAY_KEY not set',
    );
  });

  it('external_openai with base "https://x/v1" → appends /chat/completions, isExternal true', async () => {
    const u = await resolveUpstream(
      makeAgent({
        connection_type: 'external_openai',
        external_base_url: 'https://x/v1',
        external_api_key_encrypted: Buffer.from('userkey'),
        external_model_slug: 'gpt-4o',
      }),
    );
    expect(u.url).toBe('https://x/v1/chat/completions');
    expect(u.isExternal).toBe(true);
    expect(u.model).toBe('gpt-4o');
  });

  it('external_openai with base already ending /chat/completions → no double-append', async () => {
    const u = await resolveUpstream(
      makeAgent({
        connection_type: 'external_openai',
        external_base_url: 'https://x/v1/chat/completions',
        external_api_key_encrypted: Buffer.from('userkey'),
      }),
    );
    expect(u.url).toBe('https://x/v1/chat/completions');
    expect(u.isExternal).toBe(true);
  });

  it('provider_id set → loads credential, decrypts, base_url_override wins over api_base, isExternal false', async () => {
    mockLoadCred.mockResolvedValue({
      provider_id: 'openai',
      api_base: 'https://api.openai.com/v1',
      base_url: null,
      model_id: 'gpt-4o-mini',
      enc_key: Buffer.from('ciphertext'),
      requires_base_url: false,
    });
    const u = await resolveUpstream(
      makeAgent({
        connection_type: 'aiag',
        provider_id: 'openai',
        auth_ref: 'cred-uuid',
        base_url_override: 'https://proxy.example/v1',
        model_id: 'my-model',
      }),
    );
    expect(mockLoadCred).toHaveBeenCalledWith('cred-uuid');
    expect(mockDecrypt).toHaveBeenCalledWith(Buffer.from('ciphertext'));
    // base_url_override takes precedence over the catalog api_base
    expect(u.url).toBe('https://proxy.example/v1/chat/completions');
    expect(u.apiKey).toBe('decrypted:ciphertext');
    expect(u.model).toBe('my-model');
    expect(u.isExternal).toBe(false);
  });

  it('provider_id set but credential missing → throws provider_credential_missing', async () => {
    mockLoadCred.mockResolvedValue(null);
    await expect(
      resolveUpstream(makeAgent({ provider_id: 'openai', auth_ref: 'gone' })),
    ).rejects.toThrow('provider_credential_missing');
  });
});

describe('callWithFallback — gateway → OpenRouter degraded fallback', () => {
  const GATEWAY = 'http://127.0.0.1:4000/v1/chat/completions';
  const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

  it('gateway returns 404/model_not_found → re-issues to OpenRouter with OPENROUTER_API_KEY', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or_key_test');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === GATEWAY) {
        return new Response('{"error":{"code":"model_not_found"}}', { status: 404 });
      }
      // second hop → openrouter
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resp = await callWithFallback(
      { url: GATEWAY, apiKey: 'sk_aiag', model: 'm', isExternal: false },
      { model: 'm', messages: [] },
    );
    expect(resp.choices[0]?.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // assert the second hop hit openrouter with the OPENROUTER_API_KEY bearer
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall?.[0]).toBe(OPENROUTER);
    const headers = (secondCall?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer or_key_test');
  });

  it('gateway 200 → no second OpenRouter call on the happy path', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const resp = await callWithFallback(
      { url: GATEWAY, apiKey: 'sk_aiag', model: 'm', isExternal: false },
      { model: 'm', messages: [] },
    );
    expect(resp.choices[0]?.message.content).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
