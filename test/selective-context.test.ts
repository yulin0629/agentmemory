import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSelectiveContextFunctions } from "../src/functions/selective-context.js";
import { selectContext, type ContextJudge, type ContextKnowledge } from "../src/state/selective-context.js";
import { KV } from "../src/state/schema.js";
import { getSearchIndex } from "../src/functions/search.js";
import { resetLessonIndex } from "../src/functions/lessons.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    registerFunction: (id: string, handler: (input: unknown) => Promise<unknown>) => {
      functions.set(id, handler);
    },
    trigger: async (id: string | { function_id: string; payload: unknown }, input?: unknown) => {
      if (typeof id !== "string") { input = id.payload; id = id.function_id; }
      const fn = functions.get(id);
      if (!fn && id === "mem::smart-search") {
        const query = (input as { query: string }).query;
        return { mode: "compact", results: getSearchIndex().search(query, 100)
          .map(hit => ({ obsId: hit.obsId, sessionId: hit.sessionId })) };
      }
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(input);
    },
  };
}

const NOW = "2026-09-19T00:00:00.000Z";

function knowledge(overrides: Partial<ContextKnowledge> = {}): ContextKnowledge {
  const evidence = overrides.evidence ?? {
    eventId: "evt-user-1",
    text: "In TUI and CLI, render process diagrams as ASCII. Do not use Mermaid.",
    adoptedAt: "2026-09-18T12:00:00.000Z",
  };
  return {
    id: overrides.id ?? "knowledge-ascii-diagrams",
    revision: overrides.revision ?? "rev-1",
    status: overrides.status ?? "active",
    scope: overrides.scope ?? { namespace: "personal", project: "agentmemory", projectId: "repo-agentmemory" },
    evidence,
    spans: overrides.spans ?? [{
      id: "span-format",
      text: "In TUI and CLI, render process diagrams as ASCII. Do not use Mermaid.",
    }],
  };
}

const usefulJudge: ContextJudge = async (_request, candidates) =>
  candidates.flatMap(record => record.spans.map(span => ({
    knowledgeId: record.id,
    revision: record.revision,
    spanId: span.id,
    useful: 0.95,
    compatibility: "compatible" as const,
    addition: "adds" as const,
  })));

describe("selective context", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    getSearchIndex().clear();
    resetLessonIndex();
    await kv.set(KV.sessions, "current", { id: "current", project: "home", status: "active",
      agentId: "hermes-owner", startedAt: NOW });
    registerSelectiveContextFunctions(sdk as never, kv as never, {
      namespace: "personal",
      judge: usefulJudge,
      now: () => NOW,
    });
  });

  it("Hermes opt-in admits verified owned observation and summary evidence without current-session echoes", async () => {
    const oldSession = { id: "old", project: "home", cwd: "/home", startedAt: NOW,
      status: "completed", observationCount: 1, agentId: "hermes-owner" };
    await kv.set(KV.sessions, "old", oldSession);
    await kv.set(KV.sessions, "current", { ...oldSession, id: "current", status: "active" });
    const observation = { id: "obs_old", sessionId: "old", timestamp: NOW,
      type: "decision", title: "Router setting", subtitle: "", facts: [],
      narrative: "The router configuration was reviewed.", concepts: [], files: [],
      importance: 8, agentId: "hermes-owner", origin: { channel: "agent", capturedAt: NOW } };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    const echo = { ...observation, id: "obs_echo", sessionId: "current", narrative: "The router uses port 9999." };
    await kv.set(KV.observations("current"), echo.id, echo);
    getSearchIndex().add(echo as never);
    await kv.set(KV.summaries, "old", { sessionId: "old", project: "home", createdAt: NOW,
      title: "Router setting", narrative: "The router uses port 4180.", keyDecisions: [],
      filesModified: [], concepts: [], observationCount: 1 });
    const result = await sdk.trigger("mem::selective-context", { prompt: "router port?", previous: "",
      project: "home", hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private" } }) as {
      status: string; spans: Array<{ text: string }>;
    };
    expect(result.status).toBe("selected");
    expect(result.spans.some(span => span.text.includes("4180"))).toBe(true);
    expect(result.spans.every(span => !span.text.includes("9999"))).toBe(true);
  });

  it("admits legacy conversation evidence only with bounded same-owner session proof", async () => {
    const session = { id: "old", project: "home", status: "completed" };
    await kv.set(KV.sessions, "old", session);
    await kv.set(KV.sessions, "current", { id: "current", project: "home", status: "active", startedAt: NOW });
    const observation = { id: "obs_legacy", sessionId: "old", timestamp: NOW, type: "conversation",
      title: "Route repair", narrative: "The route repair uses the HTTPS relay.", facts: [], concepts: [],
      files: [], importance: 8, origin: { channel: "tool", detail: "conversation", capturedAt: NOW } };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    await kv.set(KV.summaries, "old", { sessionId: "old", project: "home", createdAt: NOW,
      title: "Route repair", narrative: "The HTTPS relay carries the route repair.", keyDecisions: [],
      filesModified: [], concepts: [], observationCount: 1 });
    const request = { prompt: "route repair", hermes: { sessionId: "current", ownerId: "hermes-owner",
      visibility: "private", verifiedSessionIds: ["current", "old"] } };
    const selected = await sdk.trigger("mem::selective-context", request) as { status: string; spans: Array<{ text: string }> };
    expect(selected.status).toBe("selected");
    expect(selected.spans.some(span => span.text.includes("HTTPS relay"))).toBe(true);
    expect(await sdk.trigger("mem::selective-context", { ...request, hermes: {
      ...request.hermes, verifiedSessionIds: ["current"] } })).toMatchObject({ status: "empty", spans: [] });
    await kv.set(KV.sessions, "old", { ...session, agentId: "other-owner" });
    expect(await sdk.trigger("mem::selective-context", request)).toMatchObject({ status: "empty", spans: [] });
    expect(await sdk.trigger("mem::selective-context", { ...request, hermes: {
      ...request.hermes, visibility: "group" } })).toMatchObject({ status: "empty", spans: [] });
    expect(await sdk.trigger("mem::selective-context", { ...request, sessionId: "foreign" }))
      .toMatchObject({ status: "unavailable", spans: [], error: "invalid_request" });
  });

  it("keeps deployed recallHistory selection and sends no session proof to the judge", async () => {
    const seen: string[] = [];
    const localSdk = mockSdk();
    registerSelectiveContextFunctions(localSdk as never, kv as never, { namespace: "personal", now: () => NOW,
      judge: async (request, candidates, signal) => {
        seen.push(JSON.stringify(request));
        return usefulJudge(request, candidates, signal);
      } });
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed" });
    const observation = { id: "obs_runtime", sessionId: "old", timestamp: NOW, type: "conversation",
      title: "Native installer", narrative: "Native installer uses the stable release tree.", facts: [],
      concepts: [], files: [], importance: 8, origin: { channel: "tool", detail: "conversation", capturedAt: NOW } };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    await kv.set(KV.memories, "mem_runtime", { id: "mem_runtime", title: "Installer path",
      content: "The installer uses the stable release directory.", type: "fact", isLatest: true,
      sessionIds: ["old"], sourceObservationIds: [], createdAt: NOW, updatedAt: NOW });
    getSearchIndex().add({ id: "mem_runtime", sessionId: "old", timestamp: NOW,
      title: "Installer path", narrative: "The installer uses the stable release directory.",
      type: "decision", facts: [], concepts: [], files: [], importance: 8 } as never);
    const response = await localSdk.trigger("mem::selective-context", { prompt: "native installer",
      recallHistory: true, sessionId: "current", excludedSessionIds: ["current"] }) as {
      status: string; spans: Array<{ evidenceEventId: string; source: { sessionId: string } }>;
    };
    expect(response.status).toBe("selected");
    expect(response.spans.some(span => span.evidenceEventId === "obs_runtime"
      && span.source?.sessionId === "old")).toBe(true);
    expect(response.spans.some(span => span.evidenceEventId === "mem_runtime")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("sessionId");
    expect(seen[0]).not.toContain("excludedSessionIds");
    expect(await localSdk.trigger("mem::selective-context", { prompt: "native installer",
      recallHistory: true, sessionId: "current", excludedSessionIds: ["old"] }))
      .toMatchObject({ status: "empty", spans: [] });
  });

  it("recalls a legacy native command observation while Hermes rejects its missing provenance", async () => {
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed" });
    const observation = { id: "obs_mq08wi0l_cef5dbf773ee", sessionId: "old", timestamp: NOW,
      type: "command_run", title: "Router rollback", narrative: "The router rollback uses the saved M2 configuration.",
      facts: [], concepts: [], files: [], importance: 8, confidence: 1, agentId: null, origin: null };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    const legacy = await sdk.trigger("mem::selective-context", { prompt: "router rollback M2",
      recallHistory: true, sessionId: "current" }) as { status: string; candidates: { historical: number } };
    expect(legacy.status).toBe("selected");
    expect(legacy.candidates.historical).toBeGreaterThan(0);
    expect(await sdk.trigger("mem::selective-context", { prompt: "router rollback M2",
      hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private",
        verifiedSessionIds: ["current", "old"] } })).toMatchObject({ status: "empty", spans: [] });
  });

  it("retrieves an owned historical conversation from the deployed hybrid search path when BM25 misses", async () => {
    const prompt = "M2 ChatGPT Web 5.0.8 修補部署失敗後採取什麼決策？是否可以說已經修好了？";
    const gold = { id: "obs_gold", sessionId: "old", timestamp: NOW, type: "conversation",
      title: "Deployment decision", narrative: "The M2 deployment failed, so the team rolled back. It is not fixed yet.",
      facts: [], concepts: [], files: [], importance: 8, confidence: 1, agentId: null,
      origin: { channel: "tool", detail: "conversation", capturedAt: NOW } };
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed", agentId: null });
    await kv.set(KV.observations("old"), gold.id, gold);
    const searchInputs: unknown[] = [];
    sdk.registerFunction("mem::smart-search", async input => {
      searchInputs.push(input);
      return { mode: "compact", results: [
        ...Array.from({ length: 22 }, (_, i) => ({ obsId: `obs_other_${i}`, sessionId: "foreign" })),
        { obsId: gold.id, sessionId: "old" },
      ] };
    });
    const result = await sdk.trigger("mem::selective-context", { prompt,
      hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private",
        verifiedSessionIds: ["old"] } }) as { status: string; candidates: { historical: number }; spans: Array<{ evidenceEventId: string }> };
    expect(result.status).toBe("selected");
    expect(searchInputs).toMatchObject([{ query: `${prompt}\n`, limit: 100,
      includeLessons: false, agentId: "*" }]);
    expect(result.candidates.historical).toBe(1);
    expect(result.spans.some(span => span.evidenceEventId === gold.id)).toBe(true);
  });

  it("keeps legacy historical observations when the source session row is absent", async () => {
    const observation = { id: "obs_legacy_without_session", sessionId: "old", timestamp: NOW,
      type: "command_run", title: "Installer decision", narrative: "The installer uses the stable release tree.",
      facts: [], concepts: [], files: [], importance: 8 };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    const result = await sdk.trigger("mem::selective-context", { prompt: "installer decision",
      recallHistory: true, sessionId: "current" }) as { spans: Array<{ evidenceEventId: string }> };
    expect(result.spans.some(span => span.evidenceEventId === observation.id)).toBe(true);
  });

  it("keeps long source lineage on legacy memory while Hermes bounds private memory lineage", async () => {
    const sourceObservationIds = Array.from({ length: 11 }, (_, i) => `obs_source_${i}`);
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed", agentId: "hermes-owner" });
    await kv.set(KV.memories, "mem_lineage", { id: "mem_lineage", title: "Installer decision",
      content: "The installer uses the stable release tree.", type: "fact", isLatest: true,
      sessionIds: ["old"], sourceObservationIds, createdAt: NOW, updatedAt: NOW, agentId: "hermes-owner" });
    getSearchIndex().add({ id: "mem_lineage", sessionId: "old", timestamp: NOW,
      title: "Installer decision", narrative: "The installer uses the stable release tree.",
      type: "decision", facts: [], concepts: [], files: [], importance: 8 } as never);
    const legacy = await sdk.trigger("mem::selective-context", { prompt: "installer decision",
      recallHistory: true, sessionId: "current" }) as { spans: Array<{ evidenceEventId: string }> };
    expect(legacy.spans.some(span => span.evidenceEventId === "mem_lineage")).toBe(true);
    const hermes = await sdk.trigger("mem::selective-context", { prompt: "installer decision",
      hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private" } }) as {
      spans: Array<{ evidenceEventId: string }> };
    expect(hermes.spans.some(span => span.evidenceEventId === "mem_lineage")).toBe(false);
  });

  it("excludes parent observation lineage from both memory and lesson recall routes", async () => {
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed", agentId: "hermes-owner" });
    await kv.set(KV.sessions, "parent", { id: "parent", project: "home", status: "completed" });
    await kv.set(KV.sessions, "ancestor", { id: "ancestor", project: "home", status: "completed" });
    await kv.set(KV.observations("parent"), "obs_parent", { id: "obs_parent", sessionId: "parent" });
    await kv.set(KV.observations("ancestor"), "obs_ancestor", { id: "obs_ancestor", sessionId: "ancestor" });
    await kv.set(KV.memories, "mem_parent", { id: "mem_parent", title: "Router rollback",
      content: "The router rollback used the parent session setting.", type: "fact", isLatest: true,
      sessionIds: ["old"], sourceObservationIds: ["obs_parent", "obs_ancestor"], createdAt: NOW, updatedAt: NOW,
      agentId: "hermes-owner" });
    getSearchIndex().add({ id: "mem_parent", sessionId: "old", timestamp: NOW, title: "Router rollback",
      narrative: "The router rollback used the parent session setting.", type: "decision", facts: [],
      concepts: [], files: [], importance: 8 } as never);
    await kv.set(KV.lessons, "lesson_parent", { id: "lesson_parent", project: "home",
      content: "The router rollback used the parent session lesson.", context: "router rollback",
      confidence: 1, reinforcements: 0, source: "manual", sourceIds: ["obs_parent", "obs_ancestor"], tags: [],
      createdAt: "2026-09-18T00:00:00.000Z", updatedAt: NOW, decayRate: 0 });
    for (const excludedSessionId of ["parent", "ancestor"]) {
      for (const request of [{ recallHistory: true, sessionId: "current" },
        { hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private",
          verifiedSessionIds: ["current", "old"] } }]) {
        const result = await sdk.trigger("mem::selective-context", { prompt: "router rollback", project: "home",
          excludedSessionIds: [excludedSessionId], ...request }) as { spans: Array<{ text: string }> };
        expect(result.spans.every(span => !span.text.includes("parent session"))).toBe(true);
      }
    }
  });

  it("Hermes opt-in fails closed for shared visibility and unknown source ownership", async () => {
    await sdk.trigger("mem::context-knowledge-put", { expectedRevision: 0, confirmedByUser: true,
      knowledge: knowledge({ scope: { namespace: "personal" } }) });
    const result = await sdk.trigger("mem::selective-context", { prompt: "draw a diagram", previous: "",
      hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "group" } });
    expect(result).toMatchObject({ status: "empty", spans: [] });
    await kv.set(KV.sessions, "foreign", { id: "foreign", project: "home", status: "completed", agentId: "other" });
    const observation = { id: "obs_foreign", sessionId: "foreign", timestamp: NOW, type: "decision",
      title: "Router port", narrative: "Private router port 9999.", facts: [], concepts: [], files: [],
      importance: 8, agentId: "other", origin: { channel: "agent", capturedAt: NOW } };
    await kv.set(KV.observations("foreign"), observation.id, observation);
    getSearchIndex().add(observation as never);
    const privateResult = await sdk.trigger("mem::selective-context", { prompt: "Router port", previous: "",
      hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private" } }) as {
      spans: Array<{ text: string }>;
    };
    expect(privateResult.spans.every(span => !span.text.includes("9999"))).toBe(true);
    expect(await sdk.trigger("mem::selective-context", { prompt: "Router port", previous: "",
      hermes: { sessionId: "current", ownerId: "foreign-owner", visibility: "private" } }))
      .toMatchObject({ status: "unavailable", spans: [], error: "unverified_session" });
    expect(await sdk.trigger("mem::selective-context", { prompt: "Do not send this externally; draw a diagram",
      hermes: { sessionId: "current", ownerId: "hermes-owner", visibility: "private" } }))
      .toMatchObject({ status: "empty", spans: [] });
  });

  it("redacts prompt and candidate secrets before Hermes judge egress", async () => {
    const secret = `sk-${"a".repeat(24)}`;
    const judged: string[] = [];
    const localSdk = mockSdk();
    registerSelectiveContextFunctions(localSdk as never, kv as never, {
      namespace: "personal", now: () => NOW,
      judge: async (request, candidates, signal) => {
        judged.push(JSON.stringify({ request, candidates }));
        return usefulJudge(request, candidates, signal);
      },
    });
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed", agentId: "owner" });
    await kv.set(KV.sessions, "current", { id: "current", project: "home", status: "active",
      agentId: "owner", startedAt: NOW });
    const observation = { id: "obs_secret", sessionId: "old", timestamp: NOW, type: "decision",
      title: "Router port", narrative: `Router port is 4180; token ${secret} is private.`,
      facts: [], concepts: [], files: [], importance: 8, agentId: "owner",
      origin: { channel: "agent", capturedAt: NOW } };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    const result = await localSdk.trigger("mem::selective-context", { prompt: `router port ${secret}`,
      hermes: { sessionId: "current", ownerId: "owner", visibility: "private" } }) as {
      spans: Array<{ text: string }>;
    };
    expect(judged).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ status: "unavailable", spans: [], error: "credential_input" });
    const sourceOnly = await localSdk.trigger("mem::selective-context", { prompt: "router port",
      hermes: { sessionId: "current", ownerId: "owner", visibility: "private" } }) as {
      status: string; spans: unknown[];
    };
    expect(sourceOnly).toMatchObject({ status: "empty", spans: [] });
    expect(JSON.stringify(judged)).not.toContain(secret);
  });

  it("keeps complete sentences and rejects a stale Hermes source after judgment", async () => {
    const localSdk = mockSdk();
    registerSelectiveContextFunctions(localSdk as never, kv as never, {
      namespace: "personal", now: () => NOW,
      judge: async (request, candidates, signal) => {
        expect(candidates.find(candidate => candidate.id === "observation:obs_long")?.spans[0]?.text)
          .toBe(`${"A".repeat(700)}.`);
        await kv.delete(KV.observations("old"), "obs_long");
        return usefulJudge(request, candidates, signal);
      },
    });
    await kv.set(KV.sessions, "old", { id: "old", project: "home", status: "completed", agentId: "owner" });
    await kv.set(KV.sessions, "current", { id: "current", project: "home", status: "active",
      agentId: "owner", startedAt: NOW });
    const observation = { id: "obs_long", sessionId: "old", timestamp: NOW, type: "decision",
      title: "Router fact", narrative: `${"A".repeat(700)}. ${"B".repeat(700)}.`,
      facts: [], concepts: [], files: [], importance: 8, agentId: "owner",
      origin: { channel: "agent", capturedAt: NOW } };
    await kv.set(KV.observations("old"), observation.id, observation);
    getSearchIndex().add(observation as never);
    const result = await localSdk.trigger("mem::selective-context", { prompt: "Router fact",
      hermes: { sessionId: "current", ownerId: "owner", visibility: "private" } });
    expect(result).toMatchObject({ status: "unavailable", spans: [], error: "knowledge_changed" });
  });

  it("stores evidence-backed knowledge, replays the same event, and audits the save", async () => {
    const input = { expectedRevision: 0, confirmedByUser: true as const, knowledge: knowledge() };
    expect(await sdk.trigger("mem::context-knowledge-put", input)).toMatchObject({
      success: true, action: "saved", revision: 1,
    });
    expect(await sdk.trigger("mem::context-knowledge-put", input)).toMatchObject({
      success: true, action: "replayed", revision: 1,
    });
    expect(await kv.list(KV.audit)).toMatchObject([{
      operation: "context_knowledge_put",
      targetIds: ["knowledge-ascii-diagrams"],
      details: { evidenceEventId: "evt-user-1", knowledgeRevision: "rev-1" },
    }]);
  });

  it("accepts iii worker metadata internally but still rejects unrelated fields", async () => {
    expect(await sdk.trigger("mem::context-knowledge-put", { expectedRevision: 0, confirmedByUser: true,
      knowledge: knowledge(), _caller_worker_id: "iii-worker" })).toMatchObject({ success: true });
    expect(await sdk.trigger("mem::selective-context", { prompt: "draw a diagram", project: "agentmemory", projectId: "repo-agentmemory",
      _caller_worker_id: "iii-worker" })).toMatchObject({ status: "selected" });
    expect(await sdk.trigger("mem::selective-context", { prompt: "draw a diagram", project: "agentmemory", projectId: "repo-agentmemory",
      _caller_worker_id: "iii-worker", namespace: "other" })).toMatchObject({ error: "invalid_request" });
  });

  it("rejects a reused source event with changed contents and stale catalog writes", async () => {
    await sdk.trigger("mem::context-knowledge-put", {
      expectedRevision: 0, confirmedByUser: true, knowledge: knowledge(),
    });
    const changedEvidence = knowledge({ revision: "rev-2", evidence: {
      eventId: "evt-user-1",
      text: "In TUI and CLI, render process diagrams as ASCII. Do not use Mermaid. This changed.",
      adoptedAt: "2026-09-18T12:00:00.000Z",
    }, spans: [{ id: "span-format", text: "In TUI and CLI, render process diagrams as ASCII. Do not use Mermaid." }] });
    expect(await sdk.trigger("mem::context-knowledge-put", {
      expectedRevision: 1, confirmedByUser: true, knowledge: changedEvidence,
    })).toMatchObject({ success: false, error: "event_conflict" });
    expect(await sdk.trigger("mem::context-knowledge-put", {
      expectedRevision: 0, confirmedByUser: true, knowledge: knowledge({
        id: "knowledge-new", revision: "rev-1", evidence: {
          eventId: "evt-user-2", text: "Always state whether a claim was verified.", adoptedAt: "2026-09-18T12:00:00.000Z",
        }, spans: [{ id: "span-verified", text: "Always state whether a claim was verified." }],
      }),
    })).toMatchObject({ success: false, error: "revision_conflict", revision: 1 });
  });

  it("injects only active, same-scope, evidence-exact text", async () => {
    await sdk.trigger("mem::context-knowledge-put", {
      expectedRevision: 0, confirmedByUser: true, knowledge: knowledge(),
    });
    await sdk.trigger("mem::context-knowledge-put", {
      expectedRevision: 1, confirmedByUser: true, knowledge: knowledge({
        id: "candidate", revision: "rev-1", status: "candidate", evidence: {
          eventId: "evt-user-2", text: "Candidate text must stay silent.", adoptedAt: "2026-09-18T12:00:00.000Z",
        }, spans: [{ id: "candidate-span", text: "Candidate text must stay silent." }],
      }),
    });
    const result = await sdk.trigger("mem::selective-context", {
      prompt: "請重新畫流程圖", project: "agentmemory", projectId: "repo-agentmemory",
    }) as { status: string; spans: Array<{ text: string; evidenceEventId: string }> };
    expect(result.status).toBe("selected");
    expect(result.spans).toMatchObject([{
      text: "In TUI and CLI, render process diagrams as ASCII. Do not use Mermaid.",
      evidenceEventId: "evt-user-1",
    }]);
  });

  it("fails closed for malformed judge output and a missed deadline", async () => {
    const request = {
      prompt: "draw a diagram", previous: "", namespace: "personal", project: "agentmemory", projectId: "repo-agentmemory", asOf: NOW,
    };
    const records = [knowledge()];
    const malformed = await selectContext(request, records, async () => []);
    expect(malformed).toEqual({ status: "unavailable", spans: [] });
    const timedOut = await selectContext(request, records, async () =>
      await new Promise<never>(() => {}), { timeoutMs: 10 });
    expect(timedOut).toEqual({ status: "unavailable", spans: [] });
  });

  it.each(["overridden", "source_restricted", "unclear"] as const)("keeps %s background out even with high relevance", async compatibility => {
    const result = await selectContext({ prompt: "draw a diagram", previous: "",
      namespace: "personal", project: "agentmemory", projectId: "repo-agentmemory", asOf: NOW }, [knowledge()], async (...args) =>
      (await usefulJudge(...args)).map(decision => ({ ...decision, compatibility })));
    expect(result).toEqual({ status: "empty", spans: [] });
  });

  it("rejects missing or unknown compatibility rather than trusting relevance alone", async () => {
    for (const compatibility of [undefined, "probably", 0.05]) {
      const result = await selectContext({ prompt: "draw a diagram", previous: "",
        namespace: "personal", project: "agentmemory", projectId: "repo-agentmemory", asOf: NOW }, [knowledge()], async (...args) =>
        (await usefulJudge(...args)).map(decision => ({ ...decision, compatibility })) as never);
      expect(result).toEqual({ status: "unavailable", spans: [] });
    }
  });

  it("keeps stale, different-project, and excluded knowledge out of the judge request", async () => {
    const seen: string[][] = [];
    const request = {
      prompt: "draw a diagram", previous: "", namespace: "personal", project: "agentmemory", projectId: "repo-agentmemory", asOf: NOW,
      excludedIds: ["excluded"],
    };
    const result = await selectContext(request, [
      knowledge(),
      knowledge({ id: "other-project", scope: { namespace: "personal", project: "other" }, evidence: {
        eventId: "evt-user-2", text: "Wrong project.", adoptedAt: "2026-09-18T12:00:00.000Z",
      }, spans: [{ id: "other", text: "Wrong project." }] }),
      knowledge({ id: "future", evidence: {
        eventId: "evt-user-3", text: "Future knowledge.", adoptedAt: "2026-09-20T12:00:00.000Z",
      }, spans: [{ id: "future", text: "Future knowledge." }] }),
      knowledge({ id: "excluded", evidence: {
        eventId: "evt-user-4", text: "Excluded knowledge.", adoptedAt: "2026-09-18T12:00:00.000Z",
      }, spans: [{ id: "excluded", text: "Excluded knowledge." }] }),
    ], async (_request, candidates) => {
      seen.push(candidates.map(candidate => candidate.id));
      return usefulJudge(_request, candidates, new AbortController().signal);
    });
    expect(seen).toEqual([["knowledge-ascii-diagrams"]]);
    expect(result.status).toBe("selected");
  });

  it("bounds the text sent to the judge without truncating source spans", async () => {
    const first = knowledge({ evidence: {
      eventId: "evt-new", text: "New context is kept whole.", adoptedAt: "2026-09-18T13:00:00.000Z",
    }, spans: [{ id: "new", text: "New context is kept whole." }] });
    const oldText = "Older context must not be sliced into a partial instruction.";
    const second = knowledge({ id: "older", evidence: {
      eventId: "evt-old", text: oldText, adoptedAt: "2026-09-18T12:00:00.000Z",
    }, spans: [{ id: "old", text: oldText }] });
    let supplied: ContextKnowledge[] = [];
    await selectContext({
      prompt: "draw a diagram", previous: "", namespace: "personal", project: "agentmemory", projectId: "repo-agentmemory", asOf: NOW,
    }, [first, second], async (_request, candidates) => {
      supplied = candidates;
      return usefulJudge(_request, candidates, new AbortController().signal);
    }, { maxCandidateCharacters: first.spans[0]!.text.length });
    expect(supplied).toHaveLength(1);
    expect(supplied[0]!.spans).toEqual(first.spans);
    expect(supplied.flatMap(record => record.spans).some(span => span.text !== first.spans[0]!.text)).toBe(false);
  });

  it("does not attach legacy name-only knowledge to a newly identified repository", async () => {
    const judge = vi.fn(usefulJudge);
    const result = await selectContext({ prompt: "draw a diagram", previous: "", namespace: "personal",
      project: "agentmemory", projectId: "repo-identity", asOf: NOW },
    [knowledge({ scope: { namespace: "personal", project: "agentmemory" } })], judge);
    expect(result.status).toBe("empty");
    expect(judge).not.toHaveBeenCalled();
  });
});
