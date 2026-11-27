import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerCaptureFunctions } from "../src/functions/capture.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerContextFunction } from "../src/functions/context.js";
import { registerSelectiveContextFunctions } from "../src/functions/selective-context.js";
import { DedupMap } from "../src/functions/dedup.js";
import { KV } from "../src/state/schema.js";
import { isKeyedLockHeld } from "../src/state/keyed-mutex.js";
import { getSearchIndex } from "../src/functions/search.js";
import type { CompressedObservation, Session } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const maps: DedupMap[] = [];
afterEach(() => {
  maps.splice(0).forEach((map) => map.stop());
  getSearchIndex().clear();
});

function setup(limit = 2, opts: { captureExplicit?: boolean } = {}) {
  const kv = mockKV();
  const sdk = mockSdk({ looseTrigger: true });
  const map = new DedupMap();
  maps.push(map);
  registerObserveFunction(sdk as never, kv as never, map, limit, opts.captureExplicit ?? false);
  registerCaptureFunctions(sdk as never, kv as never);
  registerContextFunction(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never);
  return { kv, sdk };
}

function makePayload(sessionId: string, n: number, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    hookType: "post_tool_use",
    project: "demo",
    cwd: "/tmp/demo",
    timestamp: new Date(Date.UTC(2026, 10, 27, 0, 0, n)).toISOString(),
    data: { tool_name: "Bash", tool_input: { command: `echo step-${n}` }, tool_output: `step-${n}` },
    ...overrides,
  };
}

describe("server-side session rollover", () => {
  it("rolls over into linked segments across multiple caps, seals old segments outside locks, and indexes new segments", async () => {
    const { kv, sdk } = setup(2);
    const stoppedEvents: Array<{ sessionId: string; rootLockHeld: boolean; segLockHeld: boolean }> = [];
    const compressEvents: Array<{ sessionId: string; observationId: string; rootLockHeld: boolean }> = [];

    sdk.registerFunction("event::session::stopped", async (p: unknown) => {
      const sid = (p as { sessionId: string }).sessionId;
      stoppedEvents.push({
        sessionId: sid,
        rootLockHeld: isKeyedLockHeld("obs:sess-roll"),
        segLockHeld: isKeyedLockHeld(`obs:${sid}`),
      });
      return { ok: true };
    });
    sdk.registerFunction("mem::compress", async (p: unknown) => {
      const { sessionId, observationId } = p as { sessionId: string; observationId: string };
      compressEvents.push({
        sessionId,
        observationId,
        rootLockHeld: isKeyedLockHeld("obs:sess-roll"),
      });
      return { ok: true };
    });

    const results = [];
    for (let i = 1; i <= 5; i++) {
      results.push(await sdk.trigger("mem::observe", makePayload("sess-roll", i)) as Record<string, unknown>);
    }

    expect(results.every((r) => typeof r.observationId === "string")).toBe(true);
    expect(results.map((r) => r.sessionId)).toEqual([
      "sess-roll",
      "sess-roll",
      "sess-roll--seg-2",
      "sess-roll--seg-2",
      "sess-roll--seg-3",
    ]);

    expect(await kv.list(KV.observations("sess-roll"))).toHaveLength(2);
    expect(await kv.list(KV.observations("sess-roll--seg-2"))).toHaveLength(2);
    expect(await kv.list(KV.observations("sess-roll--seg-3"))).toHaveLength(1);

    const root = await kv.get<Session>(KV.sessions, "sess-roll");
    const seg2 = await kv.get<Session>(KV.sessions, "sess-roll--seg-2");
    const seg3 = await kv.get<Session>(KV.sessions, "sess-roll--seg-3");
    expect(root).toMatchObject({ status: "completed", activeSegmentId: "sess-roll--seg-3" });
    expect(seg2).toMatchObject({ status: "completed", parentSessionId: "sess-roll" });
    expect(seg3).toMatchObject({ status: "active", parentSessionId: "sess-roll", observationCount: 1 });

    // Deferred triggers ran AFTER locks were released
    expect(stoppedEvents).toEqual([
      { sessionId: "sess-roll", rootLockHeld: false, segLockHeld: false },
      { sessionId: "sess-roll--seg-2", rootLockHeld: false, segLockHeld: false },
    ]);
    expect(compressEvents.every((c) => !c.rootLockHeld)).toBe(true);

    // Project session index includes the rolled-over segments
    const indexEntries = (await kv.get<Array<{ id: string }>>(KV.projectSessionsIndex, "demo")) ?? [];
    expect(indexEntries.map((e) => e.id)).toEqual(
      expect.arrayContaining(["sess-roll", "sess-roll--seg-2", "sess-roll--seg-3"]),
    );
  });

  it("recovers parked dead letters via capture/retry into seg-2 and deduplicates subsequent client retries", async () => {
    const { kv, sdk } = setup(2);
    const stopped: string[] = [];
    sdk.registerFunction("event::session::stopped", async (p: unknown) => {
      stopped.push((p as { sessionId: string }).sessionId);
      return { ok: true };
    });

    // Seed an already-full completed root session (like production e4c82e3b)
    await sdk.trigger("mem::observe", makePayload("sess-dead", 1));
    await sdk.trigger("mem::observe", makePayload("sess-dead", 2));
    await kv.update(KV.sessions, "sess-dead", [{ path: "status", value: "completed" }]);

    // Park two dead letters manually in capture inbox
    const p3 = makePayload("sess-dead", 3);
    const p4 = makePayload("sess-dead", 4);
    await kv.set(KV.captureInbox, "cap_dead_3", {
      key: "cap_dead_3",
      eventId: "evh_deadletter000003",
      eventSource: "client",
      sessionId: "sess-dead",
      project: "demo",
      hookType: "post_tool_use",
      observationId: "obs_dead_3_aaaaaaaaaaaa",
      status: "dead",
      attempts: 1,
      acceptedAt: p3.timestamp,
      updatedAt: p3.timestamp,
      deadAt: p3.timestamp,
      lastError: "Session observation limit reached (2)",
      payload: p3,
    });
    await kv.set(KV.captureInbox, "cap_dead_4", {
      key: "cap_dead_4",
      eventId: "evh_deadletter000004",
      eventSource: "client",
      sessionId: "sess-dead",
      project: "demo",
      hookType: "post_tool_use",
      observationId: "obs_dead_4_bbbbbbbbbbbb",
      status: "dead",
      attempts: 1,
      acceptedAt: p4.timestamp,
      updatedAt: p4.timestamp,
      deadAt: p4.timestamp,
      lastError: "Session observation limit reached (2)",
      payload: p4,
    });

    const retry = await sdk.trigger("mem::capture-retry", { all: true }) as Record<string, number>;
    expect(retry).toEqual({ matched: 2, recovered: 2, dead: 0, waiting: 0 });
    expect(await kv.list(KV.observations("sess-dead--seg-2"))).toHaveLength(2);
    // Already-completed root must NOT re-fire event::session::stopped
    expect(stopped).toEqual([]);

    // Now test normal client capture + duplicate retry across rollover
    const p5 = makePayload("sess-dead", 5);
    const cap1 = await sdk.trigger("mem::capture", { payload: p5, eventId: "evh_clientretry00005" }) as Record<string, unknown>;
    expect(cap1).toMatchObject({ status: "accepted", state: "completed" });
    expect(await kv.list(KV.observations("sess-dead--seg-3"))).toHaveLength(1);

    const cap2 = await sdk.trigger("mem::capture", { payload: p5, eventId: "evh_clientretry00005" }) as Record<string, unknown>;
    expect(cap2).toMatchObject({ status: "duplicate", state: "completed", deduplicated: true });
    expect(await kv.list(KV.observations("sess-dead--seg-3"))).toHaveLength(1);
  });

  it("deduplicates cross-segment event_id retries and keeps prompt-ledger keyed on root", async () => {
    const { kv, sdk } = setup(2);
    const id1 = randomUUID();
    const first = await sdk.trigger("mem::observe", makePayload("sess-dedup", 1, { event_id: id1 })) as Record<string, unknown>;
    await sdk.trigger("mem::observe", makePayload("sess-dedup", 2));
    // Roll over to seg-2 with a live prompt
    await sdk.trigger("mem::observe", {
      sessionId: "sess-dedup",
      hookType: "prompt_submit",
      project: "demo",
      cwd: "/tmp/demo",
      timestamp: "2026-11-27T00:01:00.000Z",
      data: { prompt: "check live prompt dedup across rollover" },
    });

    // Retry event_id from seg-1 after seg-2 is active
    const dup = await sdk.trigger("mem::observe", makePayload("sess-dedup", 1, { event_id: id1 })) as Record<string, unknown>;
    expect(dup).toMatchObject({ observationId: first.observationId, sessionId: "sess-dedup", deduplicated: true });
    expect(await kv.list(KV.observations("sess-dedup--seg-2"))).toHaveLength(1);

    // Backfill prompt targeting raw root session deduplicates against seg-2 live prompt
    const backfill = await sdk.trigger("mem::observe", {
      sessionId: "sess-dedup",
      hookType: "prompt_submit",
      project: "demo",
      cwd: "/tmp/demo",
      timestamp: "2026-11-27T00:02:00.000Z",
      data: { prompt: "check live prompt dedup across rollover", backfill: true },
    }) as Record<string, unknown>;
    expect(backfill).toMatchObject({ deduplicated: true });
    expect(await kv.list(KV.observations("sess-dedup--seg-2"))).toHaveLength(1);
  });

  it("preserves explicit memory capture (記住：) on a rolled-over segment", async () => {
    const { kv, sdk } = setup(1, { captureExplicit: true });
    registerSelectiveContextFunctions(sdk as never, kv as never, {
      namespace: "default",
      judge: async () => [],
      captureJudge: async () => "project_rule",
    });

    await sdk.trigger("mem::observe", makePayload("sess-remember", 1, {
      data: { tool_name: "Bash", tool_input: { command: "ls" }, tool_output: "ok", contextProjectId: "proj-1" },
    }));

    const saved = await sdk.trigger("mem::observe", {
      sessionId: "sess-remember",
      hookType: "prompt_submit",
      project: "demo",
      cwd: "/tmp/demo",
      timestamp: "2026-11-27T00:01:00.000Z",
      data: {
        prompt: "記住：always keep rollover segments bounded",
        explicitMemoryRequest: true,
        contextProjectId: "proj-1",
      },
    }) as { sessionId?: string; knowledgeCapture?: { success: boolean; action?: string } };

    expect(saved.sessionId).toBe("sess-remember--seg-2");
    expect(saved.knowledgeCapture).toMatchObject({ success: true, action: "saved" });
  });

  it("preserves rolled-over root lifecycle on session/start resume and routes session/end to active segment", async () => {
    const { kv, sdk } = setup(1);
    const stopped: string[] = [];
    sdk.registerFunction("event::session::stopped", async (p: unknown) => {
      stopped.push((p as { sessionId: string }).sessionId);
      return { ok: true };
    });

    await sdk.trigger("mem::observe", makePayload("sess-life", 1));
    await sdk.trigger("mem::observe", makePayload("sess-life", 2));
    const rootBefore = await kv.get<Session>(KV.sessions, "sess-life");
    expect(rootBefore).toMatchObject({ status: "completed", activeSegmentId: "sess-life--seg-2" });

    // Resume calls POST /agentmemory/session/start with raw root sessionId
    const startRes = await sdk.trigger("api::session::start", {
      body: { sessionId: "sess-life", project: "demo", cwd: "/tmp/demo-updated" },
    }) as { status_code: number; body: { session: Session } };
    expect(startRes.status_code).toBe(200);
    const rootAfter = await kv.get<Session>(KV.sessions, "sess-life");
    expect(rootAfter).toMatchObject({
      status: "completed",
      startedAt: rootBefore!.startedAt,
      endedAt: rootBefore!.endedAt,
      activeSegmentId: "sess-life--seg-2",
      cwd: "/tmp/demo-updated",
    });

    // POST /agentmemory/session/end with raw root sessionId ends sess-life--seg-2
    stopped.length = 0;
    const endRes = await sdk.trigger("api::session::end", {
      body: { sessionId: "sess-life", final: true },
    }) as { status_code: number; body: { ended: boolean } };
    expect(endRes.status_code).toBe(200);
    expect(endRes.body.ended).toBe(true);
    expect((await kv.get<Session>(KV.sessions, "sess-life--seg-2"))?.status).toBe("completed");
    expect(stopped).toEqual(["sess-life--seg-2"]);
  });

  it("excludes rolled-over child segments from mem::context and selective-context self-recall", async () => {
    const { kv, sdk } = setup(1);
    await sdk.trigger("mem::observe", makePayload("sess-ctx", 1));
    await sdk.trigger("mem::observe", makePayload("sess-ctx", 2));
    await sdk.trigger("mem::observe", makePayload("sess-other", 3));

    const ctx = await sdk.trigger("mem::context", {
      sessionId: "sess-ctx",
      project: "demo",
      budget: 4000,
    }) as { context: string };
    expect(ctx.context).toContain("step-3");
    expect(ctx.context).not.toContain("step-2");

    // Verify selective-context expands family and uses listKeys (not kv.list) on observations
    const seg2Obs = await kv.list<CompressedObservation>(KV.observations("sess-ctx--seg-2"));
    const seg2ObsId = seg2Obs[0]!.id;
    const otherObs = await kv.list<CompressedObservation>(KV.observations("sess-other"));
    const otherObsId = otherObs[0]!.id;

    let seenCandidates: Array<{ id: string }> = [];
    const listKeysSpy = vi.spyOn(kv, "listKeys");
    const listObsSpy = vi.spyOn(kv, "list");

    const scSdk = mockSdk({ looseTrigger: true });
    scSdk.registerFunction("mem::smart-search", async () => ({
      results: [
        { obsId: seg2ObsId, sessionId: "sess-ctx--seg-2", title: "step-2", narrative: "step-2", score: 10 },
        { obsId: otherObsId, sessionId: "sess-other", title: "step-3", narrative: "step-3", score: 9 },
      ],
    }));
    registerSelectiveContextFunctions(scSdk as never, kv as never, {
      namespace: "default",
      judge: async (_req, candidates) => {
        seenCandidates = candidates.map((c) => ({ id: c.id }));
        return [];
      },
    });

    await scSdk.trigger("mem::selective-context", {
      prompt: "what happened?",
      project: "demo",
      sessionId: "sess-ctx",
      recallHistory: true,
    });

    expect(seenCandidates.map((c) => c.id)).not.toContain(`observation:${seg2ObsId}`);
    expect(seenCandidates.map((c) => c.id)).toContain(`observation:${otherObsId}`);
    expect(listKeysSpy).toHaveBeenCalledWith(KV.observations("sess-ctx"));
    expect(listKeysSpy).toHaveBeenCalledWith(KV.observations("sess-ctx--seg-2"));
    const obsListCalls = listObsSpy.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"));
    expect(obsListCalls).toHaveLength(0);
  });

  it("falls back to cap error when root sessionId is too long to append --seg-2 within 200 chars", async () => {
    const { sdk } = setup(1);
    const longId = "s".repeat(196);
    const first = await sdk.trigger("mem::observe", makePayload(longId, 1)) as Record<string, unknown>;
    expect(typeof first.observationId).toBe("string");
    const second = await sdk.trigger("mem::observe", makePayload(longId, 2)) as Record<string, unknown>;
    expect(second).toMatchObject({ success: false, error: "Session observation limit reached (1)" });
  });
});
