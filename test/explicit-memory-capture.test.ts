import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSelectiveContextFunctions } from "../src/functions/selective-context.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { explicitMemoryText, isRememberRequest, type CaptureJudge } from "../src/state/explicit-memory.js";
import { KV } from "../src/state/schema.js";
import { DedupMap } from "../src/functions/dedup.js";
import type { ContextJudge } from "../src/state/selective-context.js";
import type { ContextKnowledgeCatalog } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config.js", () => ({ isAutoCompressEnabled: () => false, getAgentId: () => undefined }));
vi.mock("../src/functions/search.js", () => ({ getSearchIndex: () => ({ add: vi.fn() }), vectorIndexAddGuarded: vi.fn() }));

const useful: ContextJudge = async (_request, records) => records.flatMap(record => record.spans.map(span => ({
  knowledgeId: record.id, revision: record.revision, spanId: span.id,
  useful: 0.95, compatibility: "compatible" as const, addition: "adds" as const,
})));

function setup(captureJudge: CaptureJudge = async () => "project_rule", enabled = true) {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
    get: async <T>(scope: string, key: string) => (store.get(scope)?.get(key) as T) ?? null,
    set: async (scope: string, key: string, value: unknown) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value); return value;
    },
    update: async (scope: string, key: string, updates: Array<{ path: string; value: unknown }>) => {
      const value = store.get(scope)?.get(key) as Record<string, unknown>;
      for (const update of updates) value[update.path] = update.value;
    },
    list: async <T>(scope: string): Promise<T[]> => [...(store.get(scope)?.values() ?? [])] as T[],
  };
  const functions = new Map<string, (data: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (id: string, handler: (data: unknown) => Promise<unknown>) => functions.set(id, handler),
    trigger: async (request: { function_id: string; payload: unknown }) => functions.get(request.function_id)?.({
      ...(request.payload as Record<string, unknown>), _caller_worker_id: "iii-fixture-worker",
    }) ?? null,
  };
  registerObserveFunction(sdk as never, kv as never, new DedupMap(), undefined, enabled);
  registerSelectiveContextFunctions(sdk as never, kv as never, { namespace: "capture-test", judge: useful, captureJudge });
  const call = async (id: string, payload: unknown): Promise<any> => sdk.trigger({ function_id: id, payload });
  const observe = (prompt: string, sessionId = "session-a", project = "project-a", hookType = "prompt_submit", explicit = true) => call("mem::observe", {
    sessionId, project, cwd: "/tmp/fixture", hookType, timestamp: new Date().toISOString(), data: {
      prompt, ...(explicit && isRememberRequest(prompt) ? { explicitMemoryRequest: true } : {}),
    },
  });
  const catalog = async () => (await kv.list<ContextKnowledgeCatalog>(KV.contextKnowledge))[0];
  return { kv, call, observe, catalog };
}

describe("explicit memory capture", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["好", "1", "照做", "請記得處理這個 bug", "> 記住：別人的規則", "```\n記住：引用文字\n```"])("does not turn %s into a save command", prompt => {
    expect(isRememberRequest(prompt)).toBe(false);
    expect(explicitMemoryText(prompt)).toBeNull();
  });

  it("saves exact source before compression and recalls it on a later request", async () => {
    const app = setup();
    const text = "這個專案的報告必須保留來源。".repeat(40);
    const prompt = `請記住：${text}`;
    const result = await app.observe(prompt);
    expect(result.knowledgeCapture).toMatchObject({ success: true, status: "active", action: "saved" });
    const saved = (await app.catalog())!.records[0]!;
    expect(saved.evidence).toMatchObject({ text: prompt, sessionId: "session-a", eventId: result.observationId });
    expect(saved.spans).toEqual([{ id: "user-text", text }]);
    expect(saved.scope).toEqual({ namespace: "capture-test", project: "project-a" });
    const observation = await app.kv.get<{ narrative: string }>(KV.observations("session-a"), result.observationId);
    expect(observation.narrative.length).toBeLessThan(prompt.length);
    expect(await app.call("mem::selective-context", { prompt: "寫報告", project: "project-a" })).toMatchObject({
      status: "selected", spans: [{ text, evidenceEventId: result.observationId }],
    });
    expect(await app.call("mem::selective-context", { prompt: "寫報告", project: "other" })).toMatchObject({ status: "empty" });
  });

  it("deduplicates repeated captures without losing the first evidence or spending again", async () => {
    const judge = vi.fn<CaptureJudge>(async () => "project_rule");
    const app = setup(judge);
    const first = await app.observe("記住：報告要附來源。");
    const repeated = await app.observe("記住：報告要附來源。");
    expect(repeated.knowledgeCapture).toMatchObject({ success: true, action: "existing" });
    expect((await app.catalog())!.records).toHaveLength(1);
    expect((await app.catalog())!.records[0]!.evidence.eventId).toBe(first.observationId);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it.each(["task_only", "unclear"] as const)("keeps %s requests as non-recallable candidates", async disposition => {
    const app = setup(async () => disposition);
    expect((await app.observe("記住：這次先用這個方式。")).knowledgeCapture).toMatchObject({ status: "candidate", disposition });
    expect(await app.call("mem::selective-context", { prompt: "繼續", project: "project-a" })).toMatchObject({ status: "empty" });
  });

  it("preserves a candidate on judge failure rather than activating it", async () => {
    const app = setup(async () => { throw new Error("offline"); });
    expect((await app.observe("記住：報告要附來源。")).knowledgeCapture).toMatchObject({ success: true, status: "candidate" });
  });

  it("allows an explicit retry after an unavailable judge without promoting ambiguous candidates", async () => {
    const judge = vi.fn<CaptureJudge>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("project_rule");
    const app = setup(judge);
    expect((await app.observe("記住：報告要附來源。")).knowledgeCapture).toMatchObject({ status: "candidate", disposition: "unavailable" });
    expect((await app.observe("記住：報告要附來源。")).knowledgeCapture).toMatchObject({ status: "active" });
    expect((await app.catalog())!.records).toHaveLength(1);
    const ambiguousJudge = vi.fn<CaptureJudge>().mockResolvedValueOnce("unclear").mockResolvedValue("project_rule");
    const other = setup(ambiguousJudge);
    await other.observe("記住：就用他剛才說的方式。");
    expect((await other.observe("記住：就用他剛才說的方式。")).knowledgeCapture).toMatchObject({ status: "candidate", action: "existing" });
    expect(ambiguousJudge).toHaveBeenCalledTimes(1);
  });

  it("ignores ordinary confirmation, tool output, and disabled capture", async () => {
    const judge = vi.fn<CaptureJudge>(async () => "project_rule");
    const app = setup(judge);
    expect(await app.observe("好，照做")).not.toHaveProperty("knowledgeCapture");
    expect(await app.observe("記住：報告要附來源。", "session-a", "project-a", "post_tool_use")).not.toHaveProperty("knowledgeCapture");
    expect(await app.observe("記住：歷史記錄不應自動採納。", "session-a", "project-a", "prompt_submit", false)).not.toHaveProperty("knowledgeCapture");
    const disabled = setup(judge, false);
    expect(await disabled.observe("記住：報告要附來源。")).not.toHaveProperty("knowledgeCapture");
    expect(judge).not.toHaveBeenCalled();
  });

  it("rejects missing source and redacted or oversized content", async () => {
    const app = setup();
    expect(await app.call("mem::context-knowledge-capture", { sessionId: "x", observationId: "missing" })).toMatchObject({ error: "unverified_source" });
    for (const prompt of ["記住：", `記住：${"x".repeat(1201)}`, `記住：token=${"s".repeat(32)}`]) {
      const result = (await app.observe(prompt)).knowledgeCapture;
      expect(result.success).toBe(false);
      // Privacy filtering may discard the structured source envelope entirely.
      expect(["invalid_save_request", "unverified_source"]).toContain(result.error);
    }
    expect(await app.catalog()).toBeUndefined();
  });

  it("uses the existing session scope and supplies its active rules for conflict checking", async () => {
    const seen: string[][] = [];
    const app = setup(async (_prompt, rules) => { seen.push(rules); return "project_rule"; });
    await app.observe("記住：報告要附來源。");
    await app.observe("記住：報告用純文字。", "session-a", "spoofed-project");
    expect(seen[1]).toEqual(["報告要附來源。"]);
    expect((await app.catalog())!.records.every(r => r.scope.project === "project-a")).toBe(true);
  });

  it("does not reactivate a withdrawn rule on replay", async () => {
    const app = setup();
    await app.observe("記住：報告要附來源。");
    const catalog = (await app.catalog())!;
    const old = catalog.records[0]!;
    await app.call("mem::context-knowledge-put", { expectedRevision: catalog.revision, confirmedByUser: true,
      knowledge: { ...old, revision: "withdrawn", status: "retracted", evidence: { ...old.evidence, eventId: "withdrawal" } } });
    expect((await app.observe("記住：報告要附來源。")).knowledgeCapture).toMatchObject({ status: "retracted", action: "existing" });
    expect(await app.call("mem::selective-context", { prompt: "報告", project: "project-a" })).toMatchObject({ status: "empty" });
  });

  it("rejects a stale classification when another capture changes the catalog", async () => {
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const app = setup(async () => { if (++arrivals === 2) release(); await ready; return "project_rule"; });
    const results = await Promise.all([
      app.observe("記住：報告要附來源。", "session-a"),
      app.observe("記住：報告用純文字。", "session-b"),
    ]);
    expect(results.filter(r => r.knowledgeCapture.success)).toHaveLength(1);
    expect(results.find(r => !r.knowledgeCapture.success)?.knowledgeCapture.error).toBe("revision_conflict");
    expect((await app.catalog())!.records).toHaveLength(1);
  });
});
