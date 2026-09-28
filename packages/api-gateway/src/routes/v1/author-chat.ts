import { createHash, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { config } from "../../config";
import { sql, type SqlClient } from "../../lib/db";
import {
  executeAuthorChat,
  parseAuthorChatRequest,
  parseStoredAuthorManifest,
} from "@aiag/shared/server";
import { decryptAesGcm, deriveKek } from "@aiag/upstream-adapters/byok";
import {
  claimGatewayHttpRequest,
  recordGatewayHttpOutcome,
  HttpStorageConflictError,
  type GatewayHttpIdentity,
} from "../../billing/http-storage";
import {
  admitGatewayHttpCharge,
  readGatewayHttpResultV2,
  rejectUnstartedGatewayHttpRequest,
} from "../../billing/http-terminal-recovery";
import {
  markGatewayChargeDispatched,
  cancelUndispatchedGatewayCharge,
  settleAdmittedGatewayCharge,
} from "../../billing/admission";
import {
  fixedStoredChatHttpError,
  projectStoredChatHttpResult,
  type StoredChatHttpResponseDescriptor,
} from "../../billing/stored-chat-http-contract";
import type { StoredChatHttpIdentity } from "../../billing/stored-chat-http-identity";
import {
  normalizeStoredChatFreshPolicy,
  StoredChatFreshPolicyError,
} from "../../billing/stored-chat-fresh-policy";
import type { AuthenticatedApiKey } from "../../middleware/auth-plan04";
import type { JsonObject } from "../../billing/admission-result";
import { detectPii, extractText } from "../../lib/pii";

type VersionRow = {
  id: string | null;
  model_id: string;
  slug: string;
  author_user_id: string;
  status: string;
  enabled: boolean;
  version_status: string | null;
  public_manifest: unknown;
  manifest_digest: string;
  encrypted_token_envelope: Parameters<typeof decryptAesGcm>[0];
  policy_id: string | null;
  approved_at: unknown;
};
type BindingRow = {
  billing_request_id: string;
  author_quote: JsonObject;
  refunded: boolean;
};
type Dependencies = {
  client: SqlClient;
  enabled: boolean;
  masterKey: string | undefined;
  execute: typeof executeAuthorChat;
};
function respond(
  d: StoredChatHttpResponseDescriptor,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(d.body), {
    status: d.status,
    headers: { ...d.headers, ...headers },
  });
}
function unavailable() {
  return respond(fixedStoredChatHttpError("stored_chat_unavailable"));
}
function checkPolicy(
  key: AuthenticatedApiKey,
  identity: StoredChatHttpIdentity,
) {
  const { policy, whitelist } = normalizeStoredChatFreshPolicy(key);
  if (whitelist.length && !whitelist.includes(identity.attemptBody.model))
    throw new StoredChatFreshPolicyError("model_not_allowed");
  if (
    policy.forbid_non_ru ||
    identity.requestedMode === "ru-only" ||
    policy.default_mode === "ru-only" ||
    policy.blocked_providers?.includes("author") ||
    (policy.allowed_providers?.length &&
      !policy.allowed_providers.includes("author"))
  )
    throw new StoredChatFreshPolicyError("stored_chat_unavailable");
  // Author hosting region is not independently verified. Never infer RU residency from a URL.
  if (
    !policy.allow_pii_transborder &&
    detectPii(extractText(identity.attemptBody)).some((hit) => hit.blocking)
  )
    throw new StoredChatFreshPolicyError("pii_transborder_blocked");
}

/** This composition shares public HTTP identity, quotas, settlement and recovery with ordinary stored chat. */
export function createAuthorChatHandler(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    client: sql,
    enabled: config.AUTHOR_CHAT_ENABLED === "1",
    masterKey: process.env.AUTHOR_ENDPOINT_KEK,
    execute: executeAuthorChat,
    ...overrides,
  };
  const client = deps.client;
  return async function authorChat(
    c: Context,
    key: AuthenticatedApiKey,
    identity: StoredChatHttpIdentity,
  ): Promise<Response | null> {
    if (!deps.enabled) return null;
    const scope: GatewayHttpIdentity<"chat"> = {
      orgId: key.org_id,
      apiKeyId: key.id,
      routeKind: "chat",
      billingMode: identity.billingMode,
      contractVersion: identity.contractVersion,
      idempotencyKeyDigest: identity.idempotencyKeyDigest,
      requestFingerprint: identity.requestFingerprint,
    };
    async function binding(): Promise<BindingRow | undefined> {
      return (
        await client<
          BindingRow[]
        >`SELECT b.billing_request_id::text,b.author_quote,EXISTS(SELECT 1 FROM author_charge_refunds f WHERE f.billing_request_id=b.billing_request_id) AS refunded
    FROM gateway_http_requests r JOIN author_request_bindings b USING(billing_request_id)
    WHERE r.org_id=${key.org_id}::uuid AND r.api_key_id=${key.id}::uuid AND r.route_kind='chat' AND r.idempotency_key_digest=${identity.idempotencyKeyDigest}`
      )[0];
    }
    async function read(): Promise<Response> {
      const result = await readGatewayHttpResultV2(scope, client);
      let reconciledId: string | undefined;
      if (result.status === "unavailable") {
        const resolved = (
          await client<
            { billing_request_id: string }[]
          >`SELECT billing_request_id::text FROM aiag_read_author_no_charge(${key.org_id}::uuid,${key.id}::uuid,${scope.idempotencyKeyDigest},${scope.requestFingerprint},${scope.contractVersion}::smallint,${scope.billingMode})`
        )[0];
        reconciledId = resolved?.billing_request_id;
      }
      const captured = await binding();
      const extra: Record<string, string> = {};
      if (captured) {
        for (const [name, field] of [
          ["x-aiag-author-version-id", "versionId"],
          ["x-aiag-author-policy-id", "policyId"],
          ["x-aiag-author-manifest-digest", "manifestDigest"],
          ["x-aiag-author-policy-digest", "policyDigest"],
        ] as const) {
          const value = captured.author_quote[field];
          if (typeof value === "string") extra[name] = value;
        }
        extra["x-aiag-author-refund-state"] = captured.refunded
          ? "refunded"
          : "not_refunded";
      }
      if (reconciledId)
        return new Response(
          JSON.stringify({
            error: {
              code: "AUTHOR_NO_RESULT",
              message: "Provider outcome reconciled without a charge.",
            },
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
              "x-aiag-billing-request-id": reconciledId,
              "x-aiag-receipt-version": "author-no-charge-v1",
              "x-aiag-charged-microcredits": "0",
              "x-aiag-charge-state": "settled",
              ...extra,
            },
          },
        );
      return respond(projectStoredChatHttpResult(result), extra);
    }
    try {
      const prior = await binding();
      // Mutable listing, policy and encrypted token are never consulted to replay an admitted run.
      if (prior) return await read();
      const row = (
        await client<
          VersionRow[]
        >`SELECT v.id::text,m.id::text AS model_id,m.slug,m.author_user_id::text,m.status,m.enabled,v.status AS version_status,
     v.public_manifest,v.manifest_digest,v.encrypted_token_envelope,p.id::text AS policy_id,p.approved_at
     FROM models m LEFT JOIN author_model_versions v ON v.id=m.current_author_version_id AND v.model_id=m.id
     LEFT JOIN author_price_policies p ON p.version_id=v.id WHERE m.slug=${identity.attemptBody.model} AND m.author_user_id IS NOT NULL LIMIT 1`
      )[0];
      if (!row) return null;
      if (
        identity.contractVersion !== 1 ||
        identity.billingMode !== "stored" ||
        identity.attemptBody.stream ||
        c.req.raw.headers.has("x-upstream-key")
      )
        return respond(
          fixedStoredChatHttpError("unsupported_execution_contract"),
        );
      const existing = await readGatewayHttpResultV2(scope, client);
      if (existing.status !== "not_found") return await read();
      if (
        !row.id ||
        !row.policy_id ||
        !row.approved_at ||
        row.version_status !== "approved" ||
        !row.enabled ||
        row.status !== "live" ||
        !deps.masterKey
      )
        return unavailable();
      checkPolicy(key, identity);
      let request: ReturnType<typeof parseAuthorChatRequest>;
      try {
        request = parseAuthorChatRequest(identity.attemptBody, row.slug);
      } catch {
        return respond(fixedStoredChatHttpError("invalid_stored_chat_request"));
      }
      const manifest = parseStoredAuthorManifest(
        row.public_manifest,
        row.manifest_digest,
      );
      const token = decryptAesGcm(
        row.encrypted_token_envelope,
        deriveKek(
          deps.masterKey,
          "aiag:author-endpoint:" + row.author_user_id + ":v1",
        ),
      );
      const billingRequestId = randomUUID(),
        attemptId = randomUUID();
      const claim = await claimGatewayHttpRequest(
        { ...scope, billingRequestId },
        client,
      );
      if (!claim.didClaim) return await read();
      if (c.req.raw.signal.aborted) {
        await rejectUnstartedGatewayHttpRequest(
          { ...scope, billingRequestId },
          client,
        );
        return await read();
      }
      const pinned = (
        await client<
          { author_quote: JsonObject }[]
        >`SELECT * FROM aiag_bind_author_request(${key.org_id}::uuid,${key.id}::uuid,${billingRequestId}::uuid,${row.id}::uuid,${row.policy_id}::uuid,${scope.requestFingerprint})`
      )[0];
      if (!pinned) return unavailable();
      const quote = pinned.author_quote;
      if (
        typeof quote.priceMicrocredits !== "string" ||
        typeof quote.versionId !== "string"
      )
        return unavailable();
      const price = BigInt(quote.priceMicrocredits),
        upstreamId = "author:" + quote.versionId;
      const admitted = await admitGatewayHttpCharge(
        {
          ...scope,
          billingMode: "stored",
          billingRequestId,
          clientRequestId:
            (c.get("requestId" as never) as string | undefined) ?? null,
          modelSlug: row.slug,
          authorizedMaxCredits: price,
          quoteSnapshot: { version: 1, authorQuote: quote },
          supplierQuoteSnapshot: {
            version: 2,
            formulaVersion: "author-share-usd-micro-v1",
            authorQuote: quote,
          },
          declaredSessionId: identity.declaredSessionId,
          preDispatchDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
        },
        client,
      );
      if (admitted.kind !== "admitted" || !admitted.admission.didTransition)
        return await read();
      if (c.req.raw.signal.aborted) {
        await cancelUndispatchedGatewayCharge(
          { admission: admitted.admission },
          client,
        );
        return await read();
      }
      const dispatch = await markGatewayChargeDispatched(
        {
          admission: admitted.admission,
          attemptId,
          upstreamId,
          pricingSnapshot: quote,
        },
        client,
      );
      if (dispatch.kind !== "dispatch_granted") return await read();
      // Unknown outbound result keeps its existing durable dispatched obligation; NEVER submit again.
      const response = await deps.execute(manifest, token, request, {
        signal: c.req.raw.signal,
      });
      const usageSnapshot = {
        version: 1,
        formulaVersion: "author-fixed-microcredits-v1",
        billingRequestId,
        attemptId,
        upstreamId,
        verified: true,
        responseDigest:
          "sha256:" +
          createHash("sha256").update(JSON.stringify(response)).digest("hex"),
        completionId: response.id,
        reportedModel: response.model,
        usage: {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          cachedInputTokens: 0,
        },
      };
      const recorded = await recordGatewayHttpOutcome(
        {
          ...scope,
          admission: dispatch.admission,
          actualCostCredits: price,
          usageSnapshot,
          outcomeKind: "success",
          response,
          contractVersion: 1,
        },
        client,
      );
      await settleAdmittedGatewayCharge({ admission: recorded }, client);
      return await read();
    } catch (error) {
      if (error instanceof HttpStorageConflictError)
        return respond(fixedStoredChatHttpError("request_conflict"));
      if (error instanceof StoredChatFreshPolicyError)
        return respond(fixedStoredChatHttpError(error.kind));
      return respond(fixedStoredChatHttpError("request_state_unavailable"));
    }
  };
}
export const handleAuthorChat = createAuthorChatHandler();
