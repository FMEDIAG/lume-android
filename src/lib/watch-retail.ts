// Relojes: precio de TIENDA actual (distribuidor / boutique), nunca segunda mano.
// Flujo: leer la referencia exacta → buscar con Firecrawl anuncios de tiendas → extraer
// precios solo de páginas consultadas de verdad → calcular rango. Sin datos fiables, no hay cifra.

const GATEWAY = "https://connector-gateway.lovable.dev/firecrawl/v2";

// Mercados de segunda mano, subastas y agregadores: no son precio de tienda.
const SECOND_HAND_RE =
  /(ebay\.|wallapop|vinted|milanuncios|catawiki|watchcharts|chrono24|subito\.|kleinanzeigen|leboncoin|todocoleccion|reddit\.|forum|youtube\.|instagram\.|facebook\.|pinterest\.|wikipedia\.|watchuseek|hodinkee\.com\/articles|bobswatches|crownandcaliber|watchfinder|liveauctioneers|invaluable|sothebys|christies|phillips\.com|bonhams|heritage)/i;
const USED_TEXT_RE = /\b(pre-?owned|second[- ]hand|segunda mano|usado|used|vintage|ocasi[oó]n)\b/i;

export function normRef(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** La página menciona la referencia exacta (ignorando espacios, guiones y puntos). */
export function mentionsReference(text: string, reference: string): boolean {
  const ref = normRef(reference);
  if (ref.length < 4) return false;
  return normRef(text).includes(ref);
}

/**
 * Referencia escrita por el usuario en el contexto (p. ej. "Q169242J", "126610LN", "5711/1A-010").
 * Solo acepta códigos con letras y números mezclados, o un número tras "ref"/"referencia".
 * Descarta años, fechas, quilates, medidas e importes.
 */
export function referenceFromContext(context: string): string | null {
  const tokens = (context || "").split(/[\s,;:()"\u201c\u201d]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (t.length < 4 || t.length > 20 || !/\d/.test(t)) continue;
    if (/^\d{4}$/.test(t)) continue; // años
    if (/^\d+([.,]\d+)?(k|kt|mm|cm|g|gr|m|eur|usd)$/i.test(t)) continue; // 18k, 41mm, 65000eur
    const prev = (tokens[i - 1] ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const afterLabel = /^(ref|referencia|reference|modelo)$/.test(prev) && /^\d{4,}$/.test(t);
    if (afterLabel) return t;
    if (/^[\d.,\-\/]+$/.test(t)) continue; // fechas, importes, decimales
    if (/[A-Za-z]/.test(t)) return t; // mezcla de letras y números
  }
  return null;
}

export function isRetailUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return !SECOND_HAND_RE.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

// Segunda mano: valen mercados y casas de subastas, pero no foros, redes ni vídeos.
const NOT_A_LISTING_RE =
  /(reddit\.|forum|youtube\.|instagram\.|facebook\.|pinterest\.|tiktok\.|twitter\.|wikipedia\.|watchuseek)/i;

/** Página que puede contener un anuncio o venta de segunda mano (no foros, redes ni vídeos). */
export function isPreOwnedSourceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return !NOT_A_LISTING_RE.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

/** Acorta unas notas largas sin cortar a mitad de frase. */
export function trimNotes(text: string, max = 420): string {
  const s = (text || "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const idx = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return idx > 80 ? cut.slice(0, idx + 1) : `${cut.trimEnd()}…`;
}

/**
 * Limpia la identificación de un reloj sin precio de tienda: quita el estado aparente (no se ve
 * en una foto), las referencias alternativas entre paréntesis y, si la referencia no está
 * confirmada, no la llama "exacta".
 */
export function cleanWatchIdentification(text: string, referenceUncertain: boolean): string {
  let s = (text || "")
    .replace(/\s*(Estado aparente|Apparent condition|Estado|Condition)\s*:[^.\n]*\.?/gi, "")
    .replace(/\s*\((o|or)\s+[A-Za-z0-9][A-Za-z0-9.\-\/ ]{3,24}\)/g, "");
  if (referenceUncertain) {
    s = s
      .replace(/referencia exacta/gi, "referencia probable")
      .replace(/exact reference/gi, "probable reference");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

/** ¿Aparece ese importe escrito en la página? Evita precios inventados por el modelo. */
export function priceAppearsInText(text: string, price: number): boolean {
  if (!(price > 0)) return false;
  const digits = text.replace(/[^\d]/g, " ");
  const whole = String(Math.round(price));
  const compact = text.replace(/[.,'\s\u00a0\u202f]/g, "");
  return compact.includes(whole) || digits.includes(whole);
}

export type RetailListing = {
  url: string;
  title: string;
  price: number;
  currency: "EUR" | "USD";
};

export function retailRange(
  listings: RetailListing[],
  eurPerUsd: number,
): { eurMin: number; eurMax: number; usdMin: number; usdMax: number } | null {
  const eur = listings
    .map((l) => (l.currency === "EUR" ? l.price : l.price * eurPerUsd))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (eur.length === 0) return null;
  // Descarta extremos claramente fuera de la mediana (errores de página o variantes).
  const med = eur[Math.floor(eur.length / 2)];
  const kept = eur.filter((n) => n >= med * 0.6 && n <= med * 1.6);
  const eurMin = Math.round(kept[0]);
  const eurMax = Math.round(kept[kept.length - 1]);
  return {
    eurMin,
    eurMax,
    usdMin: Math.round(eurMin / eurPerUsd),
    usdMax: Math.round(eurMax / eurPerUsd),
  };
}

export type SearchPage = { url: string; title: string; markdown: string };

/** Restrict cited-page fetches to ordinary public HTTPS hostnames. */
export function isSafeCitationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const ipv4 = host.split(".");
  const isIpv4 = ipv4.length === 4 && ipv4.every((part) => {
    const value = Number(part);
    return part.length > 0 && Number.isInteger(value) && value >= 0 && value <= 255;
  });
  return parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    (!parsed.port || parsed.port === "443") &&
    host.includes(".") &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    !host.endsWith(".local") &&
    !host.endsWith(".internal") &&
    !isIpv4 &&
    !host.startsWith("[");
}

/** Scrape a cited page through the existing gateway; never fetch model URLs directly. */
export async function firecrawlScrape(url: string, signal: AbortSignal): Promise<SearchPage | null> {
  if (!isSafeCitationUrl(url)) return null;
  const lovableKey = process.env.LOVABLE_API_KEY;
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!lovableKey || !fcKey) return null;
  const res = await fetch(GATEWAY + "/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + lovableKey,
      "X-Connection-Api-Key": fcKey,
    },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, storeInCache: false }),
    signal,
  });
  if (!res.ok) {
    console.error("[citation] Firecrawl scrape failed [" + res.status + "]");
    return null;
  }
  const json = (await res.json()) as {
    data?: { markdown?: unknown; metadata?: { title?: unknown; statusCode?: unknown } };
  };
  const statusCode = Number(json.data?.metadata?.statusCode ?? 0);
  if (statusCode >= 400) return null;
  const markdown = typeof json.data?.markdown === "string" ? json.data.markdown.slice(0, 50_000) : "";
  if (!markdown) return null;
  return { url, title: String(json.data?.metadata?.title ?? "").slice(0, 200), markdown };
}


export async function firecrawlSearch(query: string, signal: AbortSignal): Promise<SearchPage[]> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!lovableKey || !fcKey) throw new Error("firecrawl not configured");
  const res = await fetch(`${GATEWAY}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": fcKey,
    },
    body: JSON.stringify({
      query,
      limit: 8,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[watch-retail] Firecrawl search [${res.status}]: ${body.slice(0, 300)}`);
    throw new Error(`firecrawl ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: unknown;
  };
  const raw = Array.isArray(json.data)
    ? json.data
    : ((json.data as { web?: unknown[] } | undefined)?.web ?? []);
  return (raw as Array<Record<string, unknown>>)
    .map((r) => ({
      url: String(r.url ?? (r.metadata as { sourceURL?: string } | undefined)?.sourceURL ?? ""),
      title: String(r.title ?? (r.metadata as { title?: string } | undefined)?.title ?? ""),
      markdown: String(r.markdown ?? r.description ?? ""),
    }))
    .filter((p) => p.url);
}

/** Recorta la página alrededor de las menciones de la referencia, para el extractor. */
export function excerptAround(markdown: string, reference: string, max = 2500): string {
  const ref = reference.toLowerCase();
  const lower = markdown.toLowerCase();
  const idx = lower.indexOf(ref);
  const start = Math.max(0, (idx >= 0 ? idx : 0) - 600);
  return markdown.slice(start, start + max);
}
