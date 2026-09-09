import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import type { ResilientProvider } from "./resilient.js";

// #899: compression is ~87% of LLM calls with loose quality bars, while
// summaries / reflections / consolidation are what actually gets injected
// into future sessions. Route summarize() to a dedicated provider so the
// two lanes can run on different models.
export class SplitProvider implements MemoryProvider {
  readonly name: string;

  constructor(
    private readonly primary: ResilientProvider,
    private readonly summarizer: ResilientProvider,
  ) {
    this.name = `${primary.name}+${summarizer.name}`;
  }

  compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.primary.compress(systemPrompt, userPrompt);
  }

  summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.summarizer.summarize(systemPrompt, userPrompt);
  }

  // Worst lane wins so /health and the CLI keep reading a single state.
  get circuitState(): CircuitBreakerState {
    const [a, b] = [this.primary.circuitState, this.summarizer.circuitState];
    const rank = { closed: 0, "half-open": 1, open: 2 } as const;
    return rank[a.state] >= rank[b.state] ? a : b;
  }
}
