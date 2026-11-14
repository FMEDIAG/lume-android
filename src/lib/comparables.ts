// Real listings/sales only count when the exact cited page contains the reported amount.
export type Comparable = {
  title: string;
  price: number;
  currency: "EUR" | "USD";
  kind: "sold" | "asking";
  url: string;
};

export type ComparableEvidencePage = { url: string; text: string };

/** Identity of a page: sharing a domain with a cited source is not enough. */
function pageOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid)$/i.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.hostname + u.pathname.replace(/\/$/, "") + u.search;
  } catch {
    return null;
  }
}

function comparableCandidates(raw: unknown, citationUrls: string[]): Comparable[] {
  if (!Array.isArray(raw)) return [];
  const pages = new Set(citationUrls.map(pageOf).filter((p): p is string => !!p));
  if (pages.size === 0) return [];
  const out: Comparable[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const price = typeof c.price === "number" ? c.price : Number(c.price);
    const currency = c.currency === "EUR" || c.currency === "USD" ? c.currency : null;
    const kind = c.kind === "sold" || c.kind === "asking" ? c.kind : null;
    const url = typeof c.url === "string" ? c.url : "";
    const page = pageOf(url);
    if (!currency || !kind || !page || !pages.has(page) || seen.has(page)) continue;
    if (typeof c.title !== "string" || !c.title.trim() || url.length > 200) continue;
    if (!Number.isFinite(price) || price <= 0 || price > 500_000_000) continue;
    seen.add(page);
    out.push({ title: c.title.slice(0, 120), price, currency, kind, url });
  }
  return out;
}

/** Only scrape distinct candidate pages already returned as citations by the search provider. */
export function candidateComparableUrls(raw: unknown, citationUrls: string[]): string[] {
  return comparableCandidates(raw, citationUrls).map((c) => c.url);
}

function parseMoneyAmount(raw: string): number | null {
  const value = raw.replace(/[\s'’\u00a0\u202f]/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  let normalized = value;
  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot);
    normalized = value.slice(0, decimal).replace(/[.,]/g, "") + "." + value.slice(decimal + 1);
  } else {
    const separator = Math.max(comma, dot);
    if (separator >= 0) {
      const decimals = value.length - separator - 1;
      if (decimals === 3) normalized = value.replace(/[.,]/g, "");
      else if (decimals >= 1 && decimals <= 2) {
        normalized = value.slice(0, separator).replace(/[.,]/g, "") + "." + value.slice(separator + 1);
      }
    }
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

/** A price only counts when the cited page spells out that amount in the same currency. */
export function moneyAmountAppearsInText(text: string, price: number, currency: "EUR" | "USD"): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const number = "(?:\\d{1,3}(?:[\\s.,'’\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
  const marker = currency === "EUR" ? "(?:\\bEUR\\b|€)" : "(?:\\bUSD\\b|US\\$|\\$)";
  const pattern = new RegExp("(?:^|[^A-Za-z0-9])" + marker + "\\s*(" + number + ")|(" + number + ")\\s*" + marker + "(?=$|[^A-Za-z0-9])", "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const amount = parseMoneyAmount(match[1] ?? match[2] ?? "");
    if (amount === null) continue;
    if (currency === "USD") {
      const start = match.index ?? 0;
      const nearby = text.slice(Math.max(0, start - 20), Math.min(text.length, start + match[0].length + 20));
      if (/\b(?:CAD|AUD|NZD|SGD|HKD|MXN)\b/i.test(nearby)) continue;
    }
    if (Math.abs(amount - price) <= Math.max(0.01, price * 0.0001)) return true;
  }
  return false;
}

/** A comparable must match both a cited page and an amount visibly present on that page. */
export function verifyComparables(
  raw: unknown,
  citationUrls: string[],
  evidencePages: ComparableEvidencePage[],
): Comparable[] {
  const citations = new Set(citationUrls.map(pageOf).filter((p): p is string => !!p));
  const textByPage = new Map<string, string>();
  for (const evidence of evidencePages) {
    const page = pageOf(evidence.url);
    if (page && citations.has(page) && typeof evidence.text === "string" && evidence.text) {
      textByPage.set(page, evidence.text);
    }
  }
  return comparableCandidates(raw, citationUrls).filter((c) => {
    const page = pageOf(c.url);
    const text = page ? textByPage.get(page) : undefined;
    return !!text && moneyAmountAppearsInText(text, c.price, c.currency);
  });
}

export type ComparableRange = {
  eurMin: number;
  eurMax: number;
  usdMin: number;
  usdMax: number;
  used: Comparable[];
};

/** Range from comparables (minimum 2); discard values far from the median. */
export function rangeFromComparables(
  list: Comparable[],
  eurPerUsd: number,
  minimumComparables = 2,
): ComparableRange | null {
  if (!Number.isFinite(eurPerUsd) || eurPerUsd <= 0) return null;
  const eur = (c: Comparable) => (c.currency === "EUR" ? c.price : c.price * eurPerUsd);
  const sold = list.filter((c) => c.kind === "sold");
  let used = sold.length >= 2 ? sold : list;
  if (used.length >= 3) {
    const sorted = used.map(eur).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    used = used.filter((c) => eur(c) >= median * 0.4 && eur(c) <= median * 2.5);
  }
  if (used.length < minimumComparables || used.length === 0) return null;
  const values = used.map(eur);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return { eurMin: lo, eurMax: hi, usdMin: lo / eurPerUsd, usdMax: hi / eurPerUsd, used };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** With at least two page-verified prices, replace the model's estimate with their range. */
export function anchorToComparables(
  parsed: unknown,
  citationUrls: string[],
  eurPerUsd: number,
  lang: "es" | "en",
  evidencePages: ComparableEvidencePage[],
): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  p.sources = Array.from(new Set(citationUrls.filter((url) => pageOf(url) && url.length <= 200))).slice(0, 8);
  const verified = verifyComparables(p.comparables, citationUrls, evidencePages);
  const range = rangeFromComparables(verified, eurPerUsd);
  if (!range) {
    p.confidence = "low";
    const warning = lang === "es"
      ? "Estimación orientativa: no hay al menos dos precios comparables confirmados en el contenido de páginas citadas; no es un precio de mercado confirmado."
      : "Indicative estimate: fewer than two comparable prices were confirmed in cited page content; this is not a confirmed market price.";
    p.notes = (warning + "\n\n" + (typeof p.notes === "string" ? p.notes : "")).slice(0, 4000);
    return false;
  }

  p.priceEurMin = r2(range.eurMin);
  p.priceEurMax = r2(range.eurMax);
  p.priceUsdMin = r2(range.usdMin);
  p.priceUsdMax = r2(range.usdMax);

  const sold = range.used.filter((c) => c.kind === "sold").length;
  const asking = range.used.length - sold;
  if (asking > 0 && p.confidence === "high") p.confidence = "medium";
  const line = lang === "es"
    ? "Rango calculado a partir de " + range.used.length + " comparables verificados en páginas consultadas (" + sold + " vendidos, " + asking + " a precio pedido), no de una estimación."
    : "Range calculated from " + range.used.length + " comparables verified in consulted pages (" + sold + " sold, " + asking + " asking price), not from an estimate.";
  const notes = typeof p.notes === "string" ? p.notes : "";
  p.notes = (line + (notes ? "\n\n" + notes : "")).slice(0, 4000);
  const own = Array.isArray(p.sources) ? p.sources.filter((x): x is string => typeof x === "string") : [];
  p.sources = Array.from(new Set([...range.used.map((c) => c.url), ...own])).slice(0, 8);
  return true;
}
