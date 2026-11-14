import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Search = typeof import("../src/functions/search.js");

const context = { kind: "memory" as const, logId: "test" };

// vitest.config.ts turns the coalescer off for the suite; these tests load a
// fresh module instance with the window they need.
async function loadSearch(coalesceMs: string): Promise<Search> {
  vi.stubEnv("EMBED_COALESCE_MS", coalesceMs);
  vi.resetModules();
  return import("../src/functions/search.js");
}

describe("embedding coalescer", () => {
  const add = vi.fn();
  const embedBatch = vi.fn();
  let search: Search;

  beforeEach(async () => {
    search = await loadSearch("1200");
    vi.useFakeTimers();
    add.mockReset();
    embedBatch.mockReset();
    search.setVectorIndex({ add, remove: vi.fn(), get: vi.fn() } as never);
    search.setEmbeddingProvider({ name: "test", dimensions: 2, embed: vi.fn(), embedBatch });
  });
  afterEach(async () => {
    await search.flushIndexSave();
    search.setIndexPersistence(null);
    search.setVectorIndex(null);
    search.setEmbeddingProvider(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("batches concurrent arrivals and reports each item's actual result", async () => {
    embedBatch.mockResolvedValue([new Float32Array([1, 0]), new Float32Array([1])]);
    const first = search.vectorIndexAddGuarded("a", "s", "one", context);
    const second = search.vectorIndexAddGuarded("b", "s", "two", context);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(embedBatch).toHaveBeenCalledExactlyOnceWith(["one", "two"]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("settles an add without waiting for another add's commit in the same batch", async () => {
    embedBatch.mockResolvedValue([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocked = search.vectorIndexAddGuarded("a", "s", "one", context, async () => {
      await gate;
      return true;
    });
    const free = search.vectorIndexAddGuarded("b", "s", "two", context);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await free).toBe(true);
    release();
    expect(await blocked).toBe(true);
  });

  it("waits for an already-running batch before saving and never restores deleted entries", async () => {
    let finish!: (vectors: Float32Array[]) => void;
    embedBatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = search.vectorIndexAddGuarded("a", "s", "one", context);
    await vi.advanceTimersByTimeAsync(1200);
    search.vectorIndexRemove("a");
    const save = vi.fn().mockResolvedValue(undefined);
    search.setIndexPersistence({ save, scheduleSave: vi.fn() });
    const flushing = search.flushIndexSave();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    finish([new Float32Array([1, 0])]);
    await flushing;
    expect(await pending).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not restore an entry deleted before the batch starts", async () => {
    embedBatch.mockResolvedValue([new Float32Array([1, 0])]);
    const pending = search.vectorIndexAddGuarded("a", "s", "one", context);
    search.vectorIndexRemove("a");
    await search.flushIndexSave();
    expect(await pending).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("uncoalesced add (EMBED_COALESCE_MS=0)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not restore an entry deleted while its embedding is in flight", async () => {
    const search = await loadSearch("0");
    const add = vi.fn();
    let finish!: (vector: Float32Array) => void;
    search.setVectorIndex({ add, remove: vi.fn(), get: vi.fn() } as never);
    search.setEmbeddingProvider({
      name: "test",
      dimensions: 2,
      embed: () => new Promise((resolve) => { finish = resolve; }),
      embedBatch: vi.fn(),
    });

    const pending = search.vectorIndexAddGuarded("a", "s", "one", context);
    search.vectorIndexRemove("a");
    finish(new Float32Array([1, 0]));

    expect(await pending).toBe(false);
    expect(add).not.toHaveBeenCalled();
    search.setVectorIndex(null);
    search.setEmbeddingProvider(null);
  });
});
