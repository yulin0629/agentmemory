import { logger } from "../logger.js";
import { createDecisionsCaptureJudge, createJevCaptureJudge, type CaptureJudge } from "./explicit-memory.js";
import { createDecisionsContextJudge, createJevContextJudge, type ContextJudge } from "./selective-context.js";
import type { DecisionsClient } from "./decisions-api.js";

export interface JudgeProviderConfig {
  apiKey?: string;
  model: string;
  decisionsApiKey?: string;
  decisionsBaseUrl: string;
  decisionsModel: string;
  judgeOrder: string[];
}

interface Provider<J> { name: string; judge: J }

function providers<J>(
  config: JudgeProviderConfig,
  build: { typesafe: (apiKey: string, model: string) => J; decisions: (client: DecisionsClient) => J },
): Provider<J>[] {
  const result: Provider<J>[] = [];
  for (const name of new Set(config.judgeOrder)) {
    if (name === "typesafe" && config.apiKey) {
      result.push({ name, judge: build.typesafe(config.apiKey, config.model) });
    } else if (name === "decisions" && config.decisionsApiKey) {
      result.push({ name, judge: build.decisions({
        apiKey: config.decisionsApiKey, model: config.decisionsModel, baseUrl: config.decisionsBaseUrl,
      }) });
    } else if (name !== "typesafe" && name !== "decisions") {
      logger.warn("judge failover: unknown provider in AGENTMEMORY_JUDGE_ORDER", { provider: name });
    }
  }
  if (!result.length) throw new Error("No judge provider has an API key in AGENTMEMORY_JUDGE_ORDER");
  return result;
}

/**
 * Tries each provider in order and rethrows the last error when all fail.
 * One provider is returned unwrapped so its behavior stays exactly as before.
 * An aborted signal (caller deadline) stops the chain: later providers would
 * be aborted immediately anyway.
 */
function failover<A extends unknown[], R>(
  kind: string,
  list: Provider<(...args: A) => Promise<R>>[],
  signalOf: (args: A) => AbortSignal,
): (...args: A) => Promise<R> {
  if (list.length === 1) return list[0]!.judge;
  return async (...args: A) => {
    let lastError: unknown;
    for (const [index, provider] of list.entries()) {
      try {
        const result = await provider.judge(...args);
        if (index > 0) logger.info(`${kind} judge answered by fallback provider`, { provider: provider.name });
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`${kind} judge provider failed`, {
          provider: provider.name, error: err instanceof Error ? err.message : String(err),
        });
        if (signalOf(args).aborted) break;
      }
    }
    throw lastError;
  };
}

export function createFailoverContextJudge(config: JudgeProviderConfig, requestFetch: typeof fetch = fetch): ContextJudge {
  return failover("context", providers<ContextJudge>(config, {
    typesafe: (apiKey, model) => createJevContextJudge(apiKey, model, requestFetch),
    decisions: client => createDecisionsContextJudge({ ...client, fetch: requestFetch }),
  }), args => args[2]);
}

export function createFailoverCaptureJudge(config: JudgeProviderConfig, requestFetch: typeof fetch = fetch): CaptureJudge {
  return failover("capture", providers<CaptureJudge>(config, {
    typesafe: (apiKey, model) => createJevCaptureJudge(apiKey, model, requestFetch),
    decisions: client => createDecisionsCaptureJudge({ ...client, fetch: requestFetch }),
  }), args => args[2]);
}
