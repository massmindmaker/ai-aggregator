import { handleAuthorChat } from "./author-chat";
import type { Context, Handler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { config } from "../../config";
import type { AuthenticatedApiKey } from "../../middleware/auth-plan04";
import { createStoredChatAttempt } from "../../billing/stored-chat-attempt";
import { createStoredChatByokAttempt } from "../../billing/stored-chat-byok-attempt";
import { createStoredChatStreamAttempt } from "../../billing/stored-chat-stream-attempt";
import {
  encodeStoredChatSseEvent,
  encodeStoredChatSseDone,
  projectStoredChatStreamReplay,
  storedChatStreamHeaders,
} from "../../billing/stored-chat-stream-http-contract";
import type { StoredChatHttpIdentity } from "../../billing/stored-chat-http-identity";
import type { ResolvedModel } from "../../routing/resolver";
import {
  captureStoredChatHttpRequest,
  fixedStoredChatHttpError,
  projectStoredChatHttpResult,
  StoredChatHttpContractError,
  STORED_CHAT_PRE_DISPATCH_WINDOW_MS,
  type StoredChatHttpResponseDescriptor,
} from "../../billing/stored-chat-http-contract";
import {
  claimGatewayHttpRequest,
  recordGatewayHttpOutcome,
  HttpStorageAccessError,
  HttpStorageConflictError,
  type GatewayHttpIdentity,
} from "../../billing/http-storage";
import {
  admitGatewayHttpCharge,
  readGatewayHttpResultV2,
  rejectUnstartedGatewayHttpRequest,
  isHttpRejectionCode,
  type HttpResultV2,
} from "../../billing/http-terminal-recovery";
import {
  resolveStoredChatFreshModel,
  StoredChatFreshModelError,
} from "../../routing/stored-chat-fresh-resolver";
import {
  prepareStoredChatFreshPolicy,
  StoredChatFreshPolicyError,
} from "../../billing/stored-chat-fresh-policy";

export function respondStoredChat(
  c: Context,
  descriptor: StoredChatHttpResponseDescriptor,
): Response {
  for (const [name, value] of Object.entries(descriptor.headers))
    c.header(name, value);
  return c.body(
    JSON.stringify(descriptor.body),
    descriptor.status as ContentfulStatusCode,
  );
}

export const unsupportedStoredExecution: Handler = (c) =>
  respondStoredChat(
    c,
    fixedStoredChatHttpError("unsupported_execution_contract"),
  );

function respondStoredStreamRead(
  c: Context,
  result: HttpResultV2<"chat">,
): Response {
  if (result.status === "ready" && result.contractVersion === 2)
    return projectStoredChatStreamReplay(
      result.response as import("../../billing/stored-chat-stream-http-contract").StoredHttpChatStreamResponse,
      result.billingRequestId,
      result.actualCostCredits,
    );
  return respondStoredChat(c, projectStoredChatHttpResult(result));
}

async function storedChatStream(
  c: Context,
  identity: StoredChatHttpIdentity,
  scope: GatewayHttpIdentity<"chat">,
  model: ResolvedModel,
  prepared: ReturnType<typeof prepareStoredChatFreshPolicy>,
  requestId: string,
): Promise<Response> {
  const attempt = createStoredChatStreamAttempt(
    {
      orgId: scope.orgId,
      apiKeyId: scope.apiKeyId,
      clientRequestId: requestId,
      declaredSessionId: identity.declaredSessionId,
      model,
      body: identity.attemptBody,
      requestedMode: prepared.requestedMode,
      policy: prepared.policy,
      defaultMaxOutputTokens: config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS,
      cachingDiscount: config.STORED_CHAT_CACHING_DISCOUNT_EXACT,
      preDispatchDeadlineAt: new Date(
        Date.now() + STORED_CHAT_PRE_DISPATCH_WINDOW_MS,
      ).toISOString(),
      signal: c.req.raw.signal,
    },
    {
      admitAttempt: (args) => admitGatewayHttpCharge({ ...args, ...scope }),
      rejectUnstarted: (args) =>
        rejectUnstartedGatewayHttpRequest({
          ...scope,
          billingRequestId: args.billingRequestId,
        }),
      persistOutcome: (args) =>
        recordGatewayHttpOutcome({
          ...args,
          idempotencyKeyDigest: scope.idempotencyKeyDigest,
          requestFingerprint: scope.requestFingerprint,
          contractVersion: 2,
        }),
    },
  );
  if (attempt.status !== "ready")
    return respondStoredChat(
      c,
      fixedStoredChatHttpError(
        attempt.status === "bad_request"
          ? "invalid_stored_chat_request"
          : "stored_chat_unavailable",
      ),
    );
  const claim = await claimGatewayHttpRequest({
    ...scope,
    billingRequestId: attempt.billingRequestId,
  });
  if (!claim.didClaim) {
    const existing = await readGatewayHttpResultV2(scope);
    return respondStoredStreamRead(c, existing);
  }
  const begun = await attempt.begin();
  if (begun.kind !== "dispatch_granted") {
    const existing = await readGatewayHttpResultV2(scope);
    if (existing.status !== "not_found")
      return respondStoredStreamRead(c, existing);
    return respondStoredChat(
      c,
      fixedStoredChatHttpError("request_state_unavailable"),
    );
  }
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: Parameters<typeof begun.runner.run>[0] = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encodeStoredChatSseEvent(event));
        } catch {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      void begun.runner
        .run(emit)
        .then((result) => {
          if (closed) return;
          if (result.kind === "settled_success")
            controller.enqueue(encodeStoredChatSseDone());
          closed = true;
          controller.close();
        })
        .catch(() => {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: storedChatStreamHeaders(begun.billingRequestId),
  });
}

/** Sole restricted execution composition; imported by the real server assembly. */
export const storedChat: Handler = async (c) => {
  // Pin exact startup configuration before the first await. Never reconstruct it from a Number.
  const cachingDiscount = config.STORED_CHAT_CACHING_DISCOUNT_EXACT;
  const defaultMaxOutputTokens = config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS;
  try {
    const byokHeaderPresent = c.req.raw.headers.has("x-upstream-key");
    const byokKey = c.req.raw.headers.get("x-upstream-key");
    if (
      byokHeaderPresent &&
      (![
        "stored_chat_embeddings_completions_stream",
        "stored_chat_embeddings_completions_stream_media",
        "stored_chat_embeddings_completions_stream_media_batches",
      ].includes(config.GATEWAY_HTTP_EXECUTION_MODE) ||
        byokKey === "")
    )
      return respondStoredChat(
        c,
        fixedStoredChatHttpError("unsupported_execution_contract"),
      );
    const key = c.get("apiKey" as never) as AuthenticatedApiKey;
    const { identity } = await captureStoredChatHttpRequest(c.req.raw);
    const authorResponse = await handleAuthorChat(c, key, identity);
    if (authorResponse) return authorResponse;

    if (identity.billingMode === "byok_fee") {
      if (
        identity.contractVersion !== 3 ||
        identity.attemptBody.stream ||
        byokKey === null ||
        ![
          "stored_chat_embeddings_completions_stream",
          "stored_chat_embeddings_completions_stream_media",
          "stored_chat_embeddings_completions_stream_media_batches",
        ].includes(config.GATEWAY_HTTP_EXECUTION_MODE)
      )
        return respondStoredChat(
          c,
          fixedStoredChatHttpError("unsupported_execution_contract"),
        );
      const scope: GatewayHttpIdentity<"chat"> = Object.freeze({
        orgId: key.org_id,
        apiKeyId: key.id,
        routeKind: "chat",
        billingMode: "byok_fee",
        contractVersion: 3,
        idempotencyKeyDigest: identity.idempotencyKeyDigest,
        requestFingerprint: identity.requestFingerprint,
      });
      const read = async () =>
        projectStoredChatHttpResult(await readGatewayHttpResultV2(scope));
      const existing = await readGatewayHttpResultV2(scope);
      if (existing.status !== "not_found")
        return respondStoredChat(c, projectStoredChatHttpResult(existing));
      const model = await resolveStoredChatFreshModel(
        identity.attemptBody.model,
      );
      const requestId = c.get("requestId" as never) as string;
      const prepared = prepareStoredChatFreshPolicy({
        key,
        identity,
        model,
        requestId,
      });
      const handle = createStoredChatByokAttempt(
        {
          orgId: scope.orgId,
          apiKeyId: scope.apiKeyId,
          clientRequestId: requestId,
          declaredSessionId: identity.declaredSessionId,
          body: identity.attemptBody,
          ...prepared,
          byokKey,
          feeCreditsExact: config.BYOK_FEE_CREDITS_EXACT,
          defaultMaxOutputTokens,
          preDispatchDeadlineAt: new Date(
            Date.now() + STORED_CHAT_PRE_DISPATCH_WINDOW_MS,
          ).toISOString(),
          signal: c.req.raw.signal,
        },
        {
          admitAttempt: (args) => admitGatewayHttpCharge({ ...args, ...scope }),
          rejectUnstarted: (args) =>
            rejectUnstartedGatewayHttpRequest({
              ...scope,
              billingRequestId: args.billingRequestId,
            }),
          persistOutcome: (args) =>
            recordGatewayHttpOutcome({
              ...args,
              idempotencyKeyDigest: scope.idempotencyKeyDigest,
              requestFingerprint: scope.requestFingerprint,
              contractVersion: 3,
            }),
        },
      );
      if (handle.status !== "ready")
        return respondStoredChat(
          c,
          fixedStoredChatHttpError(
            handle.status === "bad_request"
              ? "invalid_stored_chat_request"
              : "stored_chat_unavailable",
          ),
        );
      const claim = await claimGatewayHttpRequest({
        ...scope,
        billingRequestId: handle.billingRequestId,
      });
      if (!claim.didClaim) return respondStoredChat(c, await read());

      let result: Awaited<ReturnType<typeof handle.run>>;
      try {
        result = await handle.run();
      } catch {
        return respondStoredChat(
          c,
          fixedStoredChatHttpError("request_state_unavailable"),
        );
      }
      if (
        !result ||
        result.billingRequestId !== handle.billingRequestId ||
        (result.kind === "rejected" && !isHttpRejectionCode(result.code)) ||
        (result.kind === "replay" &&
          ![
            "held",
            "dispatched",
            "outcome_recorded",
            "settled",
            "cancelled",
          ].includes(result.state)) ||
        (result.kind === "settled_success" &&
          (typeof result.actualCostCredits !== "bigint" ||
            result.actualCostCredits <= 0n ||
            !result.response ||
            !result.admission ||
            result.admission.state !== "settled" ||
            result.admission.billingRequestId !== handle.billingRequestId))
      )
        return respondStoredChat(
          c,
          fixedStoredChatHttpError("request_state_unavailable"),
        );
      switch (result.kind) {
        case "settled_success":
        case "rejected":
        case "replay":
        case "cancelled_no_charge":
          return respondStoredChat(c, await read());
        case "reconciliation_required":
        case "not_started":
        default:
          return respondStoredChat(
            c,
            fixedStoredChatHttpError("request_state_unavailable"),
          );
      }
    }

    if (identity.billingMode !== "stored")
      return respondStoredChat(
        c,
        fixedStoredChatHttpError("unsupported_execution_contract"),
      );
    if (
      identity.contractVersion === 2 &&
      ![
        "stored_chat_embeddings_completions_stream",
        "stored_chat_embeddings_completions_stream_media",
        "stored_chat_embeddings_completions_stream_media_batches",
      ].includes(config.GATEWAY_HTTP_EXECUTION_MODE)
    )
      return respondStoredChat(
        c,
        fixedStoredChatHttpError("unsupported_execution_contract"),
      );
    const scope: GatewayHttpIdentity<"chat"> = Object.freeze({
      orgId: key.org_id,
      apiKeyId: key.id,
      routeKind: "chat",
      billingMode: "stored",
      contractVersion: identity.contractVersion,
      idempotencyKeyDigest: identity.idempotencyKeyDigest,
      requestFingerprint: identity.requestFingerprint,
    });
    if (identity.contractVersion === 2) {
      const existing = await readGatewayHttpResultV2(scope);
      if (existing.status !== "not_found")
        return respondStoredStreamRead(c, existing);
      const model = await resolveStoredChatFreshModel(
        identity.attemptBody.model,
      );
      const requestId = c.get("requestId" as never) as string;
      const prepared = prepareStoredChatFreshPolicy({
        key,
        identity,
        model,
        requestId,
      });
      return storedChatStream(c, identity, scope, model, prepared, requestId);
    }
    const read = async () =>
      projectStoredChatHttpResult(await readGatewayHttpResultV2(scope));
    const existing = await readGatewayHttpResultV2(scope);
    if (existing.status !== "not_found")
      return respondStoredChat(c, projectStoredChatHttpResult(existing));
    const model = await resolveStoredChatFreshModel(identity.attemptBody.model);
    const requestId = c.get("requestId" as never) as string;
    const prepared = prepareStoredChatFreshPolicy({
      key,
      identity,
      model,
      requestId,
    });
    const preDispatchDeadlineAt = new Date(
      Date.now() + STORED_CHAT_PRE_DISPATCH_WINDOW_MS,
    ).toISOString();
    const handle = createStoredChatAttempt(
      {
        orgId: scope.orgId,
        apiKeyId: scope.apiKeyId,
        clientRequestId: requestId,
        declaredSessionId: identity.declaredSessionId,
        body: identity.attemptBody,
        ...prepared,
        cachingDiscount,
        defaultMaxOutputTokens,
        preDispatchDeadlineAt,
        signal: c.req.raw.signal,
      },
      {
        admitAttempt: (args) => admitGatewayHttpCharge({ ...args, ...scope }),
        rejectUnstarted: (args) =>
          rejectUnstartedGatewayHttpRequest({
            ...scope,
            billingRequestId: args.billingRequestId,
          }),
        persistOutcome: (args) =>
          recordGatewayHttpOutcome({
            ...args,
            idempotencyKeyDigest: scope.idempotencyKeyDigest,
            requestFingerprint: scope.requestFingerprint,
          }),
      },
    );
    if (handle.status !== "ready")
      return respondStoredChat(
        c,
        fixedStoredChatHttpError(
          handle.status === "bad_request"
            ? "invalid_stored_chat_request"
            : "stored_chat_unavailable",
        ),
      );
    const claim = await claimGatewayHttpRequest({
      ...scope,
      billingRequestId: handle.billingRequestId,
    });
    if (!claim.didClaim) return respondStoredChat(c, await read());
    // The committed B1 ACK is the only grant. The handle itself is single-run.
    let result: Awaited<ReturnType<typeof handle.run>>;
    try {
      result = await handle.run();
    } catch {
      return respondStoredChat(
        c,
        fixedStoredChatHttpError("request_state_unavailable"),
      );
    }
    if (
      !result ||
      result.billingRequestId !== handle.billingRequestId ||
      (result.kind === "rejected" && !isHttpRejectionCode(result.code)) ||
      (result.kind === "replay" &&
        ![
          "held",
          "dispatched",
          "outcome_recorded",
          "settled",
          "cancelled",
        ].includes(result.state)) ||
      (result.kind === "settled_success" &&
        (typeof result.actualCostCredits !== "bigint" ||
          result.actualCostCredits < 0n ||
          !result.response ||
          !result.admission ||
          result.admission.state !== "settled" ||
          result.admission.billingRequestId !== handle.billingRequestId))
    )
      return respondStoredChat(
        c,
        fixedStoredChatHttpError("request_state_unavailable"),
      );
    switch (result.kind) {
      case "settled_success":
      case "rejected":
      case "replay":
      case "cancelled_no_charge":
        return respondStoredChat(c, await read());
      case "reconciliation_required":
      case "not_started":
      default:
        return respondStoredChat(
          c,
          fixedStoredChatHttpError("request_state_unavailable"),
        );
    }
  } catch (error) {
    if (error instanceof StoredChatHttpContractError) {
      // MC1 errors carry fixed definitions only. Rebuild their descriptor to include retry/cache headers.
      const kinds = {
        INVALID_STORED_CHAT_HTTP_IDENTITY: "invalid_identity",
        REQUEST_BODY_TOO_LARGE: "request_body_too_large",
        UNSUPPORTED_CONTENT_TYPE: "unsupported_content_type",
        UNSUPPORTED_EXECUTION_CONTRACT: "unsupported_execution_contract",
      } as const;
      const kind = kinds[error.code as keyof typeof kinds];
      return respondStoredChat(
        c,
        fixedStoredChatHttpError(kind ?? "request_state_unavailable"),
      );
    }
    const kind =
      error instanceof HttpStorageAccessError
        ? "authentication_required"
        : error instanceof HttpStorageConflictError
          ? "request_conflict"
          : error instanceof StoredChatFreshPolicyError
            ? error.kind
            : error instanceof StoredChatFreshModelError
              ? "model_unavailable"
              : "request_state_unavailable";
    return respondStoredChat(c, fixedStoredChatHttpError(kind));
  }
};
