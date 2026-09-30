import { describe, expect, it } from "vitest";
import fixture from "./fixtures/catalog-v1.json";
import {
  CATALOG_ACCEPTED_MAX_TOKENS,
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseCatalogResponseV1,
  type CatalogAvailableItemV1,
  type CatalogCursorV1,
  type CatalogItemV1,
  type CatalogResponseV1,
  type Sha256Revision,
} from "../catalog-contract";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type Equal<First, Second> =
  (<Value>() => Value extends First ? 1 : 2) extends <
    Value,
  >() => Value extends Second ? 1 : 2
    ? true
    : false;
type Expect<Condition extends true> = Condition;
type IsReadonlyArray<Value> = Value extends readonly unknown[]
  ? Value extends unknown[]
    ? false
    : true
  : false;

type _ResponseRevisionIsBranded = Expect<
  Equal<CatalogResponseV1["catalogRevision"], Sha256Revision>
>;
type _CursorRevisionIsBranded = Expect<
  Equal<CatalogCursorV1["catalogRevision"], Sha256Revision>
>;
type _ResponseDataIsReadonly = Expect<
  Equal<IsReadonlyArray<CatalogResponseV1["data"]>, true>
>;
type _CapabilitiesAreReadonly = Expect<
  Equal<IsReadonlyArray<CatalogAvailableItemV1["capabilities"]>, true>
>;
type _UnsupportedFieldsAreReadonly = Expect<
  Equal<
    IsReadonlyArray<
      CatalogAvailableItemV1["invocation"]["requestBody"]["unsupportedExecutionFields"]
    >,
    true
  >
>;
const typeAssertions: readonly [
  _ResponseRevisionIsBranded,
  _CursorRevisionIsBranded,
  _ResponseDataIsReadonly,
  _CapabilitiesAreReadonly,
  _UnsupportedFieldsAreReadonly,
] = [true, true, true, true, true];
void typeAssertions;

function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Expected JSON object at ${label}`);
  return value;
}

function asArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value))
    throw new TypeError(`Expected JSON array at ${label}`);
  return value;
}

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Fixture must contain only plain JSON");
  }
  const parsed: JsonObject = {};
  for (const [key, nested] of Object.entries(value))
    parsed[key] = asJsonValue(nested);
  return parsed;
}

function objectAt(root: JsonObject, ...path: string[]): JsonObject {
  let current: JsonObject = root;
  for (const segment of path)
    current = asObject(current[segment], path.join("."));
  return current;
}

function itemAt(root: JsonObject, index: number): JsonObject {
  return asObject(asArray(root.data, "data")[index], `data[${index}]`);
}

function cloneResponse(): JsonObject {
  return asObject(asJsonValue(structuredClone(fixture)), "fixture");
}

function parseFixture(): CatalogResponseV1 {
  return parseCatalogResponseV1(cloneResponse());
}

function availableItem(response: CatalogResponseV1): CatalogAvailableItemV1 {
  const item = response.data[0];
  if (!item || !isAvailableItem(item))
    throw new TypeError("Fixture must begin with an available item");
  return item;
}

function isAvailableItem(item: CatalogItemV1): item is CatalogAvailableItemV1 {
  return item.availability.state === "available";
}

describe("catalog contract v1", () => {
  it("accepts the strict embeddings operation union without weakening chat", () => {
    const candidate = cloneResponse();
    const item = itemAt(candidate, 0);
    objectAt(item, "model").type = "embedding";
    objectAt(item, "model").slug = "openai/text-embedding-3-small";
    objectAt(item, "deployment").contract = "stored-embeddings-v1";
    const invocation = objectAt(item, "invocation");
    invocation.path = "/v1/embeddings";
    invocation.requestBody = { unknownFields: "reject" };
    invocation.parameters = {
      model: { required: true, const: "openai/text-embedding-3-small" },
      input: { required: true, minItems: 1, maxItems: 16, item: "nonempty_utf8_string_max_8192_bytes" },
      encoding_format: { required: false, const: "float", normalizedDefault: "float" },
      dimensions: { required: false, const: 1536, normalizedDefault: 1536 },
      aiag_mode: {
        required: false, values: ["auto", "fastest", "cheapest", "balanced", "ru-only"],
        availableValues: ["auto"], defaultRequested: "auto", effectiveDefault: "auto",
        requiresExplicitAvailableValue: false,
      },
    };
    item.capabilities = [{
      id: "embeddings.stored.float.v1", inputModalities: ["text"], outputModalities: ["embedding"],
      storedResult: true, usageReceipt: true, requestDependentRestrictions: ["pii_transborder"],
      contextWindowTokensPerInput: 8192, maxInputs: 16, dimensions: 1536, encodingFormat: "float",
    }];
    const pricing = objectAt(item, "pricing");
    pricing.actualCharge = {
      formulaVersion: "db-input-output-cents-per-1k-legacy-whole-cache-v1",
      cachePolicy: { scope: "none", multiplier: "1" },
      rounding: "nearest_nonnegative_half_up_once_to_microcredit",
    };
    pricing.maximumAuthorization = {
      formula: "input_rate*context*input_count", contextWindowTokens: 8192, maxInputs: 16,
      rounding: "ceil_once_to_microcredit",
    };
    expect(parseCatalogResponseV1(candidate).data[0]!.model.type).toBe("embedding");
    const wrong = structuredClone(candidate);
    objectAt(itemAt(wrong, 0), "invocation", "parameters", "dimensions").const = 1024;
    expect(() => parseCatalogResponseV1(wrong)).toThrow();
  });

  it("accepts the strict author-version union and refuses to weaken it", () => {
    const candidate = cloneResponse();
    const item = itemAt(candidate, 0);
    objectAt(item, "model").type = "chat";
    objectAt(item, "model").slug = "author/cool-model";
    item.ownedBy = "author";
    objectAt(item, "deployment").contract = "stored-author-chat-v1";
    objectAt(item, "deployment").id = "50000000-0000-4000-8000-000000000001";
    const invocation = objectAt(item, "invocation");
    const parameters = objectAt(invocation, "parameters");
    invocation.maxBodyBytes = 32768;
    objectAt(parameters, "model").const = "author/cool-model";
    parameters.max_tokens = {
      required: false, type: "integer", minimum: 1, acceptedMaximum: 4096,
      effectiveMaximum: 4096, configuredDefault: 1024, defaultApplied: 1024,
      normalization: "clamp_to_effective_max",
    };
    objectAt(parameters, "messages").maxItems = 64;
    item.capabilities = [{
      id: "chat.completions.stored.author.v1", inputModalities: ["text"], outputModalities: ["text"],
      streaming: false, toolCalling: false, structuredOutput: false, asynchronous: false,
      storedResult: true, usageReceipt: true, requestDependentRestrictions: ["pii_transborder"],
      contextWindowTokens: null, maxOutputTokens: 4096,
    }];
    item.pricing = {
      revision: `sha256:${"c".repeat(64)}`, currency: "USD", settlementUnit: "microcredit",
      microcreditsPerUsdCent: "1000",
      rates: { request: { amount: "2500", unit: "microcredit_per_request" } },
      actualCharge: { formulaVersion: "author-fixed-microcredits-v1", rounding: "exact_microcredit_per_request" },
      maximumAuthorization: { formula: "request_rate", rounding: "exact_microcredit_per_request" },
      quoteSemantics: "terms_only_quote_created_at_admission",
    };
    const parsed = parseCatalogResponseV1(candidate).data[0]!;
    expect(parsed.availability.state).toBe("available");
    if (!("ownedBy" in parsed)) throw new TypeError("expected an author item");
    expect(parsed.ownedBy).toBe("author");

    // An author item may not borrow the upstream deployment contract, drop its
    // ownership marker, claim a context window, or price per token.
    for (const mutate of [
      (value: JsonObject) => { objectAt(itemAt(value, 0), "deployment").contract = "stored-plaintext-chat-v1"; },
      (value: JsonObject) => { delete itemAt(value, 0).ownedBy; },
      (value: JsonObject) => { asObject(asArray(itemAt(value, 0).capabilities, "capabilities")[0], "capabilities[0]").contextWindowTokens = 8192; },
      (value: JsonObject) => { objectAt(itemAt(value, 0), "pricing", "rates").input = { amount: "1", unit: "microcredit_per_token" }; },
      (value: JsonObject) => { objectAt(itemAt(value, 0), "model").type = "embedding"; },
    ]) {
      const broken = structuredClone(candidate);
      mutate(broken);
      expect(() => parseCatalogResponseV1(broken)).toThrow();
    }
  });

  it("pins a synthetic full page and a coherent canonical next cursor", () => {
    const parsed = parseFixture();
    expect(parsed.data).toHaveLength(parsed.page.limit);
    expect(parsed.data[0]?.availability.state).toBe("available");
    expect(parsed.data[1]?.availability.state).toBe("unavailable");
    const cursor = decodeCatalogCursor(parsed.page.nextCursor!);
    const last = parsed.data.at(-1)!;
    expect(cursor).toEqual({
      schemaVersion: 1,
      catalogRevision: parsed.catalogRevision,
      after: { slug: last.model.slug, modelId: last.model.id },
    });
  });

  it("rejects unknown keys, invalid identities/digests, decimals, field length and more than 100 items", () => {
    const unknown = cloneResponse();
    unknown.surprise = true;
    expect(() => parseCatalogResponseV1(unknown)).toThrow();
    const digest = cloneResponse();
    digest.catalogRevision = "sha256:ABC";
    expect(() => parseCatalogResponseV1(digest)).toThrow();
    const identity = cloneResponse();
    objectAt(itemAt(identity, 0), "model").id = "not-a-uuid";
    expect(() => parseCatalogResponseV1(identity)).toThrow();
    const money = cloneResponse();
    objectAt(itemAt(money, 0), "pricing", "rates", "input").amount = "01.2";
    expect(() => parseCatalogResponseV1(money)).toThrow();
    const longSlug = cloneResponse();
    objectAt(itemAt(longSlug, 0), "model").slug = "x".repeat(129);
    expect(() => parseCatalogResponseV1(longSlug)).toThrow();
    const large = cloneResponse();
    large.data = Array.from({ length: 101 }, () =>
      structuredClone(itemAt(large, 1)),
    );
    objectAt(large, "page").limit = 100;
    expect(() => parseCatalogResponseV1(large)).toThrow();
  });

  it("keeps the unavailable union fully null and rejects unsupported available capability data", () => {
    for (const field of ["deployment", "invocation", "capabilities"] as const) {
      const candidate = cloneResponse();
      const unavailable = itemAt(candidate, 1);
      unavailable[field] = structuredClone(itemAt(candidate, 0)[field]);
      expect(() => parseCatalogResponseV1(candidate)).toThrow();
    }
    const unsupported = cloneResponse();
    asObject(
      asArray(itemAt(unsupported, 0).capabilities, "capabilities")[0],
      "capability",
    ).streaming = true;
    expect(() => parseCatalogResponseV1(unsupported)).toThrow();
    const missingUnit = cloneResponse();
    delete objectAt(itemAt(missingUnit, 0), "pricing", "rates", "input").unit;
    expect(() => parseCatalogResponseV1(missingUnit)).toThrow();
    const missingRevision = cloneResponse();
    delete objectAt(itemAt(missingRevision, 0), "pricing").revision;
    expect(() => parseCatalogResponseV1(missingRevision)).toThrow();
  });

  it("requires every strict stored-chat and BYOK rejection descriptor field", () => {
    for (const path of [
      ["requestBody", "unknownFields"],
      ["requestBody", "unknownMessageFields"],
      ["requestBody", "unsupportedExecutionFields"],
      ["requestBody", "multimodalMessageContent"],
      ["headers", "upstreamKey"],
      ["headers", "upstreamKey", "allowed"],
      ["headers", "upstreamKey", "rejection"],
    ] as const) {
      const candidate = cloneResponse();
      const target = objectAt(
        objectAt(itemAt(candidate, 0), "invocation"),
        ...path.slice(0, -1),
      );
      delete target[path.at(-1)!];
      expect(() => parseCatalogResponseV1(candidate)).toThrow();
    }
  });

  it("describes absent and explicit max-token outcomes without implementing admission normalization", () => {
    const maxTokens =
      availableItem(parseFixture()).invocation.parameters.max_tokens;
    expect(maxTokens).toMatchObject({
      acceptedMaximum: CATALOG_ACCEPTED_MAX_TOKENS,
      effectiveMaximum: 4096,
      configuredDefault: 8192,
      defaultApplied: 4096,
      normalization: "clamp_to_effective_max",
    });
    expect([
      { requested: undefined, publishedOutcome: maxTokens.defaultApplied },
      { requested: 1, publishedOutcome: 1 },
      { requested: maxTokens.effectiveMaximum, publishedOutcome: 4096 },
      { requested: maxTokens.effectiveMaximum + 1, publishedOutcome: 4096 },
      { requested: Number.MAX_SAFE_INTEGER, publishedOutcome: 4096 },
    ]).toEqual([
      { requested: undefined, publishedOutcome: 4096 },
      { requested: 1, publishedOutcome: 1 },
      { requested: 4096, publishedOutcome: 4096 },
      { requested: 4097, publishedOutcome: 4096 },
      { requested: CATALOG_ACCEPTED_MAX_TOKENS, publishedOutcome: 4096 },
    ]);
    const malformed = cloneResponse();
    delete objectAt(
      itemAt(malformed, 0),
      "invocation",
      "parameters",
      "max_tokens",
    ).defaultApplied;
    expect(() => parseCatalogResponseV1(malformed)).toThrow();
  });

  it("rejects a next cursor from a different revision, item, or underfilled page", () => {
    const revisionMismatch = cloneResponse();
    revisionMismatch.catalogRevision = `sha256:${"f".repeat(64)}`;
    expect(() => parseCatalogResponseV1(revisionMismatch)).toThrow();
    const wrongAfter = cloneResponse();
    objectAt(wrongAfter, "page").nextCursor = encodeCatalogCursor({
      schemaVersion: 1,
      catalogRevision: parseFixture().catalogRevision,
      after: {
        slug: "synthetic-stored-chat",
        modelId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(() => parseCatalogResponseV1(wrongAfter)).toThrow();
    const underfilled = cloneResponse();
    underfilled.data = [itemAt(underfilled, 0)];
    expect(() => parseCatalogResponseV1(underfilled)).toThrow();
  });

  it("round-trips only the canonical, bounded base64url cursor", () => {
    const cursor = decodeCatalogCursor(parseFixture().page.nextCursor!);
    expect(encodeCatalogCursor(cursor)).toBe(parseFixture().page.nextCursor);
    expect(() => decodeCatalogCursor("***")).toThrow();
    expect(() => decodeCatalogCursor("a".repeat(1025))).toThrow();
    const reordered = btoa(
      JSON.stringify({
        after: cursor.after,
        catalogRevision: cursor.catalogRevision,
        schemaVersion: 1,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(() => decodeCatalogCursor(reordered)).toThrow();
  });
});
