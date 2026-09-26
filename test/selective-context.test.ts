import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSelectiveContextFunctions } from "../src/functions/selective-context.js";
import { selectContext, type ContextJudge, type ContextKnowledge } from "../src/state/selective-context.js";
import { KV } from "../src/state/schema.js";

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
    trigger: async (id: string, input: unknown) => {
      const fn = functions.get(id);
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

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSelectiveContextFunctions(sdk as never, kv as never, {
      namespace: "personal",
      judge: usefulJudge,
      now: () => NOW,
    });
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
