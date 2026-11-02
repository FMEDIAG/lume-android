import { describe, expect, it } from "vitest";
import {
  isRetailUrl,
  mentionsReference,
  priceAppearsInText,
  referenceFromContext,
  retailRange,
} from "./watch-retail";

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
  it("toma la referencia escrita en el contexto", () => {
    expect(referenceFromContext("Jaeger-LeCoultre Master Ultra Thin Tourbillon Moon Q169242J")).toBe("Q169242J");
    expect(referenceFromContext("Rolex Submariner 126610LN, oro 18k, 41mm, año 2020")).toBe("126610LN");
    expect(referenceFromContext("Patek 5711/1A-010 completo")).toBe("5711/1A-010");
    expect(referenceFromContext("ref 116500 caja y papeles")).toBe("116500");
  });
  it("no confunde años, quilates, fechas ni importes con una referencia", () => {
    expect(referenceFromContext("oro 18k 41mm 65.000 € comprado en 2020 el 2026-11-02")).toBeNull();
    expect(referenceFromContext("")).toBeNull();
  });
});
