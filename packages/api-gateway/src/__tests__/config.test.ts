import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('default output cap config', () => {
  it('defaults to 4096 and accepts larger positive safe configured caps', async () => {
    vi.stubEnv('GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS', ''); delete process.env.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS; vi.resetModules();
    expect((await import('../config')).config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096);
    vi.stubEnv('GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS','10000'); vi.resetModules();
    expect((await import('../config')).config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS).toBe(10000);
  });
  it.each(['0','-1','1.5','Infinity','NaN','9007199254740992',''])('rejects invalid default %s', async value => {
    vi.stubEnv('GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS',value); vi.resetModules();
    await expect(import('../config')).rejects.toThrow();
  });
});
