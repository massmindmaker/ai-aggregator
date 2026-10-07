import { randomUUID } from "node:crypto";
import type { TonDatabaseCloseResult } from "@aiag/database";
import type { TonEvidenceProvider } from "./ton-payment-provider.js";
import {
  TON_PROVIDER_ID,
  TON_PROVIDER_ORIGIN,
} from "./ton-payment-evidence.js";
import {
  TON_VERIFIER_VERSION,
  TON_FINALITY_POLICY_ID,
} from "./ton-payment-verifier.js";
import {
  TonOperationBudget,
  type TonCloseResult,
} from "./ton-recovery-control.js";
import {
  reconcileTonInvoices,
  type TonObserveReconcilerDeps,
  type TonReconcileSourceResult,
} from "./ton-payment-reconciler.js";
import { nativeSource, hash } from "./ton-recovery-contract.js";
export type { TonCloseResult } from "./ton-recovery-control.js";
export interface TonObservationDatabase {
  deps: Omit<TonObserveReconcilerDeps, "provider" | "newLeaseOwner">;
  close(): Promise<TonDatabaseCloseResult>;
}
export interface TonObservationStartupDeps {
  env?: Readonly<Record<string, string | undefined>>;
  makeDatabase?: (url: string) => Promise<TonObservationDatabase>;
  makeProvider?: (config: { baseUrl: string; apiKey?: string }) => TonEvidenceProvider;
  newLeaseOwner?: () => string;
  /** Test seam overriding the default TonAPI crosscheck gate when the env flag enables it. */
  crosscheckMasterchain?: import("./ton-evidence-crosscheck-gate.js").TonCrosscheckFn;
  onResult?: (
    sourceId: string | null,
    result: TonReconcileSourceResult,
  ) => void;
}
const POLL_MS = 30_000;
const forbidden = new Set([
  "connect_timeout",
  "statement_timeout",
  "query_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "options",
]);
export function parseTonObservationStartup(
  env: Readonly<Record<string, string | undefined>>,
):
  | { mode: "disabled" }
  | {
      mode: "observe";
      databaseUrl: string;
      sourceId: string | null;
      crosscheck: boolean;
      toncenterApiKey: string | undefined;
    } {
  const mode = env.TON_RECONCILIATION_MODE ?? "disabled";
  if (mode === "disabled") return { mode };
  const crosscheckFlag = env.TON_EVIDENCE_CROSSCHECK ?? "0";
  const toncenterApiKey = env.TONCENTER_API_KEY?.trim() || undefined;
  if (
    mode !== "observe" ||
    env.TON_RECONCILIATION_NETWORK !== "tvm:-3" ||
    env.TON_RECONCILIATION_ASSET_KIND !== "native" ||
    env.TON_RECONCILIATION_PROVIDER_ID !== TON_PROVIDER_ID ||
    env.TON_RECONCILIATION_PROVIDER_ORIGIN !== TON_PROVIDER_ORIGIN ||
    env.TON_RECONCILIATION_VERIFIER_VERSION !== TON_VERIFIER_VERSION ||
    env.TON_RECONCILIATION_FINALITY_POLICY_ID !== TON_FINALITY_POLICY_ID ||
    (crosscheckFlag !== "0" && crosscheckFlag !== "1")
  )
    throw Error("TON_OBSERVATION_STARTUP_REFUSED");
  const raw = env.DATABASE_URL;
  if (!raw || raw.trim() !== raw)
    throw Error("TON_OBSERVATION_STARTUP_REFUSED");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Error("TON_OBSERVATION_STARTUP_REFUSED");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.hash ||
    [...url.searchParams.keys()].some((k) => forbidden.has(k.toLowerCase()))
  )
    throw Error("TON_OBSERVATION_STARTUP_REFUSED");
  return {
    mode,
    databaseUrl: raw,
    sourceId:
      env.TON_RECONCILIATION_SOURCE_ID === undefined
        ? null
        : hash(env.TON_RECONCILIATION_SOURCE_ID),
    crosscheck: crosscheckFlag === "1",
    toncenterApiKey,
  };
}
async function defaultDatabase(url: string): Promise<TonObservationDatabase> {
  // The only runtime internal-package import; no settlement export is consumed here.
  const api = await import("@aiag/database/ton-reconciliation-internal");
  const db = api.createTonWorkerDatabase(url);
  return {
    close: () => db.close(),
    deps: {
      getInvoice: (id) => api.getTonInvoiceForReconciliation(db, id),
      listSources: (input) => api.listTonReconciliationSources(db, input),
      findInvoices: (input) => api.findTonInvoicesForReconciliation(db, input),
      recordObservation: (input) => api.recordTonChainObservation(db, input),
      claimLease: (input) => api.claimTonReconciliationLease(db, input),
      bindRecipient: (input) => api.bindTonReconciliationRecipient(db, input),
      renewLease: (input) => api.renewTonReconciliationLease(db, input),
      advanceCursor: (input) => api.advanceTonReconciliationCursor(db, input),
      releaseLease: (sourceId, owner) =>
        api.releaseTonReconciliationLease(db, sourceId, owner),
    },
  };
}

/** Prepared observe-only startup; not installed into the shared worker index before independent review. */
export async function startTonObservationFromEnv(
  options: TonObservationStartupDeps = {},
): Promise<{ close(): Promise<TonCloseResult> }> {
  const config = parseTonObservationStartup(options.env ?? process.env);
  if (config.mode === "disabled") {
    const closed = Promise.resolve<TonCloseResult>({
      kind: "closed",
      mutationOutcome: "known",
    });
    return { close: () => closed };
  }
  if ("settleVerifiedCredit" in options)
    throw Error("TON_RUNTIME_SETTLEMENT_FORBIDDEN");
  const controller = new AbortController(),
    budget = new TonOperationBudget(controller.signal);
  const database = await (options.makeDatabase ?? defaultDatabase)(
    config.databaseUrl,
  );
  let provider: TonEvidenceProvider;
  try {
    if ("settleVerifiedCredit" in database.deps)
      throw Error("TON_RUNTIME_SETTLEMENT_FORBIDDEN");
    provider = options.makeProvider
      ? options.makeProvider({ baseUrl: TON_PROVIDER_ORIGIN, apiKey: config.toncenterApiKey })
      : (await import("./ton-payment-provider.js")).createToncenterV3Provider({
          baseUrl: TON_PROVIDER_ORIGIN,
          apiKey: config.toncenterApiKey,
        });
  } catch {
    controller.abort();
    await budget.closePool(() => database.close());
    throw Error("TON_OBSERVATION_STARTUP_REFUSED");
  }
  const sourceFilter = config.sourceId;
  const deps: TonObserveReconcilerDeps = {
    ...database.deps,
    provider,
    newLeaseOwner: options.newLeaseOwner ?? randomUUID,
    ...(config.crosscheck
      ? {
          crosscheckMasterchain:
            options.crosscheckMasterchain ??
            (await import("./ton-evidence-crosscheck-gate.js")).buildTonapiCrosscheckGate(),
        }
      : {}),
  };
  let active: Promise<void> | undefined,
    afterSourceId: string | null = null,
    closing: Promise<TonCloseResult> | undefined;
  const report = (id: string | null, result: TonReconcileSourceResult) => {
    try {
      options.onResult?.(id, result);
    } catch {
      /* reporting cannot create work or undo persisted state */
    }
  };
  async function cycle() {
    try {
      const found = await budget.db(
        () =>
          deps.listSources({ afterSourceId, limit: 16, assetKind: "native" }),
        false,
      );
      if (!Array.isArray(found) || found.length > 16)
        throw Error("TON_INVALID_SOURCE_PAGE");
      const sources = found.map(nativeSource);
      let previous = afterSourceId;
      for (const source of sources) {
        if (previous !== null && source.sourceId <= previous)
          throw Error("TON_INVALID_SOURCE_ORDER");
        previous = source.sourceId;
      }
      for (const source of sources) {
        budget.check();
        if (sourceFilter !== null && source.sourceId !== sourceFilter) continue;
        const result = await reconcileTonInvoices(
          { source, limit: 4, signal: controller.signal },
          deps,
          budget,
        );
        report(source.sourceId, result);
        if (
          result.kind === "stopped" &&
          (result.reason === "db_operation_timeout" ||
            result.reason === "shutdown")
        )
          return;
      }
      budget.check();
      afterSourceId =
        sources.length < 16 ? null : sources[sources.length - 1].sourceId;
    } catch (error) {
      report(null, {
        kind: "stopped",
        reason: controller.signal.aborted
          ? "shutdown"
          : error instanceof Error && error.message === "db_operation_timeout"
            ? "db_operation_timeout"
            : "db_error",
        processed: 0,
        pagesAdvanced: 0,
      });
    }
  }
  function tick() {
    if (active || controller.signal.aborted) return;
    active = cycle().finally(() => {
      active = undefined;
    });
  }
  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  tick();
  return {
    close() {
      closing ??= (async () => {
        clearInterval(timer);
        controller.abort();
        await active;
        await budget.closePool(() => database.close());
        return budget.closeResult();
      })();
      return closing;
    },
  };
}


/** Stable process-boundary error: never carries a provider response or connection string. */
export class TonReconciliationStartupError extends Error {
  constructor(){super('TON_RECONCILIATION_STARTUP_REFUSED');this.name='TonReconciliationStartupError';}
}
/** Runtime entrypoint remains strictly disabled|observe; it has no settlement capability. */
export async function startTonReconciliationFromEnv(options:TonObservationStartupDeps={}):Promise<{close():Promise<TonCloseResult>}>{
  try{return await startTonObservationFromEnv(options);}
  catch{throw new TonReconciliationStartupError();}
}
