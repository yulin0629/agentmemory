import type {
  MemoryProvider,
  ProviderConfig,
  FallbackConfig,
} from "../types.js";
import { AgentSDKProvider } from "./agent-sdk.js";
import { AnthropicProvider } from "./anthropic.js";
import { MinimaxProvider } from "./minimax.js";
import { NoopProvider } from "./noop.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { ResilientProvider } from "./resilient.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { SplitProvider } from "./split.js";
import { getEnvVar } from "../config.js";

export { createEmbeddingProvider, createImageEmbeddingProvider } from "./embedding/index.js";

function requireEnvVar(key: string): string {
  const value = getEnvVar(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. Set it in ~/.agentmemory/.env or as an environment variable.`,
    );
  }
  return value;
}

// #778: fallback providers used to inherit the primary provider's
// model name (e.g. fallback Gemini was called with `gpt-4o-mini`),
// 404'd every call, and tripped the circuit breaker — making
// FALLBACK_PROVIDERS actively worse than no fallback. Each provider
// must resolve its OWN env-driven default model. Mirrors the resolution
// in detectProvider() so primary + fallback agree on what each
// provider's default model is.
function defaultModelFor(providerType: ProviderConfig["provider"]): string {
  switch (providerType) {
    case "openai":
      return getEnvVar("OPENAI_MODEL") || "gpt-5.6-luna";
    case "anthropic":
      return getEnvVar("ANTHROPIC_MODEL") || "claude-sonnet-5";
    case "gemini":
      return getEnvVar("GEMINI_MODEL") || "gemini-3.7-flash";
    case "openrouter":
      return getEnvVar("OPENROUTER_MODEL") || "anthropic/claude-sonnet-5";
    case "minimax":
      return getEnvVar("MINIMAX_MODEL") || "MiniMax-M3";
    case "agent-sdk":
      return "claude-sonnet-5";
    case "noop":
    default:
      return "noop";
  }
}

// Provider-side base URL for providers that don't read their own env
// (AnthropicProvider takes it as a ctor arg only). Without this, a
// fallback / summarize Anthropic provider bypasses ANTHROPIC_BASE_URL.
function baseUrlFor(providerType: ProviderConfig["provider"]): string | undefined {
  return providerType === "anthropic" ? getEnvVar("ANTHROPIC_BASE_URL") : undefined;
}

const SUMMARIZE_PROVIDER_TYPES = new Set<ProviderConfig["provider"]>([
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "minimax",
]);

// #899: AGENTMEMORY_SUMMARIZE_PROVIDER (+ optional AGENTMEMORY_SUMMARIZE_MODEL)
// routes summarize() to its own provider; compress() stays on the primary.
function withSummarizeProvider(
  primary: MemoryProvider,
  config: ProviderConfig,
): MemoryProvider {
  const raw = getEnvVar("AGENTMEMORY_SUMMARIZE_PROVIDER");
  if (!raw) return primary;
  const type = raw.toLowerCase() as ProviderConfig["provider"];
  if (!SUMMARIZE_PROVIDER_TYPES.has(type)) {
    process.stderr.write(
      `[agentmemory] Ignoring AGENTMEMORY_SUMMARIZE_PROVIDER='${raw}': ` +
        `expected one of ${[...SUMMARIZE_PROVIDER_TYPES].join(", ")}.\n`,
    );
    return primary;
  }
  const model = getEnvVar("AGENTMEMORY_SUMMARIZE_MODEL") || defaultModelFor(type);
  if (type === config.provider && model === config.model) return primary;
  return new SplitProvider(
    primary,
    createBaseProvider({
      provider: type,
      model,
      maxTokens: config.maxTokens,
      baseURL: baseUrlFor(type),
    }),
  );
}

export function createProvider(config: ProviderConfig): ResilientProvider {
  return new ResilientProvider(
    withSummarizeProvider(createBaseProvider(config), config),
  );
}

export function createFallbackProvider(
  config: ProviderConfig,
  fallbackConfig: FallbackConfig,
): ResilientProvider {
  if (fallbackConfig.providers.length === 0) {
    return createProvider(config);
  }

  const providers: MemoryProvider[] = [
    withSummarizeProvider(createBaseProvider(config), config),
  ];
  for (const providerType of fallbackConfig.providers) {
    if (providerType === config.provider) continue;
    try {
      // #778: resolve the fallback's OWN default model (or its env
      // override) rather than copying config.model from the primary.
      // Without this, FALLBACK_PROVIDERS=gemini on an OpenAI primary
      // would call Gemini with `gpt-4o-mini`, get a 404 every time,
      // and trip the circuit breaker.
      const fbConfig: ProviderConfig = {
        provider: providerType,
        model: defaultModelFor(providerType),
        maxTokens: config.maxTokens,
        baseURL: baseUrlFor(providerType),
      };
      providers.push(createBaseProvider(fbConfig));
    } catch {
      // skip unavailable fallback providers
    }
  }

  if (providers.length > 1) {
    return new ResilientProvider(new FallbackChainProvider(providers));
  }
  return new ResilientProvider(providers[0]);
}

function createBaseProvider(config: ProviderConfig): MemoryProvider {
  switch (config.provider) {
    case "minimax":
      return new MinimaxProvider(
        requireEnvVar("MINIMAX_API_KEY"),
        config.model,
        config.maxTokens,
      );
    case "anthropic":
      return new AnthropicProvider(
        requireEnvVar("ANTHROPIC_API_KEY"),
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    case "gemini": {
      const geminiKey =
        getEnvVar("GEMINI_API_KEY") || getEnvVar("GOOGLE_API_KEY");
      if (!geminiKey) {
        throw new Error(
          "GEMINI_API_KEY (or GOOGLE_API_KEY) is required for the gemini provider",
        );
      }
      return new OpenRouterProvider(
        geminiKey,
        config.model,
        config.maxTokens,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    }
    case "openrouter":
      return new OpenRouterProvider(
        requireEnvVar("OPENROUTER_API_KEY"),
        config.model,
        config.maxTokens,
        "https://openrouter.ai/api/v1/chat/completions",
      );
    case "openai": {
      const openaiKey = getEnvVar("OPENAI_API_KEY");
      if (!openaiKey) {
        throw new Error(
          "OPENAI_API_KEY is required for the openai provider",
        );
      }
      return new OpenAIProvider(
        openaiKey,
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    }
    case "noop":
      return new NoopProvider();
    case "agent-sdk":
    default:
      return new AgentSDKProvider();
  }
}
