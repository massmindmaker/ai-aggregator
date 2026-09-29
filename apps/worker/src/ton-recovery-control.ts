/** Local deadlines bound waiting only; a lost database ACK never proves rollback. */
export const TON_LEASE_MS = 90_000 as const;
export const TON_PROVIDER_PAGE_DEADLINE_MS = 60_000;
export const TON_DB_OPERATION_DEADLINE_MS = 10_000;
export const TON_POOL_CLOSE_DEADLINE_MS = 5_000;
export const TON_CLOSE_DEADLINE_MS = 30_000;
export type TonStopReason =
  | "shutdown"
  | "lease_lost"
  | "cursor_conflict"
  | "db_operation_timeout"
  | "db_error"
  | "settlement_not_found";
export class TonRunStopped extends Error {
  constructor(readonly reason: TonStopReason) {
    super(reason);
  }
}
export type TonCloseResult =
  | { kind: "closed"; mutationOutcome: "known" | "unknown" }
  | {
      kind: "deadline_exceeded";
      phase: "active_operation" | "release" | "pool";
      mutationOutcome: "known" | "unknown";
    };

export class TonOperationBudget {
  mutationOutcome: "known" | "unknown" = "known";
  closePhase: "active_operation" | "release" | "pool" | undefined;
  constructor(readonly signal: AbortSignal) {}
  check() {
    if (this.signal.aborted) throw new TonRunStopped("shutdown");
  }
  db<T>(
    operation: () => Promise<T>,
    mutating = true,
    phase: "active_operation" | "release" = "active_operation",
  ): Promise<T> {
    if (phase !== "release") this.check();
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        if (mutating) this.mutationOutcome = "unknown";
        if (this.signal.aborted) this.closePhase ??= phase;
        reject(new TonRunStopped("db_operation_timeout"));
      }, TON_DB_OPERATION_DEADLINE_MS);
      promise.then(
        (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (mutating) this.mutationOutcome = "unknown";
          reject(new TonRunStopped("db_error"));
        },
      );
    });
  }
  provider<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ kind: "value"; value: T } | { kind: "deadline" }> {
    this.check();
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.abort();
        reject(new TonRunStopped("shutdown"));
      };
      const timer = setTimeout(() => {
        if (finished) return;
        if (this.signal.aborted) {
          aborted();
          return;
        }
        finished = true;
        cleanup();
        controller.abort();
        resolve({ kind: "deadline" });
      }, TON_PROVIDER_PAGE_DEADLINE_MS);
      this.signal.addEventListener("abort", aborted, { once: true });
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(operation(controller.signal));
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(
        (value) => {
          if (finished) return;
          if (this.signal.aborted) {
            aborted();
            return;
          }
          finished = true;
          cleanup();
          resolve({ kind: "value", value });
        },
        () => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(
            new TonRunStopped(this.signal.aborted ? "shutdown" : "db_error"),
          );
        },
      );
    });
  }
  closePool(
    close: () => Promise<
      { kind: "closed" } | { kind: "deadline_exceeded"; phase: "pool" }
    >,
  ): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (failed: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failed) this.closePhase ??= "pool";
        resolve();
      };
      const timer = setTimeout(() => finish(true), TON_POOL_CLOSE_DEADLINE_MS);
      let p: ReturnType<typeof close>;
      try {
        p = close();
      } catch {
        finish(true);
        return;
      }
      p.then(
        (value) => finish(value?.kind !== "closed"),
        () => finish(true),
      );
    });
  }
  closeResult(): TonCloseResult {
    return this.closePhase
      ? {
          kind: "deadline_exceeded",
          phase: this.closePhase,
          mutationOutcome: this.mutationOutcome,
        }
      : { kind: "closed", mutationOutcome: this.mutationOutcome };
  }
}
