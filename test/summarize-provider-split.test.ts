import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FallbackConfig } from "../src/types.js";

// #899: AGENTMEMORY_SUMMARIZE_PROVIDER routes summarize() to its own
// provider/model while compress() stays on the primary.

const calls: string[] = [];
let anthropicInstances = 0;

vi.mock("../src/providers/openai.js", () => ({
  OpenAIProvider: class {
    name = "openai";
    constructor(_key: string, private model: string) {}
    async compress() { calls.push(`compress:openai:${this.model}`); return ""; }
    async summarize() { calls.push(`summarize:openai:${this.model}`); return ""; }
  },
}));

vi.mock("../src/providers/anthropic.js", () => ({
  AnthropicProvider: class {
    name = "anthropic";
    constructor(_key: string, private model: string) { anthropicInstances++; }
    async compress() { calls.push(`compress:anthropic:${this.model}`); return ""; }
    async summarize() { calls.push(`summarize:anthropic:${this.model}`); return ""; }
  },
}));

const ENV_KEYS = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "AGENTMEMORY_SUMMARIZE_PROVIDER", "AGENTMEMORY_SUMMARIZE_MODEL", "ANTHROPIC_MODEL",
];
const saved: Record<string, string | undefined> = {};

describe("summarize provider split (#899)", () => {
  beforeEach(() => {
    calls.length = 0;
    anthropicInstances = 0;
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  async function build(fallback: FallbackConfig["providers"] = []) {
    const { createProvider, createFallbackProvider } = await import("../src/providers/index.js");
    const primary = { provider: "openai" as const, model: "glm-5.3-flash", maxTokens: 100 };
    return fallback.length
      ? createFallbackProvider(primary, { providers: fallback })
      : createProvider(primary);
  }

  it("routes summarize() to the configured provider and compress() to the primary", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = "anthropic";
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    const p = await build();
    await p.compress("s", "u");
    await p.summarize("s", "u");
    expect(calls).toEqual([
      "compress:openai:glm-5.3-flash",
      "summarize:anthropic:claude-opus-5",
    ]);
  });

  it("AGENTMEMORY_SUMMARIZE_MODEL overrides the provider default model", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = "openai";
    process.env.AGENTMEMORY_SUMMARIZE_MODEL = "gpt-5.6-sol";
    const p = await build();
    await p.summarize("s", "u");
    expect(calls).toEqual(["summarize:openai:gpt-5.6-sol"]);
  });

  it("is a no-op when unset", async () => {
    const p = await build();
    await p.summarize("s", "u");
    expect(calls).toEqual(["summarize:openai:glm-5.3-flash"]);
  });

  it("ignores unknown provider names instead of falling into agent-sdk", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = "agent-sdk";
    const p = await build();
    await p.summarize("s", "u");
    expect(calls).toEqual(["summarize:openai:glm-5.3-flash"]);
  });

  it("keeps the split on the primary inside a fallback chain, sharing one instance", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = "anthropic";
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    const p = await build(["anthropic"]);
    await p.compress("s", "u");
    await p.summarize("s", "u");
    expect(calls).toEqual([
      "compress:openai:glm-5.3-flash",
      "summarize:anthropic:claude-opus-5",
    ]);
    expect(anthropicInstances).toBe(1);
  });
});
