import { beforeEach, expect, it, vi } from "vitest";
import { GeminiEmbeddingProvider } from "../src/providers/embedding/gemini.js";
import { fetchWithTimeout } from "../src/providers/_fetch.js";

const env = vi.hoisted(() => ({} as Record<string, string | undefined>));
vi.mock("../src/providers/_fetch.js", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../src/config.js", () => ({ getEnvVar: (name: string) => env[name] }));
const fetchMock = vi.mocked(fetchWithTimeout);

function sent(call: number): { url: string; model: string; text: string; width: number } {
  const [url, init] = fetchMock.mock.calls[call];
  const request = JSON.parse(String((init as RequestInit).body)).requests[0];
  return { url: String(url), model: request.model, text: request.content.parts[0].text, width: request.outputDimensionality };
}

beforeEach(() => {
  delete env.GEMINI_EMBEDDING_MODEL;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ embeddings: [{ values: [3, 4] }] })));
});

it("sends records and queries unchanged to gemini-embedding-001 when no model is set", async () => {
  const provider = new GeminiEmbeddingProvider("key");
  await provider.embedBatch(["a stored record"]);
  await provider.embedQuery("a question");

  expect(sent(0)).toEqual({
    url: expect.stringContaining("/models/gemini-embedding-001:batchEmbedContents"),
    model: "models/gemini-embedding-001", text: "a stored record", width: 768,
  });
  expect(sent(1).text).toBe("a question");
  expect(provider.vectorSpace).toBeUndefined();
});

it("tells gemini-embedding-2 which text is a record and which is a query", async () => {
  env.GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
  const provider = new GeminiEmbeddingProvider("key");
  await provider.embedBatch(["a stored record"]);
  await provider.embed("another record");
  await provider.embedQuery("a question");

  expect(sent(0)).toEqual({
    url: expect.stringContaining("/models/gemini-embedding-2:batchEmbedContents"),
    model: "models/gemini-embedding-2", text: "title: none | text: a stored record", width: 768,
  });
  expect(sent(1).text).toBe("title: none | text: another record");
  expect(sent(2).text).toBe("task: search result | query: a question");
  expect(provider.vectorSpace).toBe("gemini-embedding-2");
});
