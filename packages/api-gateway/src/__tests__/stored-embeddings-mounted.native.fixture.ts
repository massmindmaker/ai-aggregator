import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { assertTestDatabaseEnvironment, withGuardedTestDatabase } from '../../../database/scripts/test-db-guard';
import { createPgTestClient } from '../../../database/scripts/pg-test-client';
import { hash } from './stored-chat-mounted.native.fixture';

export const embeddingsSlug = 'openai/text-embedding-3-small';
export function guardEmbeddingsNative() {
  assertTestDatabaseEnvironment(process.env);
  const redis = new URL(process.env.REDIS_URL!);
  if (redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' || redis.port !== '16379' || redis.search || !['', '/0', '/'].includes(redis.pathname))
    throw new Error('stored embeddings native proof requires dedicated Redis 127.0.0.1:16379/0');
}

export async function embeddingsRuntime() {
  guardEmbeddingsNative();
  await withGuardedTestDatabase(process.env, { clientFactory: createPgTestClient }, async () => {});
  const envNames = ['GATEWAY_HTTP_EXECUTION_MODE', 'OPENROUTER_API_KEY', 'AIAG_FORCE_MOCK', 'CACHING_DISCOUNT'];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const restoreEnv = () => envNames.forEach((name) => {
    const value = previous[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  process.env.GATEWAY_HTTP_EXECUTION_MODE = 'stored_chat_embeddings';
  process.env.OPENROUTER_API_KEY = 'stored-embeddings-transport-stub';
  delete process.env.AIAG_FORCE_MOCK;
  process.env.CACHING_DISCOUNT = '0.5';
  const { default: postgres } = await import('postgres');
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const other = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const { sql } = await import('../lib/db');
  const redisModule = await import('../lib/redis');
  const redis = redisModule.redis;
  const rpm = redisModule.makeRedis('ratelimit');
  const transport = await import('../upstreams/fetch-upstream');
  const output = Object.freeze({
    id: 'emb-native-1', object: 'list', model: embeddingsSlug,
    data: Object.freeze([0, 1].map((index) => Object.freeze({
      object: 'embedding', index, embedding: Object.freeze(Array(1536).fill(index === 0 ? 0.25 : -0.5)),
    }))),
    usage: Object.freeze({ prompt_tokens: 1000, total_tokens: 1000 }),
  });
  const publicOutput = Object.freeze({
    object: output.object, model: output.model, data: output.data, usage: output.usage,
  });
  const provider = vi.spyOn(transport, 'fetchUpstream').mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { input: unknown[] };
    return new Response(JSON.stringify({ ...output, data: output.data.slice(0, request.input.length) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('stored embeddings native external network forbidden'); });
  const legacyEmbeddings = vi.spyOn((await import('../upstreams/openrouter')).openRouterUpstream, 'embeddings');
  const failover = vi.spyOn(await import('../routing/failover'), 'executeWithFailover');
  const admission = await import('../billing/admission');
  const storage = await import('../billing/http-storage');
  const { app } = await import('../server');
  await Promise.all([redis.ping(), rpm.ping()]);
  const original = (await client`
    SELECT to_jsonb(m)::text AS model, to_jsonb(mu)::text AS candidate, to_jsonb(u)::text AS upstream
      FROM models m JOIN model_upstreams mu ON mu.model_id=m.id
      JOIN upstreams u ON u.id=mu.upstream_id
     WHERE m.slug=${embeddingsSlug} AND mu.upstream_id='openrouter'
     ORDER BY mu.id LIMIT 1
  `)[0];
  if (!original) throw new Error('canonical embedding seed is missing');
  const model = JSON.parse(String(original.model));
  const candidate = JSON.parse(String(original.candidate));
  const upstream = JSON.parse(String(original.upstream));
  await client.begin(async (tx) => {
    await tx`UPDATE models SET enabled=TRUE,status='live',type='embedding' WHERE id=${model.id}::uuid`;
    await tx`UPDATE model_upstreams SET enabled=TRUE,upstream_model_id=${embeddingsSlug},price_per_1k_input=0.002,price_per_1k_output=0,markup=1.25 WHERE id=${candidate.id}::uuid`;
    await tx`UPDATE upstreams SET enabled=TRUE WHERE id='openrouter'`;
  });
  async function restoreCatalog() {
    await client.begin(async (tx) => {
      await tx`UPDATE models SET enabled=${model.enabled},status=${model.status},type=${model.type} WHERE id=${model.id}::uuid`;
      await tx`UPDATE model_upstreams SET enabled=${candidate.enabled},upstream_model_id=${candidate.upstream_model_id},price_per_1k_input=${candidate.price_per_1k_input},price_per_1k_output=${candidate.price_per_1k_output},markup=${candidate.markup} WHERE id=${candidate.id}::uuid`;
      await tx`UPDATE upstreams SET enabled=${upstream.enabled} WHERE id='openrouter'`;
    });
  }
  async function close() {
    const failures: unknown[] = [];
    for (const task of [restoreCatalog, () => sql.end(), () => redis.quit(), () => rpm.quit(), () => client.end(), () => other.end()]) {
      try { await task(); } catch (error) { failures.push(error); }
    }
    provider.mockRestore(); network.mockRestore(); legacyEmbeddings.mockRestore(); failover.mockRestore(); restoreEnv();
    if (failures.length) throw new AggregateError(failures, 'stored embeddings runtime cleanup failed');
  }
  return { client, other, sql, redis, rpm, app, provider, output, publicOutput, legacyEmbeddings, failover, admission, storage, close };
}
export type EmbeddingsRuntime = Awaited<ReturnType<typeof embeddingsRuntime>>;

export async function embeddingsOwner(runtime: EmbeddingsRuntime) {
  const user = randomUUID(), org = randomUUID(), key = randomUUID();
  const token = `sk_aiag_test_${randomUUID().replaceAll('-', '')}`;
  await runtime.client.begin(async (tx) => {
    await tx`INSERT INTO users(id,email) VALUES(${user}::uuid,${`emb-${user}@example.test`})`;
    await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'Embeddings native fixture',${user}::uuid,1000)`;
    await tx`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,rpm_limit,batch_rpm_limit,cost_limit_monthly_rub) VALUES(${key}::uuid,${org}::uuid,'Embeddings key',${hash(token)},${token.slice(0, 20)},10000,10000,NULL)`;
    await tx`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000)`;
    await tx`INSERT INTO gateway_quota_key_policies(api_key_id,org_id,session_microcredits_limit_v2) VALUES(${key}::uuid,${org}::uuid,1000000)`;
  });
  const body = Object.freeze({ model: embeddingsSlug, input: Object.freeze(['first private input', 'second private input']) });
  const post = async (id = randomUUID(), payload: unknown = body, init: RequestInit = {}) => {
    const headers = new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': id, 'x-aiag-session-id': 'embedding-session' });
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return runtime.app.fetch(new Request('http://native.test/v1/embeddings', {
      method: 'POST', body: JSON.stringify(payload), ...init, headers,
    }));
  };
  const facts = async () => ({
    mapping: await runtime.other`SELECT * FROM gateway_http_requests WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    result: await runtime.other`SELECT * FROM gateway_http_results WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    rejection: await runtime.other`SELECT * FROM gateway_http_rejections WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    admission: await runtime.other`SELECT * FROM gateway_charge_admissions WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    ledger: await runtime.other`SELECT * FROM gateway_transactions WHERE org_id=${org}::uuid ORDER BY id`,
    context: await runtime.other`SELECT * FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    buckets: await runtime.other`SELECT * FROM gateway_quota_buckets WHERE org_id=${org}::uuid ORDER BY kind`,
    events: await runtime.other`SELECT e.* FROM gateway_charge_quota_events e JOIN gateway_charge_admissions a USING(billing_request_id) WHERE a.org_id=${org}::uuid ORDER BY e.bucket_id,e.event_kind`,
    balance: await runtime.other`SELECT payg_credits::text FROM organizations WHERE id=${org}::uuid`,
  });
  async function cleanup() {
    const ids = (await runtime.client`SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid`).map((row) => String(row.billing_request_id));
    await runtime.client.begin(async (tx) => {
      await tx`DELETE FROM pii_detections WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_http_rejections WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_http_results WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_http_requests WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${tx.array(ids)}::uuid[])`;
      await tx`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${tx.array(ids)}::uuid[])`;
      await tx`DELETE FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_quota_buckets WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_quota_key_policies WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_quota_org_policies WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_transactions WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_charge_admissions WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_api_keys WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM organizations WHERE id=${org}::uuid`;
      await tx`DELETE FROM users WHERE id=${user}::uuid`;
    });
    for (const pattern of [`rl:rpm:${key}`, `rl:batch:${key}`]) await runtime.redis.del(pattern);
  }
  return { user, org, key, token, body, post, facts, cleanup };
}
export type EmbeddingsOwner = Awaited<ReturnType<typeof embeddingsOwner>>;
