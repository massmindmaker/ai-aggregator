/**
 * Client-safe subset of @aiag/shared (issue #17).
 *
 * The main entry ('.') re-exports everything, including ./s3 (@aws-sdk/client-s3)
 * and ./safe-fetch (node:dns, node:net) — Node-only modules that break when a
 * 'use client' component imports them, even transitively. tsup bundles
 * src/index.ts as a single non-split chunk, so any import from '@aiag/shared'
 * drags the whole graph in, including those Node builtins.
 *
 * This entry exports ONLY the pure, browser-safe helpers a client component
 * needs (currently: TON nano-unit conversion for admin NFT forms). Do not
 * re-export ./s3 or ./safe-fetch here.
 */
export { tonToNano, nanoToTon, NANO_PER_TON } from './startonus';
