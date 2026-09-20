import { z } from "zod";

/** Public catalog v1 is browser-safe and deliberately contains no runtime adapter data. */
export const CATALOG_SCHEMA_VERSION = 1 as const;
export const CATALOG_MAX_DATA_ITEMS = 100;
export const CATALOG_MAX_CURSOR_BYTES = 1024;
export const CATALOG_MAX_TEXT_LENGTH = 128;
export const CATALOG_ACCEPTED_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

export type Sha256Revision = `sha256:${string}`;
export type Uuid = string;
export type CatalogMode =
  | "auto"
  | "fastest"
  | "cheapest"
  | "balanced"
  | "ru-only";
export type CatalogUnavailableReason =
  | "model_frozen"
  | "runtime_contract_unavailable"
  | "key_policy_excludes_model"
  | "no_admitted_deployment"
  | "service_configuration_unavailable"
  | "retail_pricing_unavailable";

export interface CatalogModelIdentityV1 {
  readonly id: Uuid;
  readonly slug: string;
  readonly type: string;
  readonly artifact: Readonly<{
    attestation: "unattested";
    version: null;
    digest: null;
  }>;
}

export interface CatalogCursorV1 {
  readonly schemaVersion: 1;
  readonly catalogRevision: Sha256Revision;
  readonly after: Readonly<{ slug: string; modelId: Uuid }>;
}

export interface CatalogInvocationV1 {
  readonly method: "POST";
  readonly path: "/v1/chat/completions";
  readonly authorization: "bearer_api_key";
  readonly contentType: "application/json";
  readonly maxBodyBytes: 262144;
  readonly requestBody: Readonly<{
    unknownFields: "reject";
    unknownMessageFields: "reject";
    unsupportedExecutionFields: readonly [
      "tools",
      "functions",
      "tool_choice",
      "modalities",
      "audio",
      "input_audio",
    ];
    multimodalMessageContent: "reject";
  }>;
  readonly headers: Readonly<{
    idempotencyKey: Readonly<{
      name: "Idempotency-Key";
      required: true;
      pattern: "^[A-Za-z0-9._:-]{1,128}$";
    }>;
    sessionId: Readonly<{
      name: "X-AIAG-Session-Id";
      required: false;
      pattern: "^[A-Za-z0-9._:-]{1,128}$";
    }>;
    upstreamKey: Readonly<{
      name: "X-Upstream-Key";
      allowed: false;
      rejection: "UNSUPPORTED_EXECUTION_CONTRACT";
    }>;
  }>;
  readonly parameters: Readonly<{
    model: Readonly<{ required: true; const: string }>;
    messages: Readonly<{
      required: true;
      minItems: 1;
      roles: readonly ["system", "user", "assistant"];
      content: "nonempty_string";
    }>;
    stream: Readonly<{
      required: false;
      const: false;
      normalizedDefault: false;
    }>;
    max_tokens: Readonly<{
      required: false;
      type: "integer";
      minimum: 1;
      acceptedMaximum: typeof CATALOG_ACCEPTED_MAX_TOKENS;
      effectiveMaximum: number;
      configuredDefault: number;
      defaultApplied: number;
      normalization: "clamp_to_effective_max";
    }>;
    aiag_mode: Readonly<{
      required: false;
      values: readonly ["auto", "fastest", "cheapest", "balanced", "ru-only"];
      availableValues: readonly CatalogMode[];
      defaultRequested: CatalogMode;
      effectiveDefault: CatalogMode;
      requiresExplicitAvailableValue: boolean;
    }>;
  }>;
}

export interface CatalogEmbeddingsInvocationV1 {
  readonly method: "POST";
  readonly path: "/v1/embeddings";
  readonly authorization: "bearer_api_key";
  readonly contentType: "application/json";
  readonly maxBodyBytes: 262144;
  readonly requestBody: Readonly<{ unknownFields: "reject" }>;
  readonly headers: CatalogInvocationV1["headers"];
  readonly parameters: Readonly<{
    model: Readonly<{ required: true; const: string }>;
    input: Readonly<{ required: true; minItems: 1; maxItems: 16; item: "nonempty_utf8_string_max_8192_bytes" }>;
    encoding_format: Readonly<{ required: false; const: "float"; normalizedDefault: "float" }>;
    dimensions: Readonly<{ required: false; const: 1536; normalizedDefault: 1536 }>;
    aiag_mode: CatalogInvocationV1["parameters"]["aiag_mode"];
  }>;
}

export interface CatalogRetailTokenPricingV1 {
  readonly revision: Sha256Revision;
  readonly currency: "USD";
  readonly settlementUnit: "microcredit";
  readonly microcreditsPerUsdCent: "1000";
  readonly rates: Readonly<{
    input: Readonly<{ amount: string; unit: "microcredit_per_token" }>;
    output: Readonly<{ amount: string; unit: "microcredit_per_token" }>;
  }>;
  readonly actualCharge: Readonly<{
    formulaVersion: "db-input-output-cents-per-1k-legacy-whole-cache-v1";
    cachePolicy: Readonly<{
      scope: "whole_input_plus_output_cost";
      multiplier: string;
      factorFormula: "prompt=0?1:((prompt-cached)+cached*multiplier)/prompt";
    }>;
    rounding: "nearest_nonnegative_half_up_once_to_microcredit";
  }>;
  readonly maximumAuthorization: Readonly<{
    formula: "input_rate*context+max(output_rate-input_rate,0)*max_output";
    rounding: "ceil_once_to_microcredit";
  }>;
  readonly quoteSemantics: "terms_only_quote_created_at_admission";
}

export interface CatalogRetailEmbeddingsPricingV1 extends Omit<CatalogRetailTokenPricingV1, "actualCharge" | "maximumAuthorization"> {
  readonly actualCharge: Readonly<{
    formulaVersion: "db-input-output-cents-per-1k-legacy-whole-cache-v1";
    cachePolicy: Readonly<{ scope: "none"; multiplier: "1" }>;
    rounding: "nearest_nonnegative_half_up_once_to_microcredit";
  }>;
  readonly maximumAuthorization: Readonly<{
    formula: "input_rate*context*input_count";
    contextWindowTokens: 8192;
    maxInputs: 16;
    rounding: "ceil_once_to_microcredit";
  }>;
}

export interface CatalogUnavailableItemV1 {
  readonly object: "catalog.model";
  readonly model: CatalogModelIdentityV1;
  readonly availability: Readonly<{
    state: "unavailable";
    scope: "advertised_contract";
    reason: CatalogUnavailableReason;
    liveUpstreamHealthChecked: false;
  }>;
  readonly deployment: null;
  readonly invocation: null;
  readonly capabilities: readonly [];
  readonly pricing: null;
}

export interface CatalogAvailableItemV1 {
  readonly object: "catalog.model";
  readonly model: CatalogModelIdentityV1;
  readonly availability: Readonly<{
    state: "available";
    scope: "advertised_contract";
    reason: null;
    liveUpstreamHealthChecked: false;
  }>;
  readonly deployment: Readonly<{
    id: Uuid;
    configurationRevision: Sha256Revision;
    contract: "stored-plaintext-chat-v1";
  }>;
  readonly invocation: CatalogInvocationV1;
  readonly capabilities: readonly [
    Readonly<{
      id: "chat.completions.stored.plaintext.v1";
      inputModalities: readonly ["text"];
      outputModalities: readonly ["text"];
      streaming: false;
      toolCalling: false;
      structuredOutput: false;
      asynchronous: false;
      storedResult: true;
      usageReceipt: true;
      requestDependentRestrictions: readonly ["pii_transborder"];
      contextWindowTokens: number;
      maxOutputTokens: number;
    }>,
  ];
  readonly pricing: CatalogRetailTokenPricingV1;
}

export interface CatalogAvailableEmbeddingsItemV1 {
  readonly object: "catalog.model";
  readonly model: CatalogModelIdentityV1;
  readonly availability: CatalogAvailableItemV1["availability"];
  readonly deployment: Readonly<{
    id: Uuid;
    configurationRevision: Sha256Revision;
    contract: "stored-embeddings-v1";
  }>;
  readonly invocation: CatalogEmbeddingsInvocationV1;
  readonly capabilities: readonly [Readonly<{
    id: "embeddings.stored.float.v1";
    inputModalities: readonly ["text"];
    outputModalities: readonly ["embedding"];
    storedResult: true;
    usageReceipt: true;
    requestDependentRestrictions: readonly ["pii_transborder"];
    contextWindowTokensPerInput: 8192;
    maxInputs: 16;
    dimensions: 1536;
    encodingFormat: "float";
  }>];
  readonly pricing: CatalogRetailEmbeddingsPricingV1;
}

export type CatalogItemV1 = CatalogUnavailableItemV1 | CatalogAvailableItemV1 | CatalogAvailableEmbeddingsItemV1;

export interface CatalogResponseV1 {
  readonly schemaVersion: 1;
  readonly object: "catalog.list";
  readonly catalogRevision: Sha256Revision;
  readonly data: readonly CatalogItemV1[];
  readonly page: Readonly<{ limit: number; nextCursor: string | null }>;
}

const sha256RevisionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .transform((value): Sha256Revision => value as Sha256Revision);
const uuidSchema = z.string().uuid();
const boundedTextSchema = z.string().min(1).max(CATALOG_MAX_TEXT_LENGTH);
const canonicalDecimalSchema = z
  .string()
  .max(CATALOG_MAX_TEXT_LENGTH)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

export const catalogModes = [
  "auto",
  "fastest",
  "cheapest",
  "balanced",
  "ru-only",
] as const;
const catalogModeSchema = z.enum(catalogModes);

export const catalogUnavailableReasons = [
  "model_frozen",
  "runtime_contract_unavailable",
  "key_policy_excludes_model",
  "no_admitted_deployment",
  "service_configuration_unavailable",
  "retail_pricing_unavailable",
] as const;
const unavailableReasonSchema = z.enum(catalogUnavailableReasons);

const modelSchema = z
  .object({
    id: uuidSchema,
    slug: boundedTextSchema,
    type: boundedTextSchema,
    artifact: z
      .object({
        attestation: z.literal("unattested"),
        version: z.null(),
        digest: z.null(),
      })
      .strict(),
  })
  .strict();

const unavailableAvailabilitySchema = z
  .object({
    state: z.literal("unavailable"),
    scope: z.literal("advertised_contract"),
    reason: unavailableReasonSchema,
    liveUpstreamHealthChecked: z.literal(false),
  })
  .strict();

const availableAvailabilitySchema = z
  .object({
    state: z.literal("available"),
    scope: z.literal("advertised_contract"),
    reason: z.null(),
    liveUpstreamHealthChecked: z.literal(false),
  })
  .strict();

const invocationSchema = z
  .object({
    method: z.literal("POST"),
    path: z.literal("/v1/chat/completions"),
    authorization: z.literal("bearer_api_key"),
    contentType: z.literal("application/json"),
    maxBodyBytes: z.literal(262144),
    requestBody: z
      .object({
        unknownFields: z.literal("reject"),
        unknownMessageFields: z.literal("reject"),
        unsupportedExecutionFields: z.tuple([
          z.literal("tools"),
          z.literal("functions"),
          z.literal("tool_choice"),
          z.literal("modalities"),
          z.literal("audio"),
          z.literal("input_audio"),
        ]),
        multimodalMessageContent: z.literal("reject"),
      })
      .strict(),
    headers: z
      .object({
        idempotencyKey: z
          .object({
            name: z.literal("Idempotency-Key"),
            required: z.literal(true),
            pattern: z.literal("^[A-Za-z0-9._:-]{1,128}$"),
          })
          .strict(),
        sessionId: z
          .object({
            name: z.literal("X-AIAG-Session-Id"),
            required: z.literal(false),
            pattern: z.literal("^[A-Za-z0-9._:-]{1,128}$"),
          })
          .strict(),
        upstreamKey: z
          .object({
            name: z.literal("X-Upstream-Key"),
            allowed: z.literal(false),
            rejection: z.literal("UNSUPPORTED_EXECUTION_CONTRACT"),
          })
          .strict(),
      })
      .strict(),
    parameters: z
      .object({
        model: z
          .object({ required: z.literal(true), const: boundedTextSchema })
          .strict(),
        messages: z
          .object({
            required: z.literal(true),
            minItems: z.literal(1),
            roles: z.tuple([
              z.literal("system"),
              z.literal("user"),
              z.literal("assistant"),
            ]),
            content: z.literal("nonempty_string"),
          })
          .strict(),
        stream: z
          .object({
            required: z.literal(false),
            const: z.literal(false),
            normalizedDefault: z.literal(false),
          })
          .strict(),
        max_tokens: z
          .object({
            required: z.literal(false),
            type: z.literal("integer"),
            minimum: z.literal(1),
            acceptedMaximum: z.literal(CATALOG_ACCEPTED_MAX_TOKENS),
            effectiveMaximum: positiveSafeIntegerSchema,
            configuredDefault: positiveSafeIntegerSchema,
            defaultApplied: positiveSafeIntegerSchema,
            normalization: z.literal("clamp_to_effective_max"),
          })
          .strict()
          .superRefine((value, context) => {
            if (
              value.defaultApplied !==
              Math.min(value.configuredDefault, value.effectiveMaximum)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "defaultApplied must be clamped to effectiveMaximum",
              });
            }
          }),
        aiag_mode: z
          .object({
            required: z.literal(false),
            values: z.tuple([
              z.literal("auto"),
              z.literal("fastest"),
              z.literal("cheapest"),
              z.literal("balanced"),
              z.literal("ru-only"),
            ]),
            availableValues: z
              .array(catalogModeSchema)
              .min(1)
              .max(catalogModes.length)
              .superRefine((value, context) => {
                if (new Set(value).size !== value.length)
                  context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "availableValues must be unique",
                  });
              }),
            defaultRequested: catalogModeSchema,
            effectiveDefault: catalogModeSchema,
            requiresExplicitAvailableValue: z.boolean(),
          })
          .strict()
          .superRefine((value, context) => {
            if (
              value.requiresExplicitAvailableValue !==
              !value.availableValues.includes(value.effectiveDefault)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  "requiresExplicitAvailableValue must match effectiveDefault",
              });
            }
          }),
      })
      .strict(),
  })
  .strict();

const capabilitySchema = z
  .object({
    id: z.literal("chat.completions.stored.plaintext.v1"),
    inputModalities: z.tuple([z.literal("text")]),
    outputModalities: z.tuple([z.literal("text")]),
    streaming: z.literal(false),
    toolCalling: z.literal(false),
    structuredOutput: z.literal(false),
    asynchronous: z.literal(false),
    storedResult: z.literal(true),
    usageReceipt: z.literal(true),
    requestDependentRestrictions: z.tuple([z.literal("pii_transborder")]),
    contextWindowTokens: positiveSafeIntegerSchema,
    maxOutputTokens: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxOutputTokens > value.contextWindowTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxOutputTokens exceeds contextWindowTokens",
      });
    }
  });

const pricingSchema = z
  .object({
    revision: sha256RevisionSchema,
    currency: z.literal("USD"),
    settlementUnit: z.literal("microcredit"),
    microcreditsPerUsdCent: z.literal("1000"),
    rates: z
      .object({
        input: z
          .object({
            amount: canonicalDecimalSchema,
            unit: z.literal("microcredit_per_token"),
          })
          .strict(),
        output: z
          .object({
            amount: canonicalDecimalSchema,
            unit: z.literal("microcredit_per_token"),
          })
          .strict(),
      })
      .strict(),
    actualCharge: z
      .object({
        formulaVersion: z.literal(
          "db-input-output-cents-per-1k-legacy-whole-cache-v1",
        ),
        cachePolicy: z
          .object({
            scope: z.literal("whole_input_plus_output_cost"),
            multiplier: canonicalDecimalSchema,
            factorFormula: z.literal(
              "prompt=0?1:((prompt-cached)+cached*multiplier)/prompt",
            ),
          })
          .strict(),
        rounding: z.literal("nearest_nonnegative_half_up_once_to_microcredit"),
      })
      .strict(),
    maximumAuthorization: z
      .object({
        formula: z.literal(
          "input_rate*context+max(output_rate-input_rate,0)*max_output",
        ),
        rounding: z.literal("ceil_once_to_microcredit"),
      })
      .strict(),
    quoteSemantics: z.literal("terms_only_quote_created_at_admission"),
  })
  .strict();

const embeddingsPricingSchema = z
  .object({
    revision: sha256RevisionSchema,
    currency: z.literal("USD"),
    settlementUnit: z.literal("microcredit"),
    microcreditsPerUsdCent: z.literal("1000"),
    rates: pricingSchema.shape.rates,
    actualCharge: z.object({
      formulaVersion: z.literal("db-input-output-cents-per-1k-legacy-whole-cache-v1"),
      cachePolicy: z.object({ scope: z.literal("none"), multiplier: z.literal("1") }).strict(),
      rounding: z.literal("nearest_nonnegative_half_up_once_to_microcredit"),
    }).strict(),
    maximumAuthorization: z.object({
      formula: z.literal("input_rate*context*input_count"),
      contextWindowTokens: z.literal(8192),
      maxInputs: z.literal(16),
      rounding: z.literal("ceil_once_to_microcredit"),
    }).strict(),
    quoteSemantics: z.literal("terms_only_quote_created_at_admission"),
  })
  .strict();

const embeddingsInvocationSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/v1/embeddings"),
  authorization: z.literal("bearer_api_key"),
  contentType: z.literal("application/json"),
  maxBodyBytes: z.literal(262144),
  requestBody: z.object({ unknownFields: z.literal("reject") }).strict(),
  headers: invocationSchema.shape.headers,
  parameters: z.object({
    model: z.object({ required: z.literal(true), const: boundedTextSchema }).strict(),
    input: z.object({
      required: z.literal(true), minItems: z.literal(1), maxItems: z.literal(16),
      item: z.literal("nonempty_utf8_string_max_8192_bytes"),
    }).strict(),
    encoding_format: z.object({ required: z.literal(false), const: z.literal("float"), normalizedDefault: z.literal("float") }).strict(),
    dimensions: z.object({ required: z.literal(false), const: z.literal(1536), normalizedDefault: z.literal(1536) }).strict(),
    aiag_mode: invocationSchema.shape.parameters.shape.aiag_mode,
  }).strict(),
}).strict();

const embeddingsCapabilitySchema = z.object({
  id: z.literal("embeddings.stored.float.v1"),
  inputModalities: z.tuple([z.literal("text")]),
  outputModalities: z.tuple([z.literal("embedding")]),
  storedResult: z.literal(true),
  usageReceipt: z.literal(true),
  requestDependentRestrictions: z.tuple([z.literal("pii_transborder")]),
  contextWindowTokensPerInput: z.literal(8192),
  maxInputs: z.literal(16),
  dimensions: z.literal(1536),
  encodingFormat: z.literal("float"),
}).strict();

const unavailableItemSchema = z
  .object({
    object: z.literal("catalog.model"),
    model: modelSchema,
    availability: unavailableAvailabilitySchema,
    deployment: z.null(),
    invocation: z.null(),
    capabilities: z.tuple([]),
    pricing: z.null(),
  })
  .strict();

const availableItemSchema = z
  .object({
    object: z.literal("catalog.model"),
    model: modelSchema,
    availability: availableAvailabilitySchema,
    deployment: z
      .object({
        id: uuidSchema,
        configurationRevision: sha256RevisionSchema,
        contract: z.literal("stored-plaintext-chat-v1"),
      })
      .strict(),
    invocation: invocationSchema,
    capabilities: z.tuple([capabilitySchema]),
    pricing: pricingSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const max = value.invocation.parameters.max_tokens.effectiveMaximum;
    const capability = value.capabilities[0];
    if (
      max !==
      Math.min(capability.contextWindowTokens, capability.maxOutputTokens)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "effectiveMaximum must match capability limits",
      });
    }
    if (value.invocation.parameters.model.const !== value.model.slug) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invocation model must match model slug",
      });
    }
  });

const availableEmbeddingsItemSchema = z.object({
  object: z.literal("catalog.model"),
  model: modelSchema,
  availability: availableAvailabilitySchema,
  deployment: z.object({
    id: uuidSchema,
    configurationRevision: sha256RevisionSchema,
    contract: z.literal("stored-embeddings-v1"),
  }).strict(),
  invocation: embeddingsInvocationSchema,
  capabilities: z.tuple([embeddingsCapabilitySchema]),
  pricing: embeddingsPricingSchema,
}).strict().superRefine((value, context) => {
  if (value.model.type !== "embedding")
    context.addIssue({ code: z.ZodIssueCode.custom, message: "embeddings item requires embedding model" });
  if (value.invocation.parameters.model.const !== value.model.slug)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invocation model must match model slug" });
});

export const catalogItemV1Schema = z.union([
  unavailableItemSchema,
  availableItemSchema,
  availableEmbeddingsItemSchema,
]);

export const catalogResponseV1Schema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    object: z.literal("catalog.list"),
    catalogRevision: sha256RevisionSchema,
    data: z.array(catalogItemV1Schema).max(CATALOG_MAX_DATA_ITEMS),
    page: z
      .object({
        limit: z.number().int().min(1).max(CATALOG_MAX_DATA_ITEMS),
        nextCursor: z.string().min(1).max(CATALOG_MAX_CURSOR_BYTES).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.data.length > value.page.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "data may not exceed page limit",
      });
    }
  });

export const catalogCursorV1Schema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    catalogRevision: sha256RevisionSchema,
    after: z.object({ slug: boundedTextSchema, modelId: uuidSchema }).strict(),
  })
  .strict();

function binaryToBase64(binary: string): string {
  if (typeof btoa !== "function")
    throw new TypeError("Base64 encoding is unavailable");
  return btoa(binary);
}

function base64ToBinary(base64: string): string {
  if (typeof atob !== "function")
    throw new TypeError("Base64 decoding is unavailable");
  return atob(base64);
}

function utf8ToBinary(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

function binaryToUtf8(value: string): string {
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Encodes the cursor as its only accepted base64url-without-padding representation. */
export function encodeCatalogCursor(value: CatalogCursorV1): string {
  const cursor = catalogCursorV1Schema.parse(value);
  const canonicalJson = JSON.stringify({
    schemaVersion: cursor.schemaVersion,
    catalogRevision: cursor.catalogRevision,
    after: { slug: cursor.after.slug, modelId: cursor.after.modelId },
  });
  const encoded = binaryToBase64(utf8ToBinary(canonicalJson))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  if (encoded.length > CATALOG_MAX_CURSOR_BYTES)
    throw new TypeError("Catalog cursor exceeds maximum length");
  return encoded;
}

/** Decodes only strict canonical cursor JSON and its canonical base64url spelling. */
export function decodeCatalogCursor(value: unknown): CatalogCursorV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CATALOG_MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError("Invalid catalog cursor");
  }
  try {
    const padded =
      value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const cursor = catalogCursorV1Schema.parse(
      JSON.parse(binaryToUtf8(base64ToBinary(padded))),
    );
    if (encodeCatalogCursor(cursor) !== value)
      throw new TypeError("Non-canonical catalog cursor");
    return cursor;
  } catch {
    throw new TypeError("Invalid catalog cursor");
  }
}

/** Strictly parses bounded catalog JSON and verifies that any cursor is canonical. */
export function parseCatalogResponseV1(value: unknown): CatalogResponseV1 {
  const response = catalogResponseV1Schema.parse(value);
  if (response.page.nextCursor !== null) {
    const cursor = decodeCatalogCursor(response.page.nextCursor);
    const lastItem = response.data.at(-1);
    if (
      response.data.length !== response.page.limit ||
      !lastItem ||
      cursor.catalogRevision !== response.catalogRevision ||
      cursor.after.slug !== lastItem.model.slug ||
      cursor.after.modelId !== lastItem.model.id
    ) {
      throw new TypeError("Invalid catalog cursor");
    }
  }
  return response;
}
