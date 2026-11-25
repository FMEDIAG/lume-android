import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  chatCompletion,
  clientIp,
  getMetalSpots,
  isAllowedOrigin,
  requestOriginHost,
  roundMoney,
  type MetalSpots,
} from "@/lib/lume-ai";
import { anchorToComparables } from "@/lib/comparables";
import { positivePrices } from "@/lib/positive-prices";
import { capConfidenceForMissing, keyDataPrompt } from "@/lib/key-data";
import { buildFichaQueries, buildSiteQueries, formatSiteSearchInstructions, REFERENCE_SITES_BY_CATEGORY } from "@/lib/referenceSites";
import {
  cleanWatchIdentification,
  trimNotes,
  isPreOwnedSourceUrl,
  excerptAround,
  firecrawlSearch,
  referenceFromContext,
  isRetailUrl,
  mentionsReference,
  normRef,
  priceAppearsInText,
  retailRange,
  type RetailListing,
  type SearchPage,
} from "@/lib/watch-retail";
import {
  applyCoinPriceGuards,
  typicalFineWeightG,
  type CoinCertifier,
  type CoinId,
  type CoinMarketType,
  type CoinMetal,
} from "@/lib/coin-floors";

const MAX_PHOTO_CHARS = 1_500_000;
const MAX_TOTAL_PHOTO_CHARS = 6_000_000;

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const PhotoSchema = z.object({
  dataUrl: z
    .string()
    .max(MAX_PHOTO_CHARS, "Photo too large")
    .regex(DATA_URL_RE, "Unsupported or malformed image data URL"),
});

const InputSchema = z
  .object({
    photos: z.array(PhotoSchema).min(1).max(3),
    context: z.string().trim().max(500).optional().default(""),
    category: z.string().max(50).optional().default("auto"),
    condition: z.string().max(30).optional().default("unknown"),
    lang: z.enum(["es", "en"]).default("es"),
  })
  .refine(
    (val) => val.photos.reduce((sum, p) => sum + p.dataUrl.length, 0) <= MAX_TOTAL_PHOTO_CHARS,
    { message: "Total photo payload too large" },
  );

const ResultSchema = z.object({
  title: z.string().max(200),
  identification: z.string().max(2000),
  priceEurMin: z.coerce.number().finite().nonnegative().max(500_000_000),
  priceEurMax: z.coerce.number().finite().nonnegative().max(500_000_000),
  priceUsdMin: z.coerce.number().finite().nonnegative().max(500_000_000),
  priceUsdMax: z.coerce.number().finite().nonnegative().max(500_000_000),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().max(4000),
  sources: z.array(z.string().max(200)).max(8),
});

export type ValuationResult = z.infer<typeof ResultSchema>;

const RATE_LIMIT_MAX = 8;
const RATE_LIMIT_WINDOW_MS = 60_000;
const GLOBAL_MAX = 200;
const MAX_TRACKED_KEYS = 5_000;

const rateBuckets = new Map<string, number[]>();
let globalHits: number[] = [];
let lastSweep = Date.now();

function sweepStaleBuckets(now: number) {
  if (now - lastSweep < RATE_LIMIT_WINDOW_MS) return;
  lastSweep = now;
  for (const [key, arr] of rateBuckets) {
    const fresh = arr.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(key);
    else rateBuckets.set(key, fresh);
  }
  if (rateBuckets.size > MAX_TRACKED_KEYS) {
    const excess = rateBuckets.size - MAX_TRACKED_KEYS;
    let i = 0;
    for (const key of rateBuckets.keys()) {
      if (i++ >= excess) break;
      rateBuckets.delete(key);
    }
  }
}

function pruneAndCheck(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweepStaleBuckets(now);
  const arr = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

function checkGlobal(): boolean {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (globalHits.length >= GLOBAL_MAX) return false;
  globalHits.push(now);
  return true;
}

function toNumberLoose(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val !== "string") return NaN;
  const cleaned = val.trim();
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) normalized = cleaned.replace(/\./g, "").replace(",", ".");
    else normalized = cleaned.replace(/,/g, "");
  } else if (lastComma > -1) {
    normalized = cleaned.replace(",", ".");
  }
  return parseFloat(normalized);
}

function isCoinValuation(category: string, context: string): boolean {
  const blob = `${category} ${context}`.toLowerCase();
  return (
    category === "coins" ||
    /\b(coin|coins|moneda|monedas|billete|billetes|banknote|numismatic|numismática|numismatica|ngc|pcgs|escudo|escudos|onza|doubloon|peseta|pesetas)\b/.test(
      blob,
    )
  );
}

const CoinIdSchema = z.object({
  title: z.string().max(200),
  country: z.coerce.string().max(80).optional().default(""),
  denomination: z.coerce.string().max(80).optional().default(""),
  year: z.coerce.string().max(40).optional().default(""),
  mint: z.coerce.string().max(40).optional().default(""),
  seriesName: z.coerce.string().max(160).optional().default(""),
  metal: z.enum([
    "gold",
    "silver",
    "platinum",
    "copper",
    "bimetallic",
    "paper",
    "unknown",
  ]) as z.ZodType<CoinMetal>,
  estimatedFineWeightG: z.number().finite().nonnegative().max(2000).nullable().optional(),
  platedOrFilled: z.boolean().optional().default(false),
  certifier: z.enum(["NGC", "PCGS", "ANACS", "ICG", "none", "unknown"]) as z.ZodType<CoinCertifier>,
  grade: z.coerce.string().max(40).nullable().optional(),
  certNumber: z.coerce.string().max(40).nullable().optional(),
  isLikelyReproduction: z.boolean().optional().default(false),
  marketType: z
    .enum(["bullion", "numismatic", "unknown"])
    .optional()
    .default("unknown") as z.ZodType<CoinMarketType>,
  identification: z.string().max(2000),
  searchQuery: z.string().max(220),
  confidence: z.enum(["low", "medium", "high"]),
});

const CoinPriceSchema = z.object({
  meltEur: z.number().finite().nonnegative().max(500_000_000),
  meltUsd: z.number().finite().nonnegative().max(500_000_000),
  marketEurMin: z.number().finite().nonnegative().max(500_000_000),
  marketEurMax: z.number().finite().nonnegative().max(500_000_000),
  marketUsdMin: z.number().finite().nonnegative().max(500_000_000),
  marketUsdMax: z.number().finite().nonnegative().max(500_000_000),
  notes: z.string().max(4000),
  sources: z.array(z.string().max(200)).max(8),
  comparable: z.string().max(400).optional().default(""),
  comparables: z.array(z.unknown()).max(12).optional().default([]),
});

function photoContent(photos: Array<{ dataUrl: string }>, text: string) {
  return [
    { type: "text", text },
    ...photos.map((p) => ({
      type: "image_url",
      image_url: { url: p.dataUrl, detail: "high" },
    })),
  ];
}

const CardIdSchema = z.object({
  isMagic: z.boolean().catch(false),
  name: z.string().max(200).catch(""),
  setCode: z.string().max(10).nullish().catch(null),
  collectorNumber: z.string().max(12).nullish().catch(null),
  foil: z.boolean().nullish().catch(null),
  confidence: z.enum(["low", "medium", "high"]).catch("low"),
});
type CardId = z.infer<typeof CardIdSchema>;

const SCRYFALL_HEADERS = {
  "User-Agent": "Lume/1.0 (https://lume-tasa.lovable.app)",
  Accept: "application/json;q=0.9,*/*;q=0.8",
};

// Cambio aproximado, solo se usa si Scryfall trae precio en una moneda y no en la otra.
const EUR_PER_USD_APPROX = 0.86;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scryfallGet(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { headers: SCRYFALL_HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normName(n: string): string {
  return n
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priceOf(card: any, foil: boolean): { eur: number | null; usd: number | null } {
  const p = card?.prices ?? {};
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n > 0 ? n : null;
  };
  const eurN = num(p.eur);
  const eurF = num(p.eur_foil) ?? num(p.eur_etched);
  const usdN = num(p.usd);
  const usdF = num(p.usd_foil) ?? num(p.usd_etched);
  let eur = foil ? eurF : eurN;
  let usd = foil ? usdF : usdN;
  if (eur == null && usd == null) {
    eur = foil ? eurN : eurF;
    usd = foil ? usdN : usdF;
  }
  return { eur, usd };
}

function fillBoth(eur: number | null, usd: number | null): { eur: number; usd: number } {
  if (eur != null && usd != null) return { eur, usd };
  if (eur != null) return { eur, usd: eur / EUR_PER_USD_APPROX };
  return { eur: (usd as number) * EUR_PER_USD_APPROX, usd: usd as number };
}

async function identifyMagicCard(data: z.infer<typeof InputSchema>): Promise<CardId | null> {
  const system = `You identify trading cards from photos. Do NOT give a price.
Decide whether the card is a Magic: The Gathering card. Read the printed card name exactly. On modern Magic cards the bottom-left corner shows the collector number (for example 0007 or 359) and the set code (for example FRA) with the language: report them if legible, otherwise null. Set foil to true only if the card visibly has a foil/holographic finish, false if it clearly does not, null if unsure.
Return ONLY JSON with: isMagic (boolean), name (string), setCode (string or null, lowercase), collectorNumber (string or null, without leading zeros), foil (boolean or null), confidence ("low"|"medium"|"high").`;
  const user = "Identify this card. User context: " + (data.context || "(none)");

  const { text } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: photoContent(data.photos, user) },
    ],
    json: true,
    search: false,
    timeoutMs: 40_000,
    maxTokens: 500,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.collectorNumber === "number") raw.collectorNumber = String(raw.collectorNumber);

  const id = CardIdSchema.parse(raw);
  if (!id.isMagic || !id.name.trim()) return null;
  return id;
}

async function tryMagicCard(data: z.infer<typeof InputSchema>): Promise<ValuationResult | null> {
  const id = await identifyMagicCard(data);
  if (!id) return null;

  const foil = id.foil === true;
  const setCode = (id.setCode ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const cn = (id.collectorNumber ?? "").trim().replace(/^0+(?=\d)/, "");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chosen: any = null;
  let exact = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prints: any[] = [];

  // 1) Edición y número leídos de la carta: búsqueda directa e inequívoca.
  if (setCode && cn) {
    const card = await scryfallGet(
      `https://api.scryfall.com/cards/${encodeURIComponent(setCode)}/${encodeURIComponent(cn)}`,
    );
    if (card?.object === "card" && namesMatch(String(card.name ?? ""), id.name)) {
      chosen = card;
      exact = true;
    }
  }

  // 2) Si no, buscamos por nombre y miramos todas las ediciones existentes.
  if (!chosen) {
    const named = await scryfallGet(
      `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(id.name)}`,
    );
    if (!named || named.object !== "card") return null;
    if (named.prints_search_uri) {
      const list = await scryfallGet(String(named.prints_search_uri));
      if (list && Array.isArray(list.data)) {
        prints = list.data.filter((c: { games?: string[] }) =>
          Array.isArray(c.games) ? c.games.includes("paper") : true,
        );
      }
    }
    if (prints.length === 0) prints = [named];

    if (setCode) {
      const matches = prints.filter(
        (c) => c.set === setCode && (!cn || String(c.collector_number) === cn),
      );
      if (matches.length === 1) {
        chosen = matches[0];
        exact = true;
      } else if (matches.length > 1) {
        prints = matches;
      }
    }
  }

  const es = data.lang === "es";

  if (exact && chosen) {
    const p = priceOf(chosen, foil);
    if (p.eur == null && p.usd == null) return null;
    const { eur, usd } = fillBoth(p.eur, p.usd);
    const setLabel = `${chosen.set_name} (${String(chosen.set).toUpperCase()}) #${chosen.collector_number}`;
    return ResultSchema.parse({
      title: `${chosen.name} — ${chosen.set_name} #${chosen.collector_number}`.slice(0, 200),
      identification: `${chosen.name} — ${setLabel}, ${chosen.rarity}${foil ? ", foil" : ""}`.slice(0, 2000),
      priceEurMin: roundMoney(eur * 0.85),
      priceEurMax: roundMoney(eur * 1.15),
      priceUsdMin: roundMoney(usd * 0.85),
      priceUsdMax: roundMoney(usd * 1.15),
      confidence: id.confidence === "low" ? "medium" : "high",
      notes: es
        ? `Precio de referencia de mercado (Cardmarket en EUR y TCGplayer en USD, vía Scryfall) para ${setLabel}${foil ? ", foil" : ""}, en estado casi perfecto (NM). Ajusta según el estado real de la carta.`
        : `Market reference price (Cardmarket in EUR and TCGplayer in USD, via Scryfall) for ${setLabel}${foil ? ", foil" : ""}, in near mint (NM) condition. Adjust for the actual condition of the card.`,
      sources: ["Scryfall", "Cardmarket (EUR)", "TCGplayer (USD)"],
    });
  }

  // Edición no determinada: rango entre la más barata y el tercer cuartil de las ediciones.
  // Cada edición aporta su pareja EUR/USD (si falta una moneda, se convierte desde la otra): así
  // los dos rangos salen de las mismas ediciones y son coherentes entre sí.
  const eurs: number[] = [];
  const usds: number[] = [];
  for (const c of prints) {
    const p = priceOf(c, foil);
    if (p.eur == null && p.usd == null) continue;
    const both = fillBoth(p.eur, p.usd);
    eurs.push(both.eur);
    usds.push(both.usd);
  }
  if (eurs.length === 0) return null;
  eurs.sort((a, b) => a - b);
  usds.sort((a, b) => a - b);
  const q = (arr: number[], frac: number): number | null =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * frac))] : null;
  const low = fillBoth(q(eurs, 0), q(usds, 0));
  const high = fillBoth(q(eurs, 0.75), q(usds, 0.75));
  // Con una o dos ediciones el mínimo y el máximo coinciden: se abre ±15 %, como en la edición exacta.
  const widen = (lo: number, hi: number): [number, number] =>
    hi > lo ? [lo, hi] : [lo * 0.85, hi * 1.15];
  const [eurLo, eurHi] = widen(low.eur, high.eur);
  const [usdLo, usdHi] = widen(low.usd, high.usd);
  const cardName = String(prints[0]?.name ?? id.name);

  return ResultSchema.parse({
    title: cardName.slice(0, 200),
    identification: (es
      ? `${cardName} — edición no determinada (${prints.length} versiones)`
      : `${cardName} — edition not determined (${prints.length} versions)`
    ).slice(0, 2000),
    priceEurMin: roundMoney(eurLo),
    priceEurMax: roundMoney(eurHi),
    priceUsdMin: roundMoney(usdLo),
    priceUsdMax: roundMoney(usdHi),
    confidence: prints.length > 3 ? "low" : "medium",
    notes: es
      ? `No se pudo fijar la edición exacta. El rango va desde la versión más barata hasta el tercer cuartil de las ${prints.length} versiones existentes (Cardmarket y TCGplayer, vía Scryfall). Indica la edición o el número de colección en el contexto para afinarlo.`
      : `The exact edition could not be determined. The range goes from the cheapest version up to the third quartile of the ${prints.length} existing versions (Cardmarket and TCGplayer, via Scryfall). Add the edition or collector number in the context to refine it.`,
    sources: ["Scryfall", "Cardmarket (EUR)", "TCGplayer (USD)"],
  });
}

// Pon esto en false para desactivar la identificación previa: se gasta una petición de IA menos por tasación.
const USE_IDENTIFICATION_PASS = true;

// Pon esto en false para que los errores no incluyan el motivo técnico del proveedor de IA.
const SHOW_ERROR_DETAILS = false;

function errorDetail(err: unknown): string {
  if (!SHOW_ERROR_DETAILS) return "";
  return ": " + (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

// Errores de cuota o límite de peticiones del proveedor de IA (no merece la pena reintentar).
function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED/i.test(msg);
}

const ItemIdSchema = z.object({
  category: z.string().max(50).catch("other"),
  summary: z.string().max(1500).catch(""),
  searchQueries: z.array(z.string().max(120)).max(4).catch([]),
  missingInfo: z.array(z.string().max(120)).max(5).catch([]),
  ficha: z
    .object({
      maker: z.coerce.string().max(80).catch(""),
      model: z.coerce.string().max(80).catch(""),
      reference: z.coerce.string().max(80).catch(""),
      year: z.coerce.string().max(30).catch(""),
      edition: z.coerce.string().max(80).catch(""),
      material: z.coerce.string().max(80).catch(""),
    })
    .partial()
    .catch({}),
});
type ItemId = z.infer<typeof ItemIdSchema>;

// Primera pasada del flujo general: identifica el objeto sin dar precio, para que la
// segunda pasada busque ventas reales del objeto exacto en vez de adivinar.
async function identifyItem(data: z.infer<typeof InputSchema>): Promise<ItemId | null> {
  const es = data.lang === "es";
  const system = es
    ? `Eres un identificador experto de objetos. Mira las fotos e identifica el objeto con la mayor precisión posible. NO des precio. El contexto es opcional: ignóralo si contradice las fotos. Devuelve también category, una de estas claves: ${Object.keys(REFERENCE_SITES_BY_CATEGORY).join(", ")}.
Lee todo el texto visible: marcas, etiquetas, números de serie, sellos, firmas, inscripciones y, en embarcaciones, el nombre del casco y la matrícula. Indica fabricante o autor, modelo, época o año, materiales, dimensiones aproximadas y estado aparente. Si hay varios objetos, céntrate en el de mayor valor probable.
Devuelve SOLO JSON con: summary (identificación detallada en 2-4 frases, distinguiendo lo que se LEE en la foto de lo que DEDUCES), searchQueries (2-3 consultas cortas para buscar ventas reales de este objeto exacto: modelo, referencia, año), missingInfo (hasta 4 datos que NO se ven en la foto y cambiarían mucho el precio, por ejemplo año de fabricación, horas de motor, metros cuadrados, ubicación, número de serie; lista vacía si no falta ninguno), ficha (como la ficha de una moneda: {maker, model, reference, year, edition, material}; rellena cada campo SOLO si se lee en la foto o se identifica con seguridad, si no déjalo "" — nunca inventes referencias ni números).${keyDataPrompt("es")}`
    : `You are an expert item identifier. Look at the photos and identify the item as precisely as possible. Do NOT give a price. Context is optional: ignore it if it contradicts the photos. Also return category, one of these keys: ${Object.keys(REFERENCE_SITES_BY_CATEGORY).join(", ")}.
Read all visible text: brands, labels, serial numbers, hallmarks, signatures, inscriptions and, on boats, the hull name and registration. State maker or author, model, era or year, materials, approximate dimensions and apparent condition. If there are several items, focus on the one with the highest likely value.
Return ONLY JSON with: summary (detailed identification in 2-4 sentences, separating what you READ in the photo from what you INFER), searchQueries (2-3 short queries to find real sales of this exact item: model, reference, year), missingInfo (up to 4 facts that are NOT visible in the photo and would change the price a lot, for example year of manufacture, engine hours, square metres, location, serial number; empty list if none is missing), ficha (like a coin's record: {maker, model, reference, year, edition, material}; fill each field ONLY if read in the photo or identified with certainty, otherwise "" — never invent references or numbers).${keyDataPrompt("en")}`;

  const category =
    data.category && data.category !== "auto"
      ? es
        ? `\nCategoría indicada: ${data.category}`
        : `\nStated category: ${data.category}`
      : "";
  const user =
    (es ? "Identifica este objeto. Contexto del usuario: " : "Identify this item. User context: ") +
    (data.context || "(none)") +
    category;

  const { text } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: photoContent(data.photos, user) },
    ],
    json: true,
    search: false,
    timeoutMs: 25_000,
    maxTokens: 700,
    preferFast: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const id = ItemIdSchema.parse(parsed);
  return id.summary.trim() ? id : null;
}

function withMissingInfo(r: ValuationResult, id: ItemId | null, lang: "es" | "en"): ValuationResult {
  if (!id || id.missingInfo.length === 0) return r;
  const extra =
    lang === "es"
      ? ` Para afinar la tasación, añade en el contexto: ${id.missingInfo.join(", ")}.`
      : ` To refine the valuation, add in the context: ${id.missingInfo.join(", ")}.`;
  return {
    ...r,
    confidence: capConfidenceForMissing(r.confidence, id.category, id.missingInfo.length),
    notes: (r.notes + extra).slice(0, 4000),
  };
}

async function identifyCoin(data: z.infer<typeof InputSchema>): Promise<CoinId> {
  const lang = data.lang;
  const system =
    lang === "es"
      ? `Eres un numismático identificador. Mira las fotos (anverso, reverso y, si hay, la etiqueta del slab) y identifica la pieza con precisión. NO des precio.
Lee TODO el texto visible: país, denominación, año, ceca, metal, certificadora (NGC/PCGS/ANACS/ICG), grado (MS/AU/XF/VF/PR + número) y número de certificación.
Si hay varias monedas, identifica la de mayor valor probable.
Pesos típicos de fino: 8 escudos/onza ~23.7 g, 4 escudos ~11.8 g, 2 escudos ~5.9 g, 100 pesetas ~29.0 g, 25 pesetas ~7.3 g, $20 double eagle ~30.1 g.
marketType: "bullion" SOLO si es lingote moderno (Krugerrand, Maple Leaf, American Eagle, Philharmonic, Britannia, Nugget, Panda, Libertad, 50 pesos Centenario común). Oro español colonial, escudos, onzas, excelentes, doblones, pesetas de oro, macuquinas = "numismatic" SIEMPRE, aunque sean de oro.
platedOrFilled: true si es CHAPADO/DE BAÑO/enchapado en oro o plata (no macizo) — pistas: texto "gold plated", "GP", "vermeil", "plaqué", "chapado", "baño de oro/plata"; color uniforme demasiado brillante/amarillo sin el peso o densidad esperados; desgaste que deja ver un metal base grisáceo/cobrizo distinto debajo en cantos o relieves; se vende como "réplica conmemorativa" o "medalla souvenir". Si tienes CUALQUIER duda razonable de que no sea metal macizo, marca true: es preferible pecar de cauto para no sobrevalorar como si fuera oro/plata maciza.
Devuelve SOLO JSON con: title, country, denomination, year, mint, seriesName, metal (gold|silver|platinum|copper|bimetallic|paper|unknown), estimatedFineWeightG (gramos de metal fino, o null), platedOrFilled (boolean), certifier (NGC|PCGS|ANACS|ICG|none|unknown), grade, certNumber, isLikelyReproduction, marketType (bullion|numismatic|unknown), identification (párrafo técnico), searchQuery (consulta corta en inglés para NGC/Heritage: país + denominación + año + ceca + grado), confidence (low|medium|high).`
      : `You are a numismatic identifier. Look at the photos (obverse, reverse and slab label if present) and identify the piece precisely. Do NOT give a price.
Read ALL visible text: country, denomination, year, mint, metal, certifier (NGC/PCGS/ANACS/ICG), grade (MS/AU/XF/VF/PR + number) and cert number.
If several coins are shown, identify the highest-value one.
Typical fine weights: 8 escudos/onza ~23.7 g, 4 escudos ~11.8 g, 2 escudos ~5.9 g, 100 pesetas ~29.0 g, 25 pesetas ~7.3 g, $20 double eagle ~30.1 g.
marketType: "bullion" ONLY for modern bullion (Krugerrand, Maple Leaf, American Eagle, Philharmonic, Britannia, Nugget, Panda, Libertad, common 50 pesos Centenario). Spanish colonial gold, escudos, onzas, excelentes, doubloons, gold pesetas, cobs = ALWAYS "numismatic", even though they are gold.
platedOrFilled: true if it is GOLD/SILVER-PLATED or filled (not solid) — clues: text "gold plated", "GP", "vermeil", "plaqué", "chapado", "baño de oro/plata"; a suspiciously uniform bright color without the expected weight/density; wear revealing a different greyish/coppery base metal underneath on edges or high points; sold as a "commemorative replica" or "souvenir medal". If there is ANY reasonable doubt it might not be solid metal, mark true — better to be cautious than overvalue it as solid gold/silver.
Return ONLY JSON with: title, country, denomination, year, mint, seriesName, metal (gold|silver|platinum|copper|bimetallic|paper|unknown), estimatedFineWeightG (fine metal grams, or null), platedOrFilled (boolean), certifier (NGC|PCGS|ANACS|ICG|none|unknown), grade, certNumber, isLikelyReproduction, marketType (bullion|numismatic|unknown), identification (technical paragraph), searchQuery (short English NGC/Heritage query: country + denomination + year + mint + grade), confidence (low|medium|high).`;

  const user =
    (lang === "es"
      ? "Identifica esta moneda/billete. Contexto del usuario: "
      : "Identify this coin/banknote. User context: ") + (data.context || "(none)");

  const { text } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: photoContent(data.photos, user) },
    ],
    json: true,
    search: false,
    timeoutMs: 45_000,
    maxTokens: 1200,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Coin identification was not valid JSON");
  }
  const id = CoinIdSchema.parse(parsed);
  const weight = typicalFineWeightG(id);
  return weight && (!id.estimatedFineWeightG || id.estimatedFineWeightG <= 0)
    ? { ...id, estimatedFineWeightG: weight }
    : id;
}

// Busca en Firecrawl anuncios y subastas de la moneda y devuelve las páginas leídas.
async function fetchCoinPages(
  queries: string[],
): Promise<Array<{ url: string; title: string; markdown: string }>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const results = await Promise.allSettled(queries.map((q) => firecrawlSearch(q, ctrl.signal)));
    const seen = new Set<string>();
    const pages: Array<{ url: string; title: string; markdown: string }> = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const p of r.value) {
        if (!p.url || seen.has(p.url)) continue;
        seen.add(p.url);
        pages.push({ url: p.url, title: p.title, markdown: p.markdown.slice(0, 2500) });
      }
    }
    return pages.slice(0, 8);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}async function priceCoin(
  data: z.infer<typeof InputSchema>,
  id: CoinId,
  spots: MetalSpots | null,
): Promise<ValuationResult> {
  const lang = data.lang;
  const spotLine = spots
    ? lang === "es"
      ? `Cotización OBLIGATORIA a usar (no inventes otra): oro ${roundMoney(spots.goldUsd)} USD/oz troy (${roundMoney(spots.goldEur)} EUR/oz), plata ${roundMoney(spots.silverUsd)} USD/oz (${roundMoney(spots.silverEur)} EUR/oz). Cambio USD→EUR ${spots.eurPerUsd.toFixed(4)}.`
      : `MANDATORY spot to use (do not invent another): gold ${roundMoney(spots.goldUsd)} USD/troy oz (${roundMoney(spots.goldEur)} EUR/oz), silver ${roundMoney(spots.silverUsd)} USD/oz (${roundMoney(spots.silverEur)} EUR/oz). USD→EUR ${spots.eurPerUsd.toFixed(4)}.`
    : lang === "es"
      ? "No hay cotización en vivo: busca el spot actual de oro y plata antes de calcular la fundición."
      : "No live spot available: look up current gold and silver spot before computing melt.";

  const platedLine = id.platedOrFilled
    ? lang === "es"
      ? "\n\nAVISO CRÍTICO: esta pieza está marcada como CHAPADA/DE BAÑO, no metal macizo. NO calcules ni uses valor de fundición (el peso total NO es oro/plata fino). Tasa como pieza de colección/souvenir/réplica según marca, diseño, antigüedad y demanda — igual que una moneda de latón o cuproníquel, no como oro o plata físicos."
      : "\n\nCRITICAL NOTICE: this piece is marked as PLATED/FILLED, not solid metal. Do NOT compute or use melt value (the total weight is NOT fine gold/silver). Price it as a collectible/souvenir/replica based on brand, design, age and demand — like a brass or cupronickel coin, not as physical gold or silver."
    : "";

  const system =
    lang === "es"
      ? `Eres un tasador numismático. Tienes búsqueda web. Debes tasar ESTA pieza concreta, no una media de la serie.

REGLA DE ORO — el fallo que hay que evitar:
Devolver el valor de fundición (o un precio genérico de "moneda de oro") cuando el mercado de coleccionista está miles de euros por encima. Un error de ~10.000 € a la baja es inaceptable. Fundición es el SUELO, nunca el precio de venta si existen comparables.${platedLine}

Pasos:
1. Calcula meltEur/meltUsd = (gramos de fino / 31.1035) × spot. ${spotLine}
2. BUSCA el precio de MERCADO de esta pieza exacta: país + denominación + año + ceca + grado + certificadora.
   Consultas útiles: "${id.searchQuery}", "NGC Price Guide", "PCGS CoinFacts", "Heritage Auctions sold", "Áureo & Calicó", "Jesús Vico", "Cayón", "Numista", "MA-Shops", eBay sold.
3. price = rango de mercado (venta real / guía NGC-PCGS). Si hay comparable de subasta, ÚSALO. No sustituyas un 8 escudos / onza / 100 pesetas / $20 Liberty o Saint-Gaudens / 50 pesos Mexicanos por "el oro que pesa".
4. Si está encapsulada MS/PR/PF, la prima numismática suele ser el componente PRINCIPAL del precio.
5. Reproducción, chapada, o duda fuerte: confidence low y precios 0 o solo melt si el metal es auténtico y macizo.
6. En notes incluye: identificación | fino | spot | fundición | comparable | precio de mercado. Aclara si las fuentes son consultas en vivo.

Devuelve SOLO JSON: meltEur, meltUsd, marketEurMin, marketEurMax, marketUsdMin, marketUsdMax, notes, sources (array), comparable (una frase con la venta o guía usada).`
      : `You are a numismatic appraiser with live web search. Value THIS specific piece, not a series average.

GOLDEN RULE — the failure to avoid:
Returning melt value (or a generic "gold coin" price) when collector market is thousands of euros higher. A ~€10,000 undervaluation is unacceptable. Melt is the FLOOR, never the asking price when comparables exist.${platedLine}

Steps:
1. Compute meltEur/meltUsd = (fine grams / 31.1035) × spot. ${spotLine}
2. SEARCH the MARKET price of this exact piece: country + denomination + year + mint + grade + certifier.
   Useful queries: "${id.searchQuery}", NGC Price Guide, PCGS CoinFacts, Heritage Auctions sold, Áureo & Calicó, Jesús Vico, Cayón, Numista, MA-Shops, eBay sold.
3. Price = market range (actual sales / NGC-PCGS guide). If an auction comparable exists, USE IT. Do not substitute an 8 escudos / onza / 100 pesetas / $20 Liberty or Saint-Gaudens / Mexican 50 pesos with "the gold it weighs".
4. If slabbed MS/PR/PF, the numismatic premium is usually the MAIN component of the price.
5. Reproduction, plated, or strong doubt: low confidence and prices 0, or melt only if the metal is genuine and solid.
6. In notes include: ID | fine weight | spot | melt | comparable | market price. Say whether sources were live lookups.

Return ONLY JSON: meltEur, meltUsd, marketEurMin, marketEurMax, marketUsdMin, marketUsdMax, notes, sources (array), comparable (one sentence with the sale or guide used).`;

  const user = JSON.stringify(
    {
      title: id.title,
      country: id.country,
      denomination: id.denomination,
      year: id.year,
      mint: id.mint,
      seriesName: id.seriesName,
      metal: id.metal,
      estimatedFineWeightG: id.estimatedFineWeightG,
      platedOrFilled: id.platedOrFilled,
      certifier: id.certifier,
      grade: id.grade,
      certNumber: id.certNumber,
      isLikelyReproduction: id.isLikelyReproduction,
      identification: id.identification,
      userContext: data.context || "",
      condition: data.condition,
      lang,
    },
    null,
    2,
  );

  const siteInstructions = formatSiteSearchInstructions(buildSiteQueries([id.searchQuery], "coins", id.title), lang);
  const comparableInstructions = lang === "es"
    ? '\nDevuelve también comparables: [{title, price, currency (EUR|USD), kind (sold|asking), url}]. Solo piezas de la misma denominación, año, ceca, grado y autenticidad; no inventes precios ni URLs. El contexto es opcional y se ignora si contradice la foto.'
    : '\nAlso return comparables: [{title, price, currency (EUR|USD), kind (sold|asking), url}]. Match denomination, year, mint, grade and authenticity; never invent prices or URLs. Context is optional and ignored when it contradicts the photo.';
  const { text, citations } = await chatCompletion({
    messages: [
      { role: "system", content: system + siteInstructions + comparableInstructions },
      { role: "user", content: user },
    ],
    json: true,
    search: true,
    timeoutMs: 75_000,
    maxTokens: 1800,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Coin pricing was not valid JSON");
  }
  const price = CoinPriceSchema.parse(parsed);

  const sources = [...price.sources, ...citations.map((c) => c.slice(0, 200))].filter(Boolean);
  const uniqueSources = Array.from(new Set(sources)).slice(0, 8);

  const notesExtra =
    price.comparable && !price.notes.includes(price.comparable)
      ? `\n${lang === "es" ? "Comparable" : "Comparable"}: ${price.comparable}`
      : "";

  const result: ValuationResult = {
    title: id.title.slice(0, 200),
    identification: id.identification.slice(0, 2000),
    priceEurMin: roundMoney(price.marketEurMin),
    priceEurMax: roundMoney(price.marketEurMax),
    priceUsdMin: roundMoney(price.marketUsdMin),
    priceUsdMax: roundMoney(price.marketUsdMax),
    confidence: id.isLikelyReproduction ? "low" : id.confidence,
    notes: citations.length === 0 ? (lang === "es" ? "Estimación orientativa: no se han podido consultar fuentes verificadas en esta búsqueda, así que no hay comparables confirmados." : "Indicative estimate: no verified sources could be checked in this search, so there are no confirmed comparables.") : (price.notes + notesExtra).slice(0, 4000),
    sources: uniqueSources,
  };

  if (result.priceEurMax < result.priceEurMin) result.priceEurMax = result.priceEurMin;
  if (result.priceUsdMax < result.priceUsdMin) result.priceUsdMax = result.priceUsdMin;

  const anchored = anchorToComparables(Object.assign(result, { comparables: citations.length === 0 ? [] : price.comparables }), citations, spots?.eurPerUsd ?? EUR_PER_USD_APPROX, lang, true);
  // Los precios encontrados mandan sobre los suelos genéricos de una serie.
  const guarded = anchored ? result : applyCoinPriceGuards(result, { ...id, confidence: "low" }, spots);
  return ResultSchema.parse({ ...result, ...guarded });
}

// ============= Relojes: precio de tienda actual con Firecrawl =============
const WatchIdSchema = z.object({
  brand: z.coerce.string().max(60).catch(""),
  model: z.coerce.string().max(120).catch(""),
  reference: z.coerce.string().max(40).catch(""),
  referenceCertain: z.boolean().catch(false),
  description: z.coerce.string().max(700).catch(""),
});

const FX_CACHE_TTL_MS = 5 * 60_000;
let cachedFxRate: { rate: number; expiresAt: number } | null = null;
let lastKnownFxRate = EUR_PER_USD_APPROX;

async function fetchEurPerUsd(): Promise<number> {
  const now = Date.now();
  if (cachedFxRate && now < cachedFxRate.expiresAt) {
    return cachedFxRate.rate;
  }
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return lastKnownFxRate;
    const j = (await res.json()) as { rates?: { EUR?: number } };
    const r = Number(j.rates?.EUR);
    if (Number.isFinite(r) && r > 0) {
      cachedFxRate = { rate: r, expiresAt: now + FX_CACHE_TTL_MS };
      lastKnownFxRate = r;
      return r;
    }
    return lastKnownFxRate;
  } catch {
    return lastKnownFxRate;
  }
}

type WatchRetailOutcome = { result: ValuationResult | null; hint?: string; itemId?: ItemId };

async function valuateWatchRetail(data: z.infer<typeof InputSchema>): Promise<WatchRetailOutcome> {
  const es = data.lang === "es";
  const today = new Date().toISOString().slice(0, 10);
  const idSystem = es
    ? `Identifica el reloj de las fotos. Lee la REFERENCIA exacta (esfera, caja, fondo, cierre, etiqueta) o tómala del contexto del usuario si es coherente con la foto. NO la supongas por el aspecto: si no la lees con seguridad, devuelve referenceCertain=false. Añade "description": una descripción de 2-3 frases de lo que SE VE (tipo de reloj, marca, modelo, material de la caja, esfera, complicaciones visibles y correa o pulsera). En "description" NO incluyas la referencia, números de serie ni códigos de caja, y no afirmes el estado, la caja ni los papeles. Devuelve SOLO JSON {brand, model, reference, referenceCertain, description}.`
    : `Identify the watch in the photos. Read the EXACT reference (dial, case, caseback, clasp, tag) or take it from the user context if consistent with the photo. Do NOT guess it from looks: if you cannot read it with certainty, return referenceCertain=false. Add "description": a 2-3 sentence description of what is VISIBLE (watch type, brand, model, case material, dial, visible complications and strap or bracelet). In "description" do NOT include the reference, serial numbers or case codes, and do not claim condition, box or papers. Return ONLY JSON {brand, model, reference, referenceCertain, description}.`;
  const { text } = await chatCompletion({
    messages: [
      { role: "system", content: idSystem },
      {
        role: "user",
        content: photoContent(data.photos, (es ? "Contexto: " : "Context: ") + (data.context || "(none)")),
      },
    ],
    json: true,
    timeoutMs: 25_000,
    maxTokens: 600,
    preferFast: true,
  });
  let id: z.infer<typeof WatchIdSchema>;
  try {
    id = WatchIdSchema.parse(JSON.parse(text));
  } catch {
    id = { brand: "", model: "", reference: "", referenceCertain: false, description: "" };
  }
  // Si el usuario escribió la referencia en el contexto, manda sobre lo que lea la IA.
  const userRef = referenceFromContext(data.context);
  if (userRef) id = { ...id, reference: userRef, referenceCertain: true };
  const name = [id.brand, id.model].filter(Boolean).join(" ").trim() || (es ? "Reloj" : "Watch");

  // "Tasa siempre": sin precio de tienda fiable no devolvemos ceros — pasamos al
  // flujo general con una nota que explica el motivo y pide un valor orientativo.
  // Lo ya identificado se reutiliza en el flujo general, sin repetir la identificación.
  const watchItemId: ItemId = {
    category: "watches",
    summary: [id.description.trim(), `${name}${id.referenceCertain && id.reference ? ` ref. ${id.reference}` : ""}`]
      .filter(Boolean)
      .join(" "),
    searchQueries: [
      `${id.brand} ${id.model} ${id.referenceCertain ? id.reference : ""} pre-owned price sold`,
      `${id.brand} ${id.model} ${id.referenceCertain ? id.reference : ""} segunda mano precio`,
    ]
      .map((q) => q.replace(/\s+/g, " ").trim())
      .filter((q) => q.length > 12),
    missingInfo: id.referenceCertain ? [] : [es ? "referencia exacta del reloj" : "exact watch reference"],
    ficha: { maker: id.brand, model: id.model, reference: id.referenceCertain ? id.reference : "" },
  };
  const fallBack = (reason: string, hint: string): WatchRetailOutcome => {
    console.error(`[valuateItem] watch retail: ${reason}`);
    return { result: null, hint, itemId: watchItemId };
  };

  // Sin precio de tienda: anuncios y ventas de segunda mano de la MISMA referencia, con enlaces.
  const tryPreOwned = async (): Promise<ValuationResult | null> => {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 30_000);
    const found: SearchPage[] = [];
    try {
      const qs = [
        `${id.brand} ${id.reference} pre-owned used price`,
        `${id.brand} ${id.reference} segunda mano precio`,
      ];
      const res = await Promise.allSettled(qs.map((q) => firecrawlSearch(q, ctrl.signal)));
      const seenUrls = new Set<string>();
      for (const r of res) {
        if (r.status !== "fulfilled") continue;
        for (const pg of r.value) {
          if (seenUrls.has(pg.url) || !isPreOwnedSourceUrl(pg.url)) continue;
          if (!mentionsReference(pg.title + " " + pg.markdown, id.reference)) continue;
          seenUrls.add(pg.url);
          found.push(pg);
        }
      }
    } catch {
      return null;
    } finally {
      clearTimeout(tm);
    }
    const pgs = found.slice(0, 8);
    if (pgs.length === 0) return null;

    const sys = es
      ? `Para cada página, extrae el precio del reloj de SEGUNDA MANO con referencia exacta "${id.reference}" anunciado o vendido en ella. Ignora relojes nuevos de tienda, otras referencias, accesorios, cuotas mensuales y precios tachados. Si hay varios anuncios, devuelve el más representativo. Si no hay un precio claro, no incluyas esa página. Devuelve SOLO JSON {"listings":[{"index":número,"store":"nombre","price":número,"currency":"EUR|USD"}]}.`
      : `For each page, extract the price of the PRE-OWNED watch with exact reference "${id.reference}" listed or sold on it. Ignore new retail watches, other references, accessories, monthly instalments and struck-through prices. If there are several listings, return the most representative. If there is no clear price, leave that page out. Return ONLY JSON {"listings":[{"index":number,"store":"name","price":number,"currency":"EUR|USD"}]}.`;
    const exc = pgs.map((pg, i) => ({ i, text: excerptAround(pg.markdown, id.reference) }));
    const body = exc.map((e) => `### [${e.i}] ${pgs[e.i].title}\n${pgs[e.i].url}\n${e.text}`).join("\n\n");
    let ex2: { text: string };
    let rate: number;
    try {
      [ex2, rate] = await Promise.all([
        chatCompletion({
          messages: [
            { role: "system", content: sys },
            { role: "user", content: body },
          ],
          json: true,
          timeoutMs: 25_000,
          maxTokens: 800,
          preferFast: true,
        }),
        fetchEurPerUsd(),
      ]);
    } catch {
      return null;
    }
    let raw: Array<{ index?: unknown; store?: unknown; price?: unknown; currency?: unknown }> = [];
    try {
      const j = JSON.parse(ex2.text) as { listings?: unknown };
      if (Array.isArray(j.listings)) raw = j.listings as typeof raw;
    } catch {
      return null;
    }
    const ls: RetailListing[] = [];
    for (const l of raw) {
      const idx = Number(l.index);
      const pg = pgs[idx];
      const price = toNumberLoose(l.price);
      const currency = String(l.currency).toUpperCase() === "USD" ? "USD" : "EUR";
      if (!pg || !(price > 0) || !priceAppearsInText(exc[idx].text, price)) continue;
      ls.push({ url: pg.url, title: String(l.store || pg.title).slice(0, 80), price, currency });
    }
    const rg = retailRange(ls, rate);
    if (!rg) return null;
    return ResultSchema.parse({
      title: `${name} ${id.reference}`.slice(0, 200),
      identification: id.description.trim()
        ? `${id.description.trim()} ${es ? "Referencia" : "Reference"}: ${id.reference}.`
        : `${name} — ref. ${id.reference}`,
      priceEurMin: rg.eurMin,
      priceEurMax: rg.eurMax,
      priceUsdMin: rg.usdMin,
      priceUsdMax: rg.usdMax,
      confidence: "medium",
      notes: es
        ? `No consta que este reloj se venda ahora en tiendas: el valor mostrado es de segunda mano (${ls.length} anuncio(s) consultados el ${today}), no un precio de tienda.`
        : `This watch does not appear to be on sale in stores now: the value shown is pre-owned (${ls.length} listing(s) checked on ${today}), not a retail price.`,
      sources: Array.from(new Set(ls.map((l) => l.url.slice(0, 200)))).slice(0, 8),
    });
  };

  if (!id.referenceCertain || normRef(id.reference).length < 4) {
    return fallBack(
      "reference not read with certainty",
      es
        ? `Nota del sistema: no se pudo leer la referencia exacta del reloj con certeza, así que no hay precio de tienda de distribuidor. Tasa igualmente: da tu mejor estimación basada en las fotos y en búsquedas reales en la web, con confianza "low" y un rango amplio si hace falta; en "notes" indica marca y modelo probable y pide la referencia exacta (fondo de la caja, entre las asas, garantía) para poder dar el precio de tienda nuevo en un nuevo intento.`
        : `System note: the exact watch reference could not be read with certainty, so there is no dealer retail price. Still appraise it: give your best estimate from the photos and real web searches, with "low" confidence and a wide range if needed; in "notes" state the likely brand and model and ask for the exact reference (caseback, between the lugs, warranty card) so a new attempt can return the retail price.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let pages: SearchPage[] = [];
  let searchFailed = false;
  try {
    const queries = [
      `${id.brand} ${id.reference} precio tienda nuevo`,
      `${id.brand} ${id.reference} price buy new authorized dealer`,
    ];
    const results = await Promise.allSettled(queries.map((q) => firecrawlSearch(q, controller.signal)));
    searchFailed = results.every((r) => r.status === "rejected");
    const seen = new Set<string>();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const p of r.value) {
        if (seen.has(p.url) || !isRetailUrl(p.url)) continue;
        if (!mentionsReference(p.title + " " + p.markdown, id.reference)) continue;
        seen.add(p.url);
        pages.push(p);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  pages = pages.slice(0, 8);

  const notFoundHint = es
    ? `Nota del sistema: la búsqueda en tiendas y distribuidores no encontró anuncios actuales de la referencia exacta ${id.brand} ${id.reference} (consulta del ${today}), así que no hay precio de tienda nuevo fiable. Tasa igualmente con un valor orientativo basado en ventas y anuncios reales que encuentres en la web (mercado de segunda mano u ofertas equivalentes), con confianza "low" o "medium", y aclara en "notes" que no es el precio de tienda nuevo. No cites fuentes que no hayas consultado y no inventes precios.`
    : `System note: the store search found no current listings for exact reference ${id.brand} ${id.reference} (checked ${today}), so there is no reliable new retail price. Still appraise it with an indicative value based on real sales and listings you find on the web (pre-owned market or equivalent offers), with "low" or "medium" confidence, and clarify in "notes" that it is not the new retail price. Never cite sources you did not consult and never invent prices.`;
  const serviceDownHint = es
    ? `Nota del sistema: no se han podido consultar las tiendas y distribuidores (el servicio de búsqueda no responde, no está conectado o no tiene créditos), así que no hay precio de tienda nuevo. Tasa igualmente con tu mejor estimación orientativa a partir de las fotos y lo que encuentres en la web, con confianza "low", y aclara en "notes" que la consulta de tiendas falló y se puede reintentar. No cites fuentes que no hayas consultado.`
    : `System note: the store and dealer lookup failed (the search service is not responding, not connected or out of credits), so there is no new retail price. Still appraise it with your best indicative estimate from the photos and whatever you find on the web, with "low" confidence, and clarify in "notes" that the store lookup failed and can be retried. Never cite sources you did not consult.`;
  if (pages.length === 0) {
    if (!searchFailed) {
      const pre = await tryPreOwned();
      if (pre) return { result: pre };
    }
    return searchFailed
      ? fallBack(`search service unavailable for reference ${id.reference}`, serviceDownHint)
      : fallBack(`no retail listings for reference ${id.reference}`, notFoundHint);
  }

  const extractSystem = es
    ? `Para cada página, extrae el precio de venta ACTUAL del reloj NUEVO con referencia exacta "${id.reference}" en esa tienda. Ignora precios de segunda mano, usados, de otras referencias, cuotas mensuales y precios tachados. Si la página no muestra ese precio, omítela. Copia el importe tal como aparece. Devuelve SOLO JSON {"listings":[{"index":n,"store":"...","price":número,"currency":"EUR"|"USD"}]}.`
    : `For each page, extract the CURRENT selling price of the NEW watch with exact reference "${id.reference}" at that store. Ignore pre-owned, used, other references, monthly instalments and struck-through prices. If the page shows no such price, omit it. Copy the amount as shown. Return ONLY JSON {"listings":[{"index":n,"store":"...","price":number,"currency":"EUR"|"USD"}]}.`;
  const excerpts = pages.map((p, i) => ({ i, text: excerptAround(p.markdown, id.reference) }));
  const pagesText = excerpts
    .map((e) => `### [${e.i}] ${pages[e.i].title}\n${pages[e.i].url}\n${e.text}`)
    .join("\n\n");
  // La conversión y la extracción no dependen entre sí: no sumar otra espera al final.
  const [ex, eurPerUsd] = await Promise.all([chatCompletion({
    messages: [
      { role: "system", content: extractSystem },
      { role: "user", content: pagesText },
    ],
    json: true,
    timeoutMs: 25_000,
    maxTokens: 800,
    preferFast: true,
  }), fetchEurPerUsd()]);
  let rawListings: Array<{ index?: unknown; store?: unknown; price?: unknown; currency?: unknown }> = [];
  try {
    const j = JSON.parse(ex.text) as { listings?: unknown };
    if (Array.isArray(j.listings)) rawListings = j.listings as typeof rawListings;
  } catch {
    /* sin datos */
  }
  const listings: RetailListing[] = [];
  for (const l of rawListings) {
    const idx = Number(l.index);
    const page = pages[idx];
    const price = toNumberLoose(l.price);
    const currency = String(l.currency).toUpperCase() === "USD" ? "USD" : "EUR";
    if (!page || !(price > 0)) continue;
    // Solo aceptamos importes que aparecen de verdad en la página consultada.
    if (!priceAppearsInText(excerpts[idx].text, price)) continue;
    listings.push({ url: page.url, title: String(l.store || page.title).slice(0, 80), price, currency });
  }
  const range = retailRange(listings, eurPerUsd);
  if (!range) {
    const pre = await tryPreOwned();
    if (pre) return { result: pre };
    return fallBack(`no extractable retail prices for reference ${id.reference}`, notFoundHint);
  }

  return { result: ResultSchema.parse({
    title: `${name} ${id.reference}`.slice(0, 200),
    identification: id.description.trim()
      ? `${id.description.trim()} ${es ? "Referencia" : "Reference"}: ${id.reference}.`
      : `${name} — ref. ${id.reference}`,
    priceEurMin: range.eurMin,
    priceEurMax: range.eurMax,
    priceUsdMin: range.usdMin,
    priceUsdMax: range.usdMax,
    confidence: listings.length >= 3 ? "high" : "medium",
    notes: "",
    sources: Array.from(new Set(listings.map((l) => l.url.slice(0, 200)))).slice(0, 8),
  }) };
}

function formatAmount(n: number): string {
  return Math.round(n).toLocaleString("es-ES");
}

const systemEs = `Eres un tasador experto que consulta bases de datos públicas de todo el mundo (eBay sold listings, Wikipedia, Catawiki, WorthPoint, Heritage Auctions, Chrono24, Discogs, etc.). Analiza las fotos y devuelve una tasación honesta con rangos de precio realistas en EUR y USD. REGLA SOBRE EL CONTEXTO DEL USUARIO: es opcional y solo una pista. La tasación se basa SIEMPRE en las fotos y en lo que encuentres en internet; nunca falles, te bloquees ni devuelvas un error por culpa del contexto. Si el contexto es coherente con las fotos, úsalo para afinar (marca, año, ubicación, m², estado); si es confuso, contradictorio, incompleto o claramente erróneo, ignóralo por completo y tasa solo con las fotos y tus fuentes, sin mencionar el problema en "notes" salvo que sea relevante para el precio. Si no puedes identificar el objeto con seguridad, da igualmente tu mejor estimación: indica la duda en "notes", usa confianza "low" y devuelve SIEMPRE un rango de precio estimado y realista (aunque sea amplio) basado en lo que se ve y en objetos parecidos; el usuario puede añadir contexto opcional para afinarlo. No devuelvas precios en 0 por falta de certeza. Para cartas coleccionables (Magic: The Gathering, Pokémon, Yu-Gi-Oh, deportes, etc.) IDENTIFICA CON PRECISIÓN la edición/set exacto usando el símbolo de expansión, el número de colección, el año, el idioma, el borde (blanco/negro), foil/no-foil y el estado (NM/LP/MP/HP/DMG). Consulta referencias específicas (Scryfall, MTGGoldfish, TCGPlayer, Cardmarket para Magic; TCGPlayer/PriceCharting para Pokémon) y considera TODAS las ediciones posibles antes de dar el precio. Usa el rango de céntimos (ej. 0.02 - 0.10 EUR/USD) SOLO si estás seguro de que la carta u objeto coleccionable es común y de valor muy bajo (bulk). Si la carta es de una edición reciente, o no la reconoces con certeza, NO uses ese suelo: busca su precio actual en Scryfall o Cardmarket y usa el precio de mercado de la edición exacta, no el de la más barata. Indica en "notes" la edición identificada y menciona alternativas si hay duda. Para VEHÍCULOS A MOTOR (categoría vehicles: coches, motocicletas, vehículos históricos, furgonetas, camiones ligeros, etc.) identifica marca, modelo, generación aproximada, motorización, kilometraje aparente y estado visual. Consulta referencias como eBay sold listings, Mobile.de, Autoscout24, Classic.com, Bring a Trailer y Hemmings; ajusta por mercado europeo (EUR) y estadounidense (USD). Para embarcaciones (categoría boats: yates, megayates, veleros, lanchas, barcos de pesca, jet skis, neumáticas, etc.) NO apliques suelos ni techos artificiales: un yate de 40-60 m vale decenas de millones de euros y uno de más de 100 m, cientos de millones. Identifica PRIMERO astillero, modelo y serie exactos (lee el nombre del casco, la matrícula y las inscripciones), eslora (cuidado: no confundas pies con metros), año de construcción o de la última gran refit, motorización y horas de motor, y equipamiento visible. Si es un modelo de serie conocido, busca el precio real de unidades del MISMO modelo y año (YachtWorld, Boat International, SuperYacht Times, YachtBuyer, Burgess, Camper & Nicholsons, Boat Trader, Annonces du Bateau) y distingue ventas cerradas de precios pedidos. Si el precio es "bajo consulta" (POA), NO lo inventes: estima por comparables de eslora, edad y astillero similares y usa confianza "medium" o "low". En un yate nuevo o casi nuevo parte del precio de catálogo o de construcción; en uno usado aplica la depreciación real de su edad. Muestra en "notes" el modelo identificado, la eslora usada, 2-3 comparables con su precio y el cálculo. El contexto del usuario sobre astillero, modelo, eslora, año y horas de motor prevalece sobre lo que deduzcas de la foto. Para INSTRUMENTOS MUSICALES (categoría music instrument: guitarras, bajos, violines, violas, chelos, pianos, vientos, baterías, sintetizadores, amplificadores) identifica PRIMERO marca, modelo, año y país de fabricación (usa el número de serie, la etiqueta interior, la pala del mástil y las inscripciones), el acabado y si es original o ha sido reparado, retocado o con piezas cambiadas. En instrumentos de gama alta o antiguos pesan más el origen, el año y la originalidad que el modelo: un mismo modelo puede valer varias veces más según la época. Busca el precio real de ventas de unidades del MISMO modelo y año (Reverb, Thomann, eBay sold listings, Tarisio Cozio para instrumentos de cuerda frotada, y Christie's, Sotheby's o Bonhams para piezas excepcionales) y distingue el precio pedido del vendido. En violines, violas, chelos y arcos de autor, sin certificado de autenticidad trátalos como instrumento de taller o "de estilo" y baja la confianza. Muestra en "notes" el modelo identificado, el año estimado y 2-3 comparables con su precio. Para INMUEBLES (categoría realestate: pisos, casas, villas, chalets, locales, terrenos, edificios) NO apliques suelos de céntimos ni techos artificiales: estima el valor de mercado real, que puede ser de cientos de miles a decenas de millones de euros. Calcula SIEMPRE el precio como superficie × precio/m² de la microzona, antes de ajustar por estado y singularidad. El contexto del usuario sobre ubicación, m² y tipología prevalece sobre cualquier inferencia visual; no reduzcas la superficie indicada. Distingue estrictamente un apartamento pequeño de una residencia de 3+ dormitorios, dúplex, planta completa o >150 m². Si faltan m², estima un intervalo de superficie coherente y calcula ambos extremos. Para lujo usa comparables de Idealista, Fotocasa, Sotheby's Realty, Christie's Real Estate y Engel & Völkers; no limites el resultado a 1.000.000 € y explica en "notes" superficie, horquilla €/m², primas y cálculo final. Para BONSÁIS (categoría bonsai) identifica especie, estilo (chokkan, moyogi, kengai, forest, etc.), edad aproximada por grosor de tronco y nebari, calidad de la ramificación y estado de salud visible; ten en cuenta si la maceta es de autor (Tokoname, Yixing) y súmala aparte si es apreciable. Consulta Bonsai Empire, viveros y subastas especializadas, y eBay sold listings; los precios van desde 20-30 € en material de partida hasta varios miles en ejemplares de estilo maduro. Para VINO Y LICORES (categoría wine) identifica productor, denominación de origen o región, añada, formato de botella y estado de conservación (nivel de llenado, etiqueta, cápsula, corcho); consulta Wine-Searcher, iDealwine, Vinfolio y casas como Sotheby's/Christie's Wine o Whisky Auctioneer para licores. Para MUEBLES ANTIGUOS (categoría furniture) identifica estilo y época (Isabelino, Luis XV, Art Déco, medio siglo, etc.), material, posibles marcas de ebanista o taller, y estado/restauraciones; consulta Catawiki, 1stDibs, Invaluable y los departamentos de mobiliario de Christie's/Sotheby's. Para MILITARIA (categoría militaria) identifica conflicto/época, país, unidad y tipo de pieza (medalla, insignia, uniforme, documento), y sé explícito si parece una reproducción moderna en vez de una pieza original, ya que el precio varía drásticamente; consulta Hermann Historica, Bonhams Arms & Militaria y eBay sold listings. Para BOLSOS Y COMPLEMENTOS DE LUJO (categoría luxury bags) identifica marca, modelo, línea, materiales, herrajes y posibles indicios de autenticidad (calidad de costuras, sellado, número de serie visible); consulta Vestiaire Collective, The RealReal, Fashionphile, Rebag y los departamentos de bolsos de Christie's/Sotheby's. Para MINERALES Y ROCAS (categoría minerals) identifica especie mineral, hábito cristalino, color y transparencia, procedencia probable del yacimiento y tamaño estimado; consulta Mindat.org, MineralAuctions, eBay sold listings y Catawiki. Para GEMAS Y PIEDRAS PRECIOSAS SUELTAS (categoría gemstones) identifica tipo de gema, corte, color, transparencia y posible origen; el peso en quilates es determinante y si no es visible indícalo como limitación; consulta Opal Auctions (para ópalos), GemVal, GIA (Gemological Institute of America), eBay sold listings y Catawiki. Para RELOJES (categoría watches) identifica PRIMERO marca, modelo y REFERENCIA exacta (léela en la esfera, la caja, el cierre y el fondo; si es dudosa, dilo), el calibre si se ve y, sobre todo, el MATERIAL de la caja y la pulsera: oro macizo (18K/750), bicolor, chapado en oro (GP) o acero. El mismo modelo en oro macizo puede valer varias veces más que en acero, y un reloj de oro de una marca de lujo puede valer decenas de miles de euros o más: no apliques un suelo bajo ni lo tases como un reloj de gama media sin motivo. Valora además año o serie, estado, si conserva esfera, corona, manecillas y pulsera originales (piezas cambiadas o repintadas bajan mucho el precio), pulidos excesivos, caja y papeles originales y revisiones. Busca el precio real de unidades de la MISMA referencia (Chrono24, WatchCharts, eBay sold listings y casas como Phillips, Christie's, Sotheby's o Antiquorum) y distingue el precio pedido del vendido. Si no puedes leer la referencia, explica la duda en \"notes\" y amplía el rango con confianza \"low\" en vez de inventar un modelo. Muestra en \"notes\" la referencia identificada, el material y 2-3 comparables con su precio. Para JOYERÍA (categoría jewelry) busca SIEMPRE el contraste/sello de ley grabado (750/18K, 585/14K, 417/10K, 375/9K = oro macizo; 925/plata de ley; 950/platino) frente a marcas de CHAPADO/BAÑO (GP, "gold filled", "gold plated", "chapado", "baño de oro", "plaqué", "vermeil"): son mundos de valor completamente distintos. Si es oro/plata MACIZO, calcula el valor de fundición con la cotización real proporcionada (peso estimado en gramos × ley × precio del metal) y súmale una prima si hay marca reconocida, diseño de autor, gemas engastadas o antigüedad — la fundición es el SUELO, no el precio final si hay valor añadido. Si es CHAPADO/DE BAÑO, el metal precioso es una capa mínima: NO calcules fundición sobre el peso total, tasa la pieza como bisutería fina según marca, diseño y estado. Ante duda razonable entre macizo y chapado, indícalo explícitamente en "notes" y usa confidence "low" o "medium" en vez de asumir macizo.

PAÍS VASCO — mercado de alto precio: no uses medias nacionales ni provinciales para una microzona prime. Si el contexto identifica estas zonas, usa como referencia orientativa: Neguri y primera línea de Getxo 7.500-10.000 €/m² (objetivo base de lujo 8.000 €/m²); Las Arenas/Areeta y Algorta prime 6.000-8.500 €/m²; Bilbao Abandoibarra 6.500-9.000 €/m², Ensanche/Abando e Indautxu prime 5.500-8.000 €/m²; San Sebastián Centro, Área Romántica, Miraconcha y Ondarreta 8.000-12.000 €/m², con producto excepcional por encima; Zarautz y Hondarribia prime 6.000-9.000 €/m²; Vitoria centro prime 4.000-6.000 €/m². Para municipios o barrios no listados elige comparables de la microzona, no traslades automáticamente los precios prime. Añade 15-40 % por vistas al mar, terraza, ático, parcela, edificio singular, gran superficie o reforma integral de lujo. No apliques descuentos genéricos después de usar un precio/m² ya ajustado al estado. NO redondees el precio por m²: exprésalo con el valor exacto que hayas aplicado (por ejemplo, 8.125 €/m², no 8.000 €/m²) y usa ese valor exacto en la multiplicación por la superficie. Ejemplo vinculante: 200 m² de lujo en Neguri a 8.000 €/m² parten de 1.600.000 €, antes de primas; nunca deben terminar por debajo por una suposición visual contradictoria. Para otras zonas prime: Barrio de Salamanca/Chamberí 7.000-12.000 €/m², La Moraleja/Puerta de Hierro 5.500-9.000 €/m², Pedralbes/Sarrià/Eixample Dreta 6.000-10.000 €/m², Marbella Milla de Oro/Puerto Banús 6.000-12.000 €/m² e Ibiza/Mallorca prime 7.000-12.000 €/m². Si no hay acceso a anuncios en vivo, presenta las referencias como orientativas, no como consultas realizadas. Responde SIEMPRE en español.`;

const systemEn = `You are an expert appraiser who consults public databases worldwide (eBay sold listings, Wikipedia, Catawiki, WorthPoint, Heritage Auctions, Chrono24, Discogs, etc.). Analyze the photos and return an honest valuation with realistic EUR and USD ranges. RULE ABOUT USER CONTEXT: it is optional and only a hint. The valuation is ALWAYS based on the photos and what you find online; never fail, get blocked, or return an error because of the context. If the context is consistent with the photos, use it to refine (brand, year, location, area, condition); if it is confusing, contradictory, incomplete or clearly wrong, ignore it entirely and appraise from the photos and your sources alone, without mentioning the issue in "notes" unless it matters for the price. If identification is uncertain, still give your best estimate: mention the doubt in "notes", use "low" confidence and ALWAYS return a realistic estimated price range (even if wide) based on what is visible and comparable items; the user may add optional context to refine it. Do not return zero prices just because of uncertainty. For collectible cards, precisely identify every possible edition using expansion symbol, collector number, year, language, border, foil status and condition, consulting Scryfall, MTGGoldfish, TCGPlayer, Cardmarket or PriceCharting as appropriate. Only use a cents-level price (e.g. 0.02 - 0.10 EUR/USD) when you are sure the card is a common bulk card; if the card is from a recent set or you do not recognise it, look up its current price on Scryfall or Cardmarket for the exact edition instead of defaulting to a low price. For MOTOR VEHICLES (category vehicles: cars, motorcycles, historic vehicles, vans, light trucks, etc.) identify make, model, approximate generation, engine, apparent mileage and visual condition. Reference eBay sold listings, Mobile.de, Autoscout24, Classic.com, Bring a Trailer and Hemmings; adjust for European (EUR) and US (USD) markets. For WATERCRAFT (category boats: yachts, megayachts, sailboats, motorboats, fishing boats, jet skis, RIBs, etc.) never apply artificial floors or ceilings: a 40-60 m yacht is worth tens of millions of euros and one over 100 m hundreds of millions. FIRST identify the exact builder, model and series (read the hull name, registration and inscriptions), length (careful: do not confuse feet with metres), year of build or last major refit, engines and engine hours, and visible equipment. If it is a known series model, look up the real price of units of the SAME model and year (YachtWorld, Boat International, SuperYacht Times, YachtBuyer, Burgess, Camper & Nicholsons, Boat Trader, Annonces du Bateau) and distinguish closed sales from asking prices. If the price is "on application" (POA), do NOT invent it: estimate from comparables of similar length, age and builder and use "medium" or "low" confidence. For a new or nearly new yacht start from the list or build price; for a used one apply real depreciation for its age. Show in "notes" the identified model, the length used, 2-3 comparables with their price and the calculation. User-provided builder, model, length, year and engine hours override what you infer from the photo. For MUSICAL INSTRUMENTS (category music instrument: guitars, basses, violins, violas, cellos, pianos, wind instruments, drums, synthesizers, amplifiers) FIRST identify the make, model, year and country of manufacture (use the serial number, the inside label, the headstock and any inscriptions), the finish, and whether it is original or has been repaired, refinished or had parts replaced. On high-end or vintage instruments, origin, year and originality matter more than the model: the same model can be worth several times more depending on the era. Look up real sale prices of units of the SAME model and year (Reverb, Thomann, eBay sold listings, Tarisio Cozio for bowed string instruments, and Christie's, Sotheby's or Bonhams for exceptional pieces) and distinguish asking prices from sold prices. For violins, violas, cellos and bows attributed to a maker, without a certificate of authenticity treat them as workshop or "in the style of" instruments and lower the confidence. Show in "notes" the identified model, the estimated year and 2-3 comparables with their price. For REAL ESTATE, never apply artificial ceilings: ALWAYS calculate area × the micro-location's price per m² first, then adjust for condition and uniqueness. User-provided location, area and property type override visual guesses; never reduce a stated area. If area is absent, use a coherent area interval and calculate both endpoints. For luxury property cite indicative comparables from Idealista, Fotocasa, Sotheby's Realty, Christie's Real Estate and Engel & Völkers, do not cap at EUR 1,000,000, and show area, EUR/m² range, premiums and final calculation in notes. For BONSAI (category bonsai) identify species, style (chokkan, moyogi, kengai, forest, etc.), approximate age from trunk girth and nebari, ramification quality and visible health; note if the pot is by a recognised potter (Tokoname, Yixing) and value it separately if significant. Reference Bonsai Empire, specialised nurseries/auctions and eBay sold listings; prices range from EUR 20-30 for starter material to several thousand for mature styled specimens. For WINE & SPIRITS (category wine) identify producer, appellation/region, vintage, bottle format and condition (fill level, label, capsule, cork); reference Wine-Searcher, iDealwine, Vinfolio and auction houses such as Sotheby's/Christie's Wine or Whisky Auctioneer for spirits. For ANTIQUE FURNITURE (category furniture) identify style and period (e.g. Louis XV, Art Deco, mid-century), material, possible maker/workshop marks, and condition/restorations; reference Catawiki, 1stDibs, Invaluable and Christie's/Sotheby's furniture departments. For MILITARIA (category militaria) identify conflict/era, country, unit and item type (medal, insignia, uniform, document), and explicitly flag if it looks like a modern reproduction rather than an original piece, since price varies drastically; reference specialised houses like Hermann Historica, Bonhams Arms & Militaria and eBay sold listings. For LUXURY BAGS & ACCESSORIES (category luxury bags) identify brand, model, line, materials, hardware and possible authenticity cues (stitching quality, stamping, visible serial/date code); reference Vestiaire Collective, The RealReal, Fashionphile, Rebag and Christie's/Sotheby's handbag departments. For MINERALS & ROCKS (category minerals) identify mineral species, crystal habit, colour and transparency, likely locality, and estimated size; reference Mindat.org, MineralAuctions, eBay sold listings and Catawiki. For LOOSE GEMSTONES (category gemstones) identify gem type, cut, colour, transparency and likely origin; carat weight is decisive, and if not visible flag it as a limitation; reference Opal Auctions (for opals), GemVal, GIA (Gemological Institute of America), eBay sold listings and Catawiki. For WATCHES (category watches) FIRST identify brand, model and exact REFERENCE (read it on the dial, case, clasp and caseback; say so if it is uncertain), the calibre if visible and, above all, the case and bracelet MATERIAL: solid gold (18K/750), two-tone, gold-plated (GP) or steel. The same model in solid gold can be worth several times more than in steel, and a luxury-brand gold watch can be worth tens of thousands of euros or more: do not apply a low floor or price it as a mid-range watch without reason. Also weigh year or serial range, condition, whether dial, crown, hands and bracelet are original (replaced or refinished parts lower the price a lot), over-polishing, original box and papers, and service history. Look up the real price of units of the SAME reference (Chrono24, WatchCharts, eBay sold listings and houses such as Phillips, Christie's, Sotheby's or Antiquorum) and distinguish asking from sold prices. If you cannot read the reference, explain the doubt in \"notes\" and widen the range with \"low\" confidence instead of inventing a model. Show in \"notes\" the identified reference, the material and 2-3 comparables with their price. For JEWELLERY (category jewelry) ALWAYS look for the engraved hallmark/stamp (750/18K, 585/14K, 417/10K, 375/9K = solid gold; 925 = sterling silver; 950 = platinum) versus PLATED/FILLED marks (GP, "gold filled", "gold plated", "chapado", "vermeil"): these are entirely different value worlds. If SOLID gold/silver, compute melt value using the real spot price provided (estimated weight in grams × fineness × metal price) and add a premium for a recognised maker, designer piece, set gemstones or age — melt is the FLOOR, not the final price when there is added value. If PLATED/FILLED, the precious metal is a thin layer: do NOT compute melt over the total weight, price it as fine costume jewellery based on brand, design and condition. When there is reasonable doubt between solid and plated, say so explicitly in "notes" and use "low" or "medium" confidence rather than assuming solid.

BASQUE COUNTRY is a high-price market: never substitute national or province-wide averages for a prime micro-location. Indicative ranges when the user's context identifies them: Neguri and Getxo seafront 7,500-10,000 EUR/m² (8,000 EUR/m² luxury baseline); Las Arenas/Areeta and prime Algorta 6,000-8,500; Bilbao Abandoibarra 6,500-9,000, prime Ensanche/Abando and Indautxu 5,500-8,000; San Sebastián Centro, Romantic Area, Miraconcha and Ondarreta 8,000-12,000, with exceptional stock above that; prime Zarautz and Hondarribia 6,000-9,000; prime central Vitoria 4,000-6,000. For unlisted districts use their own micro-location comparables rather than automatically applying prime prices. Add 15-40% for sea views, terrace, penthouse, land, landmark building, large floor area or full luxury renovation. Do not apply a generic discount after choosing an EUR/m² figure already adjusted for condition. DO NOT round the price per m²: state the exact value you apply (for example, 8,125 EUR/m², not 8,000 EUR/m²) and use that exact value when multiplying by the area. Binding example: a 200 m² luxury residence in Neguri at 8,000 EUR/m² starts at EUR 1,600,000 before premiums and must not end below that due to a contradictory visual guess. If live listings are unavailable, clearly label sources as indicative references rather than live queries. Always answer in English.`;

function applyBulkFloor(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const rec = parsed as Record<string, unknown>;
  const lowConfidence = rec.confidence === "low";
  const enforceMinimum = (val: unknown, defaultMin: number): number => {
    const num = toNumberLoose(val);
    if (!isFinite(num) || num < 0) return 0;
    if (lowConfidence) return num;
    return num < defaultMin ? defaultMin : num;
  };
  rec.priceEurMin = enforceMinimum(rec.priceEurMin, 0.02);
  rec.priceEurMax = enforceMinimum(rec.priceEurMax, 0.1);
  rec.priceUsdMin = enforceMinimum(rec.priceUsdMin, 0.02);
  rec.priceUsdMax = enforceMinimum(rec.priceUsdMax, 0.1);
  if ((rec.priceEurMax as number) < (rec.priceEurMin as number)) rec.priceEurMax = rec.priceEurMin;
  if ((rec.priceUsdMax as number) < (rec.priceUsdMin as number)) rec.priceUsdMax = rec.priceUsdMin;
  return rec;
}

export const valuateItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    if (!process.env.XAI_API_KEY && !process.env.LOVABLE_API_KEY && !process.env.GEMINI_API_KEY) {
      console.error("[valuateItem] Missing XAI_API_KEY and LOVABLE_API_KEY");
      setResponseStatus(500);
      throw new Error("Valuation service misconfigured");
    }

    const { origin, host } = requestOriginHost();
    if (!isAllowedOrigin(origin, host)) {
      setResponseStatus(403);
      throw new Error("Forbidden");
    }

    const ip = clientIp();
    if (!checkGlobal()) {
      setResponseStatus(429);
      throw new Error("Service busy, try again later");
    }
    if (!pruneAndCheck(ip, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
      setResponseStatus(429);
      throw new Error("Too many requests");
    }

    try {
      if (isCoinValuation(data.category, data.context)) {
        let lastCoinErr: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            // Cotización e identificación no dependen entre sí: en paralelo.
            const [spots, id] = await Promise.all([getMetalSpots(), identifyCoin(data)]);
            return await priceCoin(data, id, spots);
          } catch (coinErr) {
            lastCoinErr = coinErr;
            if (isQuotaError(coinErr)) break;
          }
        }
        throw lastCoinErr;
      }

      if (data.category === "cards" || /\b(magic|mtg)\b/i.test(data.context)) {
        try {
          const card = await tryMagicCard(data);
          if (card) return card;
        } catch (cardErr) {
          console.error("[valuateItem] Magic card lookup failed, using general flow:", cardErr);
          if (isQuotaError(cardErr)) throw cardErr;
        }
      }

      let watchHint: string | undefined;
      let watchItemId: ItemId | undefined;
      if (data.category === "watches") {
        try {
          const outcome = await valuateWatchRetail(data);
          if (outcome.result) return outcome.result;
          watchHint = outcome.hint;
          watchItemId = outcome.itemId;
        } catch (watchErr) {
          console.error("[valuateItem] watch retail lookup failed, using general flow:", watchErr);
          if (isQuotaError(watchErr)) throw watchErr;
        }
      }

      const categoryLine =
        data.category && data.category !== "auto"
          ? data.lang === "es"
            ? `\nCategoría indicada: ${data.category}`
            : `\nStated category: ${data.category}`
          : "";
      const conditionLine =
        data.condition && data.condition !== "unknown"
          ? data.lang === "es"
            ? `\nCondición indicada por el usuario: ${data.condition} (ajusta el precio en consecuencia)`
            : `\nUser-stated condition: ${data.condition} (adjust price accordingly)`
          : "";

      // La cotización no depende de la identificación: se pide a la vez y se espera después.
      const spotsPromise =
        data.category === "jewelry" ? getMetalSpots() : Promise.resolve(null);

      let itemId: ItemId | null = null;
      try {
        if (USE_IDENTIFICATION_PASS) itemId = watchItemId ?? (await identifyItem(data));
      } catch (idErr) {
        console.error("[valuateItem] identification pass failed, continuing without it:", idErr);
        if (isQuotaError(idErr)) throw idErr;
      }

      // Para joyería inyectamos también la cotización real del oro/plata, igual que
      // en el flujo especializado de monedas: sin esto, la IA calcularía el valor de
      // fundición de memoria (a menudo desactualizado) en vez de con el precio de hoy.
      let metalSpotLine = "";
      const metalSpots = await spotsPromise;
      if (metalSpots) {
        metalSpotLine =
          data.lang === "es"
            ? `\nCotización actual del metal (OBLIGATORIA, no inventes otra): oro ${roundMoney(metalSpots.goldUsd)} USD/oz troy (${roundMoney(metalSpots.goldEur)} EUR/oz), plata ${roundMoney(metalSpots.silverUsd)} USD/oz (${roundMoney(metalSpots.silverEur)} EUR/oz).`
            : `\nCurrent metal spot (MANDATORY, do not invent another): gold ${roundMoney(metalSpots.goldUsd)} USD/troy oz (${roundMoney(metalSpots.goldEur)} EUR/oz), silver ${roundMoney(metalSpots.silverUsd)} USD/oz (${roundMoney(metalSpots.silverEur)} EUR/oz).`;
      }
      const queriesTxt = itemId && itemId.searchQueries.length ? itemId.searchQueries.join(" | ") : "";
      const referenceCategory = data.category === "auto" || data.category === "other"
        ? itemId?.category ?? "other"
        : data.category;
      const siteInstructions = formatSiteSearchInstructions(
        buildSiteQueries([...buildFichaQueries(itemId?.ficha), ...(itemId?.searchQueries ?? [])], referenceCategory, itemId?.summary || "objeto de la fotografía precio mercado"),
        data.lang,
      );
      const watchStyleRules =
        data.lang === "es"
          ? '\nReglas de redacción para este reloj: en "identification" describe solo lo que se VE; no afirmes que la referencia es exacta si no está escrita en la foto o en el contexto (di "probable"), no indiques el estado, la caja ni los papeles, y no incluyas modelos alternativos. En "notes" escribe como máximo dos frases cortas: que no es precio de tienda nuevo y de dónde sale el rango; no repitas la identificación ni pidas datos al usuario.'
          : '\nWriting rules for this watch: in "identification" describe only what is VISIBLE; do not claim the reference is exact unless it is written in the photo or the context (say "probable"), do not state condition, box or papers, and do not list alternative models. In "notes" write at most two short sentences: that it is not a new retail price and where the range comes from; do not repeat the identification or ask the user for data.';
      const watchLine = watchHint ? `\n${watchHint}${watchStyleRules}` : "";
      const idLine =
        itemId && itemId.summary
          ? data.lang === "es"
            ? `\nIdentificación previa a partir de las fotos (verifícala y corrígela si al buscar ves que es otro objeto): ${itemId.summary}${queriesTxt ? `\nBúsquedas sugeridas de ventas reales: ${queriesTxt}` : ""}\nBasa el precio en ventas reales cerradas (no solo en anuncios) de este objeto exacto.`
            : `\nPrior identification from the photos (verify it and correct it if your searches show it is a different item): ${itemId.summary}${queriesTxt ? `\nSuggested searches for real sales: ${queriesTxt}` : ""}\nBase the price on real closed sales (not only asking prices) of this exact item.`
          : "";

      const userPrompt =
        (data.lang === "es"
          ? "Analiza este objeto y devuelve JSON con los campos: title (nombre corto), identification (descripción detallada: tipo, marca/autor probable, época, materiales, estado aparente), priceEurMin, priceEurMax, priceUsdMin, priceUsdMax (números decimales en euros y dólares, ej: 0.05 y 0.10), confidence (low|medium|high), notes (razonamiento y factores que afectan el precio; si las bases de datos mencionadas son solo referencias orientativas y no consultas en vivo, acláralo aquí), sources (array con las bases públicas consultadas conceptualmente, ej: eBay sold listings, Wikipedia, Catawiki...), comparables (array opcional con SOLO anuncios o ventas reales que hayas encontrado con la búsqueda web: {title, price (número), currency (\"EUR\" o \"USD\"), kind (\"sold\" o \"asking\"), url (dirección exacta de la página)}; si no encontraste ninguno devuelve [] y NUNCA inventes comparables).\n\nContexto del usuario: "
          : "Analyze this item and return JSON with fields: title (short name), identification (detailed description: type, likely brand/maker, era, materials, apparent condition), priceEurMin, priceEurMax, priceUsdMin, priceUsdMax (decimal numbers in euros and dollars, e.g. 0.05 and 0.10), confidence (low|medium|high), notes (reasoning and factors affecting price; clarify here if the mentioned databases are only indicative references rather than live lookups), sources (array with the public databases consulted conceptually, e.g. eBay sold listings, Wikipedia, Catawiki...), comparables (optional array with ONLY real listings or sales you found with web search: {title, price (number), currency (\"EUR\" or \"USD\"), kind (\"sold\" or \"asking\"), url (exact page address)}; if you found none return [] and NEVER invent comparables).\n\nUser context: ") +
        (data.context || "(none)") +
        categoryLine +
        conditionLine +
        metalSpotLine +
        idLine +
        siteInstructions +
        watchLine +
        (data.lang === "es"
          ? '\nREGLA DE EVIDENCIA: sources contiene solo URLs de páginas realmente consultadas, nunca nombres de webs consultadas conceptualmente. Compara el mismo modelo, edición, material, estado y mercado; excluye lotes, accesorios, réplicas o variantes distintas. Wikipedia y catálogos descriptivos sirven para identificar, no prueban un precio. No inventes dimensiones, kilómetros, autenticidad ni procedencia; el contexto solo prevalece si es coherente. Esta regla prevalece sobre cualquier instrucción anterior contradictoria.'
          : '\nEVIDENCE RULE: sources contains only URLs of pages actually consulted, never conceptually consulted site names. Match model, edition, material, condition and market; exclude lots, accessories, replicas or different variants. Wikipedia and descriptive catalogues support identification, not price evidence. Do not invent dimensions, mileage, authenticity or provenance; context only overrides guesses when consistent. This rule overrides any conflicting earlier instruction.');

      const rangeLineEs =
        "\n\nIMPORTANTE: da SIEMPRE un rango de precio estimado y realista (aunque sea amplio) y usa confianza \"low\" si tienes dudas. No devuelvas precios en 0 y responde solo con el JSON pedido.";
      const rangeLineEn =
        "\n\nIMPORTANT: ALWAYS give a realistic estimated price range (even if wide) and use \"low\" confidence if unsure. Do not return zero prices and reply only with the requested JSON.";

      const finish = (r: ValuationResult, verifiedPrice: boolean): ValuationResult => {
        const hasLink = r.sources.some((s) => /^https?:\/\//i.test(s));
        const flagged =
          watchHint
            ? {
                ...r,
                identification: cleanWatchIdentification(
                  r.identification,
                  !!itemId && itemId.ficha?.reference === "",
                ),
                // Si el propio sistema ya avisó de que no hay comparables verificados, no se repite.
                notes: hasLink
                  ? trimNotes(r.notes)
                  : /^(Estimación orientativa|Indicative estimate)/i.test(r.notes.trim())
                    ? trimNotes(r.notes, 380)
                    : `${data.lang === "es" ? "Estimación sin fuentes verificadas." : "Estimate without verified sources."} ${trimNotes(r.notes, 380)}`.trim(),
                ...(hasLink ? {} : { confidence: "low" as const }),
              }
            : r;
        const finished = withMissingInfo(flagged, itemId, data.lang);
        return verifiedPrice && finished.confidence === "low"
          ? { ...finished, confidence: "medium" }
          : finished;
      };
      let forceRange = false;
      let lastErr: unknown = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { text, citations } = await chatCompletion({
            messages: [
              { role: "system", content: data.lang === "es" ? systemEs : systemEn },
              {
                role: "user",
                content: photoContent(
                  data.photos,
                  userPrompt + (forceRange ? (data.lang === "es" ? rangeLineEs : rangeLineEn) : ""),
                ),
              },
            ],
            json: true,
            search: true,
            // No generar otra respuesta sin búsqueda antes de probar el siguiente buscador.
            // Monedas y Magic conservan sus llamadas y su comportamiento actuales.
            evidenceFirst: true,
            timeoutMs: attempt === 1 ? 60_000 : 40_000,
            maxTokens: 2200,
          });

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error("Model did not return valid JSON");
          }

          // Si la búsqueda web consultó páginas de verdad, van primero en la lista de referencias.
          if (citations.length > 0 && parsed && typeof parsed === "object") {
            const p = parsed as { sources?: unknown };
            const own = Array.isArray(p.sources)
              ? p.sources.filter((x): x is string => typeof x === "string")
              : [];
            p.sources = Array.from(new Set([...citations.map((c) => c.slice(0, 200)), ...own])).slice(
              0,
              8,
            );
          }

          // Precio encontrado de verdad (anuncios o ventas verificados) manda sobre la estimación.
          const anchored = anchorToComparables(parsed, citations, EUR_PER_USD_APPROX, data.lang, true);
          if (!anchored) parsed = applyBulkFloor(parsed);

          const result = ResultSchema.safeParse(parsed);
          if (!result.success) {
            console.error(
              "[valuateItem] Model output failed schema validation:",
              result.error.flatten(),
            );
            throw new Error("Valuation service returned an unexpected response");
          }

          const r = positivePrices(result.data, EUR_PER_USD_APPROX);
          if (!r) {
            // Una respuesta sin precio no es una tasación. Reintentar sin inventar un suelo.
            forceRange = true;
            throw new Error("Valuation service returned no positive price");
          }
          return finish(r, anchored);
        } catch (attemptErr) {
          lastErr = attemptErr;
          if (isQuotaError(attemptErr)) break;
          // Un fallo de red/servicio no se arregla repitiendo toda la tasación (hasta 40 s más).
          // Solo corregimos respuestas recibidas con JSON o campos inválidos.
          if (!(attemptErr instanceof Error) || ![
            "Model did not return valid JSON",
            "Valuation service returned an unexpected response",
            "Valuation service returned no positive price",
          ].includes(attemptErr.message)) break;
        }
      }
      throw lastErr;
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        setResponseStatus(504);
        throw new Error("Valuation service timed out");
      }
      if (isQuotaError(err)) {
        console.error("[valuateItem] AI quota exceeded:", err);
        setResponseStatus(429);
        throw new Error("Valuation quota exceeded" + errorDetail(err));
      }
      if (err instanceof Error && err.message.startsWith("Valuation")) {
        setResponseStatus(502);
        throw err;
      }
      console.error("[valuateItem] failed:", err);
      setResponseStatus(502);
      throw new Error("Valuation service unavailable" + errorDetail(err));
    }
  });
