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
        ? `Eres un clasificador experto. Mira la foto y devuelve las 3 categorías más probables del objeto de esta lista EXACTA (usa la clave en inglés): art, cards, coins, stamps, watches, jew[...]`
        : `You are an expert classifier. Look at the photo and return the top 3 most likely categories from this EXACT list (use the English key): art, cards, coins, stamps, watches, jewelry, elec[...]`;

    const { text } = await chatCompletion({
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
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Model did not return valid JSON");
    }
    return OutputSchema.parse(parsed);
  });
