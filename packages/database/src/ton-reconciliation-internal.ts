/** Server-only TON recovery database boundary. No provider or runtime wiring. */
import { Pool } from "pg";
import type { PoolClient } from "pg";

import type {
  CloseableTonWorkerDatabase,
  TonDatabaseCloseResult,
  TonPaymentDatabase,
  TonSqlClient,
} from "./ton-payment-types";

export type {
  CloseableTonWorkerDatabase,
  TonDatabaseCloseResult,
  TonObservationInput,
  TonObservationResult,
  TonObservedReason,
  TonProviderCursor,
  TonRecipientBinding,
  TonReconciliationSource,
  TonReviewReason,
  TonSettlementObservationReason,
  TonSourceErrorCode,
  TonSweepCursor,
} from "./ton-payment-types";

export {
  settleTonInvoice,
  advanceTonReconciliationCursor,
  bindTonReconciliationRecipient,
  claimTonReconciliationLease,
  findTonInvoicesForReconciliation,
  getTonInvoiceForReconciliation,
  listTonReconciliationSources,
  recordTonChainObservation,
  releaseTonReconciliationLease,
  renewTonReconciliationLease,
} from "./ton-payments";

export const TON_DB_CONNECT_TIMEOUT_MS = 5_000;
export const TON_DB_LOCK_TIMEOUT_MS = 5_000;
export const TON_DB_STATEMENT_TIMEOUT_MS = 8_000;
export const TON_DB_QUERY_TIMEOUT_MS = 9_000;
export const TON_DB_OPERATION_DEADLINE_MS = 10_000;
export const TON_POOL_CLOSE_DEADLINE_MS = 5_000;

const FORBIDDEN_CONNECTION_SETTINGS = new Set([
  "connect_timeout",
  "statement_timeout",
  "query_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "options",
]);

function validateConnectionString(connectionString: string): void {
  if (
    typeof connectionString !== "string" ||
    connectionString.length === 0 ||
    connectionString.trim() !== connectionString
  )
    throw new Error("TON_DATABASE_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("TON_DATABASE_URL_INVALID");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    throw new Error("TON_DATABASE_URL_INVALID");
  for (const key of parsed.searchParams.keys()) {
    if (FORBIDDEN_CONNECTION_SETTINGS.has(key.toLowerCase()))
      throw new Error("TON_DATABASE_URL_OWNED_SETTING");
  }
}

function operationDeadlineError(): Error {
  return new Error("TON_DB_OPERATION_DEADLINE_EXCEEDED");
}

function queryClient(client: PoolClient, isActive: () => boolean): TonSqlClient {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      config: { text: string; values: readonly unknown[] },
    ) {
      if (!isActive()) throw operationDeadlineError();
      const result = await client.query<Row>({
        text: config.text,
        values: [...config.values],
      });
      if (!isActive()) throw operationDeadlineError();
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

class NativeTonWorkerDatabase implements CloseableTonWorkerDatabase {
  private closePromise: Promise<TonDatabaseCloseResult> | undefined;

  constructor(private readonly pool: Pool) {}

  transaction<T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    let transactionStarted = false;
    let deadlineExceeded = false;
    let released = false;
    let rollbackPromise: Promise<void> | undefined;

    const releaseOnce = (destroy = false): void => {
      if (!client || released) return;
      released = true;
      client.release(destroy || undefined);
    };

    const rollbackOnce = (): Promise<void> => {
      if (!client || !transactionStarted) return Promise.resolve();
      rollbackPromise ??= client
        .query({ text: "ROLLBACK", values: [] })
        .then(() => {
          transactionStarted = false;
        });
      return rollbackPromise;
    };

    const operation = (async () => {
      client = await this.pool.connect();
      try {
        if (deadlineExceeded) throw operationDeadlineError();
        await client.query({ text: "BEGIN", values: [] });
        transactionStarted = true;
        if (deadlineExceeded) {
          await rollbackOnce();
          throw operationDeadlineError();
        }
        const result = await run(
          queryClient(client, () => !deadlineExceeded && !released),
        );
        if (deadlineExceeded) {
          await rollbackOnce();
          throw operationDeadlineError();
        }
        await client.query({ text: "COMMIT", values: [] });
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted && !deadlineExceeded) {
          try {
            await rollbackOnce();
          } catch {
            // The original failure or outer deadline remains authoritative.
          }
        }
        throw deadlineExceeded ? operationDeadlineError() : error;
      } finally {
        releaseOnce(deadlineExceeded);
      }
    })();

    operation.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        deadlineExceeded = true;
        if (client && transactionStarted) void rollbackOnce().catch(() => {});
        releaseOnce(true);
        reject(operationDeadlineError());
      }, TON_DB_OPERATION_DEADLINE_MS);
      operation.then(
        (value) => {
          clearTimeout(timer);
          if (!deadlineExceeded) resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!deadlineExceeded) reject(error);
        },
      );
    });
  }

  close(): Promise<TonDatabaseCloseResult> {
    this.closePromise ??= (() => {
      const close = this.pool.end();
      close.catch(() => {});
      return new Promise<TonDatabaseCloseResult>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ kind: "deadline_exceeded", phase: "pool" }),
          TON_POOL_CLOSE_DEADLINE_MS,
        );
        close.then(
          () => {
            clearTimeout(timer);
            resolve({ kind: "closed" });
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    })();
    return this.closePromise;
  }
}

export function createTonWorkerDatabase(
  connectionString: string,
): CloseableTonWorkerDatabase {
  validateConnectionString(connectionString);
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: TON_DB_CONNECT_TIMEOUT_MS,
    statement_timeout: TON_DB_STATEMENT_TIMEOUT_MS,
    query_timeout: TON_DB_QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: TON_DB_OPERATION_DEADLINE_MS,
    options: `-c lock_timeout=${TON_DB_LOCK_TIMEOUT_MS}`,
  });
  return new NativeTonWorkerDatabase(pool);
}

export type { TonPaymentDatabase };
