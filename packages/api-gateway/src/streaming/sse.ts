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
  key: { id: string; org_id: string };
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
    // D-1 (USD-native): costCredits (micro) / MICRO_PER_USD = real USD.
    let chargedUsd = 0;
    try {
      if (opts.byok) {
        costCredits = calcByokFeeCredits();
        chargedUsd = costCredits / MICRO_PER_USD;
      } else {
        const upstreamCents =
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
      logger.error(
        { err: String(e), requestId: opts.requestId },
        'sse_settle_failed'
      );
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
