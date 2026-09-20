import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { createStoredEmbeddingsAttempt } from '../../billing/stored-embeddings-attempt';
import {
  captureStoredEmbeddingsHttpRequest,
  fixedStoredEmbeddingsHttpError,
  projectStoredEmbeddingsHttpResult,
  StoredEmbeddingsHttpContractError,
  STORED_EMBEDDINGS_PRE_DISPATCH_WINDOW_MS,
  type StoredEmbeddingsHttpResponseDescriptor,
} from '../../billing/stored-embeddings-http-contract';
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
  resolveStoredEmbeddingsFreshModel,
  StoredEmbeddingsFreshModelError,
} from '../../routing/stored-embeddings-fresh-resolver';
import {
  prepareStoredEmbeddingsFreshPolicy,
  StoredEmbeddingsFreshPolicyError,
} from '../../billing/stored-embeddings-fresh-policy';

export function respondStoredEmbeddings(c: Context, descriptor: StoredEmbeddingsHttpResponseDescriptor): Response {
  for (const [name, value] of Object.entries(descriptor.headers)) c.header(name, value);
  return c.body(JSON.stringify(descriptor.body), descriptor.status as ContentfulStatusCode);
}

/** Mounted only by the explicit combined stored execution mode. */
export const storedEmbeddings: Handler = async (c) => {
  try {
    if (c.req.raw.headers.has('x-upstream-key'))
      return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError('unsupported_execution_contract'));
    const key = c.get('apiKey' as never) as AuthenticatedApiKey;
    const { identity } = await captureStoredEmbeddingsHttpRequest(c.req.raw);
    const scope: GatewayHttpIdentity<'embeddings'> = Object.freeze({
      orgId: key.org_id,
      apiKeyId: key.id,
      routeKind: 'embeddings',
      billingMode: 'stored',
      contractVersion: 1,
      idempotencyKeyDigest: identity.idempotencyKeyDigest,
      requestFingerprint: identity.requestFingerprint,
    });
    const read = async () => projectStoredEmbeddingsHttpResult(await readGatewayHttpResultV2(scope));
    const existing = await readGatewayHttpResultV2(scope);
    if (existing.status !== 'not_found')
      return respondStoredEmbeddings(c, projectStoredEmbeddingsHttpResult(existing));

    const model = await resolveStoredEmbeddingsFreshModel(identity.attemptBody.model);
    const requestId = c.get('requestId' as never) as string;
    const prepared = prepareStoredEmbeddingsFreshPolicy({ key, identity, model, requestId });
    const handle = createStoredEmbeddingsAttempt({
      orgId: scope.orgId,
      apiKeyId: scope.apiKeyId,
      clientRequestId: requestId,
      declaredSessionId: identity.declaredSessionId,
      body: identity.attemptBody,
      ...prepared,
      preDispatchDeadlineAt: new Date(Date.now() + STORED_EMBEDDINGS_PRE_DISPATCH_WINDOW_MS).toISOString(),
      signal: c.req.raw.signal,
    }, {
      admitAttempt: (args) => admitGatewayHttpCharge({ ...args, ...scope }),
      rejectUnstarted: (args) => rejectUnstartedGatewayHttpRequest({
        ...scope, billingRequestId: args.billingRequestId,
      }),
      persistOutcome: (args) => recordGatewayHttpOutcome<'embeddings'>({
        ...args,
        idempotencyKeyDigest: scope.idempotencyKeyDigest,
        requestFingerprint: scope.requestFingerprint,
      }),
    });
    if (handle.status !== 'ready')
      return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError(
        handle.status === 'bad_request' ? 'invalid_stored_embeddings_request' : 'stored_embeddings_unavailable',
      ));
    const claim = await claimGatewayHttpRequest({ ...scope, billingRequestId: handle.billingRequestId });
    if (!claim.didClaim) return respondStoredEmbeddings(c, await read());
    let result: Awaited<ReturnType<typeof handle.run>>;
    try { result = await handle.run(); }
    catch { return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError('request_state_unavailable')); }
    if (
      !result || result.billingRequestId !== handle.billingRequestId ||
      (result.kind === 'rejected' && !isHttpRejectionCode(result.code)) ||
      (result.kind === 'replay' && !['held', 'dispatched', 'outcome_recorded', 'settled', 'cancelled'].includes(result.state)) ||
      (result.kind === 'settled_success' && (
        typeof result.actualCostCredits !== 'bigint' || result.actualCostCredits < 0n ||
        !result.response || !result.admission || result.admission.state !== 'settled' ||
        result.admission.billingRequestId !== handle.billingRequestId
      ))
    ) return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError('request_state_unavailable'));
    switch (result.kind) {
      case 'settled_success': case 'rejected': case 'replay': case 'cancelled_no_charge':
        return respondStoredEmbeddings(c, await read());
      default:
        return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError('request_state_unavailable'));
    }
  } catch (error) {
    if (error instanceof StoredEmbeddingsHttpContractError) {
      const kinds = {
        INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY: 'invalid_identity',
        REQUEST_BODY_TOO_LARGE: 'request_body_too_large',
        UNSUPPORTED_CONTENT_TYPE: 'unsupported_content_type',
        UNSUPPORTED_EXECUTION_CONTRACT: 'unsupported_execution_contract',
      } as const;
      return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError(
        kinds[error.code as keyof typeof kinds] ?? 'request_state_unavailable',
      ));
    }
    const kind = error instanceof HttpStorageAccessError ? 'authentication_required'
      : error instanceof HttpStorageConflictError ? 'request_conflict'
        : error instanceof StoredEmbeddingsFreshPolicyError ? error.kind
          : error instanceof StoredEmbeddingsFreshModelError ? 'model_unavailable'
            : 'request_state_unavailable';
    return respondStoredEmbeddings(c, fixedStoredEmbeddingsHttpError(kind));
  }
};
