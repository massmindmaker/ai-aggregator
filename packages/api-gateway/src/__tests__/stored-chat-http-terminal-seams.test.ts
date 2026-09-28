import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoredChatAttempt,
  type StoredChatAttemptDependencies,
  type StoredChatAttemptArgs,
} from "../billing/stored-chat-attempt";
import {
  AdmissionDeadlineExpiredError,
  AdmissionUnavailableError,
} from "../billing/admission";
import { errors } from "../lib/errors";
import type {
  AdmittedChatMechanics,
  AdmittedChatRequest,
} from "../upstreams/interface";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-09-08T00:00:00.000000Z";
function args(): StoredChatAttemptArgs {
  return {
    orgId: uuid(1),
    apiKeyId: uuid(2),
    clientRequestId: "trace",
    declaredSessionId: "Original.SID",
    preDispatchDeadlineAt: time,
    cachingDiscount: "0.5",
    model: {
      slug: "openai/gpt-4o-mini",
      type: "chat",
      candidates: [
        {
          id: "openrouter",
          upstream_id: "openrouter",
          upstream_model_id: "openai/gpt-4o-mini",
          provider: "openai",
          price_per_1k_input: 1,
          price_per_1k_output: 1,
          markup: 999,
          latency_p50_ms: 1,
          uptime: 1,
          ru_residency: false,
          billing: {
            modelUpstreamId: uuid(3),
            prices: {
              inputCentsPer1k: "0.123456789012345678",
              outputCentsPer1k: "0.5",
              markup: "1.25",
            },
          },
        },
      ],
    },
    requestedMode: "fastest",
    policy: {},
    body: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "private prompt" }],
    },
    defaultMaxOutputTokens: 4096,
  };
}
function completion() {
  return {
    response: {
      id: "gen-1",
      object: "chat.completion" as const,
      created: 1,
      model: "reported/alias",
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: "private answer" },
          finish_reason: "stop" as const,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 50,
    },
  };
}
function fixture() {
  let id = 10;
  const order: string[] = [];
  const output = completion();
  const execute = vi.fn(async (_request: AdmittedChatRequest) => {
    order.push("execute");
    return output;
  });
  const mechanics: AdmittedChatMechanics = {
    contract: "openrouter-pinned-provider-chat-v1",
    execute,
  };
  const legacy = vi.fn(async () => {
    throw Error("legacy forbidden");
  });
  const adapter = { admittedChat: mechanics, chat: legacy };
  const deps = {
    newUuid: vi.fn(() => uuid(id++)),
    getAdapter: vi.fn(() => adapter),
    admitGatewayChargeV2: vi.fn<
      (...args: Parameters<StoredChatAttemptDependencies["admitGatewayChargeV2"]>) => ReturnType<StoredChatAttemptDependencies["admitGatewayChargeV2"]>
    >(async (a) => {
      order.push("admit");
      return Object.freeze({
        ...a,
        state: "held",
        didTransition: true,
        heldSubscriptionCredits: 0n,
        heldPaygCredits: a.authorizedMaxCredits,
        capturedSubscriptionExpiresAt: null,
        attemptId: null,
        upstreamId: null,
        pricingSnapshot: null,
        actualCostCredits: null,
        usageSnapshot: null,
        outcomeKind: null,
        createdAt: time,
        dispatchedAt: null,
        outcomeRecordedAt: null,
        settledAt: null,
        cancelledAt: null,
        reconcileAfter: null,
        releasedSubscriptionCredits: 0n,
        releasedPaygCredits: 0n,
        debtRepaidCredits: 0n,
        expiredSubscriptionCredits: 0n,
      });
    }),
    markGatewayChargeDispatched: vi.fn<
      (...args: Parameters<StoredChatAttemptDependencies["markGatewayChargeDispatched"]>) => ReturnType<StoredChatAttemptDependencies["markGatewayChargeDispatched"]>
    >(async (a) => {
      order.push("dispatch");
      return {
        kind: "dispatch_granted",
        admission: Object.freeze({
          ...a.admission,
          state: "dispatched",
          didTransition: true,
          attemptId: a.attemptId,
          upstreamId: a.upstreamId,
          pricingSnapshot: a.pricingSnapshot,
          dispatchedAt: time,
        }),
      };
    }),
    recordGatewayChargeOutcomeV2: vi.fn<
      (...args: Parameters<StoredChatAttemptDependencies["recordGatewayChargeOutcomeV2"]>) => ReturnType<StoredChatAttemptDependencies["recordGatewayChargeOutcomeV2"]>
    >(async (a) => {
      order.push("outcome");
      return Object.freeze({
        ...a.admission,
        state: "outcome_recorded",
        didTransition: true,
        actualCostCredits: a.actualCostCredits,
        outcomeKind: a.outcomeKind,
        usageSnapshot: a.usageSnapshot,
        outcomeRecordedAt: time,
      });
    }),
    settleAdmittedGatewayCharge: vi.fn<
      (...args: Parameters<StoredChatAttemptDependencies["settleAdmittedGatewayCharge"]>) => ReturnType<StoredChatAttemptDependencies["settleAdmittedGatewayCharge"]>
    >(async (a) => {
      order.push("settle");
      return Object.freeze({
        ...a.admission,
        state: "settled",
        didTransition: true,
        settledAt: time,
      });
    }),
    cancelUndispatchedGatewayCharge: vi.fn<
      (...args: Parameters<
        StoredChatAttemptDependencies["cancelUndispatchedGatewayCharge"]
      >) => ReturnType<
        StoredChatAttemptDependencies["cancelUndispatchedGatewayCharge"]
      >
    >(async (a) => {
      order.push("cancel");
      return Object.freeze({
        ...a.admission,
        state: "cancelled",
        didTransition: true,
        cancelledAt: time,
      });
    }),
  };
  const input = args();
  const ready = () => {
    const result = createStoredChatAttempt(input, deps);
    if (result.status !== "ready") throw Error(result.status);
    return result;
  };
  return {
    input,
    deps,
    order,
    output,
    execute,
    mechanics,
    adapter,
    legacy,
    ready,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("HTTP terminal executor seams", () => {
  it.each([
    [undefined, "chat"],
    ["completions", "completions"],
  ] as const)("binds trusted admission route %s as %s", async (configured, expected) => {
    const f = fixture();
    const h = createStoredChatAttempt(f.input, {
      ...f.deps,
      ...(configured === undefined ? {} : { admissionRouteKind: configured }),
    });
    if (h.status !== "ready") throw Error(h.status);
    expect((await h.run()).kind).toBe("settled_success");
    expect(f.deps.admitGatewayChargeV2.mock.calls[0]![0].routeKind).toBe(expected);
  });

  it("never dispatches when the durable ACK route differs from the trusted route", async () => {
    const f = fixture();
    const original = f.deps.admitGatewayChargeV2.getMockImplementation()!;
    const h = createStoredChatAttempt(f.input, {
      ...f.deps,
      admissionRouteKind: "completions",
      admitAttempt: async (a) => ({
        kind: "admitted" as const,
        admission: { ...(await original(a)), routeKind: "chat" },
      }),
    });
    if (h.status !== "ready") throw Error(h.status);
    expect(await h.run()).toMatchObject({ kind: "reconciliation_required", stage: "admit" });
    expect(f.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("uses the custom admission as sole writer and never executes on terminal reject", async () => {
    const f = fixture();
    const admitAttempt = vi.fn(async (a: { billingRequestId: string }) => ({
      kind: "rejected" as const,
      billingRequestId: a.billingRequestId,
      code: "QUOTA_EXCEEDED" as const,
    }));
    const handle = createStoredChatAttempt(f.input, {
      ...f.deps,
      admitAttempt,
    } as Partial<StoredChatAttemptDependencies>);
    if (handle.status !== "ready") throw Error(handle.status);
    expect(await handle.run()).toEqual({
      kind: "rejected",
      billingRequestId: handle.billingRequestId,
      code: "QUOTA_EXCEEDED",
    });
    expect(admitAttempt).toHaveBeenCalledTimes(1);
    expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("durably closes only a synchronously known pre-admit abort", async () => {
    const f = fixture(),
      controller = new AbortController();
    f.input.signal = controller.signal;
    const rejectUnstarted = vi.fn(async (a: { billingRequestId: string }) => ({
      kind: "rejected" as const,
      billingRequestId: a.billingRequestId,
      code: "REQUEST_NOT_STARTED" as const,
    }));
    const handle = createStoredChatAttempt(f.input, {
      ...f.deps,
      rejectUnstarted,
    } as Partial<StoredChatAttemptDependencies>);
    if (handle.status !== "ready") throw Error(handle.status);
    controller.abort();
    expect(await handle.run()).toEqual({
      kind: "rejected",
      billingRequestId: handle.billingRequestId,
      code: "REQUEST_NOT_STARTED",
    });
    expect(rejectUnstarted).toHaveBeenCalledTimes(1);
    expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    new AdmissionUnavailableError(),
    new AdmissionDeadlineExpiredError(),
    errors.paymentRequired(),
  ])(
    "never classifies a thrown custom-writer error as durable rejection",
    async (error) => {
      const f = fixture(),
        rejectUnstarted = vi.fn(),
        admitAttempt = vi.fn(async () => {
          throw error;
        });
      const h = createStoredChatAttempt(f.input, {
        ...f.deps,
        admitAttempt,
        rejectUnstarted,
      });
      if (h.status !== "ready") throw Error(h.status);
      expect(await h.run()).toMatchObject({
        kind: "reconciliation_required",
        stage: "admit",
        lastConfirmedState: null,
      });
      expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
      expect(rejectUnstarted).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    { kind: "rejected", billingRequestId: uuid(999), code: "PAYMENT_REQUIRED" },
    { kind: "rejected", billingRequestId: uuid(10), code: "UNKNOWN" },
    { kind: "unknown" },
  ])("rejects unconfirmed custom writer result", async (result) => {
    const f = fixture();
    const h = createStoredChatAttempt(f.input, {
      ...f.deps,
      admitAttempt: async () => result,
    } as unknown as StoredChatAttemptDependencies);
    if (h.status !== "ready") throw Error(h.status);
    expect(await h.run()).toMatchObject({
      kind: "reconciliation_required",
      stage: "admit",
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
  });
  it("reports pre_admit_terminal uncertainty without falling back to not_started", async () => {
    const f = fixture(),
      controller = new AbortController();
    f.input.signal = controller.signal;
    const h = createStoredChatAttempt(f.input, {
      ...f.deps,
      rejectUnstarted: async () => {
        throw Error("lost ACK");
      },
    });
    if (h.status !== "ready") throw Error(h.status);
    controller.abort();
    expect(await h.run()).toMatchObject({
      kind: "reconciliation_required",
      stage: "pre_admit_terminal",
      lastConfirmedState: null,
    });
    expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
  });
  it("captures the custom function and preserves one promise through a deferred admission", async () => {
    const f = fixture(),
      gate = deferred<void>(),
      original = f.deps.admitGatewayChargeV2.getMockImplementation()!;
    const deps = {
      ...f.deps,
      admitAttempt: vi.fn(async (a: Parameters<typeof original>[0]) => {
        await gate.promise;
        return { kind: "admitted" as const, admission: await original(a) };
      }),
    };
    const first = deps.admitAttempt,
      h = createStoredChatAttempt(f.input, deps);
    if (h.status !== "ready") throw Error(h.status);
    deps.admitAttempt = vi.fn<(...args: Parameters<typeof first>) => ReturnType<typeof first>>(async () => {
      throw Error("changed");
    });
    const promise = h.run();
    expect(h.run()).toBe(promise);
    gate.resolve();
    expect(await promise).toMatchObject({ kind: "settled_success" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(deps.admitAttempt).not.toHaveBeenCalled();
    expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["held", "dispatch"] as const)(
    "keeps post-%s abort on the existing cancel/financial path",
    async (stage) => {
      const f = fixture(),
        controller = new AbortController();
      f.input.signal = controller.signal;
      const original = f.deps.admitGatewayChargeV2.getMockImplementation()!;
      const rejectUnstarted = vi.fn();
      const admitAttempt = async (a: Parameters<typeof original>[0]) => {
        const admission = await original(a);
        if (stage === "held") controller.abort();
        return { kind: "admitted" as const, admission };
      };
      if (stage === "dispatch") {
        const dispatch =
          f.deps.markGatewayChargeDispatched.getMockImplementation()!;
        f.deps.markGatewayChargeDispatched.mockImplementation(async (a) => {
          const result = await dispatch(a);
          controller.abort();
          return result;
        });
      }
      const h = createStoredChatAttempt(f.input, {
        ...f.deps,
        admitAttempt,
        rejectUnstarted,
      });
      if (h.status !== "ready") throw Error(h.status);
      expect(await h.run()).toMatchObject({
        kind: stage === "held" ? "cancelled_no_charge" : "settled_success",
      });
      expect(rejectUnstarted).not.toHaveBeenCalled();
      expect(f.execute).toHaveBeenCalledTimes(stage === "held" ? 0 : 1);
    },
  );
});
