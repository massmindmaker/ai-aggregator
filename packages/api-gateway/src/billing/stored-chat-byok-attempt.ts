import { randomUUID } from 'node:crypto';
import { findReviewedChatProfile } from './reviewed-token-profiles';
import { parseStoredChatBody, validateStoredChatIdentity, type StoredChatAttemptPreparation, type StoredChatAttemptResult, type StoredChatAttemptStage } from './stored-chat-attempt-contract';
import { calculateByokFee } from './token-quote';
import { parseStoredHttpChatResponse, type StoredHttpChatResponse } from './http-storage-result';
import {
  admissionJsonObjectsEqual,
  normalizeAdmissionUuid,
  parseAdmissionJsonObject,
  type GatewayChargeAdmissionResult,
  type GatewayChargeAdmissionState,
} from './admission-result';
import {
  admitGatewayByokFeeV2,
  recordGatewayChargeOutcomeV2,
  type AdmitGatewayByokFeeV2Args,
} from './quota-admission';
import {
  markGatewayChargeDispatched,
  settleAdmittedGatewayCharge,
  cancelUndispatchedGatewayCharge,
  AdmissionDeadlineExpiredError,
} from './admission';
import { isHttpRejectionCode, type HttpRejectionCode } from './http-terminal-recovery';
import type { ApiKeyPolicies, Mode, UpstreamCandidate } from '../routing/engine';
import { pickUpstream } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { AdmittedChatMechanics, AdmittedChatRequest, AdmittedChatResponse, UpstreamAdapter } from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';
import { AiagError } from '../lib/errors';

export type StoredChatByokAttemptArgs = Readonly<{
  orgId: string;
  apiKeyId: string;
  clientRequestId: string | null;
  declaredSessionId: string | null;
  preDispatchDeadlineAt: string;
  model: ResolvedModel;
  requestedMode: Mode;
  policy: Readonly<ApiKeyPolicies>;
  body: unknown;
  defaultMaxOutputTokens: number;
  byokKey: string;
  feeCreditsExact: string;
  signal?: AbortSignal;
}>;

export type StoredChatByokAttemptDependencies = Readonly<{
  getAdapter: (key: string) => UpstreamAdapter;
  newUuid: () => string;
  admitGatewayByokFeeV2: typeof admitGatewayByokFeeV2;
  admitAttempt?: (args: AdmitGatewayByokFeeV2Args) => Promise<
    Readonly<{ kind: 'admitted'; admission: GatewayChargeAdmissionResult }> |
    Readonly<{ kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode }>
  >;
  rejectUnstarted?: (args: Readonly<{ orgId: string; apiKeyId: string; billingRequestId: string }>) => Promise<
    Readonly<{ kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode }>
  >;
  markGatewayChargeDispatched: typeof markGatewayChargeDispatched;
  recordGatewayChargeOutcomeV2: typeof recordGatewayChargeOutcomeV2;
  persistOutcome?: (args: Readonly<{
    admission: GatewayChargeAdmissionResult;
    actualCostCredits: bigint;
    usageSnapshot: import('./admission-result').JsonObject;
    outcomeKind: 'success';
    response: StoredHttpChatResponse;
  }>) => Promise<GatewayChargeAdmissionResult>;
  settleAdmittedGatewayCharge: typeof settleAdmittedGatewayCharge;
  cancelUndispatchedGatewayCharge: typeof cancelUndispatchedGatewayCharge;
}>;

const unavailable = Object.freeze({
  status: 'unavailable',
  code: 'STORED_CHAT_UNAVAILABLE',
} as const);

const states: readonly GatewayChargeAdmissionState[] = [
  'held', 'dispatched', 'outcome_recorded', 'settled', 'cancelled',
];

type Chosen = Readonly<{
  candidate: UpstreamCandidate;
  mechanics: AdmittedChatMechanics;
  maxOutputTokens: number;
  upstreamId: string;
  upstreamModelId: string;
  endpointPolicy: import('./reviewed-token-profiles').ReviewedChatProfile['endpointPolicy'];
}>;

function selectCandidate(
  args: StoredChatByokAttemptArgs,
  body: ReturnType<typeof parseStoredChatBody>,
  deps: Pick<StoredChatByokAttemptDependencies, 'getAdapter'>,
): Chosen {
  if (!Number.isSafeInteger(args.defaultMaxOutputTokens) || args.defaultMaxOutputTokens <= 0)
    throw new TypeError('invalid default output cap');
  const requested = body.maxTokens ?? args.defaultMaxOutputTokens;
  if (!Number.isSafeInteger(requested) || requested <= 0)
    throw new TypeError('invalid output cap');

  const eligible: Array<Chosen> = [];
  for (const candidate of args.model.candidates) {
    if (candidate.egress_proxy != null) continue;
    const profile = findReviewedChatProfile({
      modelSlug: args.model.slug,
      modelType: args.model.type,
      upstreamId: candidate.upstream_id,
      upstreamModelId: candidate.upstream_model_id,
      adapterKey: candidate.id,
    });
    if (!profile) continue;
    let mechanics: AdmittedChatMechanics | undefined;
    try {
      const source = deps.getAdapter(profile.adapterKey).admittedChat;
      if (source?.contract === profile.adapterContract && typeof source.execute === 'function') {
        mechanics = Object.freeze({
          contract: source.contract,
          execute: source.execute.bind(source),
        });
      }
    } catch {
      mechanics = undefined;
    }
    if (!mechanics) continue;
    const maxOutputTokens = Math.min(requested, profile.contextWindowTokens, profile.maxOutputTokens);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) continue;
    eligible.push(Object.freeze({
      candidate,
      mechanics,
      maxOutputTokens,
      upstreamId: profile.upstreamId,
      upstreamModelId: profile.upstreamModelId,
      endpointPolicy: profile.endpointPolicy,
    }));
  }
  if (!eligible.length) throw new TypeError('no reviewed BYOK candidate');
  const winner = pickUpstream(
    eligible.map((entry) => entry.candidate),
    args.requestedMode,
    args.policy,
  );
  const chosen = eligible.find((entry) => entry.candidate === winner);
  if (!chosen) throw new TypeError('unbound BYOK candidate');
  return chosen;
}

export function createStoredChatByokAttempt(
  args: StoredChatByokAttemptArgs,
  dependencies: Partial<StoredChatByokAttemptDependencies> = {},
): StoredChatAttemptPreparation {
  let body: ReturnType<typeof parseStoredChatBody>;
  let identity: ReturnType<typeof validateStoredChatIdentity>;
  let feeMicrocredits: bigint;
  try {
    body = parseStoredChatBody(args.body, args.model.slug);
    identity = validateStoredChatIdentity({
      orgId: args.orgId,
      apiKeyId: args.apiKeyId,
      clientRequestId: args.clientRequestId,
      declaredSessionId: args.declaredSessionId,
      preDispatchDeadlineAt: args.preDispatchDeadlineAt,
      cachingDiscount: '1',
    });
    if (
      typeof args.byokKey !== 'string' ||
      args.byokKey.length < 1 ||
      args.byokKey.length > 4096 ||
      !/^[\x21-\x7e]+$/.test(args.byokKey)
    )
      throw new TypeError('invalid BYOK key');
    feeMicrocredits = calculateByokFee(args.feeCreditsExact);
    if (feeMicrocredits <= 0n) throw new RangeError('invalid BYOK fee');
  } catch {
    return unavailable;
  }

  const deps: StoredChatByokAttemptDependencies = Object.freeze({
    getAdapter: getUpstream,
    newUuid: randomUUID,
    admitGatewayByokFeeV2,
    markGatewayChargeDispatched,
    recordGatewayChargeOutcomeV2,
    settleAdmittedGatewayCharge,
    cancelUndispatchedGatewayCharge,
    ...dependencies,
  });

  let chosen: Chosen;
  try {
    chosen = selectCandidate(args, body, deps);
  } catch {
    return unavailable;
  }

  let billingRequestId: string;
  let attemptId: string;
  try {
    billingRequestId = normalizeAdmissionUuid(deps.newUuid());
    attemptId = normalizeAdmissionUuid(deps.newUuid());
    if (billingRequestId === attemptId) return unavailable;
  } catch {
    return unavailable;
  }

  const quoteSnapshot = parseAdmissionJsonObject({
    version: 2,
    formulaVersion: 'byok-fee-microcredits-v2',
    upstreamId: chosen.upstreamId,
    feeMicrocredits: feeMicrocredits.toString(),
  });
  const supplierQuoteSnapshot = parseAdmissionJsonObject({
    version: 2,
    formulaVersion: 'byok-zero-v2',
  });
  const pricingSnapshot = quoteSnapshot;
  const admissionArgs: AdmitGatewayByokFeeV2Args = Object.freeze({
    orgId: identity.orgId,
    apiKeyId: identity.apiKeyId,
    clientRequestId: identity.clientRequestId,
    declaredSessionId: identity.declaredSessionId,
    supplierQuoteSnapshot,
    preDispatchDeadlineAt: identity.preDispatchDeadlineAt,
    billingRequestId,
    routeKind: 'chat',
    billingMode: 'byok_fee',
    modelSlug: body.modelSlug,
    authorizedMaxCredits: feeMicrocredits,
    quoteSnapshot,
  });
  const request: AdmittedChatRequest = Object.freeze({
    modelId: chosen.upstreamModelId,
    messages: body.messages,
    maxTokens: chosen.maxOutputTokens,
    endpointPolicy: chosen.endpointPolicy,
    byokKey: args.byokKey,
  });

  function confirmed(admission: GatewayChargeAdmissionResult): GatewayChargeAdmissionResult {
    if (
      !admission ||
      !states.includes(admission.state) ||
      typeof admission.didTransition !== 'boolean' ||
      admission.billingRequestId !== billingRequestId ||
      admission.orgId !== identity.orgId ||
      admission.apiKeyId !== identity.apiKeyId ||
      admission.routeKind !== 'chat' ||
      admission.billingMode !== 'byok_fee' ||
      admission.authorizedMaxCredits !== feeMicrocredits
    )
      throw new Error('Unconfirmed BYOK admission');
    return admission;
  }

  async function perform(): Promise<StoredChatAttemptResult> {
    let lastConfirmedState: GatewayChargeAdmissionState | null = null;
    const unknown = (stage: StoredChatAttemptStage): StoredChatAttemptResult =>
      Object.freeze({ kind: 'reconciliation_required', billingRequestId, stage, lastConfirmedState });
    const replay = (admission: GatewayChargeAdmissionResult): StoredChatAttemptResult =>
      Object.freeze({ kind: 'replay', billingRequestId, state: admission.state });
    const rejected = (value: unknown): StoredChatAttemptResult => {
      const result = parseAdmissionJsonObject(value);
      if (
        result.kind !== 'rejected' ||
        result.billingRequestId !== billingRequestId ||
        !isHttpRejectionCode(result.code)
      )
        throw new Error('Unconfirmed BYOK rejection');
      return Object.freeze({ kind: 'rejected', billingRequestId, code: result.code });
    };
    const cancel = async (held: GatewayChargeAdmissionResult): Promise<StoredChatAttemptResult> => {
      try {
        const cancelled = confirmed(await deps.cancelUndispatchedGatewayCharge({ admission: held }));
        return cancelled.state === 'cancelled'
          ? Object.freeze({ kind: 'cancelled_no_charge' as const, billingRequestId })
          : unknown('cancel');
      } catch {
        return unknown('cancel');
      }
    };

    if (args.signal?.aborted) {
      if (!deps.rejectUnstarted) return Object.freeze({ kind: 'not_started', billingRequestId });
      try {
        return rejected(await deps.rejectUnstarted({
          orgId: identity.orgId,
          apiKeyId: identity.apiKeyId,
          billingRequestId,
        }));
      } catch {
        return unknown('pre_admit_terminal');
      }
    }

    let admission: GatewayChargeAdmissionResult;
    try {
      if (deps.admitAttempt) {
        const result = await deps.admitAttempt(admissionArgs);
        if (result.kind === 'rejected') return rejected(result);
        admission = confirmed(result.admission);
      } else {
        admission = confirmed(await deps.admitGatewayByokFeeV2(admissionArgs));
      }
    } catch (error) {
      if (deps.admitAttempt) return unknown('admit');
      if (error instanceof AdmissionDeadlineExpiredError)
        return Object.freeze({ kind: 'rejected', billingRequestId, code: 'ADMISSION_DEADLINE_EXPIRED' });
      if (error instanceof AiagError && error.code === 'PAYMENT_REQUIRED')
        return Object.freeze({ kind: 'rejected', billingRequestId, code: 'PAYMENT_REQUIRED' });
      return unknown('admit');
    }
    lastConfirmedState = admission.state;
    if (!admission.didTransition) return replay(admission);
    if (admission.state !== 'held') return unknown('admit');
    if (args.signal?.aborted) return cancel(admission);

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
        dispatched.pricingSnapshot === null ||
        !admissionJsonObjectsEqual(dispatched.pricingSnapshot, pricingSnapshot)
      )
        return unknown('dispatch');
      admission = dispatched;
      lastConfirmedState = admission.state;
    } catch (error) {
      if (error instanceof AdmissionDeadlineExpiredError) return cancel(admission);
      return unknown('dispatch');
    }

    let output: Awaited<ReturnType<AdmittedChatMechanics['execute']>>;
    try {
      output = await chosen.mechanics.execute(request);
    } catch {
      return unknown('provider');
    }

    let response: StoredHttpChatResponse;
    try {
      response = parseStoredHttpChatResponse(output.response);
    } catch {
      return unknown('usage');
    }

    const usageSnapshot = parseAdmissionJsonObject({
      version: 2,
      formulaVersion: 'byok-fee-microcredits-v2',
      billingRequestId,
      attemptId,
      upstreamId: chosen.upstreamId,
      verified: true,
    });
    const matchingOutcome = (candidate: GatewayChargeAdmissionResult) =>
      candidate.attemptId === attemptId &&
      candidate.upstreamId === chosen.upstreamId &&
      candidate.actualCostCredits === feeMicrocredits &&
      candidate.outcomeKind === 'success' &&
      candidate.usageSnapshot !== null &&
      admissionJsonObjectsEqual(candidate.usageSnapshot, usageSnapshot);

    try {
      const outcome = confirmed(
        await (deps.persistOutcome
          ? deps.persistOutcome({
              admission,
              actualCostCredits: feeMicrocredits,
              usageSnapshot,
              outcomeKind: 'success',
              response,
            })
          : deps.recordGatewayChargeOutcomeV2({
              admission,
              actualCostCredits: feeMicrocredits,
              usageSnapshot,
              outcomeKind: 'success',
            })),
      );
      if (!['outcome_recorded', 'settled'].includes(outcome.state) || !matchingOutcome(outcome))
        return unknown('outcome');
      admission = outcome;
      lastConfirmedState = admission.state;
    } catch {
      return unknown('outcome');
    }

    if (admission.state !== 'settled') {
      try {
        const settled = confirmed(await deps.settleAdmittedGatewayCharge({ admission }));
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
      actualCostCredits: feeMicrocredits,
      response: response as unknown as AdmittedChatResponse,
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
