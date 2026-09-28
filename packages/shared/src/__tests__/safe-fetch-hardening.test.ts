import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dnsLookup = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const destroy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('node:dns', () => ({ lookup: dnsLookup }));
vi.mock('undici', () => ({ Agent: vi.fn(() => ({ close, destroy })) }));
import { classifyBlockedIp, safeFetch } from '../safe-fetch';

const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
beforeEach(() => {
  vi.clearAllMocks();
  dnsLookup.mockImplementation((_host, _options, callback) => {
    callback(null, [{ address: '93.184.216.34', family: 4 }]);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (bunDescriptor) Object.defineProperty(process.versions, 'bun', bunDescriptor);
  else Reflect.deleteProperty(process.versions, 'bun');
});

describe('safeFetch runtime and resource boundaries', () => {
  it('pins Bun to the vetted address, preserves TLS identity and disables implicit proxy', async () => {
    Object.defineProperty(process.versions, 'bun', { configurable: true, value: '1.4.2' });
    const transport = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', transport);
    const result = await safeFetch('https://author.example.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer test' }, body: '{}', maxRedirects: 0,
    });
    expect(await result.text()).toBe('ok');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://93.184.216.34/v1/chat/completions');
    expect(new Headers(init.headers).get('host')).toBe('author.example.com');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test');
    expect(init.tls).toEqual({ serverName: 'author.example.com' });
    expect(init.proxy).toBe(false);
    expect(init.dispatcher).toBeUndefined();
  });

  it('aborts DNS waiting and never dispatches after a late DNS callback', async () => {
    let complete: ((error: null, records: { address: string; family: number }[]) => void) | undefined;
    dnsLookup.mockImplementationOnce((_host, _options, callback) => { complete = callback; });
    const transport = vi.fn().mockResolvedValue(new Response('unexpected'));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const outcome = safeFetch('https://author.example.com/chat/completions', {
      signal: controller.signal,
    }).then(() => 'resolved', () => 'aborted');
    await Promise.resolve();
    controller.abort();
    // A short sentinel exposes a stuck DNS promise without waiting for the test timeout.
    const observed = await Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve('stuck'), 30))]);
    complete?.(null, [{ address: '93.184.216.34', family: 4 }]);
    await outcome;
    expect(observed).toBe('aborted');
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not resolve DNS or dispatch an already aborted request', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('unexpected'));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    controller.abort();
    await expect(safeFetch('https://author.example.com/chat/completions', {
      signal: controller.signal,
    })).rejects.toBeDefined();
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('strips credentials on a cross-origin redirect and cancels the discarded body', async () => {
    const cancel = vi.fn();
    const redirect = new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { location: 'https://second.example.com/next' },
    });
    const transport = vi.fn().mockResolvedValueOnce(redirect).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', transport);
    const result = await safeFetch('https://first.example.com/start', {
      headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', 'Proxy-Authorization': 'secret' },
      allowlist: ['first.example.com', 'second.example.com'],
    });
    expect(await result.text()).toBe('ok');
    const headers = new Headers(transport.mock.calls[1][1].headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('proxy-authorization')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a forbidden redirect without sending a second request', async () => {
    const cancel = vi.fn();
    const transport = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { location: 'https://second.example.com/' },
    }));
    vi.stubGlobal('fetch', transport);
    await expect(safeFetch('https://first.example.com/', {
      allowlist: ['first.example.com'], maxRedirects: 0,
    })).rejects.toMatchObject({ reason: 'redirect_limit' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('closes its Node dispatcher after headers without awaiting stream completion', async () => {
    Reflect.deleteProperty(process.versions, 'bun');
    const transport = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', transport);
    expect(await (await safeFetch('https://author.example.com/')).text()).toBe('ok');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('destroys its Node dispatcher when transport fails', async () => {
    Reflect.deleteProperty(process.versions, 'bun');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection lost')));
    await expect(safeFetch('https://author.example.com/')).rejects.toThrow('connection lost');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:0000:0000:0000'])(
    'rejects expanded private IPv6: %s', (ip) => { expect(classifyBlockedIp(ip)).not.toBeNull(); },
  );
});
