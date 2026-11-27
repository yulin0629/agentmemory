import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import { initializeGraphIndex, reconcileGraphIndexRecord } from "../src/state/graph-retrieval-index.js";
import type { CompressedObservation } from "../src/types.js";

const observation: CompressedObservation = {
  id: "obs_ready", sessionId: "ses_ready", timestamp: "2026-01-01T00:00:00.000Z",
  type: "discovery", title: "Cobalt authentication", subtitle: "", facts: [],
  narrative: "Cobalt validates tokens", concepts: ["Cobalt"], files: [], importance: 5,
};

async function fixture(hold = true) {
  const index = new SearchIndex();
  index.add(observation);
  const records = new Map<string, unknown>();
  let release!: (row: unknown) => void;
  const held = new Promise<unknown>((resolve) => { release = resolve; });
  const reads: string[] = [];
  let holding = false;
  const kv = {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      reads.push(scope);
      if (holding && scope === KV.graphRetrievalControl) { await held; holding = false; }
      return (records.get(`${scope}/${key}`) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T) => { records.set(`${scope}/${key}`, value); return value; },
    delete: async (scope: string, key: string) => { records.delete(`${scope}/${key}`); },
    list: vi.fn(async () => { throw new Error("Unexpected full graph list"); }),
  };
  await kv.set(KV.observations(observation.sessionId), observation.id, observation);
  await initializeGraphIndex(kv as never, { status: "ready" });
  await reconcileGraphIndexRecord(kv as never, "node", "cobalt", {
    id: "cobalt", name: "Cobalt", type: "concept", properties: {},
    sourceObservationIds: [observation.id], createdAt: observation.timestamp,
  });
  reads.length = 0;
  holding = hold;
  return { hybrid: new HybridSearch(index, null, null, kv as never), release, reads, kv, index };
}

// A provider whose query embedding stays pending until the test releases it.
function heldEmbedding() {
  let release!: () => void;
  const pending = new Promise<Float32Array>((resolve) => { release = () => resolve(new Float32Array([1, 0])); });
  return { provider: { name: "fixture", dimensions: 2, embed: () => pending, embedBatch: async () => [] }, release };
}

afterEach(() => vi.useRealTimers());

describe("optional graph retrieval budget", () => {
  it("returns ready keyword results while graph storage is still unresponsive", async () => {
    vi.useFakeTimers();
    const { hybrid, release } = await fixture();
    let results: Awaited<ReturnType<HybridSearch["search"]>> | undefined;
    const search = hybrid.search("Cobalt").then((value) => { results = value; });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(results?.map((result) => result.observation.id)).toEqual([observation.id]);
      expect(results?.[0].graphScore).toBe(0);
    } finally {
      release([]);
      await search;
    }
  });

  it("does not start the edge read when a timed-out node read arrives late", async () => {
    vi.useFakeTimers();
    const { hybrid, release, reads, kv } = await fixture();
    const search = hybrid.search("Cobalt");
    await vi.advanceTimersByTimeAsync(500);
    expect((await search).map((result) => result.observation.id)).toEqual([observation.id]);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(kv.list).not.toHaveBeenCalled();
    expect(reads).not.toContain(KV.graphRetrievalData);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps fast graph enrichment and clears its deadline", async () => {
    vi.useFakeTimers();
    const { kv, index } = await fixture(false);
    const hybrid = new HybridSearch(index, null, null, kv as never);
    const results = await hybrid.search("Cobalt");
    expect(results[0].graphScore).toBeGreaterThan(0);
    expect(results[0].graphContext).toContain(observation.title);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("searches the graph by entity during a slow embedding call without spending the budget", async () => {
    vi.useFakeTimers();
    const { kv, index, reads } = await fixture(false);
    const vectors = new VectorIndex();
    vectors.add(observation.id, observation.sessionId, new Float32Array([1, 0]));
    const embedding = heldEmbedding();
    const search = new HybridSearch(index, vectors, embedding.provider, kv as never).search("Cobalt");
    await vi.advanceTimersByTimeAsync(600);
    expect(reads).toContain(KV.graphRetrievalData);
    embedding.release();
    const results = await search;
    expect(results[0].graphScore).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expands from vector hits after the entity search has used up its reads", async () => {
    const { kv, index, reads } = await fixture(false);
    const node = (id: string, name: string, sourceObservationIds: string[]) => reconcileGraphIndexRecord(kv as never, "node", id, {
      id, name, type: "concept", properties: {}, sourceObservationIds, createdAt: observation.timestamp,
    });
    // Nodes named like the query whose sources no longer exist: checking them
    // takes more reads than one graph query may make.
    for (let i = 0; i < 30; i++) await node(`gone_${i}`, `Cobalt ${i}`, Array.from({ length: 12 }, (_, j) => `obs_gone_${i}_${j}`));
    // The vector hit's node leads to a record that no keyword or vector matches.
    const seed = { ...observation, id: "obs_seed", title: "Seed capture", narrative: "Seed capture", concepts: [] };
    const linked = { ...observation, id: "obs_linked", title: "Linked evidence", narrative: "Linked evidence", concepts: [] };
    for (const obs of [seed, linked]) { index.add(obs); await kv.set(KV.observations(obs.sessionId), obs.id, obs); }
    await node("zeta", "Zeta", [seed.id]);
    await node("yotta", "Yotta", [linked.id]);
    await reconcileGraphIndexRecord(kv as never, "edge", "zeta_yotta", {
      id: "zeta_yotta", sourceNodeId: "zeta", targetNodeId: "yotta", type: "related_to", weight: 0.8,
      sourceObservationIds: [seed.id], createdAt: observation.timestamp,
    });
    const vectors = new VectorIndex();
    vectors.add(seed.id, seed.sessionId, new Float32Array([1, 0]));
    const embedding = heldEmbedding();
    reads.length = 0;
    const search = new HybridSearch(index, vectors, embedding.provider, kv as never).search("Cobalt");
    for (let seen = -1; seen !== reads.length;) { seen = reads.length; await new Promise((resolve) => setTimeout(resolve, 5)); }
    embedding.release();
    const results = await search;
    // Precondition: the entity search ran out of reads, so its own exact match went unscored.
    expect(results.find((result) => result.observation.id === observation.id)?.graphScore).toBe(0);
    expect(results.find((result) => result.observation.id === linked.id)?.graphScore).toBeGreaterThan(0);
  });

  it("bounds concurrent query reformulations and can recover on the next search", async () => {
    vi.useFakeTimers();
    const { hybrid, kv, release } = await fixture();
    const search = hybrid.searchWithExpansion("Cobalt", 5, {
      reformulations: ["Cobalt tokens", "Cobalt authentication"],
      temporalConcretizations: [], entityExtractions: ["Cobalt"],
    });
    await vi.advanceTimersByTimeAsync(500);
    expect((await search).map((result) => result.observation.id)).toEqual([observation.id]);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect((await hybrid.search("Cobalt"))[0].graphScore).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
