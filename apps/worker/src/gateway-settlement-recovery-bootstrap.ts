import {
  parseGatewaySettlementRecoveryDatabaseUrl,
  parseGatewaySettlementRecoveryMode,
  startGatewaySettlementRecovery,
  type GatewaySettlementRecoveryDb,
  type GatewaySettlementRecoveryHandle,
  type GatewaySettlementRecoveryScheduler,
  type GatewaySettlementRecoveryTickResult,
} from "./queues/gateway-settlement-recovery.js";

export type GatewaySettlementRecoveryStartupConfig =
  | Readonly<{ mode: "disabled" }>
  | Readonly<{
      mode: "stored_chat_v1";
      httpExecutionMode: "stored_chat_only";
      databaseUrl: string;
    }>
  | Readonly<{
      mode: "stored_chat_embeddings_v1";
      httpExecutionMode: "stored_chat_embeddings";
      databaseUrl: string;
    }>
  | Readonly<{
      mode: "stored_chat_embeddings_completions_v1";
      httpExecutionMode: "stored_chat_embeddings_completions";
      databaseUrl: string;
    }>
  | Readonly<{
      mode: "stored_chat_embeddings_completions_stream_v1";
      httpExecutionMode: "stored_chat_embeddings_completions_stream";
      databaseUrl: string;
    }>;

export type GatewaySettlementRecoveryLogger = Pick<
  import("./logger.js").Logger,
  "info" | "warn" | "error" | "fatal"
>;

const COMPONENT = "gateway_settlement_recovery";
const STARTUP_MESSAGE = "gateway settlement recovery startup refused";

export class GatewaySettlementRecoveryBoundaryError extends Error {
  readonly classification: "startup_refused";

  constructor(classification: "startup_refused") {
    super(STARTUP_MESSAGE);
    this.name = "GatewaySettlementRecoveryBoundaryError";
    this.classification = classification;
  }
}

function startupRefused(): GatewaySettlementRecoveryBoundaryError {
  return new GatewaySettlementRecoveryBoundaryError("startup_refused");
}

export function parseGatewaySettlementRecoveryStartupConfig(
  env: Readonly<Record<string, string | undefined>>,
): GatewaySettlementRecoveryStartupConfig {
  let mode: "disabled" | "stored_chat_v1" | "stored_chat_embeddings_v1" | "stored_chat_embeddings_completions_v1" | "stored_chat_embeddings_completions_stream_v1";
  try {
    mode = parseGatewaySettlementRecoveryMode(env.GATEWAY_SETTLEMENT_RECOVERY_MODE);
  } catch {
    throw startupRefused();
  }
  if (mode === "disabled") return { mode: "disabled" };

  const httpExecutionMode = mode === "stored_chat_v1"
    ? "stored_chat_only"
    : mode === "stored_chat_embeddings_v1"
      ? "stored_chat_embeddings"
      : mode === "stored_chat_embeddings_completions_stream_v1" ? "stored_chat_embeddings_completions_stream" : "stored_chat_embeddings_completions";
  if (env.GATEWAY_HTTP_EXECUTION_MODE !== httpExecutionMode) throw startupRefused();

  let databaseUrl: string;
  try {
    databaseUrl = parseGatewaySettlementRecoveryDatabaseUrl(env.DATABASE_URL ?? "");
  } catch {
    throw startupRefused();
  }
  if (mode === "stored_chat_v1") return { mode, httpExecutionMode: "stored_chat_only", databaseUrl };
  if (mode === "stored_chat_embeddings_v1") return { mode, httpExecutionMode: "stored_chat_embeddings", databaseUrl };
  if (mode === "stored_chat_embeddings_completions_stream_v1") return { mode, httpExecutionMode: "stored_chat_embeddings_completions_stream", databaseUrl };
  return { mode, httpExecutionMode: "stored_chat_embeddings_completions", databaseUrl };
}

const nativeScheduler: GatewaySettlementRecoveryScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

async function loadGatewaySettlementRecoveryDb(
  databaseUrl: string,
  allowedRoutes: readonly ("chat" | "embeddings" | "completions")[],
  allowedContractVersions: readonly (1 | 2 | 3)[],
): Promise<GatewaySettlementRecoveryDb> {
  const { createGatewaySettlementRecoveryDb } = await import("./queues/gateway-settlement-recovery-db.js");
  return createGatewaySettlementRecoveryDb(databaseUrl, { allowedRoutes, allowedContractVersions });
}

function logTick(logger: GatewaySettlementRecoveryLogger, tick: GatewaySettlementRecoveryTickResult): void {
  const binding = {
    component: COMPONENT,
    classification: tick.classification,
    selected: tick.selected,
    attempted: tick.attempted,
    settled: tick.settled,
    unconfirmed: tick.unconfirmed,
    deferred: tick.deferred,
  };
  switch (tick.classification) {
    case "complete":
      logger.info(binding, "gateway settlement recovery tick complete");
      break;
    case "partial_unconfirmed":
      logger.warn(binding, "gateway settlement recovery tick unconfirmed");
      break;
    case "selection_unavailable":
      logger.warn(binding, "gateway settlement recovery selection unavailable");
      break;
    case "stopped":
      logger.info(binding, "gateway settlement recovery tick stopped");
      break;
  }
}

function sanitizeClose(
  handle: GatewaySettlementRecoveryHandle,
  logger: GatewaySettlementRecoveryLogger,
): GatewaySettlementRecoveryHandle {
  let closePromise: Promise<void> | null = null;
  return {
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        try {
          await handle.close();
        } catch {
          logger.error(
            { component: COMPONENT, classification: "close_unavailable" },
            "gateway settlement recovery close unavailable",
          );
        }
      })();
      return closePromise;
    },
  };
}

export async function startGatewaySettlementRecoveryFromEnv(input: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  logger: GatewaySettlementRecoveryLogger;
  scheduler?: GatewaySettlementRecoveryScheduler;
  loadDb?: (
    databaseUrl: string,
    allowedRoutes: readonly ("chat" | "embeddings" | "completions")[],
    allowedContractVersions: readonly (1 | 2 | 3)[],
  ) => Promise<GatewaySettlementRecoveryDb>;
}>): Promise<GatewaySettlementRecoveryHandle | null> {
  const config = parseGatewaySettlementRecoveryStartupConfig(input.env);
  if (config.mode === "disabled") return null;

  let db: GatewaySettlementRecoveryDb | null = null;
  try {
    const loadDb = input.loadDb ?? loadGatewaySettlementRecoveryDb;
    db = await loadDb(
      config.databaseUrl,
      config.mode === "stored_chat_v1"
        ? ["chat"]
        : config.mode === "stored_chat_embeddings_v1"
          ? ["chat", "embeddings"]
          : ["chat", "embeddings", "completions"],
      config.mode === "stored_chat_embeddings_completions_stream_v1" ? [1, 2, 3] : [1],
    );
    const handle = startGatewaySettlementRecovery({
      db,
      scheduler: input.scheduler ?? nativeScheduler,
      onTick: (tick) => logTick(input.logger, tick),
    });
    return sanitizeClose(handle, input.logger);
  } catch {
    if (db !== null) {
      try {
        await db.close();
      } catch {
        // The fixed startup boundary discards both setup and cleanup diagnostics.
      }
    }
    throw startupRefused();
  }
}

export function logGatewaySettlementRecoveryBoundaryFailure(
  logger: Pick<GatewaySettlementRecoveryLogger, "fatal">,
  error: unknown,
): boolean {
  if (!(error instanceof GatewaySettlementRecoveryBoundaryError)) return false;
  logger.fatal(
    { component: COMPONENT, classification: "startup_refused" },
    STARTUP_MESSAGE,
  );
  return true;
}
