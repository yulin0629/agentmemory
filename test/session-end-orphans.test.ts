import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { KV } from "../src/state/schema.js";

function setup() {
  const handlers = new Map<string, (data: any) => Promise<any>>();
  const sdk = {
    registerFunction: (id: string, handler: any) => handlers.set(id, handler),
    registerTrigger: vi.fn(),
    trigger: vi.fn(async () => ({})),
  };
  const kv = { get: vi.fn(), update: vi.fn(), list: vi.fn(async () => []), set: vi.fn(), delete: vi.fn() };
  registerApiTriggers(sdk as never, kv as never, "");
  registerEventTriggers(sdk as never, kv as never);
  registerRememberFunction(sdk as never, kv as never);
  return { handlers, kv };
}

for (const name of ["api::session::end", "event::session::ended"]) {
  describe(name, () => {
    const payload = name.startsWith("api") ? { body: { sessionId: "s" } } : { sessionId: "s" };
    it("skips absent sessions", async () => {
      const { handlers, kv } = setup();
      kv.get.mockResolvedValue(null);
      const result = await handlers.get(name)!(payload);
      expect(kv.update).not.toHaveBeenCalled();
      expect(name.startsWith("api") ? result.status_code : result.skipped).toBe(name.startsWith("api") ? 404 : "session-absent");
    });
    it("propagates storage failures instead of reporting absence", async () => {
      const { handlers, kv } = setup();
      kv.get.mockRejectedValue(new Error("store unavailable"));
      await expect(handlers.get(name)!(payload)).rejects.toThrow("store unavailable");
      expect(kv.update).not.toHaveBeenCalled();
    });
    it("serializes the session update with concurrent deletion", async () => {
      const { handlers, kv } = setup();
      let finish!: () => void;
      kv.get.mockResolvedValue({ id: "s" });
      kv.update.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
      const ending = handlers.get(name)!(payload);
      await vi.waitFor(() => expect(kv.update).toHaveBeenCalled());
      const forgetting = handlers.get("mem::forget")!({ sessionId: "s" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(kv.delete.mock.calls.some(([scope]) => scope === KV.sessions)).toBe(false);
      finish();
      await Promise.all([ending, forgetting]);
      expect(kv.delete).toHaveBeenCalledWith(KV.sessions, "s");
    });
  });
}
