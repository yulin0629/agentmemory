import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";

const ENV_KEYS = [
  "AGENTMEMORY_SELECTIVE_CONTEXT",
  "AGENTMEMORY_CONTEXT_NAMESPACE",
  "TYPESAFE_API_KEY",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

function setup(secret = "test-secret") {
  const handlers = new Map<string, (request: Record<string, unknown>) => Promise<unknown>>();
  const trigger = vi.fn(async (input: { function_id: string; payload: unknown }) => {
    if (input.function_id === "mem::context-knowledge-put") {
      return { success: true, action: "saved", revision: 1 };
    }
    return { status: "empty", spans: [], catalogRevision: 1 };
  });
  const sdk = {
    registerFunction: (id: string, handler: (request: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger,
  };
  const kv = { get: vi.fn(), set: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() };
  registerApiTriggers(sdk as never, kv as never, secret);
  return { handlers, trigger };
}

function knowledgeBody() {
  return {
    expectedRevision: 0,
    confirmedByUser: true,
    knowledge: {
      id: "knowledge-ascii", revision: "rev-1", status: "active",
      scope: { namespace: "personal", project: "agentmemory" },
      evidence: {
        eventId: "evt-1",
        text: "Use ASCII diagrams in TUI.",
        adoptedAt: "2026-09-18T12:00:00.000Z",
      },
      spans: [{ id: "span-1", text: "Use ASCII diagrams in TUI." }],
    },
  };
}

describe("selective context REST endpoints", () => {
  beforeEach(() => {
    process.env.AGENTMEMORY_SELECTIVE_CONTEXT = "true";
    process.env.AGENTMEMORY_CONTEXT_NAMESPACE = "personal";
    process.env.TYPESAFE_API_KEY = "test-key";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("requires a configured server secret before knowledge can be written", async () => {
    const { handlers, trigger } = setup("");
    const result = await handlers.get("api::context-knowledge-put")!({ body: knowledgeBody() }) as {
      status_code: number; body: { error: string };
    };
    expect(result).toMatchObject({ status_code: 503, body: { error: "selective context requires AGENTMEMORY_SECRET" } });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("authenticates, validates the body, and forwards only parsed knowledge", async () => {
    const { handlers, trigger } = setup();
    const handler = handlers.get("api::context-knowledge-put")!;
    expect(await handler({ headers: { authorization: "Bearer wrong" }, body: knowledgeBody() })).toMatchObject({
      status_code: 401,
    });
    const invalid = knowledgeBody();
    (invalid as Record<string, unknown>).extra = "not allowed";
    expect(await handler({ headers: { authorization: "Bearer test-secret" }, body: invalid })).toMatchObject({
      status_code: 400,
    });
    expect(await handler({ headers: { authorization: "Bearer test-secret" }, body: knowledgeBody() })).toMatchObject({
      status_code: 201, body: { action: "saved", revision: 1 },
    });
    expect(trigger).toHaveBeenLastCalledWith({
      function_id: "mem::context-knowledge-put",
      payload: knowledgeBody(),
    });
  });

  it("does not expose recall while the feature configuration is incomplete", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const { handlers, trigger } = setup();
    const result = await handlers.get("api::selective-context")!({
      headers: { authorization: "Bearer test-secret" },
      body: { prompt: "draw a diagram", project: "agentmemory" },
    }) as { status_code: number; body: { error: string } };
    expect(result.status_code).toBe(503);
    expect(result.body.error).toBe("Selective context is not configured");
    expect(trigger).not.toHaveBeenCalled();
  });
});
