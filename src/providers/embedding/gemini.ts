import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { fetchWithTimeout } from "../_fetch.js";
import { createGeminiKeyPool, isGeminiKeyFailure, type GeminiKeyPool } from "./gemini-key-pool.js";

const BATCH_LIMIT = 100;
const MAX_RETRIES = 4;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 8000;
const DEFAULT_MODEL = "gemini-embedding-001";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
// gemini-embedding-2 has no task type field: the text itself says whether it
// is a stored record or a search query. gemini-embedding-001 gets the text
// as it is, which is how every index written before the model could be chosen
// was embedded.
const DOCUMENT_PREFIX = "title: none | text: ";
const QUERY_PREFIX = "task: search result | query: ";

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions = 768;
  readonly vectorSpace?: string;
  private apiKey: string;
  private fallbackKey: string;
  private keyPool?: GeminiKeyPool;
  private model: string;
  private prefixed: boolean;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("GEMINI_API_KEY") || "";
    this.fallbackKey = getEnvVar("GEMINI_API_KEY_FALLBACK") || "";
    const keyFile = (getEnvVar("GEMINI_API_KEY_FILE") || "").trim();
    if (keyFile) {
      this.keyPool = createGeminiKeyPool(keyFile, getEnvVar("GEMINI_API_KEY_PREFER") || "", this.apiKey);
      const order = this.keyPool.order().map(({ label }) => label);  // throws when there is no key at all
      if (order.length === 1 && order[0] === "GEMINI_API_KEY") {
        logger.warn("[agentmemory] gemini embed: GEMINI_API_KEY_FILE gave no usable key; only GEMINI_API_KEY answers", { file: keyFile });
      } else {
        logger.info("[agentmemory] gemini embed: key pool", { order });
      }
    } else if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is required");
    }
    const model = (getEnvVar("GEMINI_EMBEDDING_MODEL") || "").trim().replace(/^models\//, "") || DEFAULT_MODEL;
    this.model = `models/${model}`;
    this.prefixed = model.startsWith("gemini-embedding-2");
    if (model !== DEFAULT_MODEL) this.vectorSpace = model;
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.request([this.prefixed ? QUERY_PREFIX + text : text]);
    return result;
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.request(this.prefixed ? texts.map((t) => DOCUMENT_PREFIX + t) : texts);
  }

  private async postChunk(chunk: string[], key: string): Promise<Response> {
    return fetchWithTimeout(`${API_ROOT}/${this.model}:batchEmbedContents?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: chunk.map((t) => ({
          model: this.model,
          content: { parts: [{ text: t }] },
          outputDimensionality: this.dimensions,
        })),
      }),
    });
  }

  /** One attempt over the key pool: a key that is refused or over its quota is skipped for a while and the next key gets the same chunk. */
  private async postWithPool(chunk: string[], pool: GeminiKeyPool): Promise<Response> {
    const keys = pool.order();
    let response!: Response;
    for (const [index, { label, key }] of keys.entries()) {
      response = await this.postChunk(chunk, key);
      if (response.ok || index === keys.length - 1) break;
      if (!isGeminiKeyFailure(response.status, await response.clone().text())) break;
      pool.cool(key);
      logger.warn("[agentmemory] gemini embed: key refused or over its quota; trying the next key", { label, status: response.status });
    }
    return response;
  }

  private async request(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      const chunk = texts.slice(i, i + BATCH_LIMIT);
      let lastError = "";
      let data: { embeddings: Array<{ values: number[] }> } | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const useFallback = !this.keyPool && attempt === MAX_RETRIES && this.fallbackKey !== "";
        const response = this.keyPool
          ? await this.postWithPool(chunk, this.keyPool)
          : await this.postChunk(chunk, useFallback ? this.fallbackKey : this.apiKey);

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
        `[agentmemory] warn: the Gemini embedding model returned a zero-norm ` +
          `embedding (length=${vec.length}); leaving it un-normalized. ` +
          `Subsequent zero-norm vectors will not be reported.\n`,
      );
    }
    return vec;
  }
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}
