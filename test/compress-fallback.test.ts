import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerCompressFunction } from "../src/functions/compress.js";
import { getSearchIndex } from "../src/functions/search.js";
import type { MemoryProvider, RawObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (idOrOpts: string | { id: string }, fn: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function provider(compress: () => Promise<string>): MemoryProvider {
  return {
    name: "mock",
    compress,
    summarize: async () => "",
  };
}

const raw: RawObservation = {
  id: "obs_fallback",
  sessionId: "ses_fallback",
  timestamp: new Date().toISOString(),
  hookType: "post_tool_use",
  raw: {},
  toolName: "Read",
  toolInput: { file_path: "src/foo.ts" },
  toolOutput: "file contents here",
};

const payload = {
  observationId: raw.id,
  sessionId: raw.sessionId,
  raw,
};

const scope = `mem:obs:${raw.sessionId}`;

describe("mem::compress synthetic fallback on LLM failure", () => {
  beforeEach(() => {
    getSearchIndex().clear();
  });

  it("persists a synthetic observation when the provider throws", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider(async () => {
        throw new Error("503 No available accounts");
      }),
    );

    const result = (await sdk.trigger("mem::compress", payload)) as {
      success: boolean;
      error: string;
      degraded: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("compression_failed");
    expect(result.degraded).toBe(true);

    const stored = kv.store.get(scope);
    expect(stored?.size).toBe(1);
    const obs = stored!.get(raw.id) as {
      id: string;
      sessionId: string;
      type: string;
      title: string;
      files: string[];
      confidence: number;
    };
    expect(obs.id).toBe(raw.id);
    expect(obs.sessionId).toBe(raw.sessionId);
    expect(obs.type).toBe("file_read");
    expect(obs.title).toBe("Read");
    expect(obs.files).toContain("src/foo.ts");
    // degraded entries must not masquerade as LLM-quality output
    expect(obs.confidence).toBe(0.3);

    const hits = getSearchIndex().search("Read", 10);
    expect(hits.map((h) => h.obsId)).toContain(raw.id);
  });

  it("persists a synthetic observation when the LLM output is unparseable", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider(async () => "not xml at all"),
    );

    const result = (await sdk.trigger("mem::compress", payload)) as {
      success: boolean;
      error: string;
      degraded: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("parse_failed");
    expect(result.degraded).toBe(true);
    expect(kv.store.get(scope)?.size).toBe(1);
    expect(getSearchIndex().has(raw.id)).toBe(true);
  });

  it("publishes the degraded observation to both stream groups", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider(async () => {
        throw new Error("boom");
      }),
    );

    await sdk.trigger("mem::compress", payload);

    const streamSets = sdk.triggered.filter((t) => t.id === "stream::set");
    expect(streamSets).toHaveLength(2);
    const groups = streamSets.map(
      (t) => (t.data as { group_id: string }).group_id,
    );
    expect(new Set(groups).size).toBe(2);
  });

  it("keeps the LLM result when compression succeeds", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider(
        async () => `<type>file_read</type>
<title>Read src/foo.ts</title>
<narrative>Read the foo module.</narrative>
<facts><fact>foo exists</fact></facts>
<concepts><concept>foo</concept></concepts>
<files><file>src/foo.ts</file></files>
<importance>6</importance>`,
      ),
    );

    const result = (await sdk.trigger("mem::compress", payload)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const obs = kv.store.get(scope)!.get(raw.id) as {
      title: string;
      confidence: number;
    };
    expect(obs.title).toBe("Read src/foo.ts");
    expect(obs.confidence).not.toBe(0.3);
  });
});
