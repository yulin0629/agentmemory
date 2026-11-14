import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { DedupMap } from "../src/functions/dedup.js";
import { KV } from "../src/state/schema.js";
import { getSearchIndex } from "../src/functions/search.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const maps: DedupMap[] = [];
afterEach(() => {
  maps.splice(0).forEach((map) => map.stop());
  getSearchIndex().clear();
});

function setup(kv = mockKV(), limit?: number) {
  const sdk = mockSdk({ looseTrigger: true });
  const map = new DedupMap();
  maps.push(map);
  registerObserveFunction(sdk as never, kv as never, map, limit);
  registerApiTriggers(sdk as never, kv as never);
  return { sdk, kv };
}

function payload(event_id: string | undefined = randomUUID(), suffix = "a") {
  return {
    ...(event_id ? { event_id } : {}),
    sessionId: "devspace:host:workspace:segment",
    hookType: "post_tool_use",
    project: "example",
    cwd: "/tmp/example",
    timestamp: "2026-10-09T00:00:00.000Z",
    data: { tool_name: "read", tool_input: { path: "x".repeat(600) + suffix } },
  };
}

describe("durable observe event IDs", () => {
  it("whitelists the top-level UUID and rejects malformed IDs at the API boundary", async () => {
    const { sdk, kv } = setup();
    const good = payload();
    const response = await sdk.trigger("api::observe", { body: { ...good, unexpected: "ignored" } }) as any;
    expect(response.status_code).toBe(201);
    expect(response.body.observationId).toBe(`obs_event_${good.event_id!.replace(/-/g, "")}`);
    for (const event_id of [null, "", "bad", 42]) {
      expect(await sdk.trigger("api::observe", { body: { ...good, event_id } })).toMatchObject({ status_code: 400 });
    }
    expect(await kv.list(KV.observations(good.sessionId))).toHaveLength(1);
    expect(await sdk.trigger("mem::observe", { ...good, event_id: "bad" })).toMatchObject({ success: false });
  });

  it("serializes concurrent retries, including a retry at the observation limit", async () => {
    const { sdk, kv } = setup(undefined, 1);
    const event = payload();
    const results = await Promise.all(Array.from({ length: 12 }, () => sdk.trigger("mem::observe", event))) as any[];
    expect(results.filter((r) => r.deduplicated)).toHaveLength(11);
    expect(new Set(results.map((r) => r.observationId)).size).toBe(1);
    expect(await kv.list(KV.observations(event.sessionId))).toHaveLength(1);
    expect(await kv.get(KV.sessions, event.sessionId)).toMatchObject({ observationCount: 1 });
  });

  it("uses the existing observation after worker reconstruction and skips every side effect", async () => {
    const first = setup();
    const event = payload();
    const initial = await first.sdk.trigger("mem::observe", event) as any;
    const restarted = setup(first.kv);
    const set = vi.spyOn(first.kv, "set");
    const update = vi.spyOn(first.kv, "update");
    const trigger = vi.spyOn(restarted.sdk, "trigger");
    const result = await restarted.sdk.fns.get("mem::observe")!({ ...event, event_id: event.event_id!.toUpperCase() });
    expect(result).toMatchObject({ observationId: initial.observationId, deduplicated: true });
    expect(set).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("keeps different UUIDs even when the full input is identical", async () => {
    const { sdk, kv } = setup();
    const a = await sdk.trigger("mem::observe", payload()) as any;
    const b = await sdk.trigger("mem::observe", payload()) as any;
    expect(a.observationId).not.toBe(b.observationId);
    expect(await kv.list(KV.observations(payload().sessionId))).toHaveLength(2);
  });

  it("hashes complete legacy hook inputs beyond the old 500-character prefix", async () => {
    const { sdk, kv } = setup();
    const a = payload(undefined, "a"); delete a.event_id;
    const b = payload(undefined, "b"); delete b.event_id;
    const first = await sdk.trigger("mem::observe", a) as any;
    const second = await sdk.trigger("mem::observe", b) as any;
    expect(first.observationId).not.toBe(second.observationId);
    expect(await sdk.trigger("mem::observe", b)).toMatchObject({ deduplicated: true });
    expect(await kv.list(KV.observations(a.sessionId))).toHaveLength(2);
  });
});
