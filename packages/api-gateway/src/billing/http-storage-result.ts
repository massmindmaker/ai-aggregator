import type { AdmittedChatResponse } from "../upstreams/interface";
import { parseAdmissionJsonObject, type JsonObject } from "./admission-result";
import { unavailable } from "./admission-internal";

type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type StoredHttpChatResponse = DeepReadonly<AdmittedChatResponse>;
function keys(
  value: unknown,
  expected: readonly string[],
): asserts value is JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((k) => !Object.hasOwn(value, k))
  )
    unavailable();
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    unavailable();
  return value;
}
/** Positive DTO shared by read and trusted persistence; PostgreSQL owns its canonical byte cap. */
export function parseStoredHttpChatResponse(
  value: unknown,
): StoredHttpChatResponse {
  let body: JsonObject;
  try {
    body = parseAdmissionJsonObject(value);
  } catch {
    unavailable();
  }
  keys(body, ["id", "object", "created", "model", "choices", "usage"]);
  if (
    typeof body.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(body.id) ||
    body.object !== "chat.completion" ||
    typeof body.model !== "string" ||
    !/^[A-Za-z0-9_./:@+-]{1,256}$/.test(body.model)
  )
    unavailable();
  count(body.created);
  if (!Array.isArray(body.choices) || body.choices.length !== 1) unavailable();
  const choice = body.choices[0];
  keys(choice, ["index", "message", "finish_reason"]);
  if (
    count(choice.index) !== 0 ||
    !["stop", "length", "content_filter"].includes(
      choice.finish_reason as string,
    )
  )
    unavailable();
  keys(choice.message, ["role", "content"]);
  if (
    choice.message.role !== "assistant" ||
    (choice.message.content !== null &&
      typeof choice.message.content !== "string")
  )
    unavailable();
  const usage = body.usage;
  const cached =
    usage !== null &&
    typeof usage === "object" &&
    Object.hasOwn(usage, "cached_input_tokens");
  keys(usage, [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    ...(cached ? ["cached_input_tokens"] : []),
  ]);
  const prompt = count(usage.prompt_tokens),
    completion = count(usage.completion_tokens);
  if (
    count(usage.total_tokens) !== prompt + completion ||
    (cached && count(usage.cached_input_tokens) > prompt)
  )
    unavailable();
  return body as unknown as StoredHttpChatResponse;
}
