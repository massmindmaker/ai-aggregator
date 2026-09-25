import { randomUUID } from 'node:crypto';

import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { AdmittedChatStreamMechanics, AdmittedChatStreamRequest, UpstreamAdapter } from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';
import { cancelUndispatchedGatewayCharge, markGatewayChargeDispatched, settleAdmittedGatewayCharge, AdmissionDeadlineExpiredError } from './admission';
import { admissionJsonObjectsEqual, normalizeAdmissionUuid, parseAdmissionJsonObject, type GatewayChargeAdmissionResult, type GatewayChargeAdmissionState, type JsonObject } from './admission-result';
import { prepareStoredChatQuote } from './candidate-quote';
import { isHttpRejectionCode, type HttpRejectionCode } from './http-terminal-recovery';
import { admitGatewayChargeV2, recordGatewayChargeOutcomeV2, type AdmitGatewayChargeV2Args } from './quota-admission';
import { captureStoredChatEvidence, parseStoredChatStreamBody, STORED_CHAT_FORMULA } from './stored-chat-attempt-contract';
import { parseStoredHttpChatStreamResponse, type StoredHttpChatStreamResponse } from './stored-chat-stream-http-contract';

export type StoredChatStreamAttemptArgs = Readonly<{
  orgId: string; apiKeyId: string; clientRequestId: string | null; declaredSessionId: string | null;
  model: ResolvedModel; body: unknown; requestedMode: Mode; policy: Readonly<ApiKeyPolicies>;
  defaultMaxOutputTokens: number; cachingDiscount: string; preDispatchDeadlineAt: string; signal?: AbortSignal;
}>;
export type StoredChatStreamAttemptDependencies = Readonly<{
  getAdapter: (key: string) => UpstreamAdapter; newUuid: () => string;
  admitGatewayChargeV2: typeof admitGatewayChargeV2;
  admitAttempt?: (args: AdmitGatewayChargeV2Args) => Promise<Readonly<{ kind: 'admitted'; admission: GatewayChargeAdmissionResult }> | Readonly<{ kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode }>>;
  rejectUnstarted?: (args: Readonly<{ orgId: string; apiKeyId: string; billingRequestId: string }>) => Promise<Readonly<{ kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode }>>;
  markGatewayChargeDispatched: typeof markGatewayChargeDispatched; recordGatewayChargeOutcomeV2: typeof recordGatewayChargeOutcomeV2;
  persistOutcome?: (args: Readonly<{ admission: GatewayChargeAdmissionResult; actualCostCredits: bigint; usageSnapshot: JsonObject; outcomeKind: 'success'; response: StoredHttpChatStreamResponse }>) => Promise<GatewayChargeAdmissionResult>;
  settleAdmittedGatewayCharge: typeof settleAdmittedGatewayCharge; cancelUndispatchedGatewayCharge: typeof cancelUndispatchedGatewayCharge;
}>;
type Stage = 'pre_admit_terminal' | 'admit' | 'dispatch' | 'provider' | 'usage' | 'outcome' | 'settle' | 'cancel';
export type StoredChatStreamTerminalResult =
  | Readonly<{ kind: 'rejected'; billingRequestId: string; code: HttpRejectionCode }>
  | Readonly<{ kind: 'replay'; billingRequestId: string; state: GatewayChargeAdmissionState }>
  | Readonly<{ kind: 'cancelled_no_charge'; billingRequestId: string }>
  | Readonly<{ kind: 'not_started'; billingRequestId: string }>
  | Readonly<{ kind: 'reconciliation_required'; billingRequestId: string; stage: Stage; lastConfirmedState: GatewayChargeAdmissionState | null }>;
export type StoredChatStreamRunResult =
  | Readonly<{ kind: 'settled_success'; billingRequestId: string; actualCostCredits: bigint; response: StoredHttpChatStreamResponse; admission: GatewayChargeAdmissionResult }>
  | Extract<StoredChatStreamTerminalResult, { kind: 'reconciliation_required' }>;
export type StoredChatStreamAttemptRunner = Readonly<{ billingRequestId: string; run(onEvent: Parameters<AdmittedChatStreamMechanics['execute']>[1]): Promise<StoredChatStreamRunResult> }>;
export type StoredChatStreamBeginResult = Readonly<{ kind: 'dispatch_granted'; billingRequestId: string; runner: StoredChatStreamAttemptRunner }> | StoredChatStreamTerminalResult;
export type StoredChatStreamAttemptPreparation =
  | Readonly<{ status: 'bad_request'; code: 'INVALID_STORED_CHAT_REQUEST' }>
  | Readonly<{ status: 'unavailable'; code: 'STORED_CHAT_UNAVAILABLE' }>
  | Readonly<{ status: 'ready'; billingRequestId: string; begin(): Promise<StoredChatStreamBeginResult> }>;

const states: readonly GatewayChargeAdmissionState[] = ['held', 'dispatched', 'outcome_recorded', 'settled', 'cancelled'];
const unavailable = Object.freeze({ status: 'unavailable', code: 'STORED_CHAT_UNAVAILABLE' } as const);

export function createStoredChatStreamAttempt(args: StoredChatStreamAttemptArgs, dependencies: Partial<StoredChatStreamAttemptDependencies> = {}): StoredChatStreamAttemptPreparation {
  let body: ReturnType<typeof parseStoredChatStreamBody>;
  try { body = parseStoredChatStreamBody(args.body, args.model.slug); }
  catch { return Object.freeze({ status: 'bad_request', code: 'INVALID_STORED_CHAT_REQUEST' }); }
  const deps = Object.freeze({ getAdapter: getUpstream, newUuid: randomUUID, admitGatewayChargeV2, markGatewayChargeDispatched, recordGatewayChargeOutcomeV2, settleAdmittedGatewayCharge, cancelUndispatchedGatewayCharge, ...dependencies });
  const mechanics = new Map<string, AdmittedChatStreamMechanics | null>();
  const lookup = (key: string): UpstreamAdapter => {
    if (!mechanics.has(key)) {
      let captured: AdmittedChatStreamMechanics | null = null;
      try { const source = deps.getAdapter(key).admittedChatStream; if (source) captured = Object.freeze({ contract: source.contract, execute: source.execute.bind(source) }); } catch { /* frozen unavailable */ }
      mechanics.set(key, captured);
    }
    const stream = mechanics.get(key); if (!stream) throw new Error('Admitted stream unavailable');
    return Object.freeze({ admittedChatStream: stream, admittedChat: Object.freeze({ contract: 'openrouter-pinned-provider-chat-v1', execute: async () => { throw new Error('non-stream disabled'); } }), chat: async () => { throw new Error('legacy disabled'); } });
  };
  let quote: ReturnType<typeof prepareStoredChatQuote>;
  try { quote = prepareStoredChatQuote({ model: args.model, requestedMode: args.requestedMode, policy: args.policy, ...(body.maxTokens === undefined ? {} : { clientMaxTokens: body.maxTokens }), defaultMaxOutputTokens: Math.min(args.defaultMaxOutputTokens, 2048), getAdapter: lookup }); }
  catch { return unavailable; }
  if (quote.status !== 'ready') return unavailable;
  const chosen = quote.candidates[0]!; const execute = mechanics.get(chosen.adapterKey)?.execute;
  if (!execute || chosen.maxCredits > quote.authorizedMaxCredits || chosen.maxOutputTokens > 2048) return unavailable;
  let billingRequestId: string, attemptId: string;
  try { billingRequestId = normalizeAdmissionUuid(deps.newUuid()); attemptId = normalizeAdmissionUuid(deps.newUuid()); if (billingRequestId === attemptId) return unavailable; }
  catch { return unavailable; }
  const actualChargePolicy = Object.freeze({ formulaVersion: STORED_CHAT_FORMULA, cachingDiscount: args.cachingDiscount });
  const admissionArgs: AdmitGatewayChargeV2Args = Object.freeze({ orgId: normalizeAdmissionUuid(args.orgId), apiKeyId: normalizeAdmissionUuid(args.apiKeyId), clientRequestId: args.clientRequestId, declaredSessionId: args.declaredSessionId, supplierQuoteSnapshot: parseAdmissionJsonObject({ version: 2, formulaVersion: 'catalog-input-output-cents-per-1k-usd-micro-v2', tokenQuote: quote.quoteSnapshot }), preDispatchDeadlineAt: args.preDispatchDeadlineAt, billingRequestId, routeKind: 'chat', billingMode: 'stored', modelSlug: body.modelSlug, authorizedMaxCredits: quote.authorizedMaxCredits, quoteSnapshot: parseAdmissionJsonObject({ version: 1, tokenQuote: quote.quoteSnapshot, actualChargePolicy }) });
  const pricingSnapshot = parseAdmissionJsonObject({ ...quote.quoteSnapshot.candidates[0], actualChargePolicy });
  const request: AdmittedChatStreamRequest = Object.freeze({ modelId: chosen.upstreamModelId, messages: body.messages, maxTokens: chosen.maxOutputTokens, endpointPolicy: chosen.profile.endpointPolicy, ...(chosen.egressProxyUrl == null ? {} : { egressProxyUrl: chosen.egressProxyUrl }) });
  let admission: GatewayChargeAdmissionResult | null = null;
  const confirmed = (value: GatewayChargeAdmissionResult): GatewayChargeAdmissionResult => {
    if (!value || !states.includes(value.state) || typeof value.didTransition !== 'boolean' || value.billingRequestId !== billingRequestId || value.orgId !== admissionArgs.orgId || value.apiKeyId !== admissionArgs.apiKeyId || value.routeKind !== 'chat' || value.billingMode !== 'stored' || value.authorizedMaxCredits !== admissionArgs.authorizedMaxCredits) throw new Error('Unconfirmed stream admission');
    return value;
  };
  const unknown = (stage: Stage): Extract<StoredChatStreamTerminalResult, { kind: 'reconciliation_required' }> => Object.freeze({ kind: 'reconciliation_required', billingRequestId, stage, lastConfirmedState: admission?.state ?? null });
  const rejected = (value: unknown): StoredChatStreamTerminalResult => { const parsed = parseAdmissionJsonObject(value); if (parsed.kind !== 'rejected' || parsed.billingRequestId !== billingRequestId || !isHttpRejectionCode(parsed.code)) throw new Error('Unconfirmed stream rejection'); return Object.freeze({ kind: 'rejected', billingRequestId, code: parsed.code }); };
  const cancel = async (): Promise<StoredChatStreamTerminalResult> => { if (!admission) return unknown('cancel'); try { const value = confirmed(await deps.cancelUndispatchedGatewayCharge({ admission })); admission = value; return value.state === 'cancelled' ? Object.freeze({ kind: 'cancelled_no_charge', billingRequestId }) : unknown('cancel'); } catch { return unknown('cancel'); } };

  async function begin(): Promise<StoredChatStreamBeginResult> {
    if (args.signal?.aborted) { if (!deps.rejectUnstarted) return Object.freeze({ kind: 'not_started', billingRequestId }); try { return rejected(await deps.rejectUnstarted({ orgId: admissionArgs.orgId, apiKeyId: admissionArgs.apiKeyId, billingRequestId })); } catch { return unknown('pre_admit_terminal'); } }
    try { if (deps.admitAttempt) { const result = await deps.admitAttempt(admissionArgs); if (result.kind === 'rejected') return rejected(result); admission = confirmed(result.admission); } else admission = confirmed(await deps.admitGatewayChargeV2(admissionArgs)); } catch { return unknown('admit'); }
    if (!admission.didTransition) return Object.freeze({ kind: 'replay', billingRequestId, state: admission.state });
    if (admission.state !== 'held') return unknown('admit');
    if (args.signal?.aborted) return cancel();
    try { const dispatch = await deps.markGatewayChargeDispatched({ admission, attemptId, upstreamId: chosen.upstreamId, pricingSnapshot }); const value = confirmed(dispatch.admission); if (dispatch.kind === 'replay' && !value.didTransition && ['dispatched', 'outcome_recorded', 'settled'].includes(value.state)) { admission = value; return Object.freeze({ kind: 'replay', billingRequestId, state: value.state }); } if (dispatch.kind !== 'dispatch_granted' || !value.didTransition || value.state !== 'dispatched' || value.attemptId !== attemptId || value.upstreamId !== chosen.upstreamId || !value.pricingSnapshot || !admissionJsonObjectsEqual(value.pricingSnapshot, pricingSnapshot)) return unknown('dispatch'); admission = value; }
    catch (error) { if (error instanceof AdmissionDeadlineExpiredError) return cancel(); return unknown('dispatch'); }
    let runPromise: Promise<StoredChatStreamRunResult> | undefined;
    const runner: StoredChatStreamAttemptRunner = Object.freeze({ billingRequestId, run(onEvent) { return (runPromise ??= (async () => {
      let output: Awaited<ReturnType<AdmittedChatStreamMechanics['execute']>>;
      try { output = await execute!(request, onEvent); } catch { return unknown('provider'); }
      let evidence: ReturnType<typeof captureStoredChatEvidence>, response: StoredHttpChatStreamResponse;
      try { evidence = captureStoredChatEvidence(output, chosen, args.cachingDiscount, billingRequestId, attemptId); response = parseStoredHttpChatStreamResponse({ object: 'aiag.chat.stream.v1', events: output.events, final: evidence.response }); } catch { return unknown('usage'); }
      const matches = (value: GatewayChargeAdmissionResult) => value.attemptId === attemptId && value.upstreamId === chosen.upstreamId && value.actualCostCredits === evidence.actualCostCredits && value.outcomeKind === 'success' && value.usageSnapshot !== null && admissionJsonObjectsEqual(value.usageSnapshot, evidence.usageSnapshot);
      try { const value = confirmed(await (deps.persistOutcome ? deps.persistOutcome({ admission: admission!, actualCostCredits: evidence.actualCostCredits, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success', response }) : deps.recordGatewayChargeOutcomeV2({ admission: admission!, actualCostCredits: evidence.actualCostCredits, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success' }))); if (!['outcome_recorded', 'settled'].includes(value.state) || !matches(value)) return unknown('outcome'); admission = value; } catch { return unknown('outcome'); }
      if (admission.state !== 'settled') { try { const value = confirmed(await deps.settleAdmittedGatewayCharge({ admission })); if (value.state !== 'settled' || !matches(value)) return unknown('settle'); admission = value; } catch { return unknown('settle'); } }
      return Object.freeze({ kind: 'settled_success', billingRequestId, actualCostCredits: evidence.actualCostCredits, response, admission });
    })()); } });
    return Object.freeze({ kind: 'dispatch_granted', billingRequestId, runner });
  }
  let beginPromise: Promise<StoredChatStreamBeginResult> | undefined;
  return Object.freeze({ status: 'ready', billingRequestId, begin() { return (beginPromise ??= begin()); } });
}
