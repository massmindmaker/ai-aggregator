import { afterEach, describe, expect, it, vi } from 'vitest';

import { SsrfError, safeFetch } from '../safe-fetch';

afterEach(() => { vi.unstubAllGlobals(); });

describe('safeFetch redirect failures', () => {
  it('marks only exhausted redirect handling with redirect_limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {
      status: 302,
      headers: { location: 'https://allowed.test/next' },
    })));

    await expect(safeFetch('https://allowed.test/start', {
      allowlist: ['allowed.test'],
      maxRedirects: 0,
    })).rejects.toMatchObject({
      name: 'SsrfError',
      reason: 'redirect_limit',
    } satisfies Partial<SsrfError>);
  });

  it('keeps the default policy reason for existing one-argument construction', () => {
    expect(new SsrfError('blocked')).toMatchObject({
      name: 'SsrfError',
      message: 'blocked',
      reason: 'policy_blocked',
    });
  });
});
