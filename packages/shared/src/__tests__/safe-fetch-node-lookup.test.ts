import { afterEach, describe, expect, it, vi } from 'vitest';
const dnsLookup = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => ({ options: null as unknown }));
vi.mock('node:dns', () => ({ lookup: dnsLookup }));
vi.mock('undici', () => ({ Agent: vi.fn(function AgentMock(options: unknown) {
  captured.options = options;
  return { close: vi.fn().mockResolvedValue(undefined), destroy: vi.fn().mockResolvedValue(undefined) };
}) }));
import { safeFetch } from '../safe-fetch';
afterEach(() => { vi.unstubAllGlobals(); });
describe('Node pinned lookup callback contract', () => {
  it.each([false, true])('supports lookup all=%s without resolving another address', async (all) => {
    dnsLookup.mockImplementationOnce((_hostname, _options, callback) => {
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
    await safeFetch('https://author.example.com/');
    const { connect } = captured.options as {
      connect: { lookup: (hostname: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void };
    };
    const callback = vi.fn();
    connect.lookup('author.example.com', { all }, callback);
    if (all) expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    else expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
});
