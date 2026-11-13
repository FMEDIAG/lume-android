import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorToComparables, rangeFromComparables, verifyComparables, type Comparable } from "./comparables.ts";

const a: Comparable = { title: "Objeto modelo A", price: 100, currency: "EUR", kind: "sold", url: "https://ebay.com/itm/1" };
const b: Comparable = { ...a, price: 120, url: "https://ebay.com/itm/2" };

describe("tasaciones respaldadas por páginas reales", () => {
  it("rechaza una página inventada aunque comparta dominio", () => {
    assert.deepEqual(verifyComparables([a], ["https://ebay.com/itm/999"]), []);
  });
  it("acepta la página citada sin parámetros de seguimiento y no cuenta duplicados", () => {
    assert.equal(verifyComparables([a, a], [a.url + "?utm_source=search#price"]).length, 1);
  });
  it("calcula los precios desde ventas verificadas, no anuncios", () => {
    const range = rangeFromComparables([a, b, { ...a, price: 200, kind: "asking", url: "https://example.com/3" }], 0.8);
    assert.equal(range?.eurMin, 100);
    assert.equal(range?.eurMax, 120);
    assert.equal(range?.usdMin, 125);
  });
  it("no inventa una horquilla cuando ambas ventas tienen el mismo precio", () => {
    const range = rangeFromComparables([a, { ...b, price: 100 }], 0.8);
    assert.equal(range?.eurMin, 100);
    assert.equal(range?.eurMax, 100);
  });
  it("sin evidencia mantiene la estimación con confianza baja y elimina fuentes inventadas", () => {
    const result = { priceEurMin: 50, priceEurMax: 100, confidence: "high", notes: "", sources: ["Wikipedia"], comparables: [a] };
    assert.equal(anchorToComparables(result, [], 0.8, "es"), false);
    assert.equal(result.confidence, "low");
    assert.equal(result.priceEurMin, 50);
    assert.deepEqual(result.sources, []);
  });
  it("precios pedidos no justifican confianza alta", () => {
    const result = { confidence: "high", comparables: [{ ...a, kind: "asking" }, { ...b, kind: "asking" }] };
    assert.equal(anchorToComparables(result, [a.url, b.url], 0.8, "en"), true);
    assert.equal(result.confidence, "medium");
  });
  it("rechaza tipos desconocidos y cambios no válidos", () => {
    assert.deepEqual(verifyComparables([{ ...a, kind: "catalogue" }], [a.url]), []);
    assert.equal(rangeFromComparables([a, b], 0), null);
  });
  it("un precio del objeto verificado da confianza media y su referencia exacta", () => {
    const result = { priceEurMin: 50, priceEurMax: 200, confidence: "low", sources: [], comparables: [a] };
    assert.equal(anchorToComparables(result, [a.url], 0.8, "es", true), true);
    assert.equal(result.confidence, "medium");
    assert.equal(result.priceEurMin, 100);
    assert.equal(result.priceEurMax, 100);
    assert.deepEqual(result.sources, [a.url]);
  });
  it("dos precios verificados no conservan confianza baja", () => {
    const result = { confidence: "low", comparables: [a, b] };
    assert.equal(anchorToComparables(result, [a.url, b.url], 0.8, "es", true), true);
    assert.equal(result.confidence, "medium");
  });
  it("una página descriptiva sin precio verificable no eleva la confianza", () => {
    const result = { confidence: "high", sources: [], comparables: [a] };
    assert.equal(anchorToComparables(result, ["https://wikipedia.org/wiki/Objeto"], 0.8, "es", true), false);
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.sources, ["https://wikipedia.org/wiki/Objeto"]);
  });
  it("la política predeterminada de monedas conserva el mínimo de dos comparables", () => {
    const result = { confidence: "high", comparables: [a] };
    assert.equal(anchorToComparables(result, [a.url], 0.8, "es"), false);
    assert.equal(result.confidence, "low");
  });
});