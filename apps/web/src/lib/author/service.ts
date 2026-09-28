import { createHash, randomUUID } from "node:crypto";
import { db, sql } from "@/lib/db";
import {
  AuthorProbeError,
  authorProbeRequest,
  parseStoredAuthorManifest,
  parseAuthorSubmission,
  probeAuthorEndpoint,
} from "@aiag/shared/server";
import {
  decryptAesGcm,
  deriveKek,
  encryptAesGcm,
} from "@aiag/upstream-adapters/byok";

type VersionRow = {
  id: string;
  model_id: string;
  author_user_id: string;
  public_manifest: unknown;
  manifest_digest: string;
  encrypted_token_envelope: Parameters<typeof decryptAesGcm>[0];
};
export type AuthorVersionScope = {
  modelId: string;
  versionId: string;
  manifestDigest: string;
  actorId: string;
};
export function authorRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] };
  if (Array.isArray(r?.rows)) return r.rows;
  throw new AuthorOperationError("AUTHOR_OPERATION_UNAVAILABLE", 503);
}
const rows = authorRows;
export class AuthorOperationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = "AuthorOperationError";
  }
}
export function authorOperationError(error: unknown): {
  code: string;
  status: number;
} {
  if (error instanceof AuthorOperationError)
    return { code: error.code, status: error.status };
  const value = error as { message?: unknown; cause?: { message?: unknown } };
  const message = String(value?.cause?.message ?? value?.message ?? "");
  const known = [
    "AUTHOR_ADMIN_REQUIRED",
    "AUTHOR_OWNER_REQUIRED",
    "AUTHOR_INDEPENDENT_REVIEW_REQUIRED",
    "AUTHOR_VERSION_CONFLICT",
    "AUTHOR_PROBE_CONFLICT",
    "AUTHOR_POLICY_CONFLICT",
    "AUTHOR_APPROVAL_NOT_READY",
    "AUTHOR_POLICY_INVALID",
    "AUTHOR_PAYOUT_BALANCE",
    "AUTHOR_PAYOUT_CONFLICT",
    "AUTHOR_PAYOUT_INVALID",
    "AUTHOR_REFUND_NOT_READY",
    "AUTHOR_REQUEST_CONFLICT",
    "AUTHOR_RECONCILIATION_INVALID",
    "AUTHOR_RECONCILIATION_CONFLICT",
    "AUTHOR_RECONCILIATION_NOT_DUE",
    "AUTHOR_PROBE_REVIEW_REQUIRED",
  ];
  const code = known.find((c) => message === c);
  return code
    ? { code, status: code.endsWith("_REQUIRED") ? 403 : 409 }
    : { code: "AUTHOR_OPERATION_UNAVAILABLE", status: 503 };
}
export async function probeAuthorVersion(
  scope: AuthorVersionScope,
  probe: typeof probeAuthorEndpoint = probeAuthorEndpoint,
) {
  const row = rows<VersionRow>(
    await db.execute(sql`SELECT id::text,model_id::text,author_user_id::text,public_manifest,manifest_digest,encrypted_token_envelope
   FROM author_model_versions WHERE id=${scope.versionId}::uuid AND model_id=${scope.modelId}::uuid`),
  )[0];
  if (!row || row.manifest_digest !== scope.manifestDigest)
    throw new AuthorOperationError("AUTHOR_VERSION_CONFLICT");
  const manifest = parseStoredAuthorManifest(
    row.public_manifest,
    row.manifest_digest,
  );
  const master = process.env.AUTHOR_ENDPOINT_KEK;
  if (!master) throw new AuthorOperationError("AUTHOR_KEY_UNAVAILABLE", 503);
  let token: string;
  try {
    token = decryptAesGcm(
      row.encrypted_token_envelope,
      deriveKek(master, "aiag:author-endpoint:" + row.author_user_id + ":v1"),
    );
  } catch {
    throw new AuthorOperationError("AUTHOR_KEY_UNAVAILABLE", 503);
  }
  const requestDigest =
    "sha256:" +
    createHash("sha256").update(authorProbeRequest(manifest)).digest("hex");
  const claimToken = randomUUID();
  const claim = rows<{ id: string; state: string; did_claim: boolean }>(
    await db.execute(
      sql`SELECT * FROM aiag_claim_author_probe(${row.id}::uuid,${row.manifest_digest},${scope.actorId}::uuid,${requestDigest},${claimToken}::uuid)`,
    ),
  )[0];
  if (!claim)
    throw new AuthorOperationError("AUTHOR_OPERATION_UNAVAILABLE", 503);
  if (!claim.did_claim) return { operationId: claim.id, state: claim.state };
  let state = "succeeded",
    responseDigest: string | null = null,
    errorCode: string | null = null;
  try {
    responseDigest = (await probe(manifest, token)).responseDigest;
  } catch (error) {
    errorCode =
      error instanceof AuthorProbeError ? error.code : "ENDPOINT_UNAVAILABLE";
    state = errorCode === "ENDPOINT_UNAVAILABLE" ? "unknown" : "failed";
  }
  // A lost completion ACK never permits another POST. Read/recovery sees the owned operation.
  try {
    const result = rows<{ id: string; state: string }>(
      await db.execute(
        sql`SELECT * FROM aiag_complete_author_probe(${claim.id}::uuid,${claimToken}::uuid,${state},${responseDigest},${errorCode})`,
      ),
    )[0];
    return { operationId: claim.id, state: result?.state ?? "unknown" };
  } catch {
    return { operationId: claim.id, state: "unknown" };
  }
}

export async function assertAuthorVersionScope(scope: AuthorVersionScope) {
  const found = rows<{ id: string }>(
    await db.execute(
      sql`SELECT id FROM author_model_versions WHERE id=${scope.versionId}::uuid AND model_id=${scope.modelId}::uuid AND manifest_digest=${scope.manifestDigest}`,
    ),
  )[0];
  if (!found) throw new AuthorOperationError("AUTHOR_VERSION_CONFLICT");
}
export async function proposeAuthorPolicy(
  scope: AuthorVersionScope,
  input: {
    priceMicrocredits: string;
    authorShareBps: number;
    rightsReference: string;
    consentReference: string;
    availabilityDelaySeconds: number;
  },
) {
  await assertAuthorVersionScope(scope);
  return rows<{ id: string; policy_digest: string }>(
    await db.execute(
      sql`SELECT * FROM aiag_propose_author_policy(${scope.versionId}::uuid,${scope.manifestDigest},${scope.actorId}::uuid,${input.priceMicrocredits}::bigint,${input.authorShareBps}::integer,${input.rightsReference},${input.consentReference},${input.availabilityDelaySeconds}::integer)`,
    ),
  )[0];
}
export async function approveAuthorVersion(
  scope: AuthorVersionScope,
  input: { policyId: string; expectedCurrentVersionId: string | null },
) {
  if (process.env.AUTHOR_CHAT_ENABLED !== "1")
    throw new AuthorOperationError("AUTHOR_RUNTIME_DISABLED", 503);
  await assertAuthorVersionScope(scope);
  return rows<{ version_id: string; policy_id: string }>(
    await db.execute(
      sql`SELECT * FROM aiag_approve_author_version(${scope.versionId}::uuid,${input.policyId}::uuid,${scope.manifestDigest},${scope.actorId}::uuid,${input.expectedCurrentVersionId}::uuid)`,
    ),
  )[0];
}
export async function acceptAuthorPolicy(
  modelId: string,
  policyId: string,
  policyDigest: string,
  actorId: string,
) {
  const exists = rows(
    await db.execute(
      sql`SELECT p.id FROM author_price_policies p JOIN author_model_versions v ON v.id=p.version_id WHERE p.id=${policyId}::uuid AND v.model_id=${modelId}::uuid AND v.author_user_id=${actorId}::uuid`,
    ),
  );
  if (!exists.length)
    throw new AuthorOperationError("AUTHOR_OWNER_REQUIRED", 403);
  return rows(
    await db.execute(
      sql`SELECT * FROM aiag_accept_author_policy(${policyId}::uuid,${policyDigest},${actorId}::uuid)`,
    ),
  )[0];
}

export async function submitAuthorVersion(
  modelId: string,
  actorId: string,
  input: {
    name: string;
    description: string;
    endpointUrl: string;
    authToken: string;
    expectedLatestVersionNo: number;
  },
) {
  const master = process.env.AUTHOR_ENDPOINT_KEK;
  if (!master) throw new AuthorOperationError("AUTHOR_KEY_UNAVAILABLE", 503);
  return db.transaction(async (tx) => {
    const model = rows<{ id: string; slug: string }>(
      await tx.execute(sql`SELECT m.id,m.slug FROM models m JOIN users u ON u.id=m.author_user_id
   WHERE m.id=${modelId}::uuid AND m.author_user_id=${actorId}::uuid AND u.is_active AND NOT u.is_banned FOR UPDATE OF m`),
    )[0];
    if (!model) throw new AuthorOperationError("AUTHOR_OWNER_REQUIRED", 403);
    const latest = rows<{ version_no: number }>(
      await tx.execute(
        sql`SELECT coalesce(max(version_no),0)::int AS version_no FROM author_model_versions WHERE model_id=${modelId}::uuid`,
      ),
    )[0];
    if (latest?.version_no !== input.expectedLatestVersionNo)
      throw new AuthorOperationError("AUTHOR_VERSION_CONFLICT");
    const candidate = parseAuthorSubmission({
      name: input.name,
      description: input.description,
      slug: model.slug,
      endpointUrl: input.endpointUrl,
      authToken: input.authToken,
    });
    const envelope = encryptAesGcm(
      candidate.authToken,
      deriveKek(master, "aiag:author-endpoint:" + actorId + ":v1"),
    );
    const id = randomUUID(),
      versionNo = latest.version_no + 1;
    await tx.execute(sql`INSERT INTO author_model_versions(id,model_id,author_user_id,version_no,public_manifest,manifest_digest,encrypted_token_envelope,status)
   VALUES(${id}::uuid,${modelId}::uuid,${actorId}::uuid,${versionNo},${candidate.manifestJson}::jsonb,${candidate.manifestDigest},${JSON.stringify(envelope)}::jsonb,'candidate')`);
    await tx.execute(sql`INSERT INTO audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
   VALUES(${actorId}::uuid,'user','author.version.submit','model',${modelId},${JSON.stringify({ versionId: id, versionNo, manifestDigest: candidate.manifestDigest })}::jsonb)`);
    return {
      versionId: id,
      versionNo,
      manifestDigest: candidate.manifestDigest,
      state: "candidate",
    };
  });
}
export async function changeAuthorModelStatus(
  modelId: string,
  actorId: string,
  input: {
    status: "frozen" | "depublished" | "live";
    reason: string;
    expectedCurrentVersionId: string | null;
  },
) {
  if (input.status === "live" && process.env.AUTHOR_CHAT_ENABLED !== "1")
    throw new AuthorOperationError("AUTHOR_RUNTIME_DISABLED", 503);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT aiag_require_author_admin(${actorId}::uuid)`);
    const changed = rows<{ id: string }>(
      await tx.execute(sql`UPDATE models SET status=${input.status},enabled=(${input.status}='live'),
   frozen_reason=CASE WHEN ${input.status}='frozen' THEN ${input.reason} ELSE NULL END,
   depublished_reason=CASE WHEN ${input.status}='depublished' THEN ${input.reason} ELSE NULL END,updated_at=clock_timestamp()
   WHERE id=${modelId}::uuid AND author_user_id IS NOT NULL AND current_author_version_id IS NOT DISTINCT FROM ${input.expectedCurrentVersionId}::uuid
   AND (${input.status}<>'live' OR (status='frozen' AND current_author_version_id IS NOT NULL)) RETURNING id`),
    );
    if (changed.length !== 1)
      throw new AuthorOperationError("AUTHOR_VERSION_CONFLICT");
    await tx.execute(sql`INSERT INTO audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
   VALUES(${actorId}::uuid,'admin','author.model.status','model',${modelId},${JSON.stringify(input)}::jsonb)`);
    return { modelId, status: input.status };
  });
}
export function isAuthorMockMode(): boolean {
  if (
    process.env.AUTHOR_MOCK_PAYOUT_ENABLED !== "1" ||
    process.env.AIAG_TEST_DATABASE !== "1"
  )
    return false;
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return (
      url.hostname === "127.0.0.1" &&
      url.port === "15432" &&
      url.pathname === "/ai_aggregator_test" &&
      !url.search
    );
  } catch {
    return false;
  }
}
export async function requestMockAuthorPayout(
  actorId: string,
  key: string,
  input: { recipientReference: string; amountMicrocredits: string },
) {
  if (!isAuthorMockMode())
    throw new AuthorOperationError("AUTHOR_MOCK_PAYOUT_DISABLED", 503);
  const digest = createHash("sha256").update(key).digest("hex"),
    claim = randomUUID();
  const result = rows<{ id: string; state: string; did_claim: boolean }>(
    await db.execute(
      sql`SELECT * FROM aiag_claim_author_mock_payout(${actorId}::uuid,${digest},${input.recipientReference},${input.amountMicrocredits}::bigint,${claim}::uuid)`,
    ),
  )[0];
  if (!result)
    throw new AuthorOperationError("AUTHOR_OPERATION_UNAVAILABLE", 503);
  if (!result.did_claim)
    return { operationId: result.id, state: result.state, testOnly: true };
  // Deterministic simulation only. This function has no external transfer/provider call.
  try {
    const completed = rows<{ id: string; state: string }>(
      await db.execute(
        sql`SELECT * FROM aiag_complete_author_mock_payout(${result.id}::uuid,${claim}::uuid,'paid')`,
      ),
    )[0];
    return {
      operationId: result.id,
      state: completed?.state ?? "unknown",
      testOnly: true,
    };
  } catch {
    return { operationId: result.id, state: "unknown", testOnly: true };
  }
}

export async function reviewAuthorProbe(
  scope: AuthorVersionScope,
  evidenceReference: string,
) {
  await assertAuthorVersionScope(scope);
  const probe = rows<{ id: string }>(
    await db.execute(
      sql`SELECT id::text FROM author_probe_operations WHERE version_id=${scope.versionId}::uuid AND manifest_digest=${scope.manifestDigest}`,
    ),
  )[0];
  if (!probe) throw new AuthorOperationError("AUTHOR_PROBE_CONFLICT");
  return rows(
    await db.execute(
      sql`SELECT * FROM aiag_review_author_probe(${probe.id}::uuid,${scope.actorId}::uuid,${evidenceReference})`,
    ),
  )[0];
}
