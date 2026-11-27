import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GeminiEmbeddingProvider } from "../src/providers/embedding/gemini.js";
import { fetchWithTimeout } from "../src/providers/_fetch.js";

const env = vi.hoisted(() => ({} as Record<string, string | undefined>));
vi.mock("../src/providers/_fetch.js", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../src/config.js", () => ({ getEnvVar: (name: string) => env[name] }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const fetchMock = vi.mocked(fetchWithTimeout);

const KEY = { a: "key-a-" + "a".repeat(30), b: "key-b-" + "b".repeat(30), c: "key-c-" + "c".repeat(30) };
const ok = () => new Response(JSON.stringify({ embeddings: [{ values: [3, 4] }] }));
const invalid = () => new Response(JSON.stringify({ error: { details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 });

/** Answers each call by the key it carries, and records the keys asked, by name. */
function answer(respond: (name: string) => Response): string[] {
  const asked: string[] = [];
  fetchMock.mockImplementation(async (url) => {
    const name = Object.entries(KEY).find(([, key]) => String(url).includes(key))?.[0] ?? "other";
    asked.push(name);
    return respond(name);
  });
  return asked;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  for (const name of Object.keys(env)) delete env[name];
  const dir = mkdtempSync(join(tmpdir(), "gemini-pool-"));
  writeFileSync(join(dir, "agent.env"), `# keys\nGEMINI_API_KEY_FIRST=${KEY.a}\nGEMINI_API_KEY_MAIN="${KEY.b}"\nGEMINI_API_KEY_SHORT=tooshort\nOTHER=x\n`);
  env.GEMINI_API_KEY_FILE = join(dir, "agent.env");
});
afterEach(() => { vi.useRealTimers(); });

it("asks the preferred key first, moves on when it is over its quota, and leaves it alone for ten minutes", async () => {
  env.GEMINI_API_KEY_PREFER = "main";
  const provider = new GeminiEmbeddingProvider();
  let asked = answer(() => ok());
  await provider.embed("text");
  expect(asked).toEqual(["b"]);

  asked = answer((name) => name === "b" ? new Response("quota", { status: 429 }) : ok());
  expect(Array.from(await provider.embed("text"))).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
  expect(asked).toEqual(["b", "a"]);

  asked = answer(() => ok());
  await provider.embed("text");
  expect(asked).toEqual(["a"]);
  vi.advanceTimersByTime(600_001);
  await provider.embed("text");
  expect(asked).toEqual(["a", "b"]);
});

it("moves to the next key when one is invalid or refused", async () => {
  for (const refuse of [invalid, () => new Response("{}", { status: 403 })]) {
    const asked = answer((name) => name === "a" ? refuse() : ok());
    await new GeminiEmbeddingProvider().embed("text");
    expect(asked).toEqual(["a", "b"]);
  }
});

it("keeps the same key through a server error and a request the API rejects", async () => {
  let calls = 0;
  let asked = answer(() => calls++ === 0 ? new Response("unavailable", { status: 503 }) : ok());
  const result = new GeminiEmbeddingProvider().embed("text");
  await vi.runAllTimersAsync();
  await result;
  expect(asked).toEqual(["a", "a"]);

  asked = answer(() => new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), { status: 400 }));
  await expect(new GeminiEmbeddingProvider().embed("text")).rejects.toThrow("400");
  expect(asked).toEqual(["a"]);
});

it("asks GEMINI_API_KEY last, and alone when the file cannot be read", async () => {
  env.GEMINI_API_KEY = KEY.c;
  let asked = answer((name) => name === "c" ? ok() : new Response("quota", { status: 429 }));
  await new GeminiEmbeddingProvider().embed("text");
  expect(asked).toEqual(["a", "b", "c"]);

  env.GEMINI_API_KEY_FILE = "/nonexistent/agent.env";
  asked = answer(() => ok());
  await new GeminiEmbeddingProvider().embed("text");
  expect(asked).toEqual(["c"]);
});
