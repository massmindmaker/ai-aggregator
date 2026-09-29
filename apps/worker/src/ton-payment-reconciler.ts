import type {
  TonInvoice,
  VerifiedChainCredit,
  TonObservationInput,
  TonObservationResult,
  TonReconciliationSource,
  TonRecipientBinding,
  TonProviderCursor,
  TonSourceErrorCode,
  TonObservedReason,
  TonReviewReason,
} from "@aiag/database";
import type { TonEvidenceProvider } from "./ton-payment-provider.js";
import {
  TON_PROVIDER_ID,
  TON_EVIDENCE_MODEL,
  type NormalizedTonEvidence,
} from "./ton-payment-evidence.js";
import {
  verifyChainCredit,
  TON_VERIFIER_POLICY,
} from "./ton-payment-verifier.js";
import {
  TonOperationBudget,
  TonRunStopped,
  TON_LEASE_MS,
  type TonStopReason,
} from "./ton-recovery-control.js";
import {
  object,
  exact,
  nativeSource,
  sourceForInvoice,
  uuid,
  cursor,
  binding,
  providerPage,
  sourceError,
  creditCandidate,
  observedAck,
  evidenceDigest,
  TonSourceFailure,
} from "./ton-recovery-contract.js";
export interface TonObserveReconcilerDeps {
  getInvoice(id: string): Promise<TonInvoice | null>;
  listSources(input: {
    afterSourceId: string | null;
    limit: number;
    assetKind: "native";
  }): Promise<readonly TonReconciliationSource[]>;
  findInvoices(input: {
    source: TonReconciliationSource;
    references: readonly string[];
  }): Promise<readonly TonInvoice[]>;
  provider: TonEvidenceProvider;
  recordObservation(input: TonObservationInput): Promise<TonObservationResult>;
  claimLease(input: {
    source: TonReconciliationSource;
    providerId: typeof TON_PROVIDER_ID;
    leaseOwner: string;
    leaseMs: 90000;
  }): Promise<
    | {
        kind: "claimed";
        cursor: TonProviderCursor | null;
        binding: TonRecipientBinding | null;
      }
    | { kind: "busy" }
    | { kind: "source_identity_mismatch" }
  >;
  bindRecipient(input: {
    source: TonReconciliationSource;
    leaseOwner: string;
    expected: TonProviderCursor | null;
    binding: TonRecipientBinding;
  }): Promise<
    | "bound"
    | "binding_mismatch"
    | "lease_lost"
    | "cursor_conflict"
    | "source_identity_mismatch"
  >;
  renewLease(input: {
    sourceId: string;
    leaseOwner: string;
    expected: TonProviderCursor | null;
    leaseMs: 90000;
  }): Promise<"renewed" | "lease_lost" | "cursor_conflict">;
  advanceCursor(input: {
    sourceId: string;
    leaseOwner: string;
    expected: TonProviderCursor | null;
    next: TonProviderCursor | null;
    outcome: "success" | "source_error";
    retryAfterMs: number | null;
    errorCode: TonSourceErrorCode | null;
  }): Promise<"advanced" | "lease_lost" | "cursor_conflict">;
  releaseLease(
    sourceId: string,
    leaseOwner: string,
  ): Promise<"released" | "lease_lost">;
  newLeaseOwner(): string;
}
export type TonReconcileSourceResult =
  | { kind: "completed"; processed: number; pagesAdvanced: number }
  | {
      kind: "source_error";
      code: TonSourceErrorCode;
      processed: number;
      pagesAdvanced: number;
    }
  | { kind: "not_started"; reason: "busy" | "source_identity_mismatch" }
  | {
      kind: "stopped";
      reason: TonStopReason;
      processed: number;
      pagesAdvanced: number;
    };
export type TonReconcileItemResult =
  | { kind: "not_found" }
  | { kind: "source_error"; code: TonSourceErrorCode }
  | { kind: "unmatched"; evidenceDigest: string }
  | { kind: "observed"; reason: TonObservedReason }
  | { kind: "review_required"; reason: TonReviewReason }
  | { kind: "verified_candidate"; credit: VerifiedChainCredit };
const reference = (value: string | null): value is string =>
  value !== null &&
  /^aiag-ton:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    value,
  );
function request(value: unknown, names: readonly string[]) {
  const r = object(value);
  exact(r, names);
  if (
    !Number.isInteger(r.limit) ||
    (r.limit as number) < 1 ||
    (r.limit as number) > 16 ||
    !r.signal ||
    typeof (r.signal as AbortSignal).aborted !== "boolean" ||
    typeof (r.signal as AbortSignal).addEventListener !== "function"
  )
    throw Error("TON_INVALID_INPUT");
  return r;
}
function stopped(
  reason: TonStopReason,
  processed: number,
  pagesAdvanced: number,
): TonReconcileSourceResult {
  return { kind: "stopped", reason, processed, pagesAdvanced };
}

/** One source, at most four whole eight-item pages. Claim/ACKed advance are the only cursor authority. */
export async function reconcileTonInvoices(
  input: {
    source: TonReconciliationSource;
    limit: number;
    signal: AbortSignal;
  },
  deps: TonObserveReconcilerDeps,
  budget = new TonOperationBudget(input.signal),
  onItem?: (id: string, result: TonReconcileItemResult) => void,
): Promise<TonReconcileSourceResult> {
  request(input, ["source", "limit", "signal"]);
  let source: TonReconciliationSource;
  try {
    source = nativeSource(input.source);
  } catch {
    return { kind: "not_started", reason: "source_identity_mismatch" };
  }
  let processed = 0,
    pagesAdvanced = 0,
    owned = false,
    leaseOwner = "",
    expected: TonProviderCursor | null = null;
  let answer: TonReconcileSourceResult = stopped("db_error", 0, 0);
  const count = () => ({ processed, pagesAdvanced });
  const fence = (result: string, ok: string) => {
    if (result === ok) return;
    if (result === "lease_lost" || result === "cursor_conflict")
      throw new TonRunStopped(result);
    budget.mutationOutcome = "unknown";
    throw new TonRunStopped("db_error");
  };
  const renew = async () =>
    fence(
      await budget.db(() =>
        deps.renewLease({
          sourceId: source.sourceId,
          leaseOwner,
          expected,
          leaseMs: TON_LEASE_MS,
        }),
      ),
      "renewed",
    );
  const observe = async (data: TonObservationInput) => {
    const result = await budget.db(() => deps.recordObservation(data));
    try {
      return observedAck(result);
    } catch {
      budget.mutationOutcome = "unknown";
      throw new TonRunStopped("db_error");
    }
  };
  const base = (): Omit<TonObservationInput, "result" | "snapshot"> => ({
    schemaVersion: 1,
    invoiceId: null,
    sourceId: source.sourceId,
    recipientAccount: source.invoiceRecipient,
    eventIdentity: null,
    providerId: TON_PROVIDER_ID,
    evidenceModel: TON_EVIDENCE_MODEL,
    providerCursor: expected,
    observedAtMs: Date.now(),
  });
  const errorResult = async (
    code: TonSourceErrorCode,
    retryAfterMs: number | null,
    record: boolean,
    renewFirst = true,
  ): Promise<TonReconcileSourceResult> => {
    budget.check();
    if (renewFirst) await renew();
    budget.check();
    if (record)
      await observe({
        ...base(),
        result: { kind: "source_error", reason: code, evidenceDigest: null },
        snapshot: { sourceId: source.sourceId },
      });
    budget.check();
    fence(
      await budget.db(() =>
        deps.advanceCursor({
          sourceId: source.sourceId,
          leaseOwner,
          expected,
          next: expected,
          outcome: "source_error",
          errorCode: code,
          retryAfterMs,
        }),
      ),
      "advanced",
    );
    return { kind: "source_error", code, ...count() };
  };
  async function run(): Promise<TonReconcileSourceResult> {
    budget.check();
    leaseOwner = uuid(deps.newLeaseOwner());
    const claimed = await budget.db(() =>
      deps.claimLease({
        source,
        providerId: TON_PROVIDER_ID,
        leaseOwner,
        leaseMs: TON_LEASE_MS,
      }),
    );
    const raw = object(claimed);
    if (raw.kind === "busy" || raw.kind === "source_identity_mismatch") {
      exact(raw, ["kind"]);
      return { kind: "not_started", reason: raw.kind };
    }
    exact(raw, ["kind", "cursor", "binding"]);
    if (raw.kind !== "claimed") throw Error("TON_INVALID_CLAIM");
    owned = true;
    expected = cursor(raw.cursor);
    binding(raw.binding, source);
    budget.check();
    const resolved = await budget.provider((signal) =>
      deps.provider.resolveRecipientAccount(source, signal),
    );
    if (resolved.kind === "deadline")
      return errorResult("timeout", null, false);
    const resolution = object(resolved.value);
    if (resolution.kind === "source_error") {
      const err = sourceError(resolution);
      return errorResult(err.code, err.retryAfterMs, true);
    }
    exact(resolution, ["kind", "recipientAccount"]);
    if (
      resolution.kind !== "resolved" ||
      resolution.recipientAccount !== source.invoiceRecipient
    )
      return errorResult("recipient_binding_changed", null, true);
    const bound = await budget.db(() =>
      deps.bindRecipient({
        source,
        leaseOwner,
        expected,
        binding: {
          recipientAccount: source.invoiceRecipient,
          derivation: { kind: "native", ownerAddress: source.invoiceRecipient },
        },
      }),
    );
    if (bound === "binding_mismatch")
      return errorResult("recipient_binding_changed", null, true);
    if (bound === "source_identity_mismatch")
      return { kind: "not_started", reason: "source_identity_mismatch" };
    fence(bound, "bound");
    for (let index = 0; index < Math.min(4, input.limit); index++) {
      budget.check();
      await renew();
      budget.check();
      const result = await budget.provider((signal) =>
        deps.provider.scanAccountPage(
          source.invoiceRecipient,
          expected,
          signal,
        ),
      );
      budget.check();
      if (result.kind === "deadline")
        return errorResult("timeout", null, false);
      await renew();
      budget.check();
      const rawPage = object(result.value);
      if (rawPage.kind === "source_error") {
        const err = sourceError(rawPage);
        return errorResult(err.code, err.retryAfterMs, true, false);
      }
      let page: ReturnType<typeof providerPage>;
      try {
        page = providerPage(rawPage, expected, source.invoiceRecipient);
      } catch (error) {
        if (error instanceof TonSourceFailure) {
          if (error.code === "unsupported_asset")
            return { kind: "source_error", code: error.code, ...count() };
          return errorResult(error.code, null, true, false);
        }
        throw error;
      }
      const retained: NormalizedTonEvidence[] = [];
      let crossedFloor = false;
      for (const e of page.evidence) {
        if (creditCandidate(e).tx.chainTimeMs < source.scanFloorTimeMs) {
          crossedFloor = true;
          break;
        }
        retained.push(e);
      }
      if (page.evidence.length === 0)
        await observe({
          ...base(),
          result: {
            kind: "observed",
            reason: "candidate_not_found",
            evidenceDigest: null,
          },
          snapshot: { sourceId: source.sourceId },
        });
      const references = [
        ...new Set(
          retained.map((e) => creditCandidate(e).reference).filter(reference),
        ),
      ];
      const invoices = references.length
        ? await budget.db(
            () => deps.findInvoices({ source, references }),
            false,
          )
        : [];
      if (!Array.isArray(invoices) || invoices.length > references.length)
        throw Error("TON_INVALID_INVOICES");
      const byReference = new Map<string, TonInvoice>();
      const invoiceIds = new Set<string>();
      for (const invoice of invoices) {
        uuid(invoice.invoiceId);
        if (
          !references.includes(invoice.reference) ||
          byReference.has(invoice.reference) ||
          invoiceIds.has(invoice.invoiceId) ||
          invoice.network !== "tvm:-3" ||
          invoice.asset.kind !== "native" ||
          invoice.asset.decimals !== 9 ||
          invoice.recipient !== source.invoiceRecipient
        )
          throw Error("TON_INVALID_INVOICE_BINDING");
        byReference.set(invoice.reference, invoice);
        invoiceIds.add(invoice.invoiceId);
      }
      budget.check();
      for (const e of retained) {
        budget.check();
        const candidate = creditCandidate(e),
          invoice = candidate.reference
            ? byReference.get(candidate.reference)
            : undefined;
        const snapshot = {
          reference: candidate.reference,
          network: e.network,
          traceId: e.trace.id,
          masterchainSeqno: e.trace.masterchainSeqno,
          sourceId: source.sourceId,
        };
        const common = {
          ...base(),
          eventIdentity: candidate.event,
          snapshot,
          observedAtMs: e.source.fetchedAtMs,
        };
        if (!invoice) {
          await observe({
            ...common,
            invoiceId: null,
            result: {
              kind: "unmatched",
              reason: "invoice_reference_not_found",
              evidenceDigest: evidenceDigest(e),
            },
          });
          continue;
        }
        const verified = verifyChainCredit(invoice, e, TON_VERIFIER_POLICY);
        const outcome: TonObservationInput["result"] =
          verified.kind === "verified"
            ? {
                kind: "verified_candidate",
                reason: "verified_candidate",
                evidenceDigest: verified.evidenceDigest,
              }
            : verified.kind === "observed"
              ? {
                  kind: "observed",
                  reason: verified.reason,
                  evidenceDigest: verified.evidenceDigest,
                }
              : {
                  kind: "review_required",
                  reason: verified.reason,
                  evidenceDigest: verified.evidenceDigest,
                };
        await observe({
          ...common,
          invoiceId: invoice.invoiceId,
          result: outcome,
        });
        budget.check();
        onItem?.(
          invoice.invoiceId,
          verified.kind === "verified"
            ? { kind: "verified_candidate", credit: verified.credit }
            : verified.kind === "observed"
              ? { kind: "observed", reason: verified.reason }
              : { kind: "review_required", reason: verified.reason },
        );
      }
      budget.check();
      const next = crossedFloor ? null : page.nextCursor;
      fence(
        await budget.db(() =>
          deps.advanceCursor({
            sourceId: source.sourceId,
            leaseOwner,
            expected,
            next,
            outcome: "success",
            retryAfterMs: null,
            errorCode: null,
          }),
        ),
        "advanced",
      );
      expected = next;
      processed += retained.length;
      pagesAdvanced++;
      if (next === null) return { kind: "completed", ...count() };
    }
    return { kind: "completed", ...count() };
  }
  try {
    answer = await run();
  } catch (error) {
    answer =
      error instanceof TonSourceFailure
        ? { kind: "source_error", code: error.code, ...count() }
        : stopped(
            error instanceof TonRunStopped ? error.reason : "db_error",
            processed,
            pagesAdvanced,
          );
  } finally {
    if (owned) {
      try {
        const released = await budget.db(
          () => deps.releaseLease(source.sourceId, leaseOwner),
          true,
          "release",
        );
        if (released !== "released" && released !== "lease_lost") {
          budget.mutationOutcome = "unknown";
          answer = stopped("db_error", processed, pagesAdvanced);
        }
      } catch (error) {
        answer = stopped(
          error instanceof TonRunStopped ? error.reason : "db_error",
          processed,
          pagesAdvanced,
        );
      }
    }
  }
  return answer;
}

/** Read-only on-demand check; a supplied pagination position is deliberately rejected. */
export async function reconcileTonInvoice(
  input: {
    invoiceId: string;
    cursor: TonProviderCursor | null;
    limit: number;
    signal: AbortSignal;
  },
  deps: TonObserveReconcilerDeps,
): Promise<TonReconcileItemResult> {
  request(input, ["invoiceId", "cursor", "limit", "signal"]);
  uuid(input.invoiceId);
  if (input.cursor !== null) throw Error("TON_CALLER_CURSOR_FORBIDDEN");
  const budget = new TonOperationBudget(input.signal);
  let captured: TonReconcileItemResult | undefined;
  try {
    const invoice = await budget.db(
      () => deps.getInvoice(input.invoiceId),
      false,
    );
    if (!invoice) return { kind: "not_found" };
    if (invoice.invoiceId !== input.invoiceId)
      throw Error("TON_INVOICE_IDENTITY");
    if (invoice.asset.kind !== "native")
      return { kind: "source_error", code: "unsupported_asset" };
    const result = await reconcileTonInvoices(
      {
        source: sourceForInvoice(invoice),
        limit: input.limit,
        signal: input.signal,
      },
      deps,
      budget,
      (id, value) => {
        if (id === input.invoiceId) captured = value;
      },
    );
    if (result.kind === "not_started")
      return { kind: "source_error", code: "timeout" };
    if (result.kind === "source_error")
      return { kind: "source_error", code: result.code };
    if (result.kind === "stopped")
      return {
        kind: "source_error",
        code:
          result.reason === "db_error" ? "provider_schema_invalid" : "timeout",
      };
    return captured ?? { kind: "observed", reason: "candidate_not_found" };
  } catch {
    return {
      kind: "source_error",
      code: budget.signal.aborted ? "timeout" : "provider_schema_invalid",
    };
  }
}
