import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { fetchWithTimeout } from "../_fetch.js";

const BATCH_LIMIT = 100;
const MAX_RETRIES = 4;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 8000;
const MODEL = "models/gemini-embedding-001";
const API_BASE = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:batchEmbedContents`;

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions = 768;
  private apiKey: string;
  private fallbackKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("GEMINI_API_KEY") || "";
    this.fallbackKey = getEnvVar("GEMINI_API_KEY_FALLBACK") || "";
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is required");
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  private async postChunk(chunk: string[], key: string): Promise<Response> {
    return fetchWithTimeout(`${API_BASE}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: chunk.map((t) => ({
          model: MODEL,
          content: { parts: [{ text: t }] },
          outputDimensionality: this.dimensions,
        })),
      }),
    });
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      const chunk = texts.slice(i, i + BATCH_LIMIT);
      let lastError = "";
      let data: { embeddings: Array<{ values: number[] }> } | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const useFallback = attempt === MAX_RETRIES && this.fallbackKey !== "";
        const key = useFallback ? this.fallbackKey : this.apiKey;
        const response = await this.postChunk(chunk, key);

        if (response.ok) {
          data = (await response.json()) as {
            embeddings: Array<{ values: number[] }>;
          };
          if (useFallback) {
            logger.warn(
              "[agentmemory] gemini embed: primary key exhausted, served by fallback key",
            );
          }
          break;
        }

        lastError = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          throw new Error(
            `Gemini embedding failed (${response.status}): ${lastError}`,
          );
        }
        // Exponential backoff with jitter, capped: 1s, 2s, 4s, 8s (+/-25%).
        const delay = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
        await new Promise((r) => setTimeout(r, delay * (0.75 + Math.random() * 0.5)));
      }

      if (!data) {
        throw new Error(`Gemini embedding failed after retries: ${lastError}`);
      }

      for (const emb of data.embeddings) {
        results.push(l2Normalize(new Float32Array(emb.values)));
      }
    }

    return results;
  }
}

let zeroNormWarned = false;

function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    if (!zeroNormWarned) {
      zeroNormWarned = true;
      process.stderr.write(
        `[agentmemory] warn: gemini-embedding-001 returned a zero-norm ` +
          `embedding (length=${vec.length}); leaving it un-normalized. ` +
          `Subsequent zero-norm vectors will not be reported.\n`,
      );
    }
    return vec;
  }
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}
