import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from '../../config';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { createStoredChatAttempt } from '../../billing/stored-chat-attempt';
import {
  captureStoredCompletionsHttpRequest,
  fixedStoredCompletionsHttpError,
  projectStoredCompletionsHttpResult,
  StoredCompletionsHttpContractError,
  STORED_COMPLETIONS_PRE_DISPATCH_WINDOW_MS,
  type StoredCompletionsHttpResponseDescriptor,
} from '../../billing/stored-completions-http-contract';
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
import { projectStoredHttpCompletionResponse } from '../../billing/http-storage-result';
import {
  resolveStoredChatFreshModel,
  StoredChatFreshModelError,
} from '../../routing/stored-chat-fresh-resolver';
import {
  prepareStoredChatFreshPolicy,
  StoredChatFreshPolicyError,
} from '../../billing/stored-chat-fresh-policy';

export function respondStoredCompletions(
  c: Context,
  descriptor: StoredCompletionsHttpResponseDescriptor,
): Response {
  for (const [name, value] of Object.entries(descriptor.headers))
    c.header(name, value);
  return c.body(JSON.stringify(descriptor.body), descriptor.status as ContentfulStatusCode);
}

/** Mounted only by the explicit stored chat+embeddings+completions mode. */
export const storedCompletions: Handler = async (c) => {
  const cachingDiscount = config.STORED_CHAT_CACHING_DISCOUNT_EXACT;
  const defaultMaxOutputTokens = config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS;
  try {
    if (c.req.raw.headers.has('x-upstream-key'))
      return respondStoredCompletions(c, fixedStoredCompletionsHttpError('unsupported_execution_contract'));
    const key = c.get('apiKey' as never) as AuthenticatedApiKey;
    const { identity } = await captureStoredCompletionsHttpRequest(c.req.raw);
    const scope: GatewayHttpIdentity<'completions'> = Object.freeze({
      orgId: key.org_id,
      apiKeyId: key.id,
      routeKind: 'completions',
      billingMode: 'stored',
      contractVersion: 1,
      idempotencyKeyDigest: identity.idempotencyKeyDigest,
      requestFingerprint: identity.requestFingerprint,
    });
    const read = async () => projectStoredCompletionsHttpResult(await readGatewayHttpResultV2(scope));
    const existing = await readGatewayHttpResultV2(scope);
    if (existing.status !== 'not_found')
      return respondStoredCompletions(c, projectStoredCompletionsHttpResult(existing));

    const model = await resolveStoredChatFreshModel(identity.attemptBody.model);
    const requestId = c.get('requestId' as never) as string;
    const prepared = prepareStoredChatFreshPolicy({ key, identity, model, requestId });
    const handle = createStoredChatAttempt({
      orgId: scope.orgId,
      apiKeyId: scope.apiKeyId,
      clientRequestId: requestId,
      declaredSessionId: identity.declaredSessionId,
      body: identity.attemptBody,
      ...prepared,
      cachingDiscount,
      defaultMaxOutputTokens,
      preDispatchDeadlineAt: new Date(Date.now() + STORED_COMPLETIONS_PRE_DISPATCH_WINDOW_MS).toISOString(),
      signal: c.req.raw.signal,
    }, {
      admissionRouteKind: 'completions',
      admitAttempt: (args) => admitGatewayHttpCharge({ ...args, ...scope }),
      rejectUnstarted: (args) => rejectUnstartedGatewayHttpRequest({
        ...scope,
        billingRequestId: args.billingRequestId,
      }),
      persistOutcome: (args) => recordGatewayHttpOutcome<'completions'>({
        ...args,
        response: projectStoredHttpCompletionResponse(args.response),
        idempotencyKeyDigest: scope.idempotencyKeyDigest,
        requestFingerprint: scope.requestFingerprint,
      }),
    });
    if (handle.status !== 'ready')
      return respondStoredCompletions(c, fixedStoredCompletionsHttpError(
        handle.status === 'bad_request' ? 'invalid_stored_completions_request' : 'stored_completions_unavailable',
      ));
    const claim = await claimGatewayHttpRequest({ ...scope, billingRequestId: handle.billingRequestId });
    if (!claim.didClaim) return respondStoredCompletions(c, await read());
    let result: Awaited<ReturnType<typeof handle.run>>;
    try { result = await handle.run(); }
    catch { return respondStoredCompletions(c, fixedStoredCompletionsHttpError('request_state_unavailable')); }
    if (
      !result || result.billingRequestId !== handle.billingRequestId ||
      (result.kind === 'rejected' && !isHttpRejectionCode(result.code)) ||
      (result.kind === 'replay' && !['held', 'dispatched', 'outcome_recorded', 'settled', 'cancelled'].includes(result.state)) ||
      (result.kind === 'settled_success' && (
        typeof result.actualCostCredits !== 'bigint' || result.actualCostCredits < 0n ||
        !result.response || !result.admission || result.admission.state !== 'settled' ||
        result.admission.billingRequestId !== handle.billingRequestId
      ))
    ) return respondStoredCompletions(c, fixedStoredCompletionsHttpError('request_state_unavailable'));
    switch (result.kind) {
      case 'settled_success':
      case 'rejected':
      case 'replay':
      case 'cancelled_no_charge':
        return respondStoredCompletions(c, await read());
      default:
        return respondStoredCompletions(c, fixedStoredCompletionsHttpError('request_state_unavailable'));
    }
  } catch (error) {
    if (error instanceof StoredCompletionsHttpContractError) {
      const kinds = {
        INVALID_STORED_COMPLETIONS_HTTP_IDENTITY: 'invalid_identity',
        REQUEST_BODY_TOO_LARGE: 'request_body_too_large',
        UNSUPPORTED_CONTENT_TYPE: 'unsupported_content_type',
        UNSUPPORTED_EXECUTION_CONTRACT: 'unsupported_execution_contract',
      } as const;
      return respondStoredCompletions(c, fixedStoredCompletionsHttpError(
        kinds[error.code as keyof typeof kinds] ?? 'request_state_unavailable',
      ));
    }
    const kind = error instanceof HttpStorageAccessError ? 'authentication_required'
      : error instanceof HttpStorageConflictError ? 'request_conflict'
        : error instanceof StoredChatFreshPolicyError
          ? error.kind === 'stored_chat_unavailable' ? 'stored_completions_unavailable' : error.kind
          : error instanceof StoredChatFreshModelError ? 'model_unavailable'
            : 'request_state_unavailable';
    return respondStoredCompletions(c, fixedStoredCompletionsHttpError(kind));
  }
};
