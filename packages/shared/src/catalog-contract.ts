import { z } from "zod";

/** Public catalog v1 is browser-safe and deliberately contains no runtime adapter data. */
export const CATALOG_SCHEMA_VERSION = 1 as const;
export const CATALOG_MAX_DATA_ITEMS = 100;
export const CATALOG_MAX_CURSOR_BYTES = 1024;
export const CATALOG_MAX_TEXT_LENGTH = 128;
export const CATALOG_ACCEPTED_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

const sha256RevisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuidSchema = z.string().uuid();
const boundedTextSchema = z.string().min(1).max(CATALOG_MAX_TEXT_LENGTH);
const canonicalDecimalSchema = z
  .string()
  .max(CATALOG_MAX_TEXT_LENGTH)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

export type Sha256Revision = `sha256:${string}`;
export type Uuid = string;
export type CatalogMode =
  | "auto"
  | "fastest"
  | "cheapest"
  | "balanced"
  | "ru-only";

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
            values: z.tuple(
              catalogModes.map((mode) => z.literal(mode)) as [
                z.ZodLiteral<CatalogMode>,
                z.ZodLiteral<CatalogMode>,
                z.ZodLiteral<CatalogMode>,
                z.ZodLiteral<CatalogMode>,
                z.ZodLiteral<CatalogMode>,
              ],
            ),
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

export const catalogItemV1Schema = z.union([
  unavailableItemSchema,
  availableItemSchema,
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

export type CatalogModelIdentityV1 = z.infer<typeof modelSchema>;
export type CatalogUnavailableItemV1 = z.infer<typeof unavailableItemSchema>;
export type CatalogAvailableItemV1 = z.infer<typeof availableItemSchema>;
export type CatalogItemV1 = z.infer<typeof catalogItemV1Schema>;
export type CatalogResponseV1 = z.infer<typeof catalogResponseV1Schema>;
export type CatalogCursorV1 = z.infer<typeof catalogCursorV1Schema>;

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
  if (response.page.nextCursor !== null)
    decodeCatalogCursor(response.page.nextCursor);
  return response;
}
