import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  callWithFallback,
  HDR_CHARGED_USD_MICRO,
  HDR_UPSTREAM_COST_USD_MICRO,
} from '../agent-runner.js';

/**
 * D-0 gateway↔worker header CONTRACT test.
 *
 * The readiness assessment (2026-06-04) found the D-0 keystone was dead because
 * the gateway emitted `X-AIAG-Charged-Rub` (₽) while the worker read
 * `x-aiag-charged-usd-micro` (USD-micro) — names never overlapped, so
 * `billedByGateway` was ALWAYS false and the worker always fell back to its
 * local estimate table. The fix makes the gateway emit the USD-micro pair the
 * worker already reads.
 *
 * This test pins BOTH sides to ONE literal source of truth so the contract can
 * never silently drift again:
 *   GATEWAY_EMITTED_* = the byte strings the gateway sets
 *     (packages/api-gateway/src/lib/billing-headers.ts
 *      BILLING_HEADERS.CHARGED_USD_MICRO / UPSTREAM_COST_USD_MICRO).
 * The worker package can't import the gateway package (no dependency), so the
 * gateway's literal is mirrored here and the gateway-side test
 * (billing-headers.contract.test.ts) asserts the gateway constants equal these
 * SAME literals. Together they pin the contract on both sides.
 */
const GATEWAY_EMITTED_CHARGED = 'x-aiag-charged-usd-micro';
const GATEWAY_EMITTED_UPSTREAM_COST = 'x-aiag-upstream-cost-usd-micro';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D-0 gateway↔worker billing-header contract', () => {
  it('worker reader names are byte-equal to the names the gateway emits', () => {
    expect(HDR_CHARGED_USD_MICRO).toBe(GATEWAY_EMITTED_CHARGED);
    expect(HDR_UPSTREAM_COST_USD_MICRO).toBe(GATEWAY_EMITTED_UPSTREAM_COST);
  });

  it('a gateway 200 carrying the EMITTED header names lights up billedByGateway', async () => {
    // Build the response with the GATEWAY-EMITTED names (not the worker reader
    // constants) so this asserts the wire contract, not a self-referential echo.
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            [GATEWAY_EMITTED_CHARGED]: '123400', // $0.1234 → ceil(12.34) = 13 credits
            [GATEWAY_EMITTED_UPSTREAM_COST]: '90000', // $0.09 → ceil(9) = 9 credits
          },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await callWithFallback(
      {
        url: 'http://127.0.0.1:4000/v1/chat/completions',
        apiKey: 'sk_aiag',
        model: 'm',
        isExternal: false,
      },
      { model: 'm', messages: [] },
    );

    expect(out.billedByGateway).toBe(true);
    expect(out.chargedCredits).toBe(13);
    expect(out.upstreamCostCredits).toBe(9);
  });
});
