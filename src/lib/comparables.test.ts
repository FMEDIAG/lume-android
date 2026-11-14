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
  it("la política predeterminada conserva el mínimo de dos comparables", () => {
    const result = { confidence: "high", comparables: [a] };
    assert.equal(anchorToComparables(result, [a.url], 0.8, "es"), false);
    assert.equal(result.confidence, "low");
  });
  it("100 francos suizos: un precio citado conserva su referencia y eleva la confianza a media", () => {
    // Fixture sintética: no es un anuncio ni un precio real de esta moneda.
    const coin = { ...a, title: "Suiza 100 francos oro 1925", price: 2400, url: "https://example.com/swiss-100-francs-1925" };
    const result = { priceEurMin: 2000, priceEurMax: 3000, confidence: "low", sources: [], comparables: [coin] };
    assert.equal(anchorToComparables(result, [coin.url], 0.8, "es", true), true);
    assert.equal(result.confidence, "medium");
    assert.deepEqual(result.sources, [coin.url]);
    assert.equal(result.priceEurMin, 2400);
    assert.equal(result.priceEurMax, 2400);
  });
  it("100 francos suizos: sin página citada no inventa referencias ni confirma el precio", () => {
    const coin = { ...a, title: "Suiza 100 francos oro", url: "https://example.com/swiss-100-francs" };
    const result = { confidence: "high", sources: [coin.url], comparables: [coin] };
    assert.equal(anchorToComparables(result, [], 0.8, "es", true), false);
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.sources, []);
  });
});