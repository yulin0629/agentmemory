import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GeminiEmbeddingProvider } from "../src/providers/embedding/gemini.js";
import { fetchWithTimeout } from "../src/providers/_fetch.js";
vi.mock("../src/providers/_fetch.js", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../src/config.js", () => ({ getEnvVar: (name: string) => name === "GEMINI_API_KEY_FALLBACK" ? "fallback-test" : undefined }));
const fetchMock = vi.mocked(fetchWithTimeout);
beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

it("uses the fallback only after four primary retryable failures", async () => {
  fetchMock.mockImplementation(async (url) => String(url).includes("fallback-test")
    ? new Response(JSON.stringify({ embeddings: [{ values: [3, 4] }] }))
    : new Response("quota", { status: 429 }));
  const result = new GeminiEmbeddingProvider("primary-test").embed("text");
  await vi.runAllTimersAsync();
  expect(Array.from(await result)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(fetchMock.mock.calls.slice(0, 4).every(([url]) => String(url).includes("primary-test"))).toBe(true);
});

it("does not retry or use fallback for non-retryable failures", async () => {
  fetchMock.mockResolvedValue(new Response("invalid", { status: 400 }));
  await expect(new GeminiEmbeddingProvider("primary-test").embed("text")).rejects.toThrow("400");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("bounds retries when both keys fail", async () => {
  fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  const rejection = expect(new GeminiEmbeddingProvider("primary-test").embed("text")).rejects.toThrow("503");
  await vi.runAllTimersAsync();
  await rejection;
  expect(fetchMock).toHaveBeenCalledTimes(5);
});
