/**
 * SSE streaming proxy + partial settle on client abort (FIX C4 / Task 11b).
 *
 * - Forwards upstream SSE chunks to client via hono/streaming.
 * - Parses token usage as chunks arrive.
 * - On completion OR client-abort: calls settleCharge + logRequest.
 * - Partial responses tagged with header `X-AIAG-Partial: true`.
 */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { settleCharge } from '../billing/settle';
import {
  incrementSpendCounters,
  type SpendCounterArgs,
} from '../billing/spend-counters';
import {
  BILLING_HEADERS,
  formatUsdMicroHeader,
} from '../lib/billing-headers';
import { logRequest } from '../logging/stream';
import { calcCostCredits, calcByokFeeCredits, MICRO_PER_USD } from '../lib/pricing';
import { logger } from '../lib/logger';
import type { UpstreamCandidate } from '../routing/engine';
import { stripUpstreamFields } from './scrub';

export type StreamSettleOpts = {
  upstream: UpstreamCandidate;
  model: { slug: string; type: string };
  /**
   * Widened from `{id, org_id}` to the cap-bearing fields: the stream path
   * settled money but never moved the daily-USD / monthly-cost / session
   * counters, so `stream:true` was a free bypass of every enforced cap. The
   * shape is exactly what incrementSpendCounters needs (any route's `key`
   * satisfies it).
   */
  key: SpendCounterArgs['key'];
  /** `x-aiag-session-id`, forwarded so the per-session budget accumulates. */
  sessionId?: string | null;
  requestId: string;
  byok: boolean;
};

export async function streamSseAndSettle(
  c: Context,
  upstreamStream: AsyncIterable<unknown>,
  opts: StreamSettleOpts
): Promise<Response> {
  const start = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let aborted = false;
  let clientClosed = false;

  const clientSignal = c.req.raw.signal;
  const onAbort = (): void => {
    clientClosed = true;
  };
  clientSignal.addEventListener('abort', onAbort);

  return streamSSE(c, async (sseStream) => {
    try {
      for await (const chunk of upstreamStream) {
        if (clientSignal.aborted) {
          aborted = true;
          break;
        }
        const json =
          typeof chunk === 'string'
            ? safeJson(chunk)
            : (chunk as Record<string, unknown>);
        if (json && typeof json === 'object') {
          // White-label: strip provider-revealing fields before this chunk
          // is ever written to the client (mirrors the non-stream cleanup
          // in upstreams/{openrouter,gonka,groq}.ts).
          stripUpstreamFields(json as Record<string, unknown>);
          const usage = (json as any).usage;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.completion_tokens ?? outputTokens;
            cachedInputTokens = usage.cached_input_tokens ?? cachedInputTokens;
          }
          const delta = (json as any).choices?.[0]?.delta?.content;
          if (typeof delta === 'string') {
            outputTokens += Math.max(1, Math.ceil(delta.length / 4));
          }
        }
        await sseStream.writeSSE({ data: JSON.stringify(json) });
      }
      await sseStream.writeSSE({ data: '[DONE]' });
    } catch (e) {
      logger.warn(
        { err: String(e), requestId: opts.requestId },
        'sse_stream_error'
      );
    } finally {
      clientSignal.removeEventListener('abort', onAbort);
    }

    // settle + log — T1-fix (2026-07-16 rework): whole MICRO-credits, no
    // ₽/FX. `upstream.price_per_1k_input/output` are already US CENTS — see
    // lib/pricing.ts (upstreamCents, not upstreamUsd — the original bug).
    let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
    let upstreamCostUsd = 0;
    // Hoisted out of the `else` branch: the cap-counter increment below needs
    // it (daily_usd_cap accumulates real USD = cents / 100).
    let upstreamCents = 0;
    // D-1 (USD-native): costCredits (micro) / MICRO_PER_USD = real USD.
    let chargedUsd = 0;
    // Whether settlement completed. In the non-stream branch a settle failure
    // throws out of the handler and the counters are never reached — mirror
    // that here rather than counting spend that was never actually charged.
    let settled = true;
    try {
      if (opts.byok) {
        costCredits = calcByokFeeCredits();
        chargedUsd = costCredits / MICRO_PER_USD;
      } else {
        upstreamCents =
          (inputTokens / 1000) * opts.upstream.price_per_1k_input +
          (outputTokens / 1000) * opts.upstream.price_per_1k_output;
        costCredits = calcCostCredits({
          upstreamCents,
          markup: opts.upstream.markup,
          cachedInputTokens,
          totalInputTokens: inputTokens,
        });
        upstreamCostUsd = upstreamCents / 100;
        chargedUsd = costCredits / MICRO_PER_USD;
      }
      if (costCredits > 0) {
        await settleCharge({
          orgId: opts.key.org_id,
          requestId: opts.requestId,
          costCredits,
          metadata: {
            model_slug: opts.model.slug,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        });
      }
    } catch (e) {
      settled = false;
      logger.error(
        { err: String(e), requestId: opts.requestId },
        'sse_settle_failed'
      );
    }

    // Cap counters — the stream path's missing half. Runs on the same terms
    // as the non-stream branch in chat.ts (after settlement, best-effort so a
    // Redis blip can't break an already-served response). Deliberately
    // OUTSIDE the settle try/catch (the helper swallows its own Redis errors),
    // but gated on `settled` so a failed charge is not counted as spend.
    if (settled) {
      await incrementSpendCounters({
        key: opts.key,
        byok: opts.byok,
        upstreamCents,
        costCredits,
        sessionId: opts.sessionId,
      });
    }

    // T1: legacy ₽ headers (X-AIAG-Charged-Rub / X-AIAG-Upstream-Cost-Rub) are
    // no longer emitted — see chat.ts for the same note (zero real consumers,
    // required the FX rate this migration removes from the hot path).
    // D-1: USD-micro pair the TMA worker reads.
    c.header(BILLING_HEADERS.CHARGED_USD_MICRO, formatUsdMicroHeader(chargedUsd));
    c.header(
      BILLING_HEADERS.UPSTREAM_COST_USD_MICRO,
      formatUsdMicroHeader(upstreamCostUsd),
    );

    const statusCode = clientClosed || aborted ? 499 : 200;
    if (clientClosed || aborted) c.header('X-AIAG-Partial', 'true');

    void logRequest({
      requestId: opts.requestId,
      orgId: opts.key.org_id,
      apiKeyId: opts.key.id,
      type: opts.model.type,
      modelSlug: opts.model.slug,
      upstreamId: opts.upstream.upstream_id,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalCostCredits: costCredits,
      statusCode,
      latencyMs: Date.now() - start,
      byok: opts.byok,
    });
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
