import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";
import { chatCompletion, isAllowedOrigin } from "@/lib/lume-ai";
import { clientIp, requestOriginHost } from "@/lib/lume-ai";

const MAX_PHOTO_CHARS = 1_500_000;

const CATEGORY_KEYS = [
  "art",
  "cards",
  "coins",
  "stamps",
  "watches",
  "jewelry",
  "electronics",
  "books",
  "music instrument",
  "toys",
  "vinyl",
  "fashion",
  "sports",
  "memorabilia",
  "bonsai",
  "wine",
  "furniture",
  "militaria",
  "luxury bags",
  "minerals",
  "gemstones",
  "vehicles",
  "boats",
  "realestate",
  "other",
] as const;

const InputSchema = z.object({
  dataUrl: z.string().startsWith("data:image/").max(MAX_PHOTO_CHARS),
  lang: z.enum(["es", "en"]).default("es"),
});

const CandidateSchema = z.object({
  category: z.enum(CATEGORY_KEYS),
  confidence: z.number().min(0).max(100),
});

const OutputSchema = z.object({
  category: z.enum(CATEGORY_KEYS),
  confidence: z.number().min(0).max(100),
  candidates: z.array(CandidateSchema).min(1).max(5),
});

const buckets = new Map<string, number[]>();
const WINDOW = 60_000;
const MAX_PER_IP = 20;

function allowed(ip: string): boolean {
  const now = Date.now();
  const arr = (buckets.get(ip) ?? []).filter((t) => now - t < WINDOW);
  if (arr.length >= MAX_PER_IP) {
    buckets.set(ip, arr);
    return false;
  }
  arr.push(now);
  buckets.set(ip, arr);
  return true;
}

type CategoryKey = (typeof CATEGORY_KEYS)[number];

function isCategoryKey(c: unknown): c is CategoryKey {
  return typeof c === "string" && (CATEGORY_KEYS as readonly string[]).includes(c);
}

// Acepta pequeñas variaciones de la IA (confianza 0-1 en vez de 0-100, categorías fuera de la
// lista) en lugar de rechazar toda la respuesta.
function normalizeOutput(raw: unknown) {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const toConf = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n > 0 && n <= 1 ? n * 100 : n));
  };
  const candidates: Array<{ category: CategoryKey; confidence: number }> = [];
  if (Array.isArray(obj.candidates)) {
    for (const c of obj.candidates) {
      const o = (c ?? {}) as Record<string, unknown>;
      if (isCategoryKey(o.category)) {
        candidates.push({ category: o.category, confidence: toConf(o.confidence) });
      }
    }
  }
  const category = isCategoryKey(obj.category) ? obj.category : candidates[0]?.category;
  if (!category) throw new Error("Model returned no valid category");
  const confidence =
    obj.confidence !== undefined ? toConf(obj.confidence) : (candidates[0]?.confidence ?? 0);
  return OutputSchema.parse({
    category,
    confidence,
    candidates: (candidates.length ? candidates : [{ category, confidence }]).slice(0, 5),
  });
}

export const detectCategory = createServerFn({ method: "POST" })
  .validator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    if (!process.env.XAI_API_KEY && !process.env.LOVABLE_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error("AI is not available in this environment");
    }

    const { origin, host } = requestOriginHost();
    if (!isAllowedOrigin(origin, host)) {
      setResponseStatus(403);
      throw new Error("Forbidden");
    }
    const ip = clientIp();
    if (!allowed(ip)) {
      setResponseStatus(429);
      throw new Error("Too many requests");
    }

    const system =
      data.lang === "es"
        ? `Eres un clasificador experto. Mira la foto y devuelve las 3 categorías más probables del objeto de esta lista EXACTA (usa la clave en inglés): art, cards, coins, stamps, watches, jewelry, electronics, books, music instrument, toys, vinyl, fashion, sports, memorabilia, bonsai, wine, furniture, militaria, luxury bags, minerals, gemstones, vehicles, boats, realestate, other. Usa "memorabilia" para autógrafos, objetos de cine, música o historia sin relación con el deporte, y "sports" solo para objetos deportivos (camisetas, balones, medallas, cartas de deportistas). Usa "bonsai" para árboles en maceta con estilo de bonsái. Usa "wine" para botellas de vino, cava, champán o licores. Usa "furniture" para muebles antiguos o de época. Usa "militaria" para objetos militares históricos (medallas, insignias, uniformes, cascos). Usa "luxury bags" para bolsos y complementos de marcas de lujo (no ropa general, que va en "fashion"). Usa "minerals" para especímenes de minerales o rocas en bruto sin tallar (cristales, geodas, fósiles). Usa "gemstones" para gemas o piedras preciosas sueltas ya talladas/pulidas pero sin montar en joya (si están montadas en un anillo, collar, etc., usa "jewelry"). Usa "coins" para monedas, billetes y piezas numismáticas encapsuladas (NGC/PCGS). Devuelve SOLO JSON: {"category":"<mejor_clave>","confidence":<0-100>,"candidates":[{"category":"<clave>","confidence":<0-100>}, ...3 elementos ordenados por confianza descendente]}. Las confidencias deben ser porcentajes enteros y sumar aproximadamente 100.`
        : `You are an expert classifier. Look at the photo and return the top 3 most likely categories from this EXACT list (use the English key): art, cards, coins, stamps, watches, jewelry, electronics, books, music instrument, toys, vinyl, fashion, sports, memorabilia, bonsai, wine, furniture, militaria, luxury bags, minerals, gemstones, vehicles, boats, realestate, other. Use "memorabilia" for autographs, film, music or historical items unrelated to sports, and "sports" only for sports-specific items (jerseys, balls, medals, athlete trading cards). Use "bonsai" for potted trees styled as bonsai. Use "wine" for wine, champagne or spirits bottles. Use "furniture" for antique or period furniture. Use "militaria" for historic military items (medals, insignia, uniforms, helmets). Use "luxury bags" for luxury-brand bags and accessories (not general clothing, which goes in "fashion"). Use "minerals" for raw, uncut mineral or rock specimens (crystals, geodes, fossils). Use "gemstones" for cut/polished loose gems not mounted in a piece of jewelry (if mounted in a ring, necklace, etc., use "jewelry" instead). Use "coins" for coins, banknotes and slabbed numismatic pieces (NGC/PCGS). Return ONLY JSON: {"category":"<best_key>","confidence":<0-100>,"candidates":[{"category":"<key>","confidence":<0-100>}, ...3 items ordered by descending confidence]}. Confidences are integer percentages and should sum to roughly 100.`;

    // Un reintento ante fallos pasajeros; si es cuota, no insistimos.
    let text = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ({ text } = await chatCompletion({
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: data.lang === "es" ? "Clasifica este objeto." : "Classify this item.",
                },
                { type: "image_url", image_url: { url: data.dataUrl, detail: "low" } },
              ],
            },
          ],
          json: true,
          search: false,
          timeoutMs: 25_000,
          maxTokens: 400,
        }));
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/429|RESOURCE_EXHAUSTED/i.test(msg)) {
          console.error("[detectCategory] AI quota exceeded:", msg);
          setResponseStatus(429);
          throw new Error("Detection quota exceeded");
        }
        console.error(`[detectCategory] attempt ${attempt} failed:`, msg);
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Model did not return valid JSON");
    }
    return normalizeOutput(parsed);
  });
