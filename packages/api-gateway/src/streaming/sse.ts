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
  formatRubHeader,
  formatUsdMicroHeader,
} from '../lib/billing-headers';
import { logRequest } from '../logging/stream';
import { calcCostRub, calcByokFeeRub } from '../lib/pricing';
import { fetchUsdRubRate } from '../lib/cbr';
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

    // settle + log
    let totalRub = 0;
    // D-0: upstream cost we bore (₽, no markup) — 0 for BYOK.
    let upstreamCostRub = 0;
    // D-1 (USD-native): same figures in USD for the TMA worker's micro-USD pair.
    let chargedUsd = 0;
    let upstreamCostUsd = 0;
    try {
      if (opts.byok) {
        totalRub = calcByokFeeRub();
        const rate = await fetchUsdRubRate().catch(() => 92);
        chargedUsd = rate > 0 ? totalRub / rate : 0;
      } else {
        const rate = await fetchUsdRubRate().catch(() => 92);
        const upstreamUsd =
          (inputTokens / 1000) * opts.upstream.price_per_1k_input +
          (outputTokens / 1000) * opts.upstream.price_per_1k_output;
        upstreamCostRub = upstreamUsd * rate;
        totalRub = calcCostRub({
          upstreamUsd,
          rate,
          markup: opts.upstream.markup,
          cachedInputTokens,
          totalInputTokens: inputTokens,
        });
        // USD-native off the SAME rate (chargedUsd × rate == totalRub).
        upstreamCostUsd = upstreamUsd;
        chargedUsd = rate > 0 ? totalRub / rate : 0;
      }
      if (totalRub > 0) {
        await settleCharge({
          orgId: opts.key.org_id,
          requestId: opts.requestId,
          totalRub,
        });
      }
    } catch (e) {
      logger.error(
        { err: String(e), requestId: opts.requestId },
        'sse_settle_failed'
      );
    }

    // D-0: same authoritative billing headers as the non-streaming path
    // (brand-neutral ₽ figures, keyed to gateway_request_id via X-Request-Id).
    c.header(BILLING_HEADERS.CHARGED_RUB, formatRubHeader(totalRub));
    c.header(BILLING_HEADERS.UPSTREAM_COST_RUB, formatRubHeader(upstreamCostRub));
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
      totalCostRub: totalRub,
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
