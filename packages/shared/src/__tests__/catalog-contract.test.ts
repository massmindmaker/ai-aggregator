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
