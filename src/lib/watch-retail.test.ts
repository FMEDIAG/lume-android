import { describe, expect, it } from "vitest";
import { isRetailUrl, mentionsReference, priceAppearsInText, retailRange } from "./watch-retail";

describe("watch retail", () => {
  it("rechaza mercados de segunda mano", () => {
    expect(isRetailUrl("https://www.chrono24.es/rolex/x.htm")).toBe(false);
    expect(isRetailUrl("https://www.ebay.es/itm/1")).toBe(false);
    expect(isRetailUrl("https://www.rabat.net/rolex-126610ln")).toBe(true);
  });
  it("exige la referencia exacta", () => {
    expect(mentionsReference("Rolex Submariner 126610LN acero", "126610 LN")).toBe(true);
    expect(mentionsReference("Rolex Submariner 124060", "126610LN")).toBe(false);
  });
  it("solo acepta precios escritos en la página", () => {
    expect(priceAppearsInText("Precio: 10.450 €", 10450)).toBe(true);
    expect(priceAppearsInText("Precio: 9.900 €", 10450)).toBe(false);
  });
  it("sin anuncios no hay cifra", () => {
    expect(retailRange([], 0.9)).toBeNull();
  });
});
