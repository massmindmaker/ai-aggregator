import { describe, it, expect } from 'vitest';
import { KieAdapter } from '../adapters/kie';
import { createFetchMock } from './fetch-mock';

describe('KieAdapter', () => {
  it('videoGenerations submits to /api/v1/veo/generate and returns task handle', async () => {
    const mock = createFetchMock([
      { status: 200, body: { code: 200, data: { taskId: 'kie-task-1' } } },
    ]);
    const adapter = new KieAdapter({ apiKey: 'kie-key', fetch: mock.fetch });
    const handle = await adapter.videoGenerations(
      { model: 'veo-3', prompt: 'a sunset', duration_s: 8 },
      { request_id: 'r1' },
    );
    expect(handle.task_id).toBe('kie-task-1');
    expect(handle.poll_url).toBe('/api/v1/veo/status/kie-task-1');
    expect(mock.calls[0].url).toContain('/api/v1/veo/generate');
    expect(mock.calls[0].headers['authorization']).toBe('Bearer kie-key');
  });

  it('imageGenerations submits to /api/v1/image/generate', async () => {
    const mock = createFetchMock([
      { status: 200, body: { data: { taskId: 'img-1' } } },
    ]);
    const adapter = new KieAdapter({ apiKey: 'k', fetch: mock.fetch });
    const handle = await adapter.imageGenerations(
      { model: 'nano-banana-pro', prompt: 'cat' },
      { request_id: 'r' },
    );
    expect(mock.calls[0].url).toContain('/api/v1/image/generate');
    expect(handle.poll_url).toBe('/api/v1/image/status/img-1');
  });

  it('audioSpeech submits to /api/v1/suno/generate and wraps handle in 202 Response', async () => {
    const mock = createFetchMock([
      { status: 200, body: { data: { taskId: 'suno-1' } } },
    ]);
    const adapter = new KieAdapter({ apiKey: 'k', fetch: mock.fetch });
    const res = await adapter.audioSpeech(
      { model: 'suno-v4-5', input: 'happy pop song about cats' },
      { request_id: 'r' },
    );
    expect(res.status).toBe(202);
    expect(mock.calls[0].url).toContain('/api/v1/suno/generate');
    const body = (await res.json()) as { task_id: string; poll_url: string };
    expect(body.task_id).toBe('suno-1');
    expect(body.poll_url).toBe('/api/v1/suno/status/suno-1');
  });

  it('pollAsync handles pending, completed, failed states', async () => {
    const adapter = new KieAdapter({
      apiKey: 'k',
      fetch: createFetchMock([
        { status: 200, body: { data: { taskId: 't', status: 'processing' } } },
      ]).fetch,
    });
    const pending = await adapter.pollAsync('t', {
      request_id: 'r',
      poll_url: '/api/v1/veo/status/t',
    } as never);
    expect(pending.status).toBe('pending');

    const a2 = new KieAdapter({
      apiKey: 'k',
      fetch: createFetchMock([
        {
          status: 200,
          body: {
            data: {
              taskId: 't',
              status: 'completed',
              output_url: 'https://cdn.kie.ai/v.mp4',
            },
          },
        },
      ]).fetch,
    });
    const done = await a2.pollAsync('t', {
      request_id: 'r',
      poll_url: '/api/v1/veo/status/t',
    } as never);
    expect(done.status).toBe('completed');
    expect(done.output).toBe('https://cdn.kie.ai/v.mp4');

    const a3 = new KieAdapter({
      apiKey: 'k',
      fetch: createFetchMock([
        { status: 200, body: { data: { taskId: 't', status: 'failed', fail_reason: 'nsfw' } } },
      ]).fetch,
    });
    const failed = await a3.pollAsync('t', {
      request_id: 'r',
      poll_url: '/api/v1/veo/status/t',
    } as never);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('nsfw');
  });

  it('pollAsync supports gateway-prefixed jobs recordInfo contract', async () => {
    const pendingFetch = createFetchMock([
      { status: 200, body: { data: { taskId: 'j1', state: 'processing' } } },
    ]);
    const pendingAdapter = new KieAdapter({ apiKey: 'k', fetch: pendingFetch.fetch });
    expect((await pendingAdapter.pollAsync('jobs:j1', { request_id: 'r' })).status).toBe('pending');
    expect(pendingFetch.calls[0].url).toContain('/api/v1/jobs/recordInfo?taskId=j1');

    const doneFetch = createFetchMock([
      { status: 200, body: { data: { taskId: 'v1', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.ai/v.mp4'] }) } } },
    ]);
    const doneAdapter = new KieAdapter({ apiKey: 'k', fetch: doneFetch.fetch });
    const done = await doneAdapter.pollAsync('veo:v1', { request_id: 'r' });
    expect(done).toEqual({ status: 'completed', output: 'https://cdn.kie.ai/v.mp4' });
    expect(doneFetch.calls[0].url).toContain('/api/v1/veo/recordInfo?taskId=v1');

    const failedFetch = createFetchMock([
      { status: 200, body: { data: { taskId: 's1', state: 'fail', failMsg: 'provider detail' } } },
    ]);
    const failedAdapter = new KieAdapter({ apiKey: 'k', fetch: failedFetch.fetch });
    expect(await failedAdapter.pollAsync('suno:s1', { request_id: 'r' })).toEqual({
      status: 'failed',
      error: 'provider detail',
    });
    expect(failedFetch.calls[0].url).toContain('/api/v1/generate/recordInfo?taskId=s1');
  });

  it('estimateCost returns credits=0 when model pricing is undefined (hidden pricing)', async () => {
    const adapter = new KieAdapter({ apiKey: 'k', markup: 1.2, usd_rate: 95 });
    const est = await adapter.estimateCost(
      { prompt: 'x' },
      { id: 'runway-aleph', name: 'Runway Aleph', modality: 'video' },
    );
    expect(est.credits).toBe(0);
    expect(est.upstream_cost_usd).toBe(0);
  });

  it('estimateCost computes video seconds × per_second × markup × usd_rate', async () => {
    const adapter = new KieAdapter({ apiKey: 'k', markup: 1.2, usd_rate: 100 });
    const est = await adapter.estimateCost(
      { duration_s: 10 },
      {
        id: 'veo-3',
        name: 'Veo 3',
        modality: 'video',
        pricing: { per_second: 0.5 },
      },
    );
    // 10 * 0.5 = $5 upstream; *1.2 markup = $6; *100 rate = 600 credits
    expect(est.upstream_cost_usd).toBe(5);
    expect(est.credits).toBe(600);
  });

  it('listModels returns curated catalog including Veo, Kling, nano-banana', async () => {
    const adapter = new KieAdapter({ apiKey: 'k' });
    const models = await adapter.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('veo-3');
    expect(ids).toContain('kling-3.0');
    expect(ids).toContain('nano-banana-pro');
    expect(ids).toContain('suno-v4-5');
  });

  it('pricingSync excludes models with hidden pricing', async () => {
    const adapter = new KieAdapter({ apiKey: 'k' });
    const sync = await adapter.pricingSync();
    const ids = sync.map((s) => s.model_id);
    expect(ids).not.toContain('runway-aleph');
    expect(ids).not.toContain('suno-v4-5');
    expect(ids).toContain('veo-3');
  });
});
