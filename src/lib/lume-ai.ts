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
        throw new Error(xaiError ? `${xaiError}; gateway ${res.status}` : `gateway ${res.status}`);
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
