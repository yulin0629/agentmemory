import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FallbackConfig } from "../src/types.js";

// #899: AGENTMEMORY_SUMMARIZE_PROVIDER routes summarize() to its own
// provider/model while compress() stays on the primary. Each lane has its
// own fallback chain and circuit breaker.

const calls: string[] = [];
const failing = new Set<string>(); // "provider:model" entries that throw
let anthropicInstances = 0;
let openaiCtorArgs: unknown[][] = [];

function stub(provider: string, model: string, op: string) {
  calls.push(`${op}:${provider}:${model}`);
  if (failing.has(`${provider}:${model}`)) throw new Error(`${provider} down`);
  return "";
}

vi.mock("../src/providers/openai.js", () => ({
  OpenAIProvider: class {
    name = "openai";
    constructor(...args: unknown[]) { openaiCtorArgs.push(args); this.model = args[1] as string; }
    private model: string;
    async compress() { return stub("openai", this.model, "compress"); }
    async summarize() { return stub("openai", this.model, "summarize"); }
  },
}));

vi.mock("../src/providers/anthropic.js", () => ({
  AnthropicProvider: class {
    name = "anthropic";
    constructor(_key: string, private model: string) { anthropicInstances++; }
    async compress() { return stub("anthropic", this.model, "compress"); }
    async summarize() { return stub("anthropic", this.model, "summarize"); }
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
    failing.clear();
    anthropicInstances = 0;
    openaiCtorArgs = [];
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

  async function build(fallback: FallbackConfig["providers"] = [], baseURL?: string) {
    const { createFallbackProvider } = await import("../src/providers/index.js");
    const primary = { provider: "openai" as const, model: "glm-5.3-flash", maxTokens: 100, baseURL };
    return createFallbackProvider(primary, { providers: fallback });
  }

  function useAnthropicSummaries() {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = "anthropic";
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
  }

  it("routes summarize() to the configured provider and compress() to the primary", async () => {
    useAnthropicSummaries();
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

  it("inherits an explicit baseURL when only the model differs", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = "openai";
    process.env.AGENTMEMORY_SUMMARIZE_MODEL = "gpt-5.6-sol";
    await build([], "http://explicit.local");
    expect(openaiCtorArgs.map((a) => [a[1], a[3]])).toEqual([
      ["glm-5.3-flash", "http://explicit.local"],
      ["gpt-5.6-sol", "http://explicit.local"],
    ]);
  });

  it("is a no-op when unset, and still exposes circuitState", async () => {
    const p = await build();
    await p.summarize("s", "u");
    expect(calls).toEqual(["summarize:openai:glm-5.3-flash"]);
    expect(p.circuitState.state).toBe("closed");
  });

  it("accepts mixed case and surrounding whitespace", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = " Anthropic ";
    process.env.AGENTMEMORY_SUMMARIZE_MODEL = "  ";
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    const p = await build();
    await p.summarize("s", "u");
    expect(calls).toEqual(["summarize:anthropic:claude-opus-5"]);
  });

  it.each(["agent-sdk", "nonsense"])("ignores %s and stays on the primary", async (name) => {
    process.env.AGENTMEMORY_SUMMARIZE_PROVIDER = name;
    const p = await build();
    await p.summarize("s", "u");
    expect(calls).toEqual(["summarize:openai:glm-5.3-flash"]);
  });

  it("shares the fallback instance and does not retry the summarizer as its own fallback", async () => {
    useAnthropicSummaries();
    failing.add("anthropic:claude-opus-5");
    const p = await build(["anthropic"]);
    await expect(p.summarize("s", "u")).rejects.toThrow("anthropic down");
    expect(calls).toEqual(["summarize:anthropic:claude-opus-5"]);
    expect(anthropicInstances).toBe(1);
  });

  it("compress still falls back to the shared anthropic instance", async () => {
    useAnthropicSummaries();
    failing.add("openai:glm-5.3-flash");
    const p = await build(["anthropic"]);
    await p.compress("s", "u");
    expect(calls).toEqual([
      "compress:openai:glm-5.3-flash",
      "compress:anthropic:claude-opus-5",
    ]);
  });

  it("keeps compress open when the summarize breaker trips", async () => {
    useAnthropicSummaries();
    failing.add("anthropic:claude-opus-5");
    const p = await build(["anthropic"]);
    for (let i = 0; i < 3; i++) {
      await expect(p.summarize("s", "u")).rejects.toThrow("anthropic down");
    }
    await expect(p.summarize("s", "u")).rejects.toThrow("circuit_breaker_open");
    expect(p.circuitState.state).toBe("open");
    calls.length = 0;
    await p.compress("s", "u");
    expect(calls).toEqual(["compress:openai:glm-5.3-flash"]);
  });
});
