import type { MemoryProvider } from "../types.js";

// #899: compression is ~87% of LLM calls with loose quality bars, while
// summaries / reflections / consolidation are what actually gets injected
// into future sessions. Route summarize() to a dedicated provider so the
// two lanes can run on different models.
export class SplitProvider implements MemoryProvider {
  readonly name: string;

  constructor(
    private readonly primary: MemoryProvider,
    private readonly summarizer: MemoryProvider,
  ) {
    this.name = `${primary.name}+${summarizer.name}`;
    this.describeImage = primary.describeImage?.bind(primary);
  }

  readonly describeImage?: MemoryProvider["describeImage"];

  compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.primary.compress(systemPrompt, userPrompt);
  }

  summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.summarizer.summarize(systemPrompt, userPrompt);
  }
}
