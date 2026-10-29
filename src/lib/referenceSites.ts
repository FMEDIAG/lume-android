// Dominios de referencia por categoría y construcción de búsquedas multi-consulta con site:
// La IA (xAI / Mistral / Gemini) ejecuta la búsqueda web; nosotros le damos consultas concretas
// restringidas a webs de mercado reales para maximizar comparables verificables.

export type ReferenceSite = {
  /** Hostname sin www (p. ej. "ebay.com") */
  domain: string;
  /** Términos extra para priorizar ventas cerradas o listados útiles */
  soldHint?: string;
};

/** Sitios genéricos cuando la categoría no tiene mapa propio o es "other"/"auto". */
const GENERIC_SITES: ReferenceSite[] = [
  { domain: "ebay.com", soldHint: "sold" },
  { domain: "ebay.es", soldHint: "vendido" },
  { domain: "catawiki.com" },
  { domain: "worthpoint.com" },
];

/** Mapa categoría (clave de detect-category) → webs de referencia prioritarias. */
export const REFERENCE_SITES_BY_CATEGORY: Record<string, ReferenceSite[]> = {
  art: [
    { domain: "artnet.com" },
    { domain: "artsalesindex.artinfo.com" },
    { domain: "invaluable.com" },
    { domain: "catawiki.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  cards: [
    { domain: "scryfall.com" },
    { domain: "cardmarket.com" },
    { domain: "tcgplayer.com" },
    { domain: "mtggoldfish.com" },
    { domain: "pricecharting.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  coins: [
    { domain: "ngccoin.com" },
    { domain: "pcgs.com" },
    { domain: "ha.com" },
    { domain: "numista.com" },
    { domain: "ma-shops.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  stamps: [
    { domain: "stampworld.com" },
    { domain: "colnect.com" },
    { domain: "catawiki.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  watches: [
    { domain: "chrono24.com" },
    { domain: "watchcharts.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
  ],
  jewelry: [
    { domain: "catawiki.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "1stdibs.com" },
    { domain: "worthpoint.com" },
  ],
  electronics: [
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "backmarket.es" },
    { domain: "wallapop.com" },
  ],
  books: [
    { domain: "abebooks.com" },
    { domain: "iberlibro.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
  ],
  "music instrument": [
    { domain: "reverb.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
  ],
  toys: [
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "pricecharting.com" },
    { domain: "catawiki.com" },
  ],
  vinyl: [
    { domain: "discogs.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  fashion: [
    { domain: "vestiairecollective.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "therealreal.com" },
  ],
  sports: [
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
    { domain: "worthpoint.com" },
  ],
  memorabilia: [
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
    { domain: "heritage.com" },
    { domain: "ha.com" },
  ],
  bonsai: [
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
  ],
  wine: [
    { domain: "wine-searcher.com" },
    { domain: "idealwine.com" },
    { domain: "catawiki.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  furniture: [
    { domain: "1stdibs.com" },
    { domain: "catawiki.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "pamono.com" },
  ],
  militaria: [
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
    { domain: "hermann-historica.com" },
  ],
  "luxury bags": [
    { domain: "vestiairecollective.com" },
    { domain: "therealreal.com" },
    { domain: "fashionphile.com" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  minerals: [
    { domain: "mindat.org" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
  ],
  gemstones: [
    { domain: "opalauctions.com" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "catawiki.com" },
  ],
  vehicles: [
    { domain: "mobile.de" },
    { domain: "autoscout24.es" },
    { domain: "coches.net" },
    { domain: "ebay.com", soldHint: "sold" },
    { domain: "bringatrailer.com" },
    { domain: "classic.com" },
  ],
  boats: [
    { domain: "yachtworld.com" },
    { domain: "boat24.com" },
    { domain: "anuncios.net" },
    { domain: "ebay.com", soldHint: "sold" },
  ],
  realestate: [
    { domain: "idealista.com" },
    { domain: "fotocasa.es" },
    { domain: "habitaclia.com" },
    { domain: "rightmove.co.uk" },
    { domain: "zillow.com" },
  ],
  other: GENERIC_SITES,
};

const MAX_BASE_QUERIES = 3;
const MAX_SITES = 4;
const MAX_TOTAL_QUERIES = 10;

function normalizeCategory(category: string | undefined | null): string {
  const c = (category ?? "other").trim().toLowerCase();
  if (!c || c === "auto") return "other";
  return c;
}

function sitesFor(category: string): ReferenceSite[] {
  const key = normalizeCategory(category);
  return REFERENCE_SITES_BY_CATEGORY[key] ?? GENERIC_SITES;
}

/** Limpia una consulta base para combinarla con site: sin comillas rotas. */
function cleanBaseQuery(q: string): string {
  return q
    .replace(/\s+/g, " ")
    .replace(/[«»""]/g, '"')
    .trim()
    .slice(0, 100);
}

/**
 * Construye consultas multi-site a partir de las searchQueries de identificación
 * (o de un resumen corto) y de la categoría del objeto.
 *
 * Ejemplo:
 *   base = ["Rolex Submariner 16610"]
 *   category = "watches"
 *   → ["Rolex Submariner 16610 site:chrono24.com",
 *      "Rolex Submariner 16610 sold site:ebay.com", ...]
 */
export function buildSiteQueries(
  baseQueries: string[],
  category: string | undefined | null,
  fallbackPhrase?: string,
): string[] {
  const bases = baseQueries
    .map(cleanBaseQuery)
    .filter((q) => q.length >= 3)
    .slice(0, MAX_BASE_QUERIES);

  if (bases.length === 0 && fallbackPhrase) {
    const fb = cleanBaseQuery(fallbackPhrase);
    if (fb.length >= 3) bases.push(fb);
  }
  if (bases.length === 0) return [];

  const sites = sitesFor(category).slice(0, MAX_SITES);
  const out: string[] = [];
  const seen = new Set<string>();

  // Primero: cada base × cada site (prioriza las primeras bases y los primeros sites).
  for (const base of bases) {
    for (const site of sites) {
      if (out.length >= MAX_TOTAL_QUERIES) break;
      const hint = site.soldHint ? ` ${site.soldHint}` : "";
      const q = `${base}${hint} site:${site.domain}`;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
    if (out.length >= MAX_TOTAL_QUERIES) break;
  }

  // También una búsqueda abierta (sin site) de la consulta principal, por si hay fuentes fuera del mapa.
  const open = bases[0];
  if (open && out.length < MAX_TOTAL_QUERIES) {
    const key = open.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(open);
    }
  }

  return out;
}

/** Texto que se inyecta en el prompt de tasación para forzar búsquedas site:. */
export function formatSiteSearchInstructions(
  siteQueries: string[],
  lang: "es" | "en",
): string {
  if (siteQueries.length === 0) return "";
  const list = siteQueries.map((q, i) => `${i + 1}. ${q}`).join("\n");
  if (lang === "es") {
    return (
      `\nBÚSQUEDAS OBLIGATORIAS EN WEBS DE REFERENCIA (ejecuta estas consultas con la herramienta de búsqueda web, en este orden; prioriza ventas cerradas sobre anuncios):\n${list}\n` +
      `Para cada resultado útil, anota en "comparables" el título, precio, moneda, kind ("sold" o "asking") y la URL exacta de la página. ` +
      `Si tras estas búsquedas no hay al menos 2 comparables reales, pon confidence "low" y un rango amplio, y dilo en "notes". ` +
      `NUNCA inventes URLs ni precios de anuncios que no hayas visto en los resultados de búsqueda.`
    );
  }
  return (
    `\nMANDATORY SEARCHES ON REFERENCE SITES (run these queries with the web search tool, in this order; prefer closed sales over asking prices):\n${list}\n` +
    `For each useful result, record in "comparables" the title, price, currency, kind ("sold" or "asking") and the exact page URL. ` +
    `If after these searches you do not have at least 2 real comparables, set confidence to "low" and a wide range, and say so in "notes". ` +
    `NEVER invent URLs or listing prices you did not see in the search results.`
  );
}

/** Hostnames de referencia (para mensajes / depuración). */
export function referenceDomainsFor(category: string | undefined | null): string[] {
  return sitesFor(category).map((s) => s.domain);
}
