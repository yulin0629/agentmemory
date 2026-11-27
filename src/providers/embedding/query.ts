import type { EmbeddingProvider } from "../../types.js";

// Every place that embeds a search query goes through here: a model that
// reads queries and stored records differently gets the query form, and a
// call to embed() instead would rank by the wrong vector without any error.
export function embedQuery(provider: EmbeddingProvider, text: string): Promise<Float32Array> {
  return provider.embedQuery ? provider.embedQuery(text) : provider.embed(text);
}
