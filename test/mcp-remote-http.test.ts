import { describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";

function mockSdk() {
  const functions = new Map<string, (data: any) => Promise<any>>();
  const triggers: Array<{ function_id: string; config: Record<string, unknown> }> = [];
  return {
    registerFunction: (id: string, handler: (data: any) => Promise<any>) => {
      functions.set(id, handler);
    },
    registerTrigger: (trigger: { function_id: string; config: Record<string, unknown> }) => {
      triggers.push(trigger);
    },
    trigger: vi.fn(async (input: { function_id: string; payload: unknown }) => {
      const handler = functions.get(input.function_id);
      if (!handler) throw new Error(`No function: ${input.function_id}`);
      return handler(input.payload);
    }),
    getFunction: (id: string) => functions.get(id),
    stub: (id: string, handler: (data: any) => Promise<any>) => {
      functions.set(id, handler);
    },
    triggers,
  };
}

function mockKv() {
  const sessions: any[] = [];
  return {
    sessions,
    list: vi.fn(async (scope: string) => (scope === KV.sessions ? sessions : [])),
    get: vi.fn(async () => null),
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function req(body: unknown, token?: string) {
  return {
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query_params: {},
  };
}

describe("remote MCP HTTP endpoint", () => {
  it("is disabled unless a dedicated bearer token is configured", () => {
    const sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKv() as never);

    expect(sdk.getFunction("mcp::remote")).toBeUndefined();
    expect(sdk.triggers.some((trigger) => trigger.config.api_path === "/mcp")).toBe(false);
  });

  it("registers POST for JSON-RPC and answers GET/DELETE with 405", async () => {
    const sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKv() as never, undefined, "chatgpt-secret");

    const methods = sdk.triggers
      .filter((trigger) => trigger.config.api_path === "/mcp")
      .map((trigger) => trigger.config.http_method)
      .sort();
    expect(methods).toEqual(["DELETE", "GET", "POST"]);

    const rejected = await sdk.getFunction("mcp::remote::method-not-allowed")!({});
    expect(rejected.status_code).toBe(405);
    expect(rejected.body.error.code).toBe(-32000);
  });

  it("caps memory_timeline and memory_lesson_recall so remote calls cannot dump whole stores", async () => {
    const sdk = mockSdk();
    const seen: Record<string, unknown>[] = [];
    sdk.stub("mem::timeline", async (payload) => {
      seen.push(payload);
      return { observations: [] };
    });
    sdk.stub("mem::lesson-recall", async (payload) => {
      seen.push(payload);
      return { lessons: [] };
    });
    sdk.stub("mem::search", async (payload) => {
      seen.push(payload);
      return { results: [] };
    });
    registerMcpEndpoints(sdk as never, mockKv() as never, undefined, "chatgpt-secret");
    const handler = sdk.getFunction("mcp::remote")!;

    await handler(
      req(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "memory_timeline", arguments: { anchor: "2026-01-01", before: 100000, after: 100000 } },
        },
        "chatgpt-secret",
      ),
    );
    await handler(
      req(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "memory_lesson_recall", arguments: { query: "deploy", limit: 100000 } },
        },
        "chatgpt-secret",
      ),
    );

    await handler(
      req(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "memory_recall", arguments: { query: "deploy", limit: 0 } },
        },
        "chatgpt-secret",
      ),
    );

    expect(seen[0]).toMatchObject({ before: 50, after: 50 });
    expect(seen[1]).toMatchObject({ limit: 100 });
    expect(seen[2]).toMatchObject({ limit: 1 });
  });

  it("authenticates initialize and exposes only the curated read-only tools", async () => {
    const sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKv() as never, undefined, "chatgpt-secret");
    const handler = sdk.getFunction("mcp::remote")!;

    const denied = await handler(req({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect(denied.status_code).toBe(401);

    const initialized = await handler(
      req(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        },
        "chatgpt-secret",
      ),
    );
    expect(initialized.status_code).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe("agentmemory");
    expect(initialized.body.result.protocolVersion).toBe("2025-11-25");

    const current = await handler(
      req(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } },
        "chatgpt-secret",
      ),
    );
    expect(current.body.result.protocolVersion).toBe("2026-07-28");

    const unknown = await handler(
      req(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
        "chatgpt-secret",
      ),
    );
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");

    const discovered = await handler(
      req({ jsonrpc: "2.0", id: 2, method: "server/discover" }, "chatgpt-secret"),
    );
    expect(discovered.status_code).toBe(200);
    expect(discovered.body.result.supportedVersions).toContain("2026-07-28");
    expect(discovered.body.result.capabilities.tools).toEqual({ listChanged: false });

    const listed = await handler(
      req({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "chatgpt-secret"),
    );
    const tools = listed.body.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_recall",
      "memory_file_history",
      "memory_sessions",
      "memory_smart_search",
      "memory_timeline",
      "memory_commit_lookup",
      "memory_graph_query",
      "memory_lesson_recall",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.some((tool) => tool.name === "memory_save")).toBe(false);
  });

  it("dispatches allowed tools through the existing MCP implementation", async () => {
    const sdk = mockSdk();
    const kv = mockKv();
    kv.sessions.push({ id: "session-1", startedAt: "2026-03-01T00:00:00Z" });
    registerMcpEndpoints(sdk as never, kv as never, undefined, "chatgpt-secret");
    const handler = sdk.getFunction("mcp::remote")!;

    const result = await handler(
      req(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "memory_sessions", arguments: { limit: 1 } },
        },
        "chatgpt-secret",
      ),
    );

    expect(result.status_code).toBe(200);
    expect(result.body.result.isError).toBeUndefined();
    const payload = JSON.parse(result.body.result.content[0].text);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.total).toBe(1);
  });

  it("rejects write tools before dispatching to the internal MCP surface", async () => {
    const sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKv() as never, undefined, "chatgpt-secret");
    const handler = sdk.getFunction("mcp::remote")!;

    const result = await handler(
      req(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "memory_save", arguments: { content: "nope" } },
        },
        "chatgpt-secret",
      ),
    );

    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.content[0].text).toContain("not exposed");
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("bounds memory_sessions at the requested limit and returns newest sessions first", async () => {
    const sdk = mockSdk();
    const kv = mockKv();
    kv.sessions.push(
      { id: "old", startedAt: "2026-01-01T00:00:00Z" },
      { id: "new", startedAt: "2026-03-01T00:00:00Z" },
      { id: "middle", startedAt: "2026-02-01T00:00:00Z" },
    );
    registerMcpEndpoints(sdk as never, kv as never);

    const handler = sdk.getFunction("mcp::tools::call")!;
    const result = await handler(req({ name: "memory_sessions", arguments: { limit: 2 } }));
    const payload = JSON.parse(result.body.content[0].text);

    expect(payload.sessions.map((session: { id: string }) => session.id)).toEqual([
      "new",
      "middle",
    ]);
  });
});
