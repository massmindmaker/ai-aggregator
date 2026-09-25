import type { StoredChatStreamEvent } from '../upstreams/interface';
import { unavailable } from './admission-internal';
import { parseAdmissionJsonObject, type JsonObject } from './admission-result';
import { parseStoredHttpChatResponse, type StoredHttpChatResponse } from './http-storage-result';
import { microCreditsToUsdMicroString } from './token-quote';

export type StoredHttpChatStreamResponse = Readonly<{
  object: 'aiag.chat.stream.v1';
  events: readonly StoredChatStreamEvent[];
  final: StoredHttpChatResponse;
}>;

function exact(value: unknown, names: readonly string[]): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== names.length
    || names.some((name) => !Object.hasOwn(value, name))) unavailable();
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) unavailable();
  return value;
}
function bounded(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) unavailable();
  return value;
}

/** Exact persisted stream envelope selected only by trusted contractVersion=2. */
export function parseStoredHttpChatStreamResponse(value: unknown): StoredHttpChatStreamResponse {
  let body: JsonObject;
  try { body = parseAdmissionJsonObject(value); } catch { unavailable(); }
  exact(body, ['object', 'events', 'final']);
  if (body.object !== 'aiag.chat.stream.v1' || !Array.isArray(body.events)
    || body.events.length < 2 || body.events.length > 4096
    || Buffer.byteLength(JSON.stringify(body), 'utf8') > 1_048_576) unavailable();

  let id: string | null = null;
  let model: string | null = null;
  let created: number | null = null;
  let content = '';
  let finish: 'stop' | 'length' | 'content_filter' | null = null;
  let terminalUsage: JsonObject | null = null;
  const events: StoredChatStreamEvent[] = [];
  for (let index = 0; index < body.events.length; index += 1) {
    const raw = body.events[index];
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 65_536) unavailable();
    const hasUsage = !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'usage');
    exact(raw, hasUsage
      ? ['id', 'object', 'created', 'model', 'choices', 'usage']
      : ['id', 'object', 'created', 'model', 'choices']);
    const eventId = bounded(raw.id, /^[A-Za-z0-9_-]{1,256}$/);
    const eventModel = bounded(raw.model, /^[A-Za-z0-9_./:@+-]{1,256}$/);
    const eventCreated = count(raw.created);
    if (raw.object !== 'chat.completion.chunk' || !Array.isArray(raw.choices)) unavailable();
    if (id === null) { id = eventId; model = eventModel; created = eventCreated; }
    if (eventId !== id || eventModel !== model || eventCreated !== created) unavailable();

    if (hasUsage) {
      if (index !== body.events.length - 1 || finish === null || terminalUsage !== null || raw.choices.length !== 0) unavailable();
      const usage = raw.usage;
      const cached = !!usage && typeof usage === 'object' && !Array.isArray(usage) && Object.hasOwn(usage, 'cached_input_tokens');
      exact(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', ...(cached ? ['cached_input_tokens'] : [])]);
      const prompt = count(usage.prompt_tokens), completion = count(usage.completion_tokens);
      if (count(usage.total_tokens) !== prompt + completion
        || (cached && count(usage.cached_input_tokens) > prompt)) unavailable();
      terminalUsage = usage;
    } else {
      if (terminalUsage !== null || finish !== null || raw.choices.length !== 1) unavailable();
      const choice = raw.choices[0] as JsonObject;
      exact(choice, ['index', 'delta', 'finish_reason']);
      if (count(choice.index) !== 0) unavailable();
      const delta = choice.delta as JsonObject;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) unavailable();
      const deltaKeys = Object.keys(delta);
      if (deltaKeys.length > 1 || (deltaKeys[0] !== undefined && !['role', 'content'].includes(deltaKeys[0]))) unavailable();
      if (Object.hasOwn(delta, 'role') && (delta.role !== 'assistant' || index !== 0)) unavailable();
      if (Object.hasOwn(delta, 'content')) {
        if (typeof delta.content !== 'string' || delta.content.length === 0) unavailable();
        content += delta.content;
        if (Buffer.byteLength(content, 'utf8') > 524_288) unavailable();
      }
      const reason = choice.finish_reason;
      if (reason === null) {
        if (deltaKeys.length === 0) unavailable();
      } else {
        if (!['stop', 'length', 'content_filter'].includes(reason as string)
          || deltaKeys.length !== 0 || finish !== null) unavailable();
        finish = reason as unknown as typeof finish;
      }
    }
    events.push(raw as unknown as StoredChatStreamEvent);
  }
  if (id === null || model === null || created === null || finish === null || terminalUsage === null) unavailable();
  const final = parseStoredHttpChatResponse(body.final);
  const finalChoice = final.choices[0]!;
  const terminalCached = Object.hasOwn(terminalUsage, 'cached_input_tokens')
    ? terminalUsage.cached_input_tokens
    : undefined;
  if (final.id !== id || final.model !== model || final.created !== created
    || finalChoice.message.content !== content || finalChoice.finish_reason !== finish
    || final.usage.prompt_tokens !== terminalUsage.prompt_tokens
    || final.usage.completion_tokens !== terminalUsage.completion_tokens
    || final.usage.total_tokens !== terminalUsage.total_tokens
    || final.usage.cached_input_tokens !== terminalCached) unavailable();
  return Object.freeze({ object: 'aiag.chat.stream.v1', events: Object.freeze(events), final });
}

export function encodeStoredChatSseEvent(event: StoredChatStreamEvent): Uint8Array {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  if (bytes.byteLength > 65_536) throw new TypeError('stream event too large');
  return bytes;
}
export function encodeStoredChatSseDone(): Uint8Array { return new TextEncoder().encode('data: [DONE]\n\n'); }
export function projectStoredChatStreamReplay(
  result: StoredHttpChatStreamResponse,
  billingRequestId: string,
  actualCostCredits: bigint,
): Response {
  const chunks = result.events.map(encodeStoredChatSseEvent);
  chunks.push(encodeStoredChatSseDone());
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  const headers = new Headers({ 'cache-control': 'private, no-store', 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
  headers.set('x-aiag-billing-request-id', billingRequestId);
  headers.set('x-aiag-receipt-version', '1');
  headers.set('x-aiag-charged-microcredits', actualCostCredits.toString());
  headers.set('x-aiag-charge-state', 'settled');
  headers.set('x-aiag-charged-usd-micro', microCreditsToUsdMicroString(actualCostCredits));
  return new Response(body, { status: 200, headers });
}
export function storedChatStreamHeaders(billingRequestId: string): Record<string,string> {
  return { 'cache-control': 'private, no-store', 'content-type': 'text/event-stream', 'x-accel-buffering': 'no', 'x-aiag-billing-request-id': billingRequestId };
}
