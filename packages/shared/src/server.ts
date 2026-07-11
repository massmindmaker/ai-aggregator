/**
 * Server-only entry of @aiag/shared (issue #19).
 *
 * Everything that touches a Node builtin or a Node-oriented SDK lives HERE,
 * never in the main barrel ('./index.ts'):
 *   - ./s3         → @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
 *   - ./safe-fetch → node:dns, node:net, node:util (+ optional undici)
 *
 * Why a subpath and not just "be careful": tsup builds this package with
 * `splitting: false`, so each entry is one indivisible chunk. Anything the
 * main barrel re-exports is dragged into EVERY consumer of '@aiag/shared',
 * whether they use it or not. Keeping index.ts isomorphic (pure TS/Intl only)
 * makes it physically impossible for a browser bundle to pull Node code in —
 * the guard is the `exports` map, not developer discipline.
 *
 * Import rules:
 *   - Node-only code (route handlers, workers, the Bun/Hono gateway) → '@aiag/shared/server'
 *   - browser / 'use client' components                              → '@aiag/shared/client'
 *   - isomorphic helpers (formatters, error classes, constants)      → '@aiag/shared'
 */
export * from './s3';
export * from './safe-fetch';
