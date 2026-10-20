/**
 * APIs gratuitas específicas por categoría de objeto.
 * Se usan PRIMERO antes de recurrir a la IA, para ahorrar créditos.
 */

/**
 * Verificar si la categoría tiene API gratuita disponible
 */
export function hasFreeApi(category: string): boolean {
  const lower = category.toLowerCase();
  const withFreeApi = [
    "coin",
    "coins",
    "numismatic",
    "card",
    "cards",
    "collectible",
    "collectibles",
    "stamps",
    "philately",
    "watches",
    "watch",
    "comics",
    "comic",
    "electronics",
    "vehicle",
    "vehicles",
    "car",
    "cars",
    "boats",
    "boat",
  ];
  const noFreeApi = ["real_estate", "property", "house", "apartment", "bonsai", "plant", "other"];

  if (noFreeApi.some(kw => lower.includes(kw))) return false;
  if (withFreeApi.some(kw => lower.includes(kw))) return true;
  return true;
}

/**
 * Scryfall API - Cartas coleccionables
 * Gratuita, 60 requests/minute, sin clave API requerida.
 */
export async function getCardPriceScryfall(cardName: string): Promise<any> {
  try {
    const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cardName)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.object !== "card") return null;
    return {
      exists: data.prices ? true : false,
      usd: data.prices?.usd ? parseFloat(data.prices.usd) : undefined,
      usdFoil: data.prices?.usd_foil ? parseFloat(data.prices.usd_foil) : undefined,
      eur: data.prices?.eur ? parseFloat(data.prices.eur) : undefined,
      eurFoil: data.prices?.eur_foil ? parseFloat(data.prices.eur_foil) : undefined,
    };
  } catch (e) {
    console.error("Scryfall error:", e);
    return null;
  }
}

/**
 * eBay completed items search (basic, no API key required)
 * Usado para: vehículos, electrónica, artículos diversos
 */
export async function searcheBayCompleted(query: string): Promise<any[]> {
  try {
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_COMPLETED=1&_ipg=10`;
    const res = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results: any[] = [];
    const titleMatches = html.match(/<h3 class="s-item__title[^"]*">([^<]+)<\/h3>/gi) || [];
    const priceMatches = html.match(/<span class="s-item__price[^"]*">([^<]+)<\/span>/gi) || [];
    const linkMatches = html.match(/<a class="s-item__link[^"]*" href="([^"]+)"/gi) || [];

    const limit = Math.min(5, titleMatches.length);
    for (let i = 0; i < limit; i++) {
      const title = titleMatches[i] ? titleMatches[i].replace(/<[^>]+>/g, "").trim() : "";
      const price = priceMatches[i]
        ? priceMatches[i].replace(/<[^>]+>/g, "").replace(/[^\d.,]/g, "").trim()
        : "0";
      const link = linkMatches[i]
        ? linkMatches[i].replace(/<[^>]+>/g, "").replace(/"/g, "").trim()
        : "";
      if (title && price) {
        results.push({ title, price, link });
      }
    }
    return results;
  } catch (e) {
    console.error("eBay search failed:", e);
    return [];
  }
}

/**
 * Datos aproximados de relojes
 */
export function getWatchPriceEstimate(brand: string, model: string): any {
  const database: any = {
    "rolex-submariner": { priceRangeUsd: [8000, 15000], material: "Acero", movement: "Automático" },
    "omega-seamaster": { priceRangeUsd: [3000, 6000], material: "Acero", movement: "Automático" },
  };
  const key = `${brand.toLowerCase()}-${model.toLowerCase()}`;
  if (database[key]) return database[key];
  return { priceRangeUsd: [200, 2000], material: "Desconocido", movement: "Desconocido" };
}

/**
 * Precio de comic
 */
export function getComicPrice(comicTitle: string): any {
  const database: any = {
    "spider-man-first": { title: "Spider-Man #1", priceGuideUsd: 1000, firstAppearance: "Amazing Fantasy #15", grade: "NM" },
    "batman-first": { title: "Batman #1", priceGuideUsd: 850, firstAppearance: "Batman #1", grade: "NM" },
  };
  const key = comicTitle.toLowerCase().replace(/[^a-z0-9]/g, "-");
  if (database[key]) return database[key];
  return null;
}

/**
 * Precio de sello
 */
export function getStampPrice(country: string, year: number, description: string): any {
  const database: any = {
    "us-1918-1": { country: "US", year: 1918, description: "Woodrow Wilson 1 centavo", priceUsd: 0.50 },
    "es-1940-1": { country: "ES", year: 1940, description: "Franco 1 peseta", priceUsd: 0.25 },
  };
  const key = `${country.toLowerCase()}-${year}-1`;
  if (database[key]) return database[key];
  return { country, year, description, priceUsd: 0.10 };
}