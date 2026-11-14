import { describe, expect, it } from "vitest";
import { serverAuthDisabled } from "../src/secret-store.js";

describe("AGENTMEMORY_AUTH=none", () => {
  it("turns the generated API secret off only when asked to", () => {
    expect(serverAuthDisabled("none", {})).toBe(true);
    expect(serverAuthDisabled(" None ", {})).toBe(true);
    expect(serverAuthDisabled(undefined, {})).toBe(false);
    expect(serverAuthDisabled("off", {})).toBe(false);
  });

  it("never overrides an explicitly configured secret", () => {
    expect(serverAuthDisabled("none", { AGENTMEMORY_SECRET: "configured-secret" })).toBe(false);
  });
});
