import {
  parseStoredHttpChatResponse,
  type StoredHttpChatResponse,
} from './http-storage-result';
import { isHttpRejectionCode, type HttpRejectionCode } from './http-terminal-recovery';
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
import { prepareStoredChatQuote } from './candidate-quote';
import {
  captureStoredChatEvidence,
  parseStoredChatBody,
  validateStoredChatIdentity,
  STORED_CHAT_FORMULA,
  type StoredChatAttemptPreparation,
  type StoredChatAttemptResult,
  type StoredChatAttemptStage,
} from './stored-chat-attempt-contract';
import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type {
  AdmittedChatMechanics,
  AdmittedChatRequest,
  UpstreamAdapter,
} from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';
import { AiagError } from '../lib/errors';

export type StoredChatAttemptArgs = {
  orgId: string;
  apiKeyId: string;
  clientRequestId: string | null;
  declaredSessionId: string | null;
  model: ResolvedModel;
  requestedMode: Mode;
  policy: Readonly<ApiKeyPolicies>;
  body: unknown;
  defaultMaxOutputTokens: number;
  cachingDiscount: string;
  preDispatchDeadlineAt: string;
  signal?: AbortSignal;
};
/** Trusted composition/test seam only; never populate this object from a public request. */
export type StoredChatAttemptDependencies = {
  /** Trusted route identity for the shared chat mechanics; never from request body. */
  admissionRouteKind?: 'chat' | 'completions';
  getAdapter: (key: string) => UpstreamAdapter;
  newUuid: () => string;
  admitGatewayChargeV2: typeof admitGatewayChargeV2;
  /** Sole admission writer when supplied. A rejection must have a confirmed durable SQL result. */
  admitAttempt?: (args: AdmitGatewayChargeV2Args) => Promise<
    Readonly<{kind: 'admitted'; admission: GatewayChargeAdmissionResult}> |
    Readonly<{kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode}>
  >;
  /** Only called for a synchronously known abort before the first admission invocation. */
  rejectUnstarted?: (args: Readonly<{orgId: string; apiKeyId: string; billingRequestId: string}>) => Promise<
    Readonly<{kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode}>
  >;
  markGatewayChargeDispatched: typeof markGatewayChargeDispatched;
  recordGatewayChargeOutcomeV2: typeof recordGatewayChargeOutcomeV2;
  /** Sole trusted writer when supplied; never from request body, never falls back. */
  persistOutcome?: (
    args: Readonly<{
      admission: GatewayChargeAdmissionResult;
      actualCostCredits: bigint;
      usageSnapshot: import('./admission-result').JsonObject;
      outcomeKind: 'success';
      response: StoredHttpChatResponse;
    }>,
  ) => Promise<GatewayChargeAdmissionResult>;
  settleAdmittedGatewayCharge: typeof settleAdmittedGatewayCharge;
  cancelUndispatchedGatewayCharge: typeof cancelUndispatchedGatewayCharge;
};
const unavailable = Object.freeze({
  status: 'unavailable',
  code: 'STORED_CHAT_UNAVAILABLE',
} as const);
const states: readonly GatewayChargeAdmissionState[] = [
  'held',
  'dispatched',
  'outcome_recorded',
  'settled',
  'cancelled',
];

/** No caller, resume path or registry activation. A ready handle owns exactly one attempt. */
export function createStoredChatAttempt(
  args: StoredChatAttemptArgs,
  dependencies: Partial<StoredChatAttemptDependencies> = {},
): StoredChatAttemptPreparation {
  let body: ReturnType<typeof parseStoredChatBody>,
    identity: ReturnType<typeof validateStoredChatIdentity>;
  try {
    body = parseStoredChatBody(args.body, args.model.slug);
    identity = validateStoredChatIdentity(args);
  } catch {
    return Object.freeze({
      status: 'bad_request',
      code: 'INVALID_STORED_CHAT_REQUEST',
    });
  }
  const deps = Object.freeze({
    admissionRouteKind: 'chat' as const,
    getAdapter: getUpstream,
    newUuid: randomUUID,
    admitGatewayChargeV2,
    recordGatewayChargeOutcomeV2,
    markGatewayChargeDispatched,
    settleAdmittedGatewayCharge,
    cancelUndispatchedGatewayCharge,
    ...dependencies,
  });
  const admissionRouteKind = deps.admissionRouteKind;
  if (admissionRouteKind !== 'chat' && admissionRouteKind !== 'completions')
    return unavailable;
  const persistOutcome = deps.persistOutcome;
  const admitAttempt = deps.admitAttempt;
  const rejectUnstarted = deps.rejectUnstarted;
  const signal = args.signal;
  const mechanics = new Map<string, UpstreamAdapter | null>();
  // The quote sees only a frozen facade, bound to the original mechanics receiver/function.
  const lookup = (key: string): UpstreamAdapter => {
    if (!mechanics.has(key)) {
      let facade: UpstreamAdapter | null = null;
      try {
        const captured = deps.getAdapter(key).admittedChat;
        const capturedExecute = captured?.execute;
        if (captured && typeof capturedExecute === 'function') {
          const admittedChat: AdmittedChatMechanics = Object.freeze({
            contract: captured.contract,
            execute: capturedExecute.bind(captured),
          });
          facade = Object.freeze({
            admittedChat,
            chat: async () => {
              throw new Error('Legacy chat is not admitted');
            },
          });
        }
      } catch {
        /* Cache unavailable too; a later lookup must not change the pool. */
      }
      mechanics.set(key, facade);
    }
    const adapter = mechanics.get(key);
    if (!adapter) throw new Error('Admitted mechanics unavailable');
    return adapter;
  };
  let quote: ReturnType<typeof prepareStoredChatQuote>;
  try {
    quote = prepareStoredChatQuote({
      model: args.model,
      requestedMode: args.requestedMode,
      policy: args.policy,
      ...(body.maxTokens === undefined
        ? {}
        : { clientMaxTokens: body.maxTokens }),
      defaultMaxOutputTokens: args.defaultMaxOutputTokens,
      getAdapter: lookup,
    });
  } catch {
    return unavailable;
  }
  if (quote.status !== 'ready') return unavailable;
  const chosen = quote.candidates[0]!;
  const execute = mechanics.get(chosen.adapterKey)?.admittedChat?.execute;
  if (!execute || chosen.maxCredits > quote.authorizedMaxCredits)
    return unavailable;
  let billingRequestId: string, attemptId: string;
  try {
    billingRequestId = normalizeAdmissionUuid(deps.newUuid());
    attemptId = normalizeAdmissionUuid(deps.newUuid());
    if (billingRequestId === attemptId) return unavailable;
  } catch {
    return unavailable;
  }
  const actualChargePolicy = Object.freeze({
    formulaVersion: STORED_CHAT_FORMULA,
    cachingDiscount: identity.cachingDiscount,
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
    routeKind: admissionRouteKind,
    billingMode: 'stored',
    modelSlug: body.modelSlug,
    authorizedMaxCredits: quote.authorizedMaxCredits,
    quoteSnapshot: parseAdmissionJsonObject({
      version: 1,
      tokenQuote: quote.quoteSnapshot,
      actualChargePolicy,
    }),
  });
  const pricingSnapshot = parseAdmissionJsonObject({
    ...quote.quoteSnapshot.candidates[0],
    actualChargePolicy,
  });
  const request: AdmittedChatRequest = Object.freeze({
    modelId: chosen.upstreamModelId,
    messages: body.messages,
    maxTokens: chosen.maxOutputTokens,
    endpointPolicy: chosen.profile.endpointPolicy,
    ...(chosen.egressProxyUrl == null
      ? {}
      : { egressProxyUrl: chosen.egressProxyUrl }),
  });

  function confirmed(
    admission: GatewayChargeAdmissionResult,
  ): GatewayChargeAdmissionResult {
    // Wrappers validate full DB rows and prior facts. Guard this closed attempt's identity too.
    if (
      !admission ||
      !states.includes(admission.state) ||
      typeof admission.didTransition !== 'boolean' ||
      admission.billingRequestId !== billingRequestId ||
      admission.orgId !== identity.orgId ||
      admission.apiKeyId !== identity.apiKeyId ||
      admission.routeKind !== admissionRouteKind ||
      admission.authorizedMaxCredits !== admissionArgs.authorizedMaxCredits
    )
      throw new Error('Unconfirmed admission');
    return admission;
  }
  async function perform(): Promise<StoredChatAttemptResult> {
    let lastConfirmedState: GatewayChargeAdmissionState | null = null;
    const unknown = (stage: StoredChatAttemptStage): StoredChatAttemptResult =>
      Object.freeze({
        kind: 'reconciliation_required',
        billingRequestId,
        stage,
        lastConfirmedState,
      });
    const replay = (
      admission: GatewayChargeAdmissionResult,
    ): StoredChatAttemptResult =>
      Object.freeze({
        kind: 'replay',
        billingRequestId,
        state: admission.state,
      });
    async function cancel(
      held: GatewayChargeAdmissionResult,
    ): Promise<StoredChatAttemptResult> {
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
    const rejected = (value: unknown): StoredChatAttemptResult => {
      const result = parseAdmissionJsonObject(value);
      if(result.kind!=='rejected'||result.billingRequestId!==billingRequestId||!isHttpRejectionCode(result.code)) throw new Error('Unconfirmed rejection');
      return Object.freeze({kind:'rejected',billingRequestId,code:result.code});
    };
    if (signal?.aborted) {
      if(!rejectUnstarted) return Object.freeze({ kind: 'not_started', billingRequestId });
      try {return rejected(await rejectUnstarted(Object.freeze({orgId:identity.orgId,apiKeyId:identity.apiKeyId,billingRequestId})));}
      catch {return unknown('pre_admit_terminal');}
    }
    let admission: GatewayChargeAdmissionResult;
    try {
      if(admitAttempt) {
        const result=await admitAttempt(admissionArgs);
        if(result?.kind==='rejected') return rejected(result);
        if(result?.kind!=='admitted') return unknown('admit');
        admission=confirmed(result.admission);
      } else admission = confirmed(await deps.admitGatewayChargeV2(admissionArgs));
    } catch (error) {
      // A supplied writer failing (including PAYMENT_REQUIRED-shaped errors) is uncertain, never fallback/reject.
      if(admitAttempt) return unknown('admit');
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
    // From mark invocation onward, client abort never releases or stops financial recording.
    let output: Awaited<ReturnType<AdmittedChatMechanics['execute']>>;
    try {
      output = await execute!(request);
    } catch {
      return unknown('provider');
    }
    let evidence: ReturnType<typeof captureStoredChatEvidence>;
    try {
      evidence = captureStoredChatEvidence(
        output,
        chosen,
        identity.cachingDiscount,
        billingRequestId,
        attemptId,
      );
    } catch {
      return unknown('usage');
    }
    const matchingOutcome = (a: GatewayChargeAdmissionResult) =>
      a.attemptId === attemptId &&
      a.upstreamId === chosen.upstreamId &&
      a.actualCostCredits === evidence.actualCostCredits &&
      a.outcomeKind === 'success' &&
      a.usageSnapshot !== null &&
      admissionJsonObjectsEqual(a.usageSnapshot, evidence.usageSnapshot);
    try {
      const outcome = confirmed(
        await (persistOutcome
          ? persistOutcome(
              Object.freeze({
                admission,
                actualCostCredits: evidence.actualCostCredits,
                usageSnapshot: evidence.usageSnapshot,
                outcomeKind: 'success',
                response: parseStoredHttpChatResponse(evidence.response),
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
  let runPromise: Promise<StoredChatAttemptResult> | undefined;
  return Object.freeze({
    status: 'ready',
    billingRequestId,
    run() {
      return (runPromise ??= Promise.resolve().then(perform));
    },
  });
}
