// Botones de "Referencias": nombre corto + enlace. Se usa en el resultado y en el historial.

// Solo se abren direcciones http(s): las referencias vienen de la IA y no son de fiar.
function asWebUrl(source: string): URL | null {
  try {
    const u = new URL(source.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Nombre corto para el botón: la web si es una dirección; si no, el nombre sin los detalles. */
export function sourceLabel(source: string): string {
  const url = asWebUrl(source);
  if (url) return url.hostname.replace(/^www\./, "");
  const short = source.split(/\s[-–—|]\s|\s\(|:\s/)[0].trim() || source.trim();
  return short.length > 32 ? short.slice(0, 31).trimEnd() + "…" : short;
}

// Las webs de cartas solo entienden el nombre ("Mox Sapphire"), no "nombre — edición #nº".
function cardName(title: string): string {
  return title.split(/\s[—–]\s/)[0].trim() || title.trim();
}

/** A dónde lleva el botón: la página exacta si es una dirección; si no, una búsqueda del objeto. */
export function sourceUrl(source: string, query: string): string {
  const direct = asWebUrl(source);
  if (direct) return direct.href;
  const q = encodeURIComponent(query);
  const card = encodeURIComponent(cardName(query));
  const s = source.toLowerCase();
  if (s.includes("ebay")) return `https://www.ebay.com/sch/i.html?_nkw=${q}`;
  if (s.includes("wikipedia")) return `https://en.wikipedia.org/wiki/Special:Search?search=${q}`;
  if (s.includes("catawiki")) return `https://www.catawiki.com/en/search?query=${q}`;
  if (s.includes("worthpoint")) return `https://www.worthpoint.com/search?q=${q}`;
  if (s.includes("heritage")) return `https://www.ha.com/search?search=${q}`;
  if (s.includes("chrono24")) return `https://www.chrono24.com/search/index.htm?query=${q}`;
  if (s.includes("discogs")) return `https://www.discogs.com/search/?q=${q}`;
  if (s.includes("scryfall")) return `https://scryfall.com/search?q=${card}&unique=prints`;
  if (s.includes("tcgplayer")) return `https://www.tcgplayer.com/search/all/product?q=${card}`;
  if (s.includes("cardmarket"))
    return `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${card}`;
  if (s.includes("mtggoldfish")) return `https://www.mtggoldfish.com/q?query_string=${card}`;
  if (s.includes("pricecharting"))
    return `https://www.pricecharting.com/search-products?type=videogames&q=${q}`;
  return `https://www.google.com/search?q=${encodeURIComponent(query + " " + source)}`;
}
