import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPreOwnedSourceUrl,
  cleanWatchIdentification,
  isRetailUrl,
  mentionsReference,
  priceAppearsInText,
  referenceFromContext,
  retailRange,
  trimNotes,
  isSafeCitationUrl,
  firecrawlSearch,
  firecrawlScrape,
} from "./watch-retail";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("watch retail", () => {
  it("only allows public HTTPS citation URLs for scraping", () => {
    expect(isSafeCitationUrl("https://example.com/item/1")).toBe(true);
    expect(isSafeCitationUrl("http://example.com/item/1")).toBe(false);
    expect(isSafeCitationUrl("https://localhost/item/1")).toBe(false);
    expect(isSafeCitationUrl("https://127.0.0.1/item/1")).toBe(false);
    expect(isSafeCitationUrl("https://192.168.1.5/item/1")).toBe(false);
    expect(isSafeCitationUrl("https://example.com:8443/item/1")).toBe(false);
    expect(isSafeCitationUrl("https://user:pass@example.com/item/1")).toBe(false);
  });
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
  it("en segunda mano acepta mercados y descarta foros y redes", () => {
    expect(isPreOwnedSourceUrl("https://www.chrono24.es/jaeger-lecoultre/ref-q169242j.htm")).toBe(true);
    expect(isPreOwnedSourceUrl("https://www.ebay.com/itm/123")).toBe(true);
    expect(isPreOwnedSourceUrl("https://www.reddit.com/r/Watches/comments/x")).toBe(false);
    expect(isPreOwnedSourceUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
  });
  it("limpia la identificación: sin estado, sin alternativas y sin llamar exacta a una referencia dudosa", () => {
    const raw =
      "Reloj Seiko 5 Sports, referencia exacta SRPD53K1 (o SBSA003). Caja de acero. Estado aparente: Impecable / Mint.";
    const out = cleanWatchIdentification(raw, true);
    expect(out).toBe("Reloj Seiko 5 Sports, referencia probable SRPD53K1. Caja de acero.");
    expect(cleanWatchIdentification(raw, false)).toContain("referencia exacta SRPD53K1");
  });
  it("acorta notas largas en el final de una frase", () => {
    const long = "Primera frase corta. ".repeat(40);
    const out = trimNotes(long, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".")).toBe(true);
    expect(trimNotes("Nota breve.", 120)).toBe("Nota breve.");
  });
});

describe("Firecrawl API", () => {
  it("uses Firecrawl v2 directly for search with its own key", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-test-key");
    vi.stubEnv("LOVABLE_API_KEY", "legacy-lovable-key");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { web: [{ url: "https://shop.example/item", title: "Watch", markdown: "Price: 1000 EUR" }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pages = await firecrawlSearch("Rolex Submariner", new AbortController().signal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/search");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Authorization")).toBe("Bearer firecrawl-test-key");
    expect(new Headers(request.headers).has("X-Connection-Api-Key")).toBe(false);
    expect(JSON.parse(String(request.body))).toMatchObject({
      query: "Rolex Submariner",
      limit: 8,
      scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true },
    });
    expect(pages).toEqual([{ url: "https://shop.example/item", title: "Watch", markdown: "Price: 1000 EUR" }]);
  });

  it("uses Firecrawl v2 directly to scrape cited pages", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ success: true, data: { markdown: "Price: 1000 EUR", metadata: { title: "Watch" } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await firecrawlScrape("https://shop.example/item", new AbortController().signal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/scrape");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Authorization")).toBe("Bearer firecrawl-test-key");
    expect(page).toEqual({ url: "https://shop.example/item", title: "Watch", markdown: "Price: 1000 EUR" });
  });
});