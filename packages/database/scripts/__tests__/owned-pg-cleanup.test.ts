import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOwnedPgClient } from "../owned-pg-cleanup";
afterEach(() => vi.useRealTimers());
describe("bounded cleanup of an owned local PostgreSQL connection", () => {
  it("closes normally without destroying a healthy socket", async () => {
    const c = {
      end: vi.fn().mockResolvedValue(undefined),
      connection: { stream: { destroy: vi.fn() } },
    };
    expect(await closeOwnedPgClient(c)).toBe(true);
    expect(c.end).toHaveBeenCalledTimes(1);
    expect(c.connection.stream.destroy).not.toHaveBeenCalled();
  });
  it("destroys only the owned socket if graceful close rejects", async () => {
    const c = {
      end: vi.fn().mockRejectedValue(Error("private detail")),
      connection: { stream: { destroy: vi.fn() } },
    };
    expect(await closeOwnedPgClient(c)).toBe(false);
    expect(c.connection.stream.destroy).toHaveBeenCalledTimes(1);
  });
  it("bounds hung close and consumes a late rejection without further cleanup calls", async () => {
    vi.useFakeTimers();
    let reject: (e: Error) => void = () => {};
    const c = {
      end: vi.fn(
        () =>
          new Promise<void>((_, r) => {
            reject = r;
          }),
      ),
      connection: { stream: { destroy: vi.fn() } },
    };
    const done = closeOwnedPgClient(c);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done).toBe(false);
    expect(c.connection.stream.destroy).toHaveBeenCalledTimes(1);
    reject(Error("late close"));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.connection.stream.destroy).toHaveBeenCalledTimes(1);
  });
  it("reports cleanup uncertainty even if destroy throws or a socket is unavailable", async () => {
    expect(
      await closeOwnedPgClient({
        end: async () => {
          throw Error();
        },
      }),
    ).toBe(false);
    expect(
      await closeOwnedPgClient({
        end: async () => {
          throw Error();
        },
        connection: {
          stream: {
            destroy: () => {
              throw Error();
            },
          },
        },
      }),
    ).toBe(false);
  });
  it("handles synchronous close errors through the same force-close path", async () => {
    const c = {
      end: () => {
        throw Error("sync");
      },
      connection: { stream: { destroy: vi.fn() } },
    };
    expect(await closeOwnedPgClient(c)).toBe(false);
    expect(c.connection.stream.destroy).toHaveBeenCalledTimes(1);
  });
});
