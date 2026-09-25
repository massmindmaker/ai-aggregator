import { microCreditsToUsdMicroString } from "./token-quote";
import {
  captureStoredChatHttpIdentity,
  type StoredChatHttpIdentity,
} from "./stored-chat-http-identity";
import type { HttpResultV2 } from "./http-terminal-recovery";

export const REQUEST_BODY_LIMIT_BYTES = 262_144;
export const STORED_CHAT_PRE_DISPATCH_WINDOW_MS = 30_000;

type StoredChatHttpErrorCode =
  | "INVALID_STORED_CHAT_HTTP_IDENTITY"
  | "REQUEST_BODY_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "UNSUPPORTED_EXECUTION_CONTRACT"
  | "MODEL_NOT_ALLOWED"
  | "PII_TRANSBORDER_BLOCKED"
  | "KEY_POLICY_UNAVAILABLE"
  | "MODEL_UNAVAILABLE"
  | "INVALID_STORED_CHAT_REQUEST"
  | "STORED_CHAT_UNAVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "REQUEST_CONFLICT"
  | "REQUEST_PENDING"
  | "REQUEST_RESULT_EXPIRED"
  | "REQUEST_RESULT_UNAVAILABLE"
  | "REQUEST_STATE_UNAVAILABLE";

type StoredChatHttpErrorType =
  | "request_error"
  | "authentication_error"
  | "server_error";

type ErrorDefinition = Readonly<{
  status: 400 | 401 | 403 | 409 | 410 | 413 | 415 | 501 | 503 | 202;
  code: StoredChatHttpErrorCode;
  message: string;
  type: StoredChatHttpErrorType;
  retryAfter?: "2";
}>;

const errors = Object.freeze({
  invalid_identity: {
    status: 400,
    code: "INVALID_STORED_CHAT_HTTP_IDENTITY",
    message: "Invalid stored chat request",
    type: "request_error",
  },
  request_body_too_large: {
    status: 413,
    code: "REQUEST_BODY_TOO_LARGE",
    message: "Request body too large",
    type: "request_error",
  },
  unsupported_content_type: {
    status: 415,
    code: "UNSUPPORTED_CONTENT_TYPE",
    message: "JSON content type required",
    type: "request_error",
  },
  unsupported_execution_contract: {
    status: 501,
    code: "UNSUPPORTED_EXECUTION_CONTRACT",
    message: "Operation unavailable in this execution mode",
    type: "request_error",
  },
  model_not_allowed: {
    status: 403,
    code: "MODEL_NOT_ALLOWED",
    message: "Model not allowed for this key",
    type: "request_error",
  },
  pii_transborder_blocked: {
    status: 403,
    code: "PII_TRANSBORDER_BLOCKED",
    message: "Request blocked by data policy",
    type: "request_error",
  },
  key_policy_unavailable: {
    status: 503,
    code: "KEY_POLICY_UNAVAILABLE",
    message: "Key policy unavailable",
    type: "server_error",
    retryAfter: "2",
  },
  model_unavailable: {
    status: 503,
    code: "MODEL_UNAVAILABLE",
    message: "Model unavailable",
    type: "server_error",
    retryAfter: "2",
  },
  invalid_stored_chat_request: {
    status: 400,
    code: "INVALID_STORED_CHAT_REQUEST",
    message: "Invalid stored chat request",
    type: "request_error",
  },
  stored_chat_unavailable: {
    status: 503,
    code: "STORED_CHAT_UNAVAILABLE",
    message: "Stored chat unavailable",
    type: "server_error",
    retryAfter: "2",
  },
  authentication_required: {
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
    message: "Authentication required",
    type: "authentication_error",
  },
  request_conflict: {
    status: 409,
    code: "REQUEST_CONFLICT",
    message: "Request conflicts with stored state",
    type: "request_error",
  },
  request_pending: {
    status: 202,
    code: "REQUEST_PENDING",
    message: "Request is pending",
    type: "request_error",
    retryAfter: "2",
  },
  request_result_expired: {
    status: 410,
    code: "REQUEST_RESULT_EXPIRED",
    message: "Stored response expired",
    type: "request_error",
  },
  request_result_unavailable: {
    status: 409,
    code: "REQUEST_RESULT_UNAVAILABLE",
    message: "Stored response unavailable",
    type: "request_error",
  },
  request_state_unavailable: {
    status: 503,
    code: "REQUEST_STATE_UNAVAILABLE",
    message: "Request state unavailable",
    type: "server_error",
    retryAfter: "2",
  },
} as const satisfies Record<string, ErrorDefinition>);

export type StoredChatHttpErrorKind = keyof typeof errors;
export type StoredChatHttpResponseDescriptor = Readonly<{
  status: number;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}>;

export class StoredChatHttpContractError extends Error {
  readonly status: number;
  readonly code: StoredChatHttpErrorCode;
  readonly type: StoredChatHttpErrorType;

  constructor(definition: ErrorDefinition) {
    super(definition.message);
    this.name = "StoredChatHttpContractError";
    this.status = definition.status;
    this.code = definition.code;
    this.type = definition.type;
  }
}

function descriptor(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): StoredChatHttpResponseDescriptor {
  return Object.freeze({
    status,
    body,
    headers: Object.freeze({
      "cache-control": "private, no-store",
      "content-type": "application/json",
      ...headers,
    }),
  });
}

function fixedError(
  definition: ErrorDefinition,
): StoredChatHttpResponseDescriptor {
  return descriptor(
    definition.status,
    Object.freeze({
      error: Object.freeze({
        code: definition.code,
        message: definition.message,
        type: definition.type,
      }),
    }),
    definition.retryAfter ? { "retry-after": definition.retryAfter } : {},
  );
}

export function fixedStoredChatHttpError(
  kind: StoredChatHttpErrorKind,
): StoredChatHttpResponseDescriptor {
  return fixedError(errors[kind]);
}

function contentTypeIsJson(value: string | null): boolean {
  if (value === null) return false;
  const [mediaType] = value.split(";", 1);
  return mediaType!.trim().toLowerCase() === "application/json";
}

async function cancel(
  stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (stream !== null) {
    try {
      await stream.cancel();
    } catch {
      // Oversize classification does not depend on whether a peer observes cancellation.
    }
  }
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^[0-9]+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(REQUEST_BODY_LIMIT_BYTES)) {
      await cancel(request.body);
      throw new StoredChatHttpContractError(errors.request_body_too_large);
    }
  }

  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        value === undefined ||
        size + value.byteLength > REQUEST_BODY_LIMIT_BYTES
      ) {
        try {
          await reader.cancel();
        } catch {
          // The hard size bound still applies when cancellation acknowledgement is lost.
        }
        throw new StoredChatHttpContractError(errors.request_body_too_large);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StoredChatHttpContractError(errors.invalid_identity);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnsupportedFeature(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (
    [
      "tools",
      "functions",
      "tool_choice",
      "modalities",
      "audio",
      "input_audio",
    ].some((name) => Object.hasOwn(body, name))
  )
    return true;
  return (
    Array.isArray(body.messages) &&
    body.messages.some(
      (message) =>
        isRecord(message) &&
        (Array.isArray(message.content) ||
          Object.hasOwn(message, "image_url") ||
          Object.hasOwn(message, "audio")),
    )
  );
}

export type CapturedStoredChatHttpRequest = Readonly<{
  identity: StoredChatHttpIdentity;
}>;

/**
 * Reads only the bounded public request shape. Authentication, billing scope,
 * route mounting, and fresh preparation are deliberately owned by later MCs.
 */
export async function captureStoredChatHttpRequest(
  request: Request,
): Promise<CapturedStoredChatHttpRequest> {
  if (!contentTypeIsJson(request.headers.get("content-type")))
    throw new StoredChatHttpContractError(errors.unsupported_content_type);

  const raw = await readBoundedBody(request);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new StoredChatHttpContractError(errors.invalid_identity);
  }
  if (hasUnsupportedFeature(body))
    throw new StoredChatHttpContractError(
      errors.unsupported_execution_contract,
    );

  try {
    return Object.freeze({
      identity: captureStoredChatHttpIdentity({
        body,
        idempotencyKey: request.headers.get("idempotency-key"),
        declaredSessionId: request.headers.get("x-aiag-session-id"),
        byokKey: request.headers.get("x-upstream-key"),
      }),
    });
  } catch {
    throw new StoredChatHttpContractError(errors.invalid_identity);
  }
}

function billingHeaders(billingRequestId: string): Record<string, string> {
  return { "x-aiag-billing-request-id": billingRequestId };
}

/** Maps only already-validated durable facts; it never creates an HTTP result. */
export function projectStoredChatHttpResult(
  result: HttpResultV2,
): StoredChatHttpResponseDescriptor {
  switch (result.status) {
    case "ready":
      return descriptor(result.httpStatus, result.response, {
        ...billingHeaders(result.billingRequestId),
        "x-aiag-receipt-version": "1",
        "x-aiag-charged-microcredits": result.actualCostCredits.toString(),
        "x-aiag-charge-state": "settled",
        "x-aiag-charged-usd-micro": microCreditsToUsdMicroString(
          result.actualCostCredits,
        ),
      });
    case "rejected":
      return descriptor(
        result.httpStatus,
        result.response,
        billingHeaders(result.billingRequestId),
      );
    case "pending": {
      const response = fixedStoredChatHttpError("request_pending");
      return descriptor(response.status, response.body, {
        ...response.headers,
        ...billingHeaders(result.billingRequestId),
      });
    }
    case "expired": {
      const response = fixedStoredChatHttpError("request_result_expired");
      return descriptor(response.status, response.body, {
        ...response.headers,
        ...billingHeaders(result.billingRequestId),
      });
    }
    case "unavailable": {
      const response = fixedStoredChatHttpError("request_result_unavailable");
      return descriptor(response.status, response.body, {
        ...response.headers,
        ...billingHeaders(result.billingRequestId),
      });
    }
    case "not_found":
      throw new TypeError("A not-found result requires fresh preparation");
  }
}
