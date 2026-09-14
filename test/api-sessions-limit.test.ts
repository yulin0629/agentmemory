import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

function setup() {
  const handlers = new Map<string, (data: any) => Promise<any>>();
  const sessions = [
    { id: "old", startedAt: "2026-01-01T00:00:00Z" },
    { id: "new", startedAt: "2026-03-01T00:00:00Z" },
    { id: "middle", startedAt: "2026-02-01T00:00:00Z" },
  ];
  const sdk = {
    registerFunction: (id: string, handler: (data: any) => Promise<any>) => {
      handlers.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: vi.fn(async () => ({})),
  };
  const kv = {
    list: vi.fn(async (scope: string) => (scope === KV.sessions ? sessions : [])),
    get: vi.fn(async () => null),
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  registerApiTriggers(sdk as never, kv as never);
  return { handlers, kv };
}

describe("GET /agentmemory/sessions limit", () => {
  it("limits before summary fan-out and orders limited results newest first", async () => {
    const { handlers, kv } = setup();
    const result = await handlers.get("api::sessions")!({
      headers: {},
      query_params: { limit: "2" },
    });

    expect(result.status_code).toBe(200);
    expect(result.body.sessions.map((session: { id: string }) => session.id)).toEqual([
      "new",
      "middle",
    ]);
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing unbounded behavior when limit is omitted", async () => {
    const { handlers, kv } = setup();
    const result = await handlers.get("api::sessions")!({
      headers: {},
      query_params: {},
    });

    expect(result.status_code).toBe(200);
    expect(result.body.sessions).toHaveLength(3);
    expect(kv.get).toHaveBeenCalledTimes(3);
  });
});
