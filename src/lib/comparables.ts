// Precios encontrados de verdad (anuncios o ventas) mandan sobre el precio estimado por la IA.
// Solo se aceptan comparables cuya página aparece entre las que la búsqueda web consultó de verdad:
// así la IA no puede inventarse un anuncio para "justificar" un precio.

export type Comparable = {
  title: string;
  price: number;
  currency: "EUR" | "USD";
  kind: "sold" | "asking";
  url: string;
};

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Se queda con los comparables bien formados cuya web figura entre las páginas consultadas. */
export function verifyComparables(raw: unknown, citationUrls: string[]): Comparable[] {
  if (!Array.isArray(raw)) return [];
  const hosts = new Set(citationUrls.map(hostOf).filter((h): h is string => !!h));
  if (hosts.size === 0) return [];
  const out: Comparable[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const price = typeof c.price === "number" ? c.price : Number(c.price);
    const currency = c.currency === "EUR" || c.currency === "USD" ? c.currency : null;
    const kind = c.kind === "sold" ? "sold" : "asking";
    const url = typeof c.url === "string" ? c.url : "";
    const host = hostOf(url);
    if (!currency || !host || !hosts.has(host)) continue;
    if (!Number.isFinite(price) || price <= 0 || price > 500_000_000) continue;
    out.push({
      title: typeof c.title === "string" ? c.title.slice(0, 120) : "",
      price,
      currency,
      kind,
      url: url.slice(0, 200),
    });
  }
  return out;
}

export type ComparableRange = {
  eurMin: number;
  eurMax: number;
  usdMin: number;
  usdMax: number;
  used: Comparable[];
};

/** Rango a partir de los comparables (mínimo 2). Descarta valores muy fuera de la mediana. */
export function rangeFromComparables(
  list: Comparable[],
  eurPerUsd: number,
): ComparableRange | null {
  const eur = (c: Comparable) => (c.currency === "EUR" ? c.price : c.price * eurPerUsd);
  let used = list;
  if (used.length >= 3) {
    const sorted = used.map(eur).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    used = used.filter((c) => eur(c) >= median * 0.4 && eur(c) <= median * 2.5);
  }
  if (used.length < 2) return null;
  const values = used.map(eur);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi <= lo) {
    lo *= 0.9;
    hi *= 1.1;
  }
  return { eurMin: lo, eurMax: hi, usdMin: lo / eurPerUsd, usdMax: hi / eurPerUsd, used };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Si hay al menos 2 comparables verificados, el rango sale de ellos (no de la estimación de la IA)
 * y sus páginas pasan a encabezar las referencias. Devuelve true si se ha aplicado.
 */
export function anchorToComparables(
  parsed: unknown,
  citationUrls: string[],
  eurPerUsd: number,
  lang: "es" | "en",
): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  const verified = verifyComparables(p.comparables, citationUrls);
  const range = rangeFromComparables(verified, eurPerUsd);
  if (!range) return false;

  p.priceEurMin = r2(range.eurMin);
  p.priceEurMax = r2(range.eurMax);
  p.priceUsdMin = r2(range.usdMin);
  p.priceUsdMax = r2(range.usdMax);

  const sold = range.used.filter((c) => c.kind === "sold").length;
  const asking = range.used.length - sold;
  const line =
    lang === "es"
      ? `Rango calculado a partir de ${range.used.length} comparables encontrados en internet (${sold} vendidos, ${asking} a precio pedido), no de una estimación.`
      : `Range calculated from ${range.used.length} comparables found online (${sold} sold, ${asking} asking price), not from an estimate.`;
  const notes = typeof p.notes === "string" ? p.notes : "";
  p.notes = (line + (notes ? "\n\n" + notes : "")).slice(0, 4000);

  const own = Array.isArray(p.sources)
    ? p.sources.filter((x): x is string => typeof x === "string")
    : [];
  p.sources = Array.from(new Set([...range.used.map((c) => c.url), ...own])).slice(0, 8);
  return true;
}
