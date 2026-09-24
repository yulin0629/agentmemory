import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushIndexSave, setEmbeddingProvider, setIndexPersistence, setVectorIndex, vectorIndexAddGuarded, vectorIndexRemove } from "../src/functions/search.js";

const context = { kind: "memory" as const, logId: "test" };
const add = vi.fn();
const embedBatch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  add.mockReset();
  embedBatch.mockReset();
  setVectorIndex({ add, remove: vi.fn() } as never);
  setEmbeddingProvider({ name: "test", dimensions: 2, embed: vi.fn(), embedBatch });
});
afterEach(async () => {
  await flushIndexSave();
  setIndexPersistence(null);
  setVectorIndex(null);
  setEmbeddingProvider(null);
  vi.useRealTimers();
});

describe("embedding coalescer", () => {
  it("batches concurrent arrivals and reports each item's actual result", async () => {
    embedBatch.mockResolvedValue([new Float32Array([1, 0]), new Float32Array([1])]);
    const first = vectorIndexAddGuarded("a", "s", "one", context);
    const second = vectorIndexAddGuarded("b", "s", "two", context);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(embedBatch).toHaveBeenCalledExactlyOnceWith(["one", "two"]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("waits for an already-running batch before saving and never restores deleted entries", async () => {
    let finish!: (vectors: Float32Array[]) => void;
    embedBatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = vectorIndexAddGuarded("a", "s", "one", context);
    await vi.advanceTimersByTimeAsync(1200);
    vectorIndexRemove("a");
    const save = vi.fn().mockResolvedValue(undefined);
    setIndexPersistence({ save, scheduleSave: vi.fn() });
    const flushing = flushIndexSave();
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
    const pending = vectorIndexAddGuarded("a", "s", "one", context);
    vectorIndexRemove("a");
    await flushIndexSave();
    expect(await pending).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("uncoalesced add (EMBED_COALESCE_MS=0)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not restore an entry deleted while its embedding is in flight", async () => {
    vi.stubEnv("EMBED_COALESCE_MS", "0");
    vi.resetModules();
    const search = await import("../src/functions/search.js");
    const uncoalescedAdd = vi.fn();
    let finish!: (vector: Float32Array) => void;
    search.setVectorIndex({ add: uncoalescedAdd, remove: vi.fn() } as never);
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
    expect(uncoalescedAdd).not.toHaveBeenCalled();
    search.setVectorIndex(null);
    search.setEmbeddingProvider(null);
  });
});
