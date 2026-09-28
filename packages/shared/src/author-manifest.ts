import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const submissionSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/),
    description: z.string().trim().min(10).max(4000),
    endpointUrl: z.string().min(1).max(2048),
    authToken: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\r\n]+$/),
    authHeader: z.literal("Authorization").optional(),
    hostedBy: z.enum(["platform", "author"]).optional(),
    exclusive: z.boolean().optional(),
    pricingHintPerRequestRub: z
      .number()
      .finite()
      .nonnegative()
      .nullable()
      .optional(),
    contestSubmissionId: z.string().uuid().nullable().optional(),
  })
  .strict();

export class AuthorManifestError extends Error {
  constructor(
    readonly code: "INVALID_AUTHOR_SUBMISSION" | "INVALID_AUTHOR_ENDPOINT",
  ) {
    super(code);
    this.name = "AuthorManifestError";
  }
}

function canonicalEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthorManifestError("INVALID_AUTHOR_ENDPOINT");
  }
  const hostname = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.port ||
    !hostname.includes(".") ||
    isIP(hostname) !== 0 ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname) ||
    !url.pathname.endsWith("/chat/completions")
  )
    throw new AuthorManifestError("INVALID_AUTHOR_ENDPOINT");
  return url.toString();
}

export interface AuthorManifestV1 {
  readonly schemaVersion: 1;
  readonly adapter: "openai_chat_https_v1";
  readonly model: Readonly<{
    slug: string;
    type: "chat";
    displayName: string;
    description: string;
  }>;
  readonly endpoint: Readonly<{
    url: string;
    method: "POST";
    authorization: "bearer";
  }>;
  readonly capability: "chat.completions.plaintext.v1";
  readonly requestSchema: "chat.messages.text.v1";
  readonly responseSchema: "chat.assistant.text.v1";
  readonly rights: Readonly<{
    state: "pending_verification";
    commercialUse: false;
  }>;
  readonly consentReference: null;
}

export interface ParsedAuthorSubmission {
  readonly manifest: AuthorManifestV1;
  readonly manifestJson: string;
  readonly manifestDigest: string;
  readonly authToken: string;
  readonly hostedByIntent: "platform" | "author";
  readonly exclusiveIntent: boolean;
}

/**
 * Candidate manifest only. No network request or price/rights grant occurs here.
 * Input JSON key order and whitespace never alter the server-built digest.
 */
export function parseAuthorSubmission(value: unknown): ParsedAuthorSubmission {
  const parsed = submissionSchema.safeParse(value);
  if (!parsed.success)
    throw new AuthorManifestError("INVALID_AUTHOR_SUBMISSION");
  const input = parsed.data;
  const manifest: AuthorManifestV1 = {
    schemaVersion: 1,
    adapter: "openai_chat_https_v1",
    model: {
      slug: input.slug,
      type: "chat",
      displayName: input.name,
      description: input.description,
    },
    endpoint: {
      url: canonicalEndpoint(input.endpointUrl),
      method: "POST",
      authorization: "bearer",
    },
    capability: "chat.completions.plaintext.v1",
    requestSchema: "chat.messages.text.v1",
    responseSchema: "chat.assistant.text.v1",
    rights: { state: "pending_verification", commercialUse: false },
    consentReference: null,
  };
  const manifestJson = JSON.stringify(manifest);
  return {
    manifest,
    manifestJson,
    manifestDigest:
      "sha256:" +
      createHash("sha256").update(manifestJson, "utf8").digest("hex"),
    authToken: input.authToken,
    hostedByIntent: input.hostedBy ?? "platform",
    exclusiveIntent: input.exclusive ?? false,
  };
}

const storedManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapter: z.literal("openai_chat_https_v1"),
    model: z
      .object({
        slug: z.string(),
        type: z.literal("chat"),
        displayName: z.string(),
        description: z.string(),
      })
      .strict(),
    endpoint: z
      .object({
        url: z.string(),
        method: z.literal("POST"),
        authorization: z.literal("bearer"),
      })
      .strict(),
    capability: z.literal("chat.completions.plaintext.v1"),
    requestSchema: z.literal("chat.messages.text.v1"),
    responseSchema: z.literal("chat.assistant.text.v1"),
    rights: z
      .object({
        state: z.literal("pending_verification"),
        commercialUse: z.literal(false),
      })
      .strict(),
    consentReference: z.null(),
  })
  .strict();

/** Rebuild canonical key order after JSONB serialization; never trust a stored digest alone. */
export function parseStoredAuthorManifest(
  value: unknown,
  expectedDigest: string,
): AuthorManifestV1 {
  const parsed = storedManifestSchema.safeParse(value);
  if (!parsed.success)
    throw new AuthorManifestError("INVALID_AUTHOR_SUBMISSION");
  const v = parsed.data;
  const canonical = parseAuthorSubmission({
    name: v.model.displayName,
    slug: v.model.slug,
    description: v.model.description,
    endpointUrl: v.endpoint.url,
    authToken: "manifest-validation-only",
  });
  if (
    canonical.manifestDigest !== expectedDigest ||
    JSON.stringify(v) !== canonical.manifestJson
  )
    throw new AuthorManifestError("INVALID_AUTHOR_SUBMISSION");
  return canonical.manifest;
}
