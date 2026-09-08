import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from '../../config';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { createStoredChatAttempt } from '../../billing/stored-chat-attempt';
import {
  captureStoredChatHttpRequest,
  fixedStoredChatHttpError,
  projectStoredChatHttpResult,
  StoredChatHttpContractError,
  STORED_CHAT_PRE_DISPATCH_WINDOW_MS,
  type StoredChatHttpResponseDescriptor,
} from '../../billing/stored-chat-http-contract';
import {
  claimGatewayHttpRequest,
  recordGatewayHttpOutcome,
  HttpStorageAccessError,
  HttpStorageConflictError,
  type GatewayHttpIdentity,
} from '../../billing/http-storage';
import {
  admitGatewayHttpCharge,
  readGatewayHttpResultV2,
  rejectUnstartedGatewayHttpRequest,
  isHttpRejectionCode,
} from '../../billing/http-terminal-recovery';
import {
  resolveStoredChatFreshModel,
  StoredChatFreshModelError,
} from '../../routing/stored-chat-fresh-resolver';
import {
  prepareStoredChatFreshPolicy,
  StoredChatFreshPolicyError,
} from '../../billing/stored-chat-fresh-policy';

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
    fixedStoredChatHttpError('unsupported_execution_contract'),
  );

/** Sole restricted execution composition; imported by the real server assembly. */
export const storedChat: Handler = async (c) => {
  // Pin exact startup configuration before the first await. Never reconstruct it from a Number.
  const cachingDiscount = config.STORED_CHAT_CACHING_DISCOUNT_EXACT;
  const defaultMaxOutputTokens = config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS;
  try {
    if (c.req.raw.headers.has('x-upstream-key'))
      return respondStoredChat(
        c,
        fixedStoredChatHttpError('unsupported_execution_contract'),
      );
    const key = c.get('apiKey' as never) as AuthenticatedApiKey;
    const { identity } = await captureStoredChatHttpRequest(c.req.raw);
    const scope: GatewayHttpIdentity = Object.freeze({
      orgId: key.org_id,
      apiKeyId: key.id,
      routeKind: 'chat',
      billingMode: 'stored',
      contractVersion: 1,
      idempotencyKeyDigest: identity.idempotencyKeyDigest,
      requestFingerprint: identity.requestFingerprint,
    });
    const read = async () =>
      projectStoredChatHttpResult(await readGatewayHttpResultV2(scope));
    const existing = await readGatewayHttpResultV2(scope);
    if (existing.status !== 'not_found')
      return respondStoredChat(c, projectStoredChatHttpResult(existing));
    const model = await resolveStoredChatFreshModel(identity.attemptBody.model);
    const requestId = c.get('requestId' as never) as string;
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
    if (handle.status !== 'ready')
      return respondStoredChat(
        c,
        fixedStoredChatHttpError(
          handle.status === 'bad_request'
            ? 'invalid_stored_chat_request'
            : 'stored_chat_unavailable',
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
        fixedStoredChatHttpError('request_state_unavailable'),
      );
    }
    if (
      !result ||
      result.billingRequestId !== handle.billingRequestId ||
      (result.kind === 'rejected' && !isHttpRejectionCode(result.code)) ||
      (result.kind === 'replay' &&
        ![
          'held',
          'dispatched',
          'outcome_recorded',
          'settled',
          'cancelled',
        ].includes(result.state)) ||
      (result.kind === 'settled_success' &&
        (typeof result.actualCostCredits !== 'bigint' ||
          result.actualCostCredits < 0n ||
          !result.response ||
          !result.admission ||
          result.admission.state !== 'settled' ||
          result.admission.billingRequestId !== handle.billingRequestId))
    )
      return respondStoredChat(
        c,
        fixedStoredChatHttpError('request_state_unavailable'),
      );
    switch (result.kind) {
      case 'settled_success':
      case 'rejected':
      case 'replay':
      case 'cancelled_no_charge':
        return respondStoredChat(c, await read());
      case 'reconciliation_required':
      case 'not_started':
      default:
        return respondStoredChat(
          c,
          fixedStoredChatHttpError('request_state_unavailable'),
        );
    }
  } catch (error) {
    if (error instanceof StoredChatHttpContractError) {
      // MC1 errors carry fixed definitions only. Rebuild their descriptor to include retry/cache headers.
      const kinds = {
        INVALID_STORED_CHAT_HTTP_IDENTITY: 'invalid_identity',
        REQUEST_BODY_TOO_LARGE: 'request_body_too_large',
        UNSUPPORTED_CONTENT_TYPE: 'unsupported_content_type',
        UNSUPPORTED_EXECUTION_CONTRACT: 'unsupported_execution_contract',
      } as const;
      const kind = kinds[error.code as keyof typeof kinds];
      return respondStoredChat(
        c,
        fixedStoredChatHttpError(kind ?? 'request_state_unavailable'),
      );
    }
    const kind =
      error instanceof HttpStorageAccessError
        ? 'authentication_required'
        : error instanceof HttpStorageConflictError
          ? 'request_conflict'
          : error instanceof StoredChatFreshPolicyError
            ? error.kind
            : error instanceof StoredChatFreshModelError
              ? 'model_unavailable'
              : 'request_state_unavailable';
    return respondStoredChat(c, fixedStoredChatHttpError(kind));
  }
};
