import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression cases for interleavings found by model-checking the session
// lifecycle (observe -> compress -> summarize, plus mem::forget) in TLA+.

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));

import { registerCompressFunction } from "../src/functions/compress.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, RawObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
    store,
    afterSet: undefined as undefined | ((scope: string, key: string) => Promise<void>),
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      await kv.afterSet?.(scope, key);
      return data;
    },
    // iii's kv builtin upserts: ops apply to a fresh object when the key is gone.
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ) => {
      if (!store.has(scope)) store.set(scope, new Map());
      const next = { ...((store.get(scope)!.get(key) as object) ?? {}) } as Record<string, unknown>;
      for (const op of ops) if (op.type === "set") next[op.path] = op.value;
      store.get(scope)!.set(key, next);
      return next;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
  return kv;
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, fn: Function) => fns.set(id, fn),
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      return fn ? fn(payload) : null;
    },
  };
}

function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (entered = r));
  return { open, opened, reached, entered };
}

function summaryXml(title: string) {
  return `<summary><title>${title}</title><narrative>n</narrative><decisions></decisions><files></files><concepts></concepts></summary>`;
}

const SID = "ses_race";

function compressedObs(i: number) {
  return {
    id: `obs_${i}`,
    sessionId: SID,
    timestamp: new Date().toISOString(),
    type: "conversation",
    title: `obs ${i}`,
    facts: [],
    narrative: `narrative ${i}`,
    concepts: [],
    files: [],
    importance: 5,
  };
}

async function seedSession(kv: ReturnType<typeof mockKV>) {
  await kv.set(KV.sessions, SID, {
    id: SID,
    project: "p",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "active",
  });
}

describe("session lifecycle races", () => {
  const savedLockTimeout = process.env.SUMMARIZE_LOCK_TIMEOUT_MS;

  beforeEach(() => getSearchIndex().clear());
  afterEach(() => {
    if (savedLockTimeout === undefined) delete process.env.SUMMARIZE_LOCK_TIMEOUT_MS;
    else process.env.SUMMARIZE_LOCK_TIMEOUT_MS = savedLockTimeout;
  });

  it.each([
    ["synthetic fallback after an LLM error", async (): Promise<string> => {
      throw new Error("upstream 503");
    }],
    ["LLM result", async () => `<type>file_read</type>
<title>Read secret.env</title>
<narrative>Read the env file.</narrative>
<facts><fact>API_KEY is set</fact></facts>
<concepts><concept>env</concept></concepts>
<files><file>secret.env</file></files>
<importance>6</importance>`],
  ])("an in-flight compress does not resurrect an observation forgotten meanwhile (%s)", async (_path, finish) => {
    const sdk = mockSdk();
    const kv = mockKV();
    const g = gate();
    const provider: MemoryProvider = {
      name: "mock",
      compress: async () => {
        g.entered();
        await g.opened;
        return finish();
      },
      summarize: async () => "",
    };
    const metrics = { record: vi.fn(async () => {}) };
    registerCompressFunction(sdk as never, kv as never, provider, metrics as never);
    registerRememberFunction(sdk as never, kv as never);

    await seedSession(kv);
    const raw: RawObservation = {
      id: "obs_1",
      sessionId: SID,
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      raw: {},
      toolName: "Read",
      toolInput: { file_path: "secret.env" },
      toolOutput: "API_KEY=...",
    };
    await kv.set(KV.observations(SID), raw.id, raw);

    const compressing = sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: SID,
      raw,
    });
    await g.reached;
    await sdk.trigger("mem::forget", { sessionId: SID });
    g.open();
    expect(await compressing).toMatchObject({ success: false });

    expect(await kv.list(KV.observations(SID))).toEqual([]);
    expect(getSearchIndex().has(raw.id)).toBe(false);
    expect(metrics.record).toHaveBeenCalledWith("mem::compress", expect.any(Number), false);
  });

  it("an in-flight summarize does not write a summary for a session forgotten meanwhile", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const g = gate();
    const provider: MemoryProvider = {
      name: "mock",
      compress: async () => "",
      summarize: async () => {
        g.entered();
        await g.opened;
        return summaryXml("stale");
      },
    };
    const metrics = { record: vi.fn(async () => {}) };
    registerSummarizeFunction(sdk as never, kv as never, provider, metrics as never);
    registerRememberFunction(sdk as never, kv as never);

    await seedSession(kv);
    await kv.set(KV.observations(SID), "obs_1", compressedObs(1));

    const summarizing = sdk.trigger("mem::summarize", { sessionId: SID });
    await g.reached;
    await sdk.trigger("mem::forget", { sessionId: SID });
    g.open();
    expect(await summarizing).toMatchObject({ success: false, error: "session_deleted" });

    expect(await kv.get(KV.summaries, SID)).toBeNull();
    expect(metrics.record).toHaveBeenCalledWith("mem::summarize", expect.any(Number), false);
  });

  it("an in-flight summarize does not leak forgotten observations into a session recreated meanwhile", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const g = gate();
    const provider: MemoryProvider = {
      name: "mock",
      compress: async () => "",
      summarize: async () => {
        g.entered();
        await g.opened;
        return summaryXml("covers forgotten obs_1");
      },
    };
    registerSummarizeFunction(sdk as never, kv as never, provider);
    registerRememberFunction(sdk as never, kv as never);

    await seedSession(kv);
    await kv.set(KV.observations(SID), "obs_1", compressedObs(1));

    const summarizing = sdk.trigger("mem::summarize", { sessionId: SID });
    await g.reached;
    await sdk.trigger("mem::forget", { sessionId: SID });
    // The next turn's observation recreates the session row.
    await seedSession(kv);
    await kv.set(KV.observations(SID), "obs_2", compressedObs(2));
    g.open();
    await summarizing;

    expect(await kv.get(KV.summaries, SID)).toBeNull();
  });

  it("forget racing an observe leaves neither a partial session row nor the observation", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const g = gate();
    registerObserveFunction(sdk as never, kv as never);
    registerRememberFunction(sdk as never, kv as never);

    await seedSession(kv);
    kv.afterSet = async (scope) => {
      if (scope !== KV.observations(SID)) return;
      kv.afterSet = undefined;
      g.entered();
      await g.opened;
    };

    const observing = sdk.trigger("mem::observe", {
      sessionId: SID,
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_output: "x" },
    });
    await g.reached;
    const forgetting = sdk.trigger("mem::forget", { sessionId: SID });
    await Promise.race([forgetting, new Promise((r) => setTimeout(r, 50))]);
    g.open();
    await Promise.all([observing, forgetting]);

    const row = await kv.get<Record<string, unknown>>(KV.sessions, SID);
    expect(row === null || typeof row.id === "string").toBe(true);
    expect(await kv.list(KV.observations(SID))).toEqual([]);
  });

  it("forgetting one observation while observe is still writing it does not leave its synthetic compression behind", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const g = gate();
    registerObserveFunction(sdk as never, kv as never);
    registerRememberFunction(sdk as never, kv as never);

    await seedSession(kv);
    let obsId = "";
    kv.afterSet = async (scope, key) => {
      if (scope !== KV.observations(SID)) return;
      kv.afterSet = undefined;
      obsId = key;
      g.entered();
      await g.opened;
    };

    const observing = sdk.trigger("mem::observe", {
      sessionId: SID,
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_output: "x" },
    });
    await g.reached;
    const forgetting = sdk.trigger("mem::forget", { sessionId: SID, observationIds: [obsId] });
    await Promise.race([forgetting, new Promise((r) => setTimeout(r, 50))]);
    g.open();
    await Promise.all([observing, forgetting]);

    expect(await kv.list(KV.observations(SID))).toEqual([]);
    expect(getSearchIndex().has(obsId)).toBe(false);
  });

  it("a summarize run that outlived its lock timeout does not overwrite a newer summary", async () => {
    process.env.SUMMARIZE_LOCK_TIMEOUT_MS = "30";
    const sdk = mockSdk();
    const kv = mockKV();
    const slow = gate();
    let call = 0;
    const provider: MemoryProvider = {
      name: "mock",
      compress: async () => "",
      summarize: async () => {
        call += 1;
        if (call === 1) {
          slow.entered();
          await slow.opened;
          return summaryXml("turn 1 only");
        }
        return summaryXml("turns 1 and 2");
      },
    };
    registerSummarizeFunction(sdk as never, kv as never, provider);

    await seedSession(kv);
    await kv.set(KV.observations(SID), "obs_1", compressedObs(1));

    const first = sdk.trigger("mem::summarize", { sessionId: SID });
    await slow.reached;
    expect(await first).toMatchObject({ success: false, error: "summarize_timeout" });

    await kv.set(KV.observations(SID), "obs_2", compressedObs(2));
    await sdk.trigger("mem::summarize", { sessionId: SID });
    expect(await kv.get(KV.summaries, SID)).toMatchObject({ observationCount: 2 });

    slow.open();
    await new Promise((r) => setTimeout(r, 20));

    expect(await kv.get(KV.summaries, SID)).toMatchObject({
      title: "turns 1 and 2",
      observationCount: 2,
    });
  });
});
