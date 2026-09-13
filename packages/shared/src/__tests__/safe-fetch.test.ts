import { afterEach, describe, expect, it, vi } from 'vitest';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ lookup: dnsLookup }));

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

  it('applies the actual DNS policy branch before mocked fetch', async () => {
    dnsLookup.mockImplementationOnce((_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://provider-dns-policy.test/path')).rejects.toMatchObject({
      name: 'SsrfError',
      reason: 'policy_blocked',
    } satisfies Partial<SsrfError>);
    expect(dnsLookup).toHaveBeenCalledWith('provider-dns-policy.test', { all: true }, expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
