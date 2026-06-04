// Gonka pre-commit spike — runs the whole §"Spike plan" from
// docs/specs/2026-06-03-gonka-grant-application.md against the GonkaGate broker.
// Run after the founder provides the GonkaGate key:
//   GONKA_API_KEY=gp-... node scripts/gonka-spike.mjs
// Optional end-to-end gateway hop (step 4): also set
//   AIAG_GATEWAY_KEY=sk_aiag_live_... GATEWAY_URL=http://127.0.0.1:4000

const GONKA_BASE = 'https://api.gonkagate.com/v1';
const MODEL = 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8';
const N = 12;

const key = process.env.GONKA_API_KEY;
if (!key) {
  console.error('FATAL: GONKA_API_KEY is required (a gp-... GonkaGate key).');
  console.error('  GONKA_API_KEY=gp-... node scripts/gonka-spike.mjs');
  process.exit(1);
}
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)];

// Step 2 — reachability + live model list
console.log(`\n[1] GET ${GONKA_BASE}/models`);
const mres = await fetch(`${GONKA_BASE}/models`, { headers: auth });
if (!mres.ok) { console.error(`  models failed: HTTP ${mres.status} ${await mres.text().catch(() => '')}`); process.exit(1); }
const models = await mres.json();
const slugs = (models.data ?? models.models ?? []).map((m) => m.id ?? m.name ?? m).filter(Boolean);
console.log(`  ${slugs.length} live slug(s):`);
for (const s of slugs) console.log(`    - ${s}`);
console.log(`  Qwen3-235B present: ${slugs.includes(MODEL) ? 'YES' : 'NOT in list (will still try)'}`);

// Step 3 — latency over N short completions + per-token cost if usage returned
console.log(`\n[2] ${N}× chat completions of ${MODEL} (measuring total latency)`);
const lat = [];
let lastUsage = null;
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${GONKA_BASE}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly one word: ping' }],
        max_tokens: 8,
        stream: false,
      }),
    });
    const ms = Date.now() - t0;
    if (!r.ok) { console.log(`  call ${i + 1}: HTTP ${r.status} (${ms}ms) ${(await r.text().catch(() => '')).slice(0, 120)}`); continue; }
    const j = await r.json();
    lat.push(ms);
    lastUsage = j.usage ?? lastUsage;
    console.log(`  call ${i + 1}: ${ms}ms${j.usage ? ` (tok ${j.usage.total_tokens})` : ''}`);
  } catch (e) {
    console.log(`  call ${i + 1}: ERROR ${e.message}`);
  }
}
if (lat.length) {
  console.log(`\n  latency over ${lat.length} ok call(s): p50=${pct(lat, 50)}ms · p95=${pct(lat, 95)}ms · min=${Math.min(...lat)}ms · max=${Math.max(...lat)}ms`);
} else {
  console.error('  no successful completions — cannot report latency.');
}
if (lastUsage) {
  console.log(`  last usage: prompt=${lastUsage.prompt_tokens} completion=${lastUsage.completion_tokens} total=${lastUsage.total_tokens}`);
  if (lastUsage.cost != null) console.log(`  reported cost (last call): $${lastUsage.cost} → $${(lastUsage.cost / Math.max(1, lastUsage.total_tokens)).toExponential(3)}/token`);
  else console.log('  no per-call cost field in usage — capture real per-token cost from the GonkaGate dashboard.');
}

// Step 4 — optional end-to-end hop through OUR local gateway
const gwKey = process.env.AIAG_GATEWAY_KEY;
const gwUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:4000';
if (gwKey) {
  console.log(`\n[3] gateway hop: ${gwUrl}/v1/chat/completions (model=gonka/qwen3-235b)`);
  try {
    const t0 = Date.now();
    const r = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gwKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gonka/qwen3-235b', messages: [{ role: 'user', content: 'Reply with one word: ping' }], max_tokens: 8 }),
    });
    const body = await r.text();
    console.log(`  HTTP ${r.status} (${Date.now() - t0}ms): ${body.slice(0, 300)}`);
    console.log(r.ok ? '  end-to-end routing OK — verify ledger debit + markup separately.' : '  gateway hop failed — check the gonka/qwen3-235b slug is seeded + registered.');
  } catch (e) {
    console.log(`  gateway hop ERROR: ${e.message} (is the gateway running on :4000?)`);
  }
} else {
  console.log('\n[3] gateway hop SKIPPED (set AIAG_GATEWAY_KEY [+ GATEWAY_URL] to test end-to-end routing).');
}

console.log('\nDone. Paste p50/p95 + the live /v1/models slugs + per-token cost into the grant application.');
