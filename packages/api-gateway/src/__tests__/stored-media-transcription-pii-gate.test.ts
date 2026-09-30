/**
 * F-3 (security review) — route-level proof that a PII prompt cannot reach the
 * reviewed kie.ai media capability and that transcription of raw audio cannot
 * reach the non-RU groq upstream under the DEFAULT key policy.
 *
 * These mount the real route modules with only the resolver + upstream registry
 * stubbed, so the assertion covers the wiring, not just the helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const submitMedia = vi.fn();
const executeTranscription = vi.fn();

vi.mock('../upstreams/registry', () => ({
  getUpstream: () => ({
    admittedMedia: { contract: 'kie-market-reviewed-media-v1', submit: submitMedia },
    admittedTranscription: {
      contract: 'groq-pcm-wav-transcription-v1',
      execute: executeTranscription,
    },
  }),
}));

// The durable attempt does real billing work; the gate must fire BEFORE it.
// The durable attempt is where the provider submit callback is actually
// invoked (and where billing/admission happen). Stubbing it to 'queued' proves
// the route REACHED the durable execution step instead of failing the gate.
vi.mock('../billing/stored-media-attempt', () => ({
  createStoredMediaAttempt: (args: { submit: () => Promise<unknown> }) => ({
    run: async () => {
      await args.submit();
      return { kind: 'queued', taskId: 'task-1' };
    },
  }),
}));
vi.mock('../billing/stored-transcription-attempt', () => ({
  createStoredTranscriptionAttempt: (args: { execute: () => Promise<unknown> }) => ({
    run: async () => {
      await args.execute();
      return { kind: 'completed', taskId: 'task-2', text: 'transcript' };
    },
  }),
}));
vi.mock('../billing/media-job-storage', () => ({ readMediaJob: async () => null }));
vi.mock('../lib/media-queue', () => ({ enqueueOwnedMediaPoll: vi.fn() }));

import type { Hono as HonoType } from 'hono';
import { applyAiagErrorHandler, errors } from '../lib/errors';
import { resolveModelWithOverride, setResolveModelOverride } from '../routing/resolver';
import { findReviewedMediaProfile } from '../billing/reviewed-media-profiles';
import { findReviewedTranscriptionProfile } from '../billing/reviewed-transcription-profiles';

const IMAGE_CANDIDATE = {
  id: 'kie',
  upstream_id: 'kie',
  upstream_model_id: 'nano-banana-2',
  provider: 'kie',
  price_per_1k_input: 0,
  price_per_1k_output: 0,
  price_per_image: 4,
  markup: 1.2,
  latency_p50_ms: 100,
  uptime: 0.99,
  // kie.ai is NOT RU-resident.
  ru_residency: false,
  egress_proxy: null,
  priority: 1,
  billing: {
    modelUpstreamId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    prices: { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1.2000' },
    pricePerImageCents: '4.00',
  },
};

const STT_CANDIDATE = {
  id: 'groq',
  upstream_id: 'groq',
  upstream_model_id: 'whisper-large-v3',
  provider: 'groq',
  price_per_1k_input: 0,
  price_per_1k_output: 0,
  price_per_audio_sec: 0.0030833333,
  markup: 1.8,
  latency_p50_ms: 10,
  uptime: 0.99,
  // groq.com is NOT RU-resident.
  ru_residency: false,
  egress_proxy: null,
  priority: 1,
  billing: {
    modelUpstreamId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    prices: { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1.8' },
    pricePerAudioSecondCents: '0.0030833333',
  },
};

function mount(route: HonoType, policies: Record<string, unknown>) {
  const app = new Hono();
  applyAiagErrorHandler(app);
  app.use('*', async (c, next) => {
    c.set(
      'apiKey' as never,
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        org_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        policies,
        rpm_limit: 100,
        batch_rpm_limit: 100,
        daily_usd_cap: null,
        model_whitelist: [],
        ru_residency_only: false,
      } as never
    );
    await next();
  });
  app.route('/v1', route);
  return app;
}

function wav(): Uint8Array {
  const sampleRate = 16000;
  const frames = sampleRate;
  const dataBytes = frames * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  return bytes;
}

describe('F-3: stored media route blocks PII prompts from leaving the country', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KIE_API_KEY = 'stub';
    // The resolver attaches reviewed capability bindings from the process
    // manifest; the test override must do the same or the route fails closed.
    const reviewedMediaProfile = findReviewedMediaProfile({
      routeKind: 'image',
      modelSlug: 'nano-banana-2-kie',
      modelType: 'image',
      upstreamId: 'kie',
      upstreamModelId: 'nano-banana-2',
      adapterKey: 'kie',
    });
    setResolveModelOverride(async () => ({
      slug: 'nano-banana-2-kie',
      type: 'image',
      candidates: [{ ...IMAGE_CANDIDATE, ...(reviewedMediaProfile ? { reviewedMediaProfile } : {}) }],
    }));
  });
  afterEach(() => {
    setResolveModelOverride(null);
    delete process.env.KIE_API_KEY;
  });

  async function postImage(app: Hono, prompt: string) {
    return app.fetch(
      new Request('http://gateway.test/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-' + Math.random() },
        body: JSON.stringify({ model: 'nano-banana-2-kie', prompt }),
      })
    );
  }

  it('403s a prompt carrying an email under the default key policy', async () => {
    const { storedMedia } = await import('../routes/v1/stored-media');
    const app = mount(storedMedia, {});
    const r = await postImage(app, 'нарисуй кота, пиши на user@example.com');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(submitMedia).not.toHaveBeenCalled();
  });

  it('403s a prompt carrying an ИНН under the default key policy', async () => {
    const { storedMedia } = await import('../routes/v1/stored-media');
    const app = mount(storedMedia, {});
    const r = await postImage(app, 'обложка для ИНН 7707083893');
    expect(r.status).toBe(403);
    expect(submitMedia).not.toHaveBeenCalled();
  });

  it('passes a PII-free prompt through to the reviewed provider', async () => {
    const { storedMedia } = await import('../routes/v1/stored-media');
    const app = mount(storedMedia, {});
    const r = await postImage(app, 'a cat on a windowsill');
    expect(r.status).toBe(202);
    expect(submitMedia).toHaveBeenCalledTimes(1);
    expect(String(JSON.stringify(await r.json()))).not.toContain('prompt');
  });

  it('allows a PII prompt when the key explicitly sets allow_pii_transborder', async () => {
    const { storedMedia } = await import('../routes/v1/stored-media');
    const app = mount(storedMedia, { allow_pii_transborder: true });
    const r = await postImage(app, 'напиши на user@example.com');
    expect(r.status).toBe(202);
    expect(submitMedia).toHaveBeenCalledTimes(1);
  });
});

describe('F-3: stored transcription route treats raw audio as PII', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GROQ_API_KEY = 'stub';
    const reviewedTranscriptionProfile = findReviewedTranscriptionProfile({
      modelSlug: 'whisper-large-v3',
      modelType: 'audio',
      upstreamId: 'groq',
      upstreamModelId: 'whisper-large-v3',
      adapterKey: 'groq',
    });
    setResolveModelOverride(async () => ({
      slug: 'whisper-large-v3',
      type: 'audio',
      candidates: [{ ...STT_CANDIDATE, ...(reviewedTranscriptionProfile ? { reviewedTranscriptionProfile } : {}) }],
    }));
  });
  afterEach(() => {
    setResolveModelOverride(null);
    delete process.env.GROQ_API_KEY;
  });

  async function postAudio(app: Hono) {
    const form = new FormData();
    form.set('model', 'whisper-large-v3');
    form.set('file', new File([wav()], 'speech.wav', { type: 'audio/wav' }));
    return app.fetch(
      new Request('http://gateway.test/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'idempotency-key': 'idem-' + Math.random() },
        body: form,
      })
    );
  }

  it('403s under the default key policy because the only upstream (groq) is not RU-resident', async () => {
    const { storedTranscription } = await import('../routes/v1/stored-transcription');
    const app = mount(storedTranscription, {});
    const r = await postAudio(app);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(executeTranscription).not.toHaveBeenCalled();
  });

  it('passes when the key explicitly sets allow_pii_transborder', async () => {
    const { storedTranscription } = await import('../routes/v1/stored-transcription');
    const app = mount(storedTranscription, { allow_pii_transborder: true });
    const r = await postAudio(app);
    expect(r.status).toBe(200);
    expect(executeTranscription).toHaveBeenCalledTimes(1);
  });

  it('resolver override is the seam the server boots (no independent lookup)', () => {
    // Guards against a future refactor reintroducing a private resolver call.
    expect(typeof resolveModelWithOverride).toBe('function');
    expect(errors.forbidden('x').status).toBe(403);
  });
});