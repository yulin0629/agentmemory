import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionsContextJudge, createJevContextJudge, type ContextKnowledge, type ContextRequest } from "../src/state/selective-context.js";
import { createDecisionsCaptureJudge } from "../src/state/explicit-memory.js";
import { createFailoverCaptureJudge, createFailoverContextJudge, type JudgeProviderConfig } from "../src/state/judge-failover.js";
import { getSelectiveContextConfig } from "../src/config.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const TYPESAFE = "https://api.typesafe.ai/v1/systemone";
const DECISIONS = "https://api.openai.com/v1/decisions";

const request: ContextRequest = { prompt: "部署前要做什麼？", previous: "", namespace: "ns", asOf: "2026-11-08T00:00:00Z" };
const candidates = [{
  id: "k1", revision: "r1", status: "active", scope: { namespace: "ns" },
  evidence: { eventId: "e1", text: "部署前先跑測試。回報附輸出。", adoptedAt: "2026-11-01T00:00:00Z" },
  spans: [{ id: "s1", text: "部署前先跑測試。" }, { id: "s2", text: "回報附輸出。" }],
}] as ContextKnowledge[];

type Call = { url: string; body: Record<string, any> };
function stubFetch(routes: Record<string, (body: Record<string, any>) => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    return routes[url]!(body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function decisionsContextAnswers(body: Record<string, any>) {
  return { answers: body.questions.map((q: { name: string; type: string }) => {
    const i = Number(q.name.split("_")[1]);
    if (q.type === "predicate") return { type: "predicate", name: q.name, probability: i === 0 ? 0.91 : 0.12 };
    return { type: "choice", name: q.name, choice: q.name.startsWith("compatibility") ? "compatible" : i === 0 ? "adds" : "restates",
      probabilities: [], confidence: 0.9 };
  }), usage: { input_tokens: 10 } };
}
const jevContextAnswers = { answers: {
  useful_0: { noul: 0.8 }, compatibility_0: { choice: "compatible" }, addition_0: { choice: "adds" },
  useful_1: { noul: 0.3 }, compatibility_1: { choice: "unclear" }, addition_1: { choice: "unclear" },
} };

const base: JudgeProviderConfig = {
  model: "jev-preview", decisionsBaseUrl: "https://api.openai.com/v1", decisionsModel: "gpt-6-luna",
  judgeOrder: ["typesafe", "decisions"],
};
const signal = () => new AbortController().signal;

describe("Decisions context judge", () => {
  it("asks the Jev questions as predicate/choice and maps answers to decisions", async () => {
    const { fn, calls } = stubFetch({ [DECISIONS]: body => json(decisionsContextAnswers(body)) });
    const decisions = await createDecisionsContextJudge({ apiKey: "dk", model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1/", fetch: fn })(
      request, candidates, signal());
    expect(decisions).toEqual([
      { knowledgeId: "k1", revision: "r1", spanId: "s1", text: "部署前先跑測試。", useful: 0.91, compatibility: "compatible", addition: "adds" },
      { knowledgeId: "k1", revision: "r1", spanId: "s2", text: "回報附輸出。", useful: 0.12, compatibility: "compatible", addition: "restates" },
    ]);
    const body = calls[0]!.body;
    expect(calls[0]!.url).toBe(DECISIONS);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_json", data: {
      current_prompt: request.prompt, previous: "", candidates: [{ text: "部署前先跑測試。" }, { text: "回報附輸出。" }],
    } }] }]);
    expect(body.questions.map((q: any) => [q.name, q.type, q.choices?.map((c: any) => c.value)])).toEqual([
      ["useful_0", "predicate", undefined],
      ["compatibility_0", "choice", ["compatible", "overridden", "source_restricted", "unclear"]],
      ["addition_0", "choice", ["adds", "restates", "unclear"]],
      ["useful_1", "predicate", undefined],
      ["compatibility_1", "choice", ["compatible", "overridden", "source_restricted", "unclear"]],
      ["addition_1", "choice", ["adds", "restates", "unclear"]],
    ]);
  });

  it("throws on a refusal, a missing answer, an unknown choice, or an HTTP error", async () => {
    const judge = (respond: (body: Record<string, any>) => Response) =>
      createDecisionsContextJudge({ apiKey: "dk", model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1",
        fetch: stubFetch({ [DECISIONS]: respond }).fn })(request, candidates, signal());
    await expect(judge(body => { const r = decisionsContextAnswers(body); r.answers[2] = { type: "refusal", name: "addition_0" }; return json(r); }))
      .rejects.toThrow(/refused/);
    await expect(judge(body => { const r = decisionsContextAnswers(body); r.answers.pop(); return json(r); })).rejects.toThrow();
    await expect(judge(body => { const r = decisionsContextAnswers(body); r.answers[1].choice = "maybe"; return json(r); })).rejects.toThrow();
    await expect(judge(() => json({ error: {} }, 429))).rejects.toThrow(/429/);
  });
});

describe("Decisions capture judge", () => {
  it("maps the disposition choice and sends the same value set", async () => {
    const { fn, calls } = stubFetch({ [DECISIONS]: () => json({ answers: [{ type: "choice", name: "disposition", choice: "task_only" }] }) });
    const judge = createDecisionsCaptureJudge({ apiKey: "dk", model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1", fetch: fn });
    await expect(judge("記住：這次先跳過 lint", ["規則 A"], signal())).resolves.toBe("task_only");
    expect(calls[0]!.body.input[0].content[0].data).toEqual({ user_prompt: "記住：這次先跳過 lint", existing_project_rules: ["規則 A"] });
    expect(calls[0]!.body.questions[0].choices.map((c: any) => c.value)).toEqual(["project_rule", "task_only", "unclear"]);
  });

  it("treats a refusal as a judge failure", async () => {
    const { fn } = stubFetch({ [DECISIONS]: () => json({ answers: [{ type: "refusal", name: "disposition" }] }) });
    await expect(createDecisionsCaptureJudge({ apiKey: "dk", model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1", fetch: fn })(
      "記住：x", [], signal())).rejects.toThrow(/refused/);
  });
});

describe("judge failover", () => {
  const keys = { ...base, apiKey: "tk", decisionsApiKey: "dk" };

  it("falls over from a TypeSafe 402 to Decisions", async () => {
    const { fn, calls } = stubFetch({ [TYPESAFE]: () => json({ error: "credit" }, 402), [DECISIONS]: body => json(decisionsContextAnswers(body)) });
    const decisions = await createFailoverContextJudge(keys, fn)(request, candidates, signal());
    expect(calls.map(c => c.url)).toEqual([TYPESAFE, DECISIONS]);
    expect(decisions.map(d => d.useful)).toEqual([0.91, 0.12]);

    const capture = stubFetch({ [TYPESAFE]: () => json({}, 402),
      [DECISIONS]: () => json({ answers: [{ type: "choice", name: "disposition", choice: "project_rule" }] }) });
    await expect(createFailoverCaptureJudge(keys, capture.fn)("記住：x", [], signal())).resolves.toBe("project_rule");
    expect(capture.calls.map(c => c.url)).toEqual([TYPESAFE, DECISIONS]);
  });

  it("rethrows the last error when every provider fails", async () => {
    const { fn, calls } = stubFetch({ [TYPESAFE]: () => json({}, 402),
      [DECISIONS]: () => json({ answers: [{ type: "refusal", name: "disposition" }] }) });
    await expect(createFailoverCaptureJudge(keys, fn)("記住：x", [], signal())).rejects.toThrow(/Decisions judge refused/);
    expect(calls).toHaveLength(2);
  });

  it("does not call TypeSafe when the first provider answers", async () => {
    const { fn, calls } = stubFetch({ [TYPESAFE]: () => json(jevContextAnswers), [DECISIONS]: body => json(decisionsContextAnswers(body)) });
    await createFailoverContextJudge({ ...keys, judgeOrder: ["decisions", "typesafe"] }, fn)(request, candidates, signal());
    expect(calls.map(c => c.url)).toEqual([DECISIONS]);
  });

  it("stops the chain once the caller's deadline has aborted the signal", async () => {
    const controller = new AbortController();
    const { fn, calls } = stubFetch({ [TYPESAFE]: () => { controller.abort(); throw new Error("aborted"); },
      [DECISIONS]: body => json(decisionsContextAnswers(body)) });
    await expect(createFailoverContextJudge(keys, fn)(request, candidates, controller.signal)).rejects.toThrow("aborted");
    expect(calls.map(c => c.url)).toEqual([TYPESAFE]);
  });

  it("with only a TypeSafe key behaves exactly like the Jev judge", async () => {
    const only = { ...base, apiKey: "tk" };
    const failing = stubFetch({ [TYPESAFE]: () => json({}, 402) });
    await expect(createFailoverContextJudge(only, failing.fn)(request, candidates, signal())).rejects.toThrow("Context judge HTTP 402");
    expect(failing.calls).toHaveLength(1);

    const a = stubFetch({ [TYPESAFE]: () => json(jevContextAnswers) });
    const b = stubFetch({ [TYPESAFE]: () => json(jevContextAnswers) });
    const viaFailover = await createFailoverContextJudge(only, a.fn)(request, candidates, signal());
    const direct = await createJevContextJudge("tk", "jev-preview", b.fn)(request, candidates, signal());
    expect(viaFailover).toEqual(direct);
    expect(a.calls).toEqual(b.calls);
  });
});

describe("judge provider config", () => {
  const ENV_KEYS = ["TYPESAFE_API_KEY", "OPENAI_DECISIONS_API_KEY", "OPENAI_DECISIONS_BASE_URL", "OPENAI_DECISIONS_MODEL", "AGENTMEMORY_JUDGE_ORDER"];
  const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  afterEach(() => {
    for (const key of ENV_KEYS) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key];
  });
  const setEnv = (values: Record<string, string>) => { for (const key of ENV_KEYS) process.env[key] = values[key] ?? ""; };

  it("respects AGENTMEMORY_JUDGE_ORDER and skips providers without a key", async () => {
    setEnv({ TYPESAFE_API_KEY: "tk", OPENAI_DECISIONS_API_KEY: "dk", AGENTMEMORY_JUDGE_ORDER: " Decisions , typesafe",
      OPENAI_DECISIONS_BASE_URL: "https://proxy.example/v1" });
    const config = getSelectiveContextConfig();
    expect(config.judgeOrder).toEqual(["decisions", "typesafe"]);
    expect(config.decisionsModel).toBe("gpt-6-luna");
    const { fn, calls } = stubFetch({ "https://proxy.example/v1/decisions": () => json({}, 503), [TYPESAFE]: () => json(jevContextAnswers) });
    await createFailoverContextJudge(config, fn)(request, candidates, signal());
    expect(calls.map(c => c.url)).toEqual(["https://proxy.example/v1/decisions", TYPESAFE]);

    setEnv({ TYPESAFE_API_KEY: "tk", AGENTMEMORY_JUDGE_ORDER: "decisions" });
    expect(getSelectiveContextConfig().hasJudge).toBe(false);
    setEnv({ OPENAI_DECISIONS_API_KEY: "dk" });
    expect(getSelectiveContextConfig()).toMatchObject({ hasJudge: true, judgeOrder: ["typesafe", "decisions"] });
  });
});
