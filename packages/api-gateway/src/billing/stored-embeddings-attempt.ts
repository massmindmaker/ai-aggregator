import {
  parseStoredHttpEmbeddingsResponse,
  type StoredHttpEmbeddingsResponse,
} from './http-storage-result';
import {
  isHttpRejectionCode,
  type HttpRejectionCode,
} from './http-terminal-recovery';
import {
  admitGatewayChargeV2,
  recordGatewayChargeOutcomeV2,
  type AdmitGatewayChargeV2Args,
} from './quota-admission';
import { randomUUID } from 'node:crypto';
import {
  markGatewayChargeDispatched,
  settleAdmittedGatewayCharge,
  cancelUndispatchedGatewayCharge,
  AdmissionDeadlineExpiredError,
} from './admission';
import {
  admissionJsonObjectsEqual,
  normalizeAdmissionUuid,
  parseAdmissionJsonObject,
  type GatewayChargeAdmissionResult,
  type GatewayChargeAdmissionState,
} from './admission-result';
import { prepareStoredEmbeddingQuote } from './embedding-candidate-quote';
import {
  captureStoredEmbeddingsEvidence,
  parseStoredEmbeddingsBody,
  validateStoredEmbeddingsIdentity,
  STORED_EMBEDDINGS_FORMULA,
  type StoredEmbeddingsAttemptPreparation,
  type StoredEmbeddingsAttemptResult,
  type StoredEmbeddingsAttemptStage,
} from './stored-embeddings-attempt-contract';
import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type {
  AdmittedEmbeddingsMechanics,
  AdmittedEmbeddingsRequest,
  UpstreamAdapter,
} from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';
import { AiagError } from '../lib/errors';

export type StoredEmbeddingsAttemptArgs = {
  orgId: string;
  apiKeyId: string;
  clientRequestId: string | null;
  declaredSessionId: string | null;
  model: ResolvedModel;
  requestedMode: Mode;
  policy: Readonly<ApiKeyPolicies>;
  body: unknown;
  preDispatchDeadlineAt: string;
  signal?: AbortSignal;
};

/** Trusted composition/test seam; none of these dependencies come from HTTP. */
export type StoredEmbeddingsAttemptDependencies = {
  getAdapter: (key: string) => UpstreamAdapter;
  newUuid: () => string;
  admitGatewayChargeV2: typeof admitGatewayChargeV2;
  admitAttempt?: (
    args: AdmitGatewayChargeV2Args,
  ) => Promise<
    | Readonly<{
        kind: 'admitted';
        admission: GatewayChargeAdmissionResult;
      }>
    | Readonly<{
        kind: 'rejected';
        billingRequestId: string;
        code: HttpRejectionCode;
      }>
  >;
  rejectUnstarted?: (
    args: Readonly<{
      orgId: string;
      apiKeyId: string;
      billingRequestId: string;
    }>,
  ) => Promise<
    Readonly<{
      kind: 'rejected';
      billingRequestId: string;
      code: HttpRejectionCode;
    }>
  >;
  markGatewayChargeDispatched: typeof markGatewayChargeDispatched;
  recordGatewayChargeOutcomeV2: typeof recordGatewayChargeOutcomeV2;
  persistOutcome?: (
    args: Readonly<{
      admission: GatewayChargeAdmissionResult;
      actualCostCredits: bigint;
      usageSnapshot: import('./admission-result').JsonObject;
      outcomeKind: 'success';
      response: StoredHttpEmbeddingsResponse;
    }>,
  ) => Promise<GatewayChargeAdmissionResult>;
  settleAdmittedGatewayCharge: typeof settleAdmittedGatewayCharge;
  cancelUndispatchedGatewayCharge: typeof cancelUndispatchedGatewayCharge;
};

const unavailable = Object.freeze({
  status: 'unavailable',
  code: 'STORED_EMBEDDINGS_UNAVAILABLE',
} as const);
const states: readonly GatewayChargeAdmissionState[] = [
  'held',
  'dispatched',
  'outcome_recorded',
  'settled',
  'cancelled',
];

/** A ready handle closes over one candidate, one attempt and one memoized run. */
export function createStoredEmbeddingsAttempt(
  args: StoredEmbeddingsAttemptArgs,
  dependencies: Partial<StoredEmbeddingsAttemptDependencies> = {},
): StoredEmbeddingsAttemptPreparation {
  let body: ReturnType<typeof parseStoredEmbeddingsBody>;
  let identity: ReturnType<typeof validateStoredEmbeddingsIdentity>;
  try {
    body = parseStoredEmbeddingsBody(args.body, args.model.slug);
    identity = validateStoredEmbeddingsIdentity(args);
  } catch {
    return Object.freeze({
      status: 'bad_request',
      code: 'INVALID_STORED_EMBEDDINGS_REQUEST',
    });
  }

  const deps = Object.freeze({
    getAdapter: getUpstream,
    newUuid: randomUUID,
    admitGatewayChargeV2,
    recordGatewayChargeOutcomeV2,
    markGatewayChargeDispatched,
    settleAdmittedGatewayCharge,
    cancelUndispatchedGatewayCharge,
    ...dependencies,
  });
  const persistOutcome = deps.persistOutcome;
  const admitAttempt = deps.admitAttempt;
  const rejectUnstarted = deps.rejectUnstarted;
  const signal = args.signal;

  const mechanics = new Map<string, UpstreamAdapter | null>();
  const lookup = (key: string): UpstreamAdapter => {
    if (!mechanics.has(key)) {
      let facade: UpstreamAdapter | null = null;
      try {
        const captured = deps.getAdapter(key).admittedEmbeddings;
        const capturedExecute = captured?.execute;
        if (captured && typeof capturedExecute === 'function') {
          const admittedEmbeddings: AdmittedEmbeddingsMechanics = Object.freeze({
            contract: captured.contract,
            execute: capturedExecute.bind(captured),
          });
          facade = Object.freeze({
            admittedEmbeddings,
            chat: async () => {
              throw new Error('Legacy chat is not admitted');
            },
          });
        }
      } catch {
        // Cache the unavailable result so registry mutation cannot alter this attempt.
      }
      mechanics.set(key, facade);
    }
    const adapter = mechanics.get(key);
    if (!adapter) throw new Error('Admitted embeddings mechanics unavailable');
    return adapter;
  };

  let quote: ReturnType<typeof prepareStoredEmbeddingQuote>;
  try {
    quote = prepareStoredEmbeddingQuote({
      model: args.model,
      requestedMode: args.requestedMode,
      policy: args.policy,
      inputCount: body.input.length,
      getAdapter: lookup,
    });
  } catch {
    return unavailable;
  }
  if (quote.status !== 'ready') return unavailable;
  const chosen = quote.candidates[0];
  const execute = mechanics.get(chosen.adapterKey)?.admittedEmbeddings?.execute;
  if (!execute || chosen.maxCredits !== quote.authorizedMaxCredits)
    return unavailable;
  const executeAttempt: AdmittedEmbeddingsMechanics['execute'] = execute;

  let billingRequestId: string;
  let attemptId: string;
  try {
    billingRequestId = normalizeAdmissionUuid(deps.newUuid());
    attemptId = normalizeAdmissionUuid(deps.newUuid());
    if (billingRequestId === attemptId) return unavailable;
  } catch {
    return unavailable;
  }

  const actualChargePolicy = Object.freeze({
    formulaVersion: STORED_EMBEDDINGS_FORMULA,
    cachingDiscount: '1',
  });
  const quoteSnapshot = parseAdmissionJsonObject({
    version: 1,
    tokenQuote: quote.quoteSnapshot,
    actualChargePolicy,
  });
  const admissionArgs: AdmitGatewayChargeV2Args = Object.freeze({
    orgId: identity.orgId,
    apiKeyId: identity.apiKeyId,
    clientRequestId: identity.clientRequestId,
    declaredSessionId: identity.declaredSessionId,
    supplierQuoteSnapshot: parseAdmissionJsonObject({
      version: 2,
      formulaVersion: 'catalog-input-output-cents-per-1k-usd-micro-v2',
      tokenQuote: quote.quoteSnapshot,
    }),
    preDispatchDeadlineAt: identity.preDispatchDeadlineAt,
    billingRequestId,
    routeKind: 'embeddings',
    billingMode: 'stored',
    modelSlug: body.modelSlug,
    authorizedMaxCredits: quote.authorizedMaxCredits,
    quoteSnapshot,
  });
  const pricingSnapshot = parseAdmissionJsonObject({
    ...quote.quoteSnapshot.candidates[0],
    actualChargePolicy,
  });
  const request: AdmittedEmbeddingsRequest = Object.freeze({
    modelId: chosen.upstreamModelId,
    input: body.input,
    endpointPolicy: chosen.profile.endpointPolicy,
    ...(chosen.egressProxyUrl == null
      ? {}
      : { egressProxyUrl: chosen.egressProxyUrl }),
  });

  function confirmed(
    admission: GatewayChargeAdmissionResult,
  ): GatewayChargeAdmissionResult {
    if (
      !admission ||
      !states.includes(admission.state) ||
      typeof admission.didTransition !== 'boolean' ||
      admission.billingRequestId !== billingRequestId ||
      admission.orgId !== identity.orgId ||
      admission.apiKeyId !== identity.apiKeyId ||
      admission.clientRequestId !== identity.clientRequestId ||
      admission.routeKind !== 'embeddings' ||
      admission.billingMode !== 'stored' ||
      admission.modelSlug !== body.modelSlug ||
      admission.authorizedMaxCredits !== admissionArgs.authorizedMaxCredits ||
      admission.preDispatchDeadlineAt !== identity.preDispatchDeadlineAt ||
      !admissionJsonObjectsEqual(admission.quoteSnapshot, quoteSnapshot)
    )
      throw new Error('Unconfirmed embeddings admission');
    return admission;
  }

  async function perform(): Promise<StoredEmbeddingsAttemptResult> {
    let lastConfirmedState: GatewayChargeAdmissionState | null = null;
    const unknown = (
      stage: StoredEmbeddingsAttemptStage,
    ): StoredEmbeddingsAttemptResult =>
      Object.freeze({
        kind: 'reconciliation_required',
        billingRequestId,
        stage,
        lastConfirmedState,
      });
    const replay = (
      admission: GatewayChargeAdmissionResult,
    ): StoredEmbeddingsAttemptResult =>
      Object.freeze({
        kind: 'replay',
        billingRequestId,
        state: admission.state,
      });
    async function cancel(
      held: GatewayChargeAdmissionResult,
    ): Promise<StoredEmbeddingsAttemptResult> {
      try {
        const cancelled = confirmed(
          await deps.cancelUndispatchedGatewayCharge({ admission: held }),
        );
        if (cancelled.state !== 'cancelled') return unknown('cancel');
        return Object.freeze({ kind: 'cancelled_no_charge', billingRequestId });
      } catch {
        return unknown('cancel');
      }
    }
    const rejected = (value: unknown): StoredEmbeddingsAttemptResult => {
      const result = parseAdmissionJsonObject(value);
      if (
        result.kind !== 'rejected' ||
        result.billingRequestId !== billingRequestId ||
        !isHttpRejectionCode(result.code)
      )
        throw new Error('Unconfirmed rejection');
      return Object.freeze({
        kind: 'rejected',
        billingRequestId,
        code: result.code,
      });
    };

    if (signal?.aborted) {
      if (!rejectUnstarted)
        return Object.freeze({ kind: 'not_started', billingRequestId });
      try {
        return rejected(
          await rejectUnstarted(
            Object.freeze({
              orgId: identity.orgId,
              apiKeyId: identity.apiKeyId,
              billingRequestId,
            }),
          ),
        );
      } catch {
        return unknown('pre_admit_terminal');
      }
    }

    let admission: GatewayChargeAdmissionResult;
    try {
      if (admitAttempt) {
        const result = await admitAttempt(admissionArgs);
        if (result?.kind === 'rejected') return rejected(result);
        if (result?.kind !== 'admitted') return unknown('admit');
        admission = confirmed(result.admission);
      } else {
        admission = confirmed(await deps.admitGatewayChargeV2(admissionArgs));
      }
    } catch (error) {
      if (admitAttempt) return unknown('admit');
      if (error instanceof AdmissionDeadlineExpiredError)
        return Object.freeze({
          kind: 'rejected',
          billingRequestId,
          code: 'ADMISSION_DEADLINE_EXPIRED',
        });
      if (error instanceof AiagError && error.code === 'PAYMENT_REQUIRED')
        return Object.freeze({
          kind: 'rejected',
          billingRequestId,
          code: 'PAYMENT_REQUIRED',
        });
      return unknown('admit');
    }
    lastConfirmedState = admission.state;
    if (!admission.didTransition) return replay(admission);
    if (admission.state !== 'held') return unknown('admit');
    if (signal?.aborted) return cancel(admission);

    try {
      const dispatch = await deps.markGatewayChargeDispatched({
        admission,
        attemptId,
        upstreamId: chosen.upstreamId,
        pricingSnapshot,
      });
      const dispatched = confirmed(dispatch.admission);
      if (
        dispatch.kind === 'replay' &&
        !dispatched.didTransition &&
        ['dispatched', 'outcome_recorded', 'settled'].includes(dispatched.state)
      )
        return replay(dispatched);
      if (
        dispatch.kind !== 'dispatch_granted' ||
        !dispatched.didTransition ||
        dispatched.state !== 'dispatched' ||
        dispatched.attemptId !== attemptId ||
        dispatched.upstreamId !== chosen.upstreamId ||
        !dispatched.pricingSnapshot ||
        !admissionJsonObjectsEqual(dispatched.pricingSnapshot, pricingSnapshot)
      )
        return unknown('dispatch');
      admission = dispatched;
      lastConfirmedState = admission.state;
    } catch (error) {
      if (error instanceof AdmissionDeadlineExpiredError)
        return cancel(admission);
      return unknown('dispatch');
    }

    let output: Awaited<ReturnType<AdmittedEmbeddingsMechanics['execute']>>;
    try {
      output = await executeAttempt(request);
    } catch {
      return unknown('provider');
    }
    let evidence: ReturnType<typeof captureStoredEmbeddingsEvidence>;
    try {
      evidence = captureStoredEmbeddingsEvidence(
        output,
        chosen,
        billingRequestId,
        attemptId,
      );
    } catch {
      return unknown('usage');
    }

    const matchingOutcome = (value: GatewayChargeAdmissionResult) =>
      value.attemptId === attemptId &&
      value.upstreamId === chosen.upstreamId &&
      value.actualCostCredits === evidence.actualCostCredits &&
      value.outcomeKind === 'success' &&
      value.usageSnapshot !== null &&
      admissionJsonObjectsEqual(value.usageSnapshot, evidence.usageSnapshot);
    try {
      const outcome = confirmed(
        await (persistOutcome
          ? persistOutcome(
              Object.freeze({
                admission,
                actualCostCredits: evidence.actualCostCredits,
                usageSnapshot: evidence.usageSnapshot,
                outcomeKind: 'success',
                response: parseStoredHttpEmbeddingsResponse(evidence.response),
              }),
            )
          : deps.recordGatewayChargeOutcomeV2({
              admission,
              actualCostCredits: evidence.actualCostCredits,
              usageSnapshot: evidence.usageSnapshot,
              outcomeKind: 'success',
            })),
      );
      if (
        !['outcome_recorded', 'settled'].includes(outcome.state) ||
        !matchingOutcome(outcome)
      )
        return unknown('outcome');
      admission = outcome;
      lastConfirmedState = admission.state;
    } catch {
      return unknown('outcome');
    }

    if (admission.state !== 'settled') {
      try {
        const settled = confirmed(
          await deps.settleAdmittedGatewayCharge({ admission }),
        );
        if (settled.state !== 'settled' || !matchingOutcome(settled))
          return unknown('settle');
        admission = settled;
      } catch {
        return unknown('settle');
      }
    }
    return Object.freeze({
      kind: 'settled_success',
      billingRequestId,
      actualCostCredits: evidence.actualCostCredits,
      response: evidence.response,
      admission,
    });
  }

  let runPromise: Promise<StoredEmbeddingsAttemptResult> | undefined;
  return Object.freeze({
    status: 'ready',
    billingRequestId,
    run() {
      return (runPromise ??= Promise.resolve().then(perform));
    },
  });
}
