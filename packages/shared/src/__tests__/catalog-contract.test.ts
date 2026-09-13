import { describe, expect, it } from "vitest";
import fixture from "./fixtures/catalog-v1.json";
import {
  CATALOG_ACCEPTED_MAX_TOKENS,
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseCatalogResponseV1,
} from "../catalog-contract";

const response = () => structuredClone(fixture);
const available = () => response().data[0] as Record<string, any>;

describe("catalog contract v1", () => {
  it("pins a synthetic available item, unavailable item, and canonical next cursor", () => {
    const parsed = parseCatalogResponseV1(response());
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].availability.state).toBe("available");
    expect(parsed.data[1].availability.state).toBe("unavailable");
    expect(decodeCatalogCursor(parsed.page.nextCursor!)).toEqual({
      schemaVersion: 1,
      catalogRevision: parsed.catalogRevision,
      after: {
        slug: "synthetic-stored-chat",
        modelId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("rejects unknown keys, invalid identities/digests, decimals, field length and more than 100 items", () => {
    const unknown = response();
    (unknown as any).surprise = true;
    expect(() => parseCatalogResponseV1(unknown)).toThrow();
    const digest = response();
    digest.catalogRevision = "sha256:ABC";
    expect(() => parseCatalogResponseV1(digest)).toThrow();
    const identity = response();
    identity.data[0].model.id = "not-a-uuid";
    expect(() => parseCatalogResponseV1(identity)).toThrow();
    const money = response();
    (money.data[0] as any).pricing.rates.input.amount = "01.2";
    expect(() => parseCatalogResponseV1(money)).toThrow();
    const longSlug = response();
    longSlug.data[0].model.slug = "x".repeat(129);
    expect(() => parseCatalogResponseV1(longSlug)).toThrow();
    const large = response();
    large.data = Array.from({ length: 101 }, () =>
      structuredClone(large.data[1]),
    );
    large.page.limit = 100;
    expect(() => parseCatalogResponseV1(large)).toThrow();
  });

  it("keeps the discriminated unavailable and available shapes fail-closed", () => {
    const unavailable = response();
    (unavailable.data[1] as any).pricing = available().pricing;
    expect(() => parseCatalogResponseV1(unavailable)).toThrow();
    const missingPricingUnit = response();
    delete (missingPricingUnit.data[0] as any).pricing.rates.input.unit;
    expect(() => parseCatalogResponseV1(missingPricingUnit)).toThrow();
    const missingRevision = response();
    delete (missingRevision.data[0] as any).pricing.revision;
    expect(() => parseCatalogResponseV1(missingRevision)).toThrow();
    const unsupportedCapability = response();
    (unsupportedCapability.data[0] as any).capabilities[0].streaming = true;
    expect(() => parseCatalogResponseV1(unsupportedCapability)).toThrow();
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
    ]) {
      const candidate = response();
      let target = (candidate.data[0] as any).invocation;
      for (const segment of path.slice(0, -1)) target = target[segment];
      delete target[path.at(-1)!];
      expect(() => parseCatalogResponseV1(candidate)).toThrow();
    }
  });

  it("pins all four distinct max-token values and the request-boundary vectors", () => {
    const maxTokens = available().invocation.parameters.max_tokens;
    expect(maxTokens).toMatchObject({
      acceptedMaximum: CATALOG_ACCEPTED_MAX_TOKENS,
      effectiveMaximum: 4096,
      configuredDefault: 8192,
      defaultApplied: 4096,
      normalization: "clamp_to_effective_max",
    });
    expect([
      undefined,
      1,
      maxTokens.effectiveMaximum,
      maxTokens.effectiveMaximum + 1,
      Number.MAX_SAFE_INTEGER,
    ]).toEqual([undefined, 1, 4096, 4097, CATALOG_ACCEPTED_MAX_TOKENS]);
    const malformed = response();
    delete (malformed.data[0] as any).invocation.parameters.max_tokens
      .defaultApplied;
    expect(() => parseCatalogResponseV1(malformed)).toThrow();
  });

  it("round-trips only the canonical, bounded base64url cursor", () => {
    const cursor = decodeCatalogCursor(response().page.nextCursor!);
    expect(encodeCatalogCursor(cursor)).toBe(response().page.nextCursor);
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
