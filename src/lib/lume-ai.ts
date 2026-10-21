import { getRequest } from "@tanstack/react-start/server";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const PREVIEW_HOST_RE =
  /(^|\.)(lovable\.app|lovable\.dev|lovableproject\.com|grok\.me|grok\.com|x\.ai)$/i;

export function isAllowedOrigin(origin: string | null, host: string | null): boolean {
  if (host) {
    const hostOnly = host.split(":")[0] ?? host;
    if (hostOnly === "localhost" || hostOnly === "127.0.0.1" || PREVIEW_HOST_RE.test(hostOnly)) {
      if (!origin) return true;
    }
  }
  if (!origin) return false;
  let originHost: string;
  let originFull: string;
  try {
    const u = new URL(origin);
    originHost = u.host;
    originFull = u.origin;
  } catch {
    return false;
  }
  if (host && originHost === host) return true;
  if (ALLOWED_ORIGINS.includes(originFull)) return true;
  if (PREVIEW_HOST_RE.test(originHost.split(":")[0] ?? originHost)) return true;
  if (/^localhost(:\d+)?$/.test(originHost) || /^127\.0\.0\.1(:\d+)?$/.test(originHost)) {
    return true;
  }
  return false;
}

export function clientIp(): string {
  const request = getRequest();
  return (
    request?.headers.get("cf-connecting-ip") ??
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request?.headers.get("x-real-ip") ??
    "unknown"
  );
}

export function requestOriginHost(): { origin: string | null; host: string | null } {
  const request = getRequest();
  return {
    origin: request?.headers.get("origin") ?? request?.headers.get("referer") ?? null,
    host: request?.headers.get("host") ?? null,
  };
}

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

export type ChatResult = {
  text: string;
  citations: string[];
};

async function parseChatJson(res: Response): Promise<ChatResult> {
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };
  const raw = json.choices?.[0]?.message?.content ?? "{}";
  return {
    text: extractJsonText(raw),
    citations: Array.isArray(json.citations) ? json.citations.slice(0, 8) : [],
  };
}

function xaiBody(opts: {
  messages: ChatMessage[];
  json?: boolean;
  search?: boolean;
  maxTokens?: number;
  searchTool?: "web_search" | "live_search" | "search_parameters" | "none";
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: "grok-4.5",
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 2200,
  };
  const mode = opts.searchTool ?? (opts.search ? "web_search" : "none");
  if (opts.json && mode === "none") body.response_format = { type: "json_object" };
  if (mode === "web_search") {
    body.tools = [{ type: "web_search" }];
  } else if (mode === "live_search") {
    body.tools = [{ type: "live_search" }];
  } else if (mode === "search_parameters") {
    body.search_parameters = { mode: "on", return_citations: true };
  }
  return body;
}

export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return body;
  return body.slice(start, end + 1);
}

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  json?: boolean;
  search?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<ChatResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const xaiKey = process.env.XAI_API_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let xaiError: string | null = null;

    if (xaiKey) {
      const searchModes: Array<"web_search" | "live_search" | "search_parameters" | "none"> =
        opts.search ? ["web_search", "live_search", "search_parameters", "none"] : ["none"];

      let lastErr = "";
      for (const mode of searchModes) {
        try {
          const res = await fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${xaiKey}`,
            },
            body: JSON.stringify(xaiBody({ ...opts, search: mode !== "none", searchTool: mode })),
            signal: controller.signal,
          });
          if (res.ok) return await parseChatJson(res);
          lastErr = await res.text();
          console.error(`[lume-ai] xAI ${mode} [${res.status}]: ${lastErr.slice(0, 280)}`);
          // 401/403 = clave inválida; 402/429 = sin crédito o límite alcanzado.
          // En cualquiera de estos casos no tiene sentido seguir insistiendo con xAI:
          // salimos del bucle y probamos el gateway de Lovable como alternativa real.
          if ([401, 402, 403, 429].includes(res.status)) break;
          if (!opts.search) break;
          if (![400, 410, 422, 404].includes(res.status)) break;
        } catch (fetchErr) {
          lastErr = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          console.error(`[lume-ai] xAI ${mode} fetch failed: ${lastErr}`);
          break;
        }
      }
      xaiError = `xAI failed: ${lastErr.slice(0, 120)}`;
    }
    let geminiError = null as string | null;
    let mistralError = null as string | null;
    const geminiKey = process.env.GEMINI_API_KEY;
    const mistralKey = process.env.MISTRAL_API_KEY;

    const tryMistral = async (): Promise<ChatResult | null> => {
      if (!mistralKey) return null;
      try {
        return await mistralCompletion(mistralKey, opts, controller.signal);
      } catch (err) {
        console.error("[lume-ai] Mistral failed:", err);
        mistralError = err instanceof Error ? err.message : String(err);
        return null;
      }
    };

    const tryGemini = async (): Promise<ChatResult | null> => {
      if (!geminiKey) return null;
      try {
        return await geminiCompletion(geminiKey, opts, controller.signal);
      } catch (geminiErr) {
        console.error("[lume-ai] Gemini failed:", geminiErr);
        geminiError = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
        // Cuota agotada (a menudo la de búsqueda web): probamos sin búsqueda antes de rendirnos.
        // La tasación sale menos precisa, pero sale.
        if (opts.search && /429|RESOURCE_EXHAUSTED/i.test(geminiError)) {
          try {
            console.error("[lume-ai] Retrying Gemini without web search");
            return await geminiCompletion(geminiKey, { ...opts, search: false }, controller.signal);
          } catch (noSearchErr) {
            console.error("[lume-ai] Gemini without search failed:", noSearchErr);
            geminiError +=
              "; no-search " +
              (noSearchErr instanceof Error ? noSearchErr.message : String(noSearchErr));
          }
        }
        return null;
      }
    };

    const geminiFirst = opts.search === true && USE_GEMINI_FOR_SEARCH;
    const providers = geminiFirst ? [tryGemini, tryMistral] : [tryMistral, tryGemini];
    for (const attempt of providers) {
      const result = await attempt();
      if (result) return result;
    }
    if (!lovableKey && (mistralError || geminiError)) {
      throw new Error([xaiError, mistralError, geminiError].filter(Boolean).join("; "));
    }
    // Si xAI no está configurada, o falló (clave inválida, sin crédito, error de red...),
    // caemos de verdad al gateway de Lovable en vez de fallar toda la tasación.
    if (lovableKey) {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": lovableKey,
        },
        body: JSON.stringify({
          model: "google/gemini-3.6-flash",
          messages: opts.messages,
          response_format: opts.json ? { type: "json_object" } : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`[lume-ai] Lovable error [${res.status}]: ${text.slice(0, 400)}`);
        throw new Error(
          [xaiError, mistralError, geminiError, `gateway ${res.status}`].filter(Boolean).join("; "),
        );
      }
      return parseChatJson(res);
    }

    throw new Error(xaiError ?? "AI is not available in this environment");
  } finally {
    clearTimeout(timeout);
  }
}

export type MetalSpots = {
  goldUsd: number;
  silverUsd: number;
  goldEur: number;
  silverEur: number;
  eurPerUsd: number;
};

async function fetchJson(url: string, ms: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getMetalSpots(): Promise<MetalSpots | null> {
  const [gold, silver, fx] = await Promise.all([
    fetchJson("https://api.gold-api.com/price/XAU", 4000),
    fetchJson("https://api.gold-api.com/price/XAG", 4000),
    fetchJson("https://api.frankfurter.app/latest?from=USD&to=EUR", 4000),
  ]);
  const goldUsd = Number((gold as { price?: number } | null)?.price);
  const silverUsd = Number((silver as { price?: number } | null)?.price);
  const eurPerUsd = Number((fx as { rates?: { EUR?: number } } | null)?.rates?.EUR);
  if (!Number.isFinite(goldUsd) || goldUsd <= 0) return null;
  if (!Number.isFinite(silverUsd) || silverUsd <= 0) return null;
  if (!Number.isFinite(eurPerUsd) || eurPerUsd <= 0) return null;
  return {
    goldUsd,
    silverUsd,
    eurPerUsd,
    goldEur: goldUsd * eurPerUsd,
    silverEur: silverUsd * eurPerUsd,
  };
}

export function roundMoney(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n < 1) return Math.round(n * 100) / 100;
  if (n < 100) return Math.round(n * 10) / 10;
  return Math.round(n);
}

function toGeminiContents(messages: ChatMessage[]) {
  const system: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];
  for (const m of messages) {
    const parts: Array<Record<string, unknown>> = [];
    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else {
      for (const p of m.content) {
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ text: p.text });
        } else if (p.type === "image_url") {
          const url = (p.image_url as { url?: string } | undefined)?.url ?? "";
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
        }
      }
    }
    if (m.role === "system") {
      for (const p of parts) if (typeof p.text === "string") system.push(p.text);
    } else {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
  }
  return { system: system.join("\n\n"), contents };
}

// Orden de proveedores: xAI (si hay clave) -> Mistral (si hay MISTRAL_API_KEY) -> Gemini -> Lovable.
// La API de chat de Mistral no hace búsqueda web. Pon esto en true para que las peticiones que
// piden búsqueda web sigan yendo primero a Gemini (y Mistral quede como respaldo).
const USE_GEMINI_FOR_SEARCH = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Espera antes de reintentar: la que indica el proveedor (Retry-After, en segundos) o una pausa corta.
function retryDelayMs(res: Response, attempt: number): number {
  const secs = Number(res.headers?.get("retry-after"));
  const base = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1500 * attempt;
  return Math.min(base, 6000);
}

async function mistralCompletion(
  apiKey: string,
  opts: { messages: ChatMessage[]; json?: boolean; maxTokens?: number },
  signal: AbortSignal,
): Promise<ChatResult> {
  // Mistral espera la imagen como texto (URL o data URL) en image_url.
  const messages = opts.messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: m.content.map((part) => {
        if (part.type === "image_url") {
          const img = part.image_url as { url?: string } | string | undefined;
          return { type: "image_url", image_url: typeof img === "string" ? img : (img?.url ?? "") };
        }
        return part;
      }),
    };
  });

  // Modelo grande para tasar; pequeño y barato para tareas ligeras (detección, identificación).
  const light = (opts.maxTokens ?? 2200) <= 700;
  const body: Record<string, unknown> = {
    model: light ? "mistral-small-latest" : "mistral-large-latest",
    messages,
    max_tokens: opts.maxTokens ?? 2200,
    temperature: 0.2,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  // Ante un límite por minuto (429) o un fallo del servidor (5xx), esperamos y reintentamos.
  let res!: Response;
  let text = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    break;
  }
  if (!res.ok) {
    console.error(`[lume-ai] Mistral error [${res.status}]: ${text.slice(0, 400)}`);
    let reason = "";
    try {
      const j = JSON.parse(text) as { message?: string; code?: string | number; type?: string };
      reason = [j.type, j.code].filter(Boolean).join(" ");
      if (!reason && j.message) reason = j.message.slice(0, 80);
    } catch {
      /* respuesta que no es JSON */
    }
    throw new Error(reason ? `mistral ${res.status} ${reason}` : `mistral ${res.status}`);
  }
  const json = JSON.parse(text) as {
    choices?: Array<{
      message?: { content?: string | Array<{ type?: string; text?: string }> };
    }>;
  };
  const content = json.choices?.[0]?.message?.content;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => c.text ?? "").join("")
        : "";
  return { text: extractJsonText(raw || "{}"), citations: [] };
}

async function geminiCompletion(
  apiKey: string,
  opts: { messages: ChatMessage[]; json?: boolean; search?: boolean },
  signal: AbortSignal,
): Promise<ChatResult> {
  const { system, contents } = toGeminiContents(opts.messages);
  const body: Record<string, unknown> = { contents };
  if (opts.json && !opts.search) {
    body.generationConfig = { responseMimeType: "application/json" };
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (opts.search) body.tools = [{ google_search: {} }];

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    console.error(`[lume-ai] Gemini error [${res.status}]: ${text.slice(0, 400)}`);
    // Motivo que da Google (sin datos sensibles): estado y razón, para poder diagnosticar.
    let reason = "";
    try {
      const j = JSON.parse(text) as {
        error?: { status?: string; message?: string; details?: Array<{ reason?: string }> };
      };
      const detail = j.error?.details?.find((d) => d.reason)?.reason;
      reason = [j.error?.status, detail].filter(Boolean).join(" ");
      if (!reason && j.error?.message) reason = j.error.message.slice(0, 80);
    } catch {
      /* respuesta que no es JSON */
    }
    throw new Error(reason ? `gemini ${res.status} ${reason}` : `gemini ${res.status}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
    }>;
  };
  const cand = json.candidates?.[0];
  const raw = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const citations = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => typeof u === "string")
    .slice(0, 8);
  return { text: extractJsonText(raw || "{}"), citations };
}
