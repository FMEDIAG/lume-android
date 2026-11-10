import { describe, expect, it } from "vitest";
import { positivePrices } from "./positive-prices";

const zero = { priceEurMin: 0, priceEurMax: 0, priceUsdMin: 0, priceUsdMax: 0 };
describe("no zero valuations", () => {
  it("never delivers an all-zero valuation or invents a replacement price", () => {
    expect(positivePrices(zero, 0.9)).toBeNull();
  });
  it("fills missing endpoints from a price actually returned", () => {
    expect(positivePrices({ ...zero, priceEurMax: 90, priceUsdMax: 100 }, 0.9)).toEqual({
      priceEurMin: 90, priceEurMax: 90, priceUsdMin: 100, priceUsdMax: 100,
    });
  });
  it("converts a missing currency instead of displaying zero", () => {
    expect(positivePrices({ ...zero, priceUsdMin: 100, priceUsdMax: 200 }, 0.9)).toEqual({
      priceEurMin: 90, priceEurMax: 180, priceUsdMin: 100, priceUsdMax: 200,
    });
  });
  it("preserves positive cents-level prices", () => {
    const prices = { priceEurMin: 0.02, priceEurMax: 0.1, priceUsdMin: 0.02, priceUsdMax: 0.1 };
    expect(positivePrices(prices, 0.9)).toEqual(prices);
  });
});