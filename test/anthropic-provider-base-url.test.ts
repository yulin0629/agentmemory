import { describe, it, expect, afterEach } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

// ANTHROPIC_BASE_URL must apply to every AnthropicProvider (primary,
// fallback, summarize lane), not only the one built from detectProvider().
describe("AnthropicProvider base URL", () => {
  const saved = process.env.ANTHROPIC_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  });

  it("reads ANTHROPIC_BASE_URL when no baseURL is passed", () => {
    process.env.ANTHROPIC_BASE_URL = "http://proxy.local";
    const p = new AnthropicProvider("sk-test", "claude-opus-5", 100);
    expect((p as unknown as { client: { baseURL: string } }).client.baseURL).toBe("http://proxy.local");
  });

  it("prefers an explicit baseURL over the env", () => {
    process.env.ANTHROPIC_BASE_URL = "http://proxy.local";
    const p = new AnthropicProvider("sk-test", "claude-opus-5", 100, "http://explicit");
    expect((p as unknown as { client: { baseURL: string } }).client.baseURL).toBe("http://explicit");
  });
});
