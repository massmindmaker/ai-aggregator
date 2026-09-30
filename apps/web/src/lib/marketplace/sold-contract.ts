/**
 * Sold v1 execution contract — the storefront's ONLY source for what the
 * gateway will actually execute.
 *
 * 🔴 AG-7 (2026-09-30): the model detail page used to render
 * Streaming / Tool-calling / Vision / JSON schema from
 * `catalog.generated.ts` `capabilities.*` — static upstream metadata generated
 * by gen-marketplace-catalog.ts. That is NOT what we sell. The advertised
 * contract in `packages/api-gateway/src/catalog/public-catalog.ts` says the
 * exact opposite for the sold v1 scope:
 *
 *   - `capability.streaming === false`            (public-catalog.ts:642)
 *   - `capability.toolCalling === false`          (:643)
 *   - `capability.structuredOutput === false`     (:644)
 *   - `capability.inputModalities === ['text']`   (:640) and
 *     `requestBody.multimodalMessageContent === 'reject'` (:609) → no vision
 *   - `unsupportedExecutionFields: ['tools','functions','tool_choice', …]` (:608)
 *   - `parameters.stream === { const: false, normalizedDefault: false }` (:619)
 *
 * So a card that said "Tool-calling: да" (9 of 36 LLMs carried that flag) sent
 * the buyer to a 501 `unsupported_execution_contract`. Storefront copy must
 * narrow to this contract, never to the generator's optimism.
 *
 * Scope of the sold contract (what `/v1/catalog` can mark `available`):
 * `projectModel()` returns `available` only for `chat` and `embedding`
 * (public-catalog.ts:519-521). Image / video / audio are sold through the
 * dedicated media endpoints, NOT through the chat catalog contract, so they
 * must not be advertised as chat models here.
 */

export interface SoldCapability {
  /** Stable id for the capability row. */
  id: 'streaming' | 'toolCalling' | 'vision' | 'structuredOutput';
  /** Russian label shown on the model page. */
  label: string;
  /** What the sold v1 gateway contract actually does. */
  supported: boolean;
  /** Short, factual explanation of the contract. */
  note: string;
}

/** The single source of truth for every capability claim on the storefront. */
export const SOLD_CAPABILITIES: readonly SoldCapability[] = Object.freeze([
  Object.freeze({
    id: 'streaming',
    label: 'Потоковая выдача (SSE)',
    supported: false,
    note: 'В ответе всегда приходит полный JSON, без stream-дельт.',
  }),
  Object.freeze({
    id: 'toolCalling',
    label: 'Вызов функций (tools)',
    supported: false,
    note: 'Поля tools / functions / tool_choice отклоняются шлюзом.',
  }),
  Object.freeze({
    id: 'vision',
    label: 'Изображения во входе',
    supported: false,
    note: 'Контент сообщения — только текст.',
  }),
  Object.freeze({
    id: 'structuredOutput',
    label: 'Структурированный вывод по схеме',
    supported: false,
    note: 'Формат ответа задаёт модель, не JSON Schema.',
  }),
]);

/** Model types the chat catalog contract can actually serve. */
export const SOLD_CHAT_TYPES: readonly string[] = Object.freeze(['llm']);

/** Model types `/v1/catalog` can serve (chat + embedding). */
export const SOLD_CATALOG_TYPES: readonly string[] = Object.freeze([
  'llm',
  'embedding',
]);

/**
 * Can the chat playground route (`/api/playground/run` → `/v1/chat/completions`)
 * be offered for a model of this type? It posts a chat completion for whatever
 * slug it is given, so anything that is not a chat model is a guaranteed
 * failure. Media models are exercised through their own endpoints instead.
 */
export function isChatRunnable(type: string): boolean {
  return SOLD_CHAT_TYPES.includes(type);
}
