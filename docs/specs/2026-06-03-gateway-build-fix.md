# Gateway build fix — `ERR_UNSUPPORTED_DIR_IMPORT` (ioredis/built/utils)

> Date: 2026-06-03 · Scope: `packages/api-gateway` build (tsup → ESM) · Status: root cause confirmed by reading the emitted `dist/server-node.js`, not guessed.

## Symptom

Prod gateway crash-loops at startup:

```
Error [ERR_UNSUPPORTED_DIR_IMPORT]:
  file:///srv/aiag/gateway/releases/<rel>/node_modules/ioredis/built/utils
```

Built by the CI step `bun run --cwd packages/api-gateway build`
(`.github/workflows/deploy-production.yml:155`) → tsup → `dist/server-node.js` (ESM).
Worked on a May-10 build, broke on a June-3 build.

## Root cause (confirmed)

The emitted ESM bundle `packages/api-gateway/dist/server-node.js` contains **two
directory imports** copied verbatim from BullMQ's ESM source:

```js
// dist/server-node.js:2659  (from node_modules/bullmq/dist/esm/utils/index.js)
import { CONNECTION_CLOSED_ERROR_MSG } from "ioredis/built/utils";

// dist/server-node.js:18020 (from node_modules/bullmq/dist/esm/classes/redis-connection.js)
import { CONNECTION_CLOSED_ERROR_MSG as CONNECTION_CLOSED_ERROR_MSG2 } from "ioredis/built/utils";
```

`"ioredis/built/utils"` is a **directory** (it resolves to `built/utils/index.js`
only under CommonJS's directory-resolution algorithm). Node's **ESM** loader does
**not** do directory resolution and does not honor an `index.js` fallback for a bare
subpath that the package's `exports` map doesn't expose → `ERR_UNSUPPORTED_DIR_IMPORT`.

How those lines got into our bundle:

1. `src/server.ts:24` statically imports `./routes/v1/batches`, and
   `src/server.ts:85` mounts it (`app.route('/v1/batches', batches)`).
2. `src/routes/v1/batches.ts:52` calls `await import('bullmq')`. It is *written* as a
   dynamic import to degrade gracefully if BullMQ/Redis are missing — but that does
   **not** keep it out of the bundle.
3. tsup's `external` list contains **only** `@aiag/database`
   (`packages/api-gateway/tsup.config.ts:10`). `bullmq` is therefore **bundled**.
   tsup inlines BullMQ's entire ESM build into `server-node.js`, including its
   `import ... from "ioredis/built/utils"` lines, which it leaves as bare external
   specifiers (it externalizes at the `ioredis` *package* boundary but copies the
   deep subpath string unchanged).
4. At runtime Node tries to import the `ioredis/built/utils` **directory** → crash.

### Why May-10 worked and June-3 broke

The batches route + the `bullmq` dependency were added in the gateway plan-04 work
(`b62610a wip(gateway): plan-04 tasks 3-12 …`). The May-10 build predates BullMQ
being statically reachable from `server.ts`, so no BullMQ ESM (and thus no
`ioredis/built/utils` directory import) was ever emitted. Once `batches.ts` became
part of the static import graph, every tsup build inlines BullMQ and reproduces the
crash. Resolved lockfile versions involved (`bun.lock`): `bullmq@5.76.6`,
`ioredis@5.10.1` — both irrelevant to the fix; the bug is the bundling boundary, not
a version regression.

`ioredis` (our own `src/lib/redis.ts` → `import Redis from 'ioredis'`) is **not** the
direct trigger: that bare `"ioredis"` import resolves fine via the package `main`.
The crash is specifically the **`ioredis/built/utils` subpath that BullMQ deep-imports.**

## The fix (minimal, one line)

Stop bundling the Redis stack. Add `bullmq` and `ioredis` to tsup `external` so both
resolve from `node_modules` at runtime (CJS-friendly directory resolution, exactly as
they did pre-regression and exactly how `import Redis from 'ioredis'` already works).

**File:** `packages/api-gateway/tsup.config.ts`

```diff
   splitting: false,
-  external: ['@aiag/database'],
+  external: ['@aiag/database', 'bullmq', 'ioredis'],
 });
```

Both are already real runtime `dependencies` (`ioredis ^5.4.1`) / available on the VPS
(`bullmq` is resolvable for the `await import('bullmq')`), so externalizing them does
not break runtime resolution — it restores it. `ioredis` is listed too for safety so
no future deep `ioredis/...` subpath gets re-inlined by another bundled dep.

### Why this is the right fix (not the alternatives)

- **Add to `external` (chosen).** Surgical, one line, leaves the dynamic-import
  graceful-degradation contract in `batches.ts` intact, and matches the existing
  pattern (`@aiag/database` is already external). Native deps like `ioredis`/`bullmq`
  are meant to be externalized in a Node ESM bundle, never inlined.
- **`noExternal` / force-bundle ioredis as `index.js`.** Wrong direction — it would
  bundle *more* native code and would still need a banner shim to rewrite the directory
  import. More fragile, larger surface.
- **`format: 'cjs'`.** Would sidestep the ESM directory-import rule, but the package is
  `"type": "module"` and the Node entry (`server-node.ts`) + `@hono/node-server` are
  authored ESM; switching the whole gateway to CJS is a much larger, riskier change
  than externalizing two deps.
- **`require`-shim banner.** Treats the symptom, not the cause; still inlines all of
  BullMQ. Rejected.
- **Pin an older ioredis/bullmq.** The bug is the bundling boundary, not a version —
  pinning is a non-fix that would silently re-break on the next bump.

### Cross-check: how the rest of the codebase avoids this

Our own `src/lib/redis.ts` imports `ioredis` at the package root (`import Redis from
'ioredis'`) — a valid ESM entry, never a `/built/...` subpath — which is why it never
triggered the error. The OpenRouter / upstream adapters are plain `fetch` HTTP clients
with no Redis deep-imports, so they were never affected. The only deep `ioredis/built/*`
importer in the graph is **third-party BullMQ**, which is exactly why the answer is to
**not bundle BullMQ** rather than touch any of our source.

## Verification (per project rules — VPS, no local runtime)

1. Apply the one-line `external` change.
2. `bun run --cwd packages/api-gateway build` (CI or on VPS).
3. Confirm the emitted bundle no longer contains the directory import:
   `dist/server-node.js` must have **zero** occurrences of `ioredis/built/utils`
   (pre-fix: lines 2659 + 18020).
4. Deploy + `pm2 restart gateway`; confirm the `{"msg":"listening","port":4000}`
   log line appears and the crash-loop is gone (skill `aiag-deploy`).

## Files

- Bug fix: `packages/api-gateway/tsup.config.ts` (line 10).
- Evidence: `packages/api-gateway/dist/server-node.js:2659`, `:18020` (directory imports);
  `packages/api-gateway/src/routes/v1/batches.ts:52` (`await import('bullmq')`);
  `packages/api-gateway/src/server.ts:24,85` (static import of the batches route);
  `bun.lock` (`bullmq@5.76.6`, `ioredis@5.10.1`).
