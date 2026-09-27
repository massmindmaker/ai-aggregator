import { describe, expect, it } from 'vitest';
import { createMediaKieAdapter } from '../../media-kie';

describe('media Kie worker bootstrap', () => {
  it('polls through the same operator-configured KIE_BASE_URL as gateway submit', async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: { taskId: 'j1', state: 'processing' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const adapter = createMediaKieAdapter(
      { KIE_API_KEY: 'worker-key', KIE_BASE_URL: 'https://kie.worker.test/custom' },
      fetchMock,
    );
    expect(adapter).not.toBeNull();
    expect((await adapter!.pollAsync('jobs:j1', { request_id: 'r' })).status).toBe('pending');
    expect(calls).toEqual(['https://kie.worker.test/api/v1/jobs/recordInfo?taskId=j1']);
  });

  it('stays disabled without KIE_API_KEY', () => {
    expect(createMediaKieAdapter({ KIE_BASE_URL: 'https://kie.worker.test' })).toBeNull();
  });
});
