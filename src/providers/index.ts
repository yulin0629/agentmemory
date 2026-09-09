import type {
  MemoryProvider,
  ProviderConfig,
  FallbackConfig,
  CircuitBreakerState,
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
import { getEnvVar, loadSummarizeConfig } from "../config.js";

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

// #899: resolve the summarize-lane config, or undefined when unset / same as primary.
function summarizeProviderConfig(primary: ProviderConfig): ProviderConfig | undefined {
  const lane = loadSummarizeConfig();
  if (!lane) return undefined;
  const model = lane.model || defaultModelFor(lane.provider);
  if (lane.provider === primary.provider && model === primary.model) return undefined;
  return {
    provider: lane.provider,
    model,
    maxTokens: primary.maxTokens,
    // Same provider, different model: keep an explicitly passed base URL.
    baseURL: lane.provider === primary.provider ? primary.baseURL : undefined,
  };
}

export type LlmProvider = MemoryProvider & { readonly circuitState: CircuitBreakerState };

function chain(providers: MemoryProvider[]): MemoryProvider {
  return providers.length > 1 ? new FallbackChainProvider(providers) : providers[0];
}

export function createProvider(config: ProviderConfig): LlmProvider {
  return createFallbackProvider(config, { providers: [] });
}

export function createFallbackProvider(
  config: ProviderConfig,
  fallbackConfig: FallbackConfig,
): LlmProvider {
  const base = createBaseProvider(config);
  const fallbacks: { config: ProviderConfig; provider: MemoryProvider }[] = [];
  for (const entry of fallbackConfig.providers) {
    const providerType = typeof entry === "string" ? entry : entry.provider;
    // #778: resolve the fallback's OWN default model (or its env
    // override) rather than copying config.model from the primary.
    // Without this, FALLBACK_PROVIDERS=gemini on an OpenAI primary
    // would call Gemini with `gpt-4o-mini`, get a 404 every time,
    // and trip the circuit breaker.
    const model = typeof entry === "string" ? defaultModelFor(providerType) : entry.model;
    // The primary's own provider only helps as a fallback with another model.
    if (providerType === config.provider && model === config.model) continue;
    try {
      const fbConfig: ProviderConfig = {
        provider: providerType,
        model,
        maxTokens: config.maxTokens,
        // Same provider, different model: keep an explicitly passed base URL.
        baseURL: providerType === config.provider ? config.baseURL : undefined,
      };
      fallbacks.push({ config: fbConfig, provider: createBaseProvider(fbConfig) });
    } catch {
      // skip unavailable fallback providers
    }
  }
  const fallbackProviders = fallbacks.map((f) => f.provider);

  const summarizeConfig = summarizeProviderConfig(config);
  if (!summarizeConfig) {
    return new ResilientProvider(chain([base, ...fallbackProviders]));
  }
  // Each lane gets its own chain and its own circuit breaker: a failing
  // summarize endpoint must not open the breaker for compress, and the
  // summarize chain must not retry the summarizer itself as a fallback.
  const summarizer =
    fallbacks.find(
      (f) =>
        f.config.provider === summarizeConfig.provider &&
        f.config.model === summarizeConfig.model,
    )?.provider ?? createBaseProvider(summarizeConfig);
  return new SplitProvider(
    new ResilientProvider(chain([base, ...fallbackProviders])),
    new ResilientProvider(
      chain([summarizer, ...fallbackProviders.filter((f) => f !== summarizer)]),
    ),
  );
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
