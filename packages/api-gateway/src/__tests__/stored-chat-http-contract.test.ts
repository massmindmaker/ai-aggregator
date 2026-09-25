import { describe, expect, it } from "vitest";
import type { HttpResultV2 } from "../billing/http-terminal-recovery";
import {
  REQUEST_BODY_LIMIT_BYTES,
  STORED_CHAT_PRE_DISPATCH_WINDOW_MS,
  StoredChatHttpContractError,
  captureStoredChatHttpRequest,
  fixedStoredChatHttpError,
  projectStoredChatHttpResult,
} from "../billing/stored-chat-http-contract";

const billingRequestId = "00000000-0000-4000-8000-000000000001";
const requestBody = (patch: Record<string, unknown> = {}) => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "private prompt" }],
  ...patch,
});
const request = (body: unknown, init: RequestInit = {}) => {
  const { headers, ...rest } = init;
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    ...rest,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": "key.Original:1",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
};

function chunkedRequest(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "key.Original:1",
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

async function expectContractError(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  await expect(promise).rejects.toMatchObject({ status, code });
}

function ready(
  actualCostCredits: bigint,
): Extract<HttpResultV2, { status: "ready" }> {
  return {
    contractVersion: 1,
    status: "ready",
    billingRequestId,
    httpStatus: 200,
    contentType: "application/json",
    response: {
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    actualCostCredits,
    storedAt: "2026-09-08T00:00:00.000000Z",
    expiresAt: "2026-09-08T00:05:00.000000Z",
  };
}

describe("stored chat HTTP contract", () => {
  it("uses the fixed 30 second pre-dispatch window", () => {
    expect(STORED_CHAT_PRE_DISPATCH_WINDOW_MS).toBe(30_000);
  });

  it("bounds raw bodies before JSON parsing when Content-Length is forged", async () => {
    const body = '{"messages":"' + "x".repeat(REQUEST_BODY_LIMIT_BYTES) + '"}';
    const oversized = request(body, { headers: { "content-length": "1" } });

    await expectContractError(
      captureStoredChatHttpRequest(oversized),
      413,
      "REQUEST_BODY_TOO_LARGE",
    );
  });

  it("bounds chunked raw bodies before JSON parsing", async () => {
    const oversized = chunkedRequest([
      '{"messages":"',
      "x".repeat(REQUEST_BODY_LIMIT_BYTES),
      '"}',
    ]);

    await expectContractError(
      captureStoredChatHttpRequest(oversized),
      413,
      "REQUEST_BODY_TOO_LARGE",
    );
  });

  it("requires JSON content before B2 capture", async () => {
    await expectContractError(
      captureStoredChatHttpRequest(
        request(requestBody(), { headers: { "content-type": "text/plain" } }),
      ),
      415,
      "UNSUPPORTED_CONTENT_TYPE",
    );
  });

  it("preserves B2 distinctions and accepts an omitted SID", async () => {
    const absent = await captureStoredChatHttpRequest(request(requestBody()));
    const explicitAuto = await captureStoredChatHttpRequest(
      request(requestBody({ aiag_mode: "auto" })),
    );
    const withSid = await captureStoredChatHttpRequest(
      request(requestBody(), { headers: { "x-aiag-session-id": "SID.1" } }),
    );

    expect(absent.identity.requestedMode).toBeNull();
    expect(explicitAuto.identity.requestedMode).toBe("auto");
    expect(explicitAuto.identity.requestFingerprint).not.toBe(
      absent.identity.requestFingerprint,
    );
    expect(withSid.identity.declaredSessionId).toBe("SID.1");
    expect(Object.isFrozen(absent)).toBe(true);
  });


  it("captures strict BYOK header as contract v3 without exposing the secret", async () => {
    const secret = "sk-caller-BYOK-123";
    const captured = await captureStoredChatHttpRequest(
      request(requestBody(), { headers: { "x-upstream-key": secret } }),
    );
    expect(captured.identity).toMatchObject({
      contractVersion: 3,
      routeKind: "chat",
      billingMode: "byok_fee",
    });
    expect(JSON.stringify(captured)).not.toContain(secret);
  });

  it("classifies malformed JSON, key, and SID as B2 bad requests", async () => {
    await expectContractError(
      captureStoredChatHttpRequest(request("{")),
      400,
      "INVALID_STORED_CHAT_HTTP_IDENTITY",
    );
    await expectContractError(
      captureStoredChatHttpRequest(
        request(requestBody(), { headers: { "idempotency-key": "" } }),
      ),
      400,
      "INVALID_STORED_CHAT_HTTP_IDENTITY",
    );
    await expectContractError(
      captureStoredChatHttpRequest(
        request(requestBody(), { headers: { "x-aiag-session-id": "" } }),
      ),
      400,
      "INVALID_STORED_CHAT_HTTP_IDENTITY",
    );
  });

  it("keeps unknown fields as B2 errors but classifies explicit unsupported features", async () => {
    await expectContractError(
      captureStoredChatHttpRequest(request(requestBody({ unknown: true }))),
      400,
      "INVALID_STORED_CHAT_HTTP_IDENTITY",
    );
    const stream = await captureStoredChatHttpRequest(request(requestBody({ stream: true })));
    expect(stream.identity.contractVersion).toBe(2);
    expect(stream.identity.attemptBody.stream).toBe(true);
    await expectContractError(
      captureStoredChatHttpRequest(request(requestBody({ tools: [] }))),
      501,
      "UNSUPPORTED_EXECUTION_CONTRACT",
    );
  });

  it("projects a durable ready result with exact receipt headers above 2^53", () => {
    const result = ready(10_014_900_000_000_000n);
    const descriptor = projectStoredChatHttpResult(result);

    expect(descriptor).toMatchObject({ status: 200, body: result.response });
    expect(descriptor.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "x-aiag-billing-request-id": billingRequestId,
      "x-aiag-receipt-version": "1",
      "x-aiag-charged-microcredits": "10014900000000000",
      "x-aiag-charge-state": "settled",
      "x-aiag-charged-usd-micro": "100149000000000000",
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("keeps a zero durable charge exact", () => {
    const descriptor = projectStoredChatHttpResult(ready(0n));
    expect(descriptor.headers["x-aiag-charged-microcredits"]).toBe("0");
    expect(descriptor.headers["x-aiag-charged-usd-micro"]).toBe("0");
  });

  it("returns a rejected row unchanged without charge headers", () => {
    const rejected: HttpResultV2 = {
      contractVersion: 1,
      status: "rejected",
      billingRequestId,
      code: "PAYMENT_REQUIRED",
      httpStatus: 402,
      contentType: "application/json",
      response: {
        error: {
          code: "PAYMENT_REQUIRED",
          message: "Payment required",
          type: "billing_error",
        },
      },
      storedAt: "2026-09-08T00:00:00.000000Z",
    };
    const descriptor = projectStoredChatHttpResult(rejected);

    expect(descriptor).toMatchObject({ status: 402, body: rejected.response });
    expect(descriptor.headers["x-aiag-billing-request-id"]).toBe(
      billingRequestId,
    );
    expect(descriptor.headers).not.toHaveProperty(
      "x-aiag-charged-microcredits",
    );
    expect(descriptor.headers).not.toHaveProperty("x-aiag-charged-usd-micro");
  });

  it.each([
    ["pending", 202, "REQUEST_PENDING"],
    ["unavailable", 409, "REQUEST_RESULT_UNAVAILABLE"],
    ["expired", 410, "REQUEST_RESULT_EXPIRED"],
  ] as const)(
    "maps durable %s without charge headers",
    (status, expectedStatus, code) => {
      const result: HttpResultV2 =
        status === "expired"
          ? {
              contractVersion: 1,
              status,
              billingRequestId,
              storedAt: "2026-09-08T00:00:00.000000Z",
              expiresAt: "2026-09-08T00:05:00.000000Z",
            }
          : { contractVersion: 1, status, billingRequestId };
      const descriptor = projectStoredChatHttpResult(result);

      expect(descriptor.status).toBe(expectedStatus);
      expect(descriptor.body).toMatchObject({ error: { code } });
      expect(descriptor.headers["x-aiag-billing-request-id"]).toBe(
        billingRequestId,
      );
      expect(descriptor.headers).not.toHaveProperty(
        "x-aiag-charged-microcredits",
      );
    },
  );

  it("uses fixed errors without reflecting arbitrary causes", () => {
    const descriptor = fixedStoredChatHttpError("request_state_unavailable");

    expect(descriptor).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "REQUEST_STATE_UNAVAILABLE",
          message: "Request state unavailable",
          type: "server_error",
        },
      },
      headers: { "retry-after": "2", "cache-control": "private, no-store" },
    });
    expect(descriptor.headers).not.toHaveProperty("x-aiag-billing-request-id");
    expect(StoredChatHttpContractError).toBeTypeOf("function");
  });

  it.each([
    ["model_not_allowed", 403, "MODEL_NOT_ALLOWED"],
    ["pii_transborder_blocked", 403, "PII_TRANSBORDER_BLOCKED"],
    ["key_policy_unavailable", 503, "KEY_POLICY_UNAVAILABLE"],
    ["model_unavailable", 503, "MODEL_UNAVAILABLE"],
    ["invalid_stored_chat_request", 400, "INVALID_STORED_CHAT_REQUEST"],
    ["stored_chat_unavailable", 503, "STORED_CHAT_UNAVAILABLE"],
    ["authentication_required", 401, "AUTHENTICATION_REQUIRED"],
    ["request_conflict", 409, "REQUEST_CONFLICT"],
  ] as const)(
    "maps fixed %s errors without a durable billing identifier",
    (kind, status, code) => {
      const descriptor = fixedStoredChatHttpError(kind);

      expect(descriptor.status).toBe(status);
      expect(descriptor.body).toMatchObject({ error: { code } });
      expect(descriptor.headers).not.toHaveProperty(
        "x-aiag-billing-request-id",
      );
    },
  );
});
