import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
import { chatCompletion } from "./lume-ai";

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