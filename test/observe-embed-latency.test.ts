import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// vitest.config.ts turns the coalescer off for the suite. These cases turn it
// on, with an embedding that never settles, and require observe to return
// without waiting for the coalescing window.
async function setup() {
  vi.stubEnv("EMBED_COALESCE_MS", "1200");
  vi.resetModules();
  const search = await import("../src/functions/search.js");
  const { registerObserveFunction } = await import("../src/functions/observe.js");
  const { DedupMap } = await import("../src/functions/dedup.js");
  const { mockKV, mockSdk } = await import("./helpers/mocks.js");
  search.setVectorIndex({ add: vi.fn(), remove: vi.fn(), get: vi.fn(), has: () => false } as never);
  search.setEmbeddingProvider({
    name: "stalled",
    dimensions: 2,
    embed: () => new Promise(() => {}),
    embedBatch: () => new Promise(() => {}),
  });
  const sdk = mockSdk({ looseTrigger: true });
  const kv = mockKV();
  const map = new DedupMap();
  registerObserveFunction(sdk as never, kv as never, map);
  return { sdk, search, stop: () => map.stop() };
}

// The capture queue's shape: its own eventId and a fixed observationId, so a
// retry reaches the stored-observation path that restores index entries.
const event = () => ({
  eventId: `evc_${randomUUID()}`,
  observationId: `obs_${randomUUID().replace(/-/g, "")}`,
  sessionId: "ses_latency",
  hookType: "post_tool_use",
  project: "example",
  cwd: "/tmp/example",
  timestamp: "2026-11-14T00:00:00.000Z",
  data: { tool_name: "read", tool_input: { path: "/repo/a.ts" } },
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllEnvs();
});

describe("observe with the embedding coalescer on", () => {
  it("returns before the coalescing window closes, for a new event and for its retry", async () => {
    const { sdk, search, stop } = await setup();
    cleanup = () => {
      stop();
      search.setVectorIndex(null);
      search.setEmbeddingProvider(null);
    };
    const payload = event();
    for (const expected of [{ deduplicated: undefined }, { deduplicated: true }]) {
      const started = performance.now();
      const result = await sdk.trigger("mem::observe", payload) as { deduplicated?: boolean };
      expect(performance.now() - started).toBeLessThan(600);
      expect(result.deduplicated).toBe(expected.deduplicated);
    }
  });
});
