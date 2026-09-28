import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('author execution rollout boundary', () => {
  it('rejects author sales enabled with legacy execution before accepting traffic', async () => {
    vi.stubEnv('AUTHOR_CHAT_ENABLED', '1');
    vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', 'legacy');
    vi.resetModules();
    await expect(import('../config')).rejects.toThrow('AUTHOR_CHAT_REQUIRES_STORED_EXECUTION');
  });
  it.each(['stored_chat_only', 'stored_chat_embeddings_completions_stream_media_batches'])(
    'accepts the reviewed author adapter in %s', async (mode) => {
      vi.stubEnv('AUTHOR_CHAT_ENABLED', '1');
      vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', mode);
      vi.resetModules();
      await expect(import('../config')).resolves.toMatchObject({ config: { AUTHOR_CHAT_ENABLED: '1' } });
    },
  );
  it('preserves legacy compatibility with author execution disabled', async () => {
    vi.stubEnv('AUTHOR_CHAT_ENABLED', '0');
    vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', 'legacy');
    vi.resetModules();
    await expect(import('../config')).resolves.toMatchObject({ config: { GATEWAY_HTTP_EXECUTION_MODE: 'legacy' } });
  });
});
