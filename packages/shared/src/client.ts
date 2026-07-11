/**
 * Client-safe subset of @aiag/shared (issue #17, updated by #19).
 *
 * Originally this entry existed because the main barrel re-exported ./s3
 * (@aws-sdk) and ./safe-fetch (node:dns, node:net), and tsup's `splitting:
 * false` made that one indivisible chunk — so a 'use client' component
 * importing anything from '@aiag/shared' dragged Node builtins in.
 *
 * #19 fixed that at the root: both Node-only modules now live behind
 * '@aiag/shared/server', and the main barrel is isomorphic.
 *
 * This entry is still the right import for 'use client' components: it is the
 * minimal, explicitly-audited browser surface (currently TON nano-unit
 * conversion for the admin NFT forms), so a client bundle can never grow a
 * Node dependency by accident even if the barrel regresses. Never re-export
 * ./s3 or ./safe-fetch here.
 */
export { tonToNano, nanoToTon, NANO_PER_TON } from './startonus';
