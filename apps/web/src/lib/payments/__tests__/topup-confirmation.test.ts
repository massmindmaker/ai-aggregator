import { describe, expect, it } from "vitest";

import {
  calculateTopupGrantCredits,
  rublesToKopecks,
} from "../topup-confirmation";

describe("top-up confirmation exact arithmetic", () => {
  it("parses persisted RUB into integer kopecks without accepting rounding inputs", () => {
    expect(rublesToKopecks("990.00")).toBe(99_000);
    expect(rublesToKopecks("495.5")).toBe(49_550);
    expect(rublesToKopecks("990.001")).toBeNull();
    expect(rublesToKopecks("1e3")).toBeNull();
    expect(rublesToKopecks(990)).toBeNull();
  });

  it("derives the grant from the canonical Basic tier using integer half-up rounding", () => {
    const rate = { priceRubles: 990, credits: 1200 };
    expect(calculateTopupGrantCredits(99_000, rate)).toBe(1_200_000);
    expect(calculateTopupGrantCredits(49_500, rate)).toBe(600_000);
    expect(calculateTopupGrantCredits(1, rate)).toBe(12);
  });
});
