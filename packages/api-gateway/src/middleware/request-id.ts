import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * CRITICAL money fix (2026-09-30): the client `X-Request-Id` header is TRACE
 * ONLY. It is no longer the financial idempotency key on the legacy billing
 * path — a client that replayed one fixed header made every later request
 * hit `idempotent=TRUE` inside `aiag_settle_charge_credits` and return a free
 * inference, unbounded, with no privilege required. The stored/admission path
 * was already safe (its financial identity is the server-minted
 * `billing_request_id` UUID; `client_request_id` is only compared for
 * identity conflicts).
 *
 * Two ids are minted per request now:
 *  - `requestId` — the trace id. Echoed as `X-Request-Id`, used for logs,
 *    `logRequest`, PII rows. Client value honored, but VALIDATED (see
 *    `CLIENT_TRACE_ID_RE`) so a header can never blow up the VARCHAR(64)
 *    `request_id` column after the provider has already been paid.
 *  - `settlementRequestId` — ALWAYS server-minted (`stl_<uuid>`), never
 *    client-influenced. This is what legacy `settleCharge` passes to
 *    `aiag_settle_charge_credits`, so a repeated client header can no longer
 *    suppress a charge.
 *
 * Invariant for future callers: only `settlementRequestId` may reach a money
 * function. Anything reaching SQL from a request header is trace data.
 */

/**
 * Deliberately the same shape the stored HTTP-idempotency contract uses
 * (docs/superpowers/plans/2026-09-08-gateway-http-storage.md): 1…64 ASCII
 * `[A-Za-z0-9._:-]`. 64 is `gateway_transactions.request_id`'s VARCHAR limit,
 * so an accepted value can never fail the INSERT.
 */
export const CLIENT_TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Trace id: the client's value when it validates, else a fresh server id. */
export function resolveTraceRequestId(incoming: string | undefined): string {
  return incoming && CLIENT_TRACE_ID_RE.test(incoming) ? incoming : newRequestId();
}

/** Server-owned ids. Never derived from anything a client sent. */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/** Server-owned settlement identity — the ONLY id money functions may see. */
export function newSettlementRequestId(): string {
  return `stl_${randomUUID()}`;
}

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const rid = resolveTraceRequestId(c.req.header('x-request-id'));
    c.set('requestId' as never, rid as never);
    c.set('settlementRequestId' as never, newSettlementRequestId() as never);
    c.header('X-Request-Id', rid);
    await next();
  };
}