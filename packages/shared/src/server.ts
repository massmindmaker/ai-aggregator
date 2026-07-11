/**
 * Server-only subset of @aiag/shared (issue #19).
 *
 * s3.ts pulls in @aws-sdk/client-s3, a large Node-oriented dependency. It has
 * no browser use case — only Next.js route handlers (`runtime = 'nodejs'`)
 * call uploadToS3/getSignedDownloadUrl — and, unlike safe-fetch.ts below, no
 * consumer needs it from the bare '@aiag/shared' entry. So it lives behind
 * this explicit server-only subpath instead of the main barrel, shrinking the
 * set of Node-only code the main entry ships.
 *
 * NOTE: safe-fetch.ts (node:dns/node:net) is NOT moved here and stays exported
 * from the main barrel ('./index.ts'). packages/api-gateway imports
 * `safeFetch`/`SsrfError` from the bare '@aiag/shared' specifier and, per
 * issue #19's constraint, must not be edited — removing that export would
 * break its build. api-gateway is a Bun/Hono server (never bundled for a
 * browser), so this is safe; the residual guard is procedural, not physical:
 * no 'use client' component may ever import the bare barrel — use
 * '@aiag/shared/client' for browser-safe helpers instead.
 */
export * from './s3';
