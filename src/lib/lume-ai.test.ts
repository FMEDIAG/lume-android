import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
import { chatCompletion, raceForEvidence, type ChatResult } from "./lume-ai";

const grounded = (text: string): ChatResult => ({ text, citations: ["https://shop.example/" + text] });
const later = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe("raceForEvidence", () => {
  it("starts the next search when the first one is slow and returns the first grounded reply", async () => {
    const started: number[] = [];
    const t0 = Date.now();
    const result = await raceForEvidence(
      [
        () => (started.push(Date.now() - t0), later(500, grounded("slow"))),
        () => (started.push(Date.now() - t0), later(10, grounded("fast"))),
      ],
      50,
    );
    expect(result?.text).toBe("fast");
    expect(started[1]).toBeLessThan(200);
  });

  it("falls back to the highest-priority ungrounded reply only after every search finishes", async () => {
    const result = await raceForEvidence(
      [
        () => later(30, { text: "first", citations: [] }),
        () => Promise.resolve(null),
        () => later(5, { text: "third", citations: [] }),
      ],
      1000,
    );
    expect(result).toEqual({ text: "first", citations: [] });
  });

  it("returns null when every provider fails", async () => {
    const result = await raceForEvidence([() => Promise.reject(new Error("x")), async () => null], 10);
    expect(result).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("evidence-first latency", () => {
  it("tries the next search instead of generating a serial ungrounded Mistral reply", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "test");
    vi.stubEnv("GEMINI_API_KEY", "test");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ candidates: [{
        content: { parts: [{ text: '{"price":100}' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://shop.example/product" } }] },
      }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletion({
      messages: [{ role: "user", content: "Find a verified price" }],
      search: true,
      evidenceFirst: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("generativelanguage.googleapis.com");
    expect(result.citations).toEqual(["https://shop.example/product"]);
  });

  it("preserves the existing non-search fallback when the option is absent", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "test");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"price":100}' } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletion({ messages: [{ role: "user", content: "Price" }], search: true });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(result.text).toBe('{"price":100}');
  });
});
