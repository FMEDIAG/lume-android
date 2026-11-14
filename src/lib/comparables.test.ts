import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anchorToComparables,
  moneyAmountAppearsInText,
  rangeFromComparables,
  verifyComparables,
  type Comparable,
  type ComparableEvidencePage,
} from "./comparables.ts";

const a: Comparable = { title: "Objeto modelo A", price: 100, currency: "EUR", kind: "sold", url: "https://ebay.com/itm/1" };
const b: Comparable = { ...a, price: 120, url: "https://ebay.com/itm/2" };
const page = (c: Comparable): ComparableEvidencePage => ({
  url: c.url,
  text: c.currency === "EUR" ? "Precio vendido: " + c.price + " EUR" : "Precio vendido: USD " + c.price,
});

describe("precios comparables verificados en páginas citadas", () => {
  it("rechaza una página inventada aunque comparta dominio", () => {
    assert.deepEqual(verifyComparables([a], ["https://ebay.com/itm/999"], [page(a)]), []);
  });
  it("acepta la página citada sin parámetros de seguimiento y no cuenta duplicados", () => {
    assert.equal(verifyComparables([a, a], [a.url + "?utm_source=search#price"], [page(a)]).length, 1);
  });
  it("rechaza un importe que no aparece en el texto de la página", () => {
    assert.deepEqual(verifyComparables([a], [a.url], [{ url: a.url, text: "Precio vendido: 90 EUR" }]), []);
  });
  it("rechaza un importe que aparece con otra moneda", () => {
    assert.deepEqual(verifyComparables([a], [a.url], [{ url: a.url, text: "Precio vendido: USD 100" }]), []);
  });
  it("lee importes localizados y exige la moneda", () => {
    assert.equal(moneyAmountAppearsInText("Precio: 1.234,50 €", 1234.5, "EUR"), true);
    assert.equal(moneyAmountAppearsInText("Price: USD 1,234.50", 1234.5, "USD"), true);
    assert.equal(moneyAmountAppearsInText("Price: $1,234.50 CAD", 1234.5, "USD"), false);
    assert.equal(moneyAmountAppearsInText("Precio: 10.450 €", 10450, "EUR"), true);
    assert.equal(moneyAmountAppearsInText("Precio: 9.900 €", 10450, "EUR"), false);
  });
  it("calcula el rango de dos ventas verificadas, no de anuncios", () => {
    const range = rangeFromComparables([a, b, { ...a, price: 200, kind: "asking", url: "https://ebay.com/itm/3" }], 0.8);
    assert.equal(range?.eurMin, 100);
    assert.equal(range?.eurMax, 120);
    assert.equal(range?.usdMin, 125);
  });
  it("sin evidencia conserva la estimación con confianza baja y quita fuentes no citadas", () => {
    const result = { priceEurMin: 50, priceEurMax: 100, confidence: "high", notes: "", sources: ["Wikipedia"], comparables: [a] };
    assert.equal(anchorToComparables(result, [], 0.8, "es", []), false);
    assert.equal(result.confidence, "low");
    assert.equal(result.priceEurMin, 50);
    assert.deepEqual(result.sources, []);
  });
  it("precios pedidos no justifican confianza alta", () => {
    const askingA = { ...a, kind: "asking" as const };
    const askingB = { ...b, kind: "asking" as const };
    const result = { confidence: "high", comparables: [askingA, askingB] };
    assert.equal(anchorToComparables(result, [a.url, b.url], 0.8, "en", [page(askingA), page(askingB)]), true);
    assert.equal(result.confidence, "medium");
  });
  it("rechaza tipos desconocidos y cambios no válidos", () => {
    assert.deepEqual(verifyComparables([{ ...a, kind: "catalogue" }], [a.url], [page(a)]), []);
    assert.equal(rangeFromComparables([a, b], 0), null);
  });
  it("un único precio verificado no sube la confianza ni fija el rango", () => {
    const result = { priceEurMin: 50, priceEurMax: 200, confidence: "high", sources: [], comparables: [a] };
    assert.equal(anchorToComparables(result, [a.url], 0.8, "es", [page(a)]), false);
    assert.equal(result.confidence, "low");
    assert.equal(result.priceEurMin, 50);
    assert.equal(result.priceEurMax, 200);
  });
  it("dos precios confirmados anclan el rango y conservan sus referencias", () => {
    const result = { priceEurMin: 50, priceEurMax: 200, confidence: "low", sources: [], comparables: [a, b] };
    assert.equal(anchorToComparables(result, [a.url, b.url], 0.8, "es", [page(a), page(b)]), true);
    assert.equal(result.priceEurMin, 100);
    assert.equal(result.priceEurMax, 120);
    assert.deepEqual(result.sources.slice(0, 2), [a.url, b.url]);
  });
  it("una página descriptiva sin precio comparable no confirma el precio", () => {
    const result = { confidence: "high", sources: [], comparables: [a] };
    assert.equal(anchorToComparables(result, ["https://wikipedia.org/wiki/Objeto"], 0.8, "es", []), false);
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.sources, ["https://wikipedia.org/wiki/Objeto"]);
  });
  it("100 francos suizos: un único importe citado sigue siendo orientativo", () => {
    const coin = { ...a, title: "Suiza 100 francos oro 1925", price: 2400, url: "https://example.com/swiss-100-francs-1925" };
    const result = { priceEurMin: 2000, priceEurMax: 3000, confidence: "high", sources: [], comparables: [coin] };
    assert.equal(anchorToComparables(result, [coin.url], 0.8, "es", [page(coin)]), false);
    assert.equal(result.confidence, "low");
    assert.equal(result.priceEurMin, 2000);
  });
  it("100 francos suizos: dos importes en páginas citadas confirman el rango", () => {
    const coinA = { ...a, title: "Suiza 100 francos oro 1925", price: 2400, url: "https://example.com/swiss-100-francs-1925" };
    const coinB = { ...coinA, price: 2500, url: "https://example.net/swiss-100-francs-1925" };
    const result = { priceEurMin: 2000, priceEurMax: 3000, confidence: "low", sources: [], comparables: [coinA, coinB] };
    assert.equal(anchorToComparables(result, [coinA.url, coinB.url], 0.8, "es", [page(coinA), page(coinB)]), true);
    assert.equal(result.priceEurMin, 2400);
    assert.equal(result.priceEurMax, 2500);
  });
});
