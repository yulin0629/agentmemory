import { SearchIndex } from "./search-index.js";
import type { SearchLayer } from "./search-layer.js";
import { VectorIndex } from "./vector-index.js";
import type {
  EmbeddingProvider,
  HybridSearchResult,
  CompressedObservation,
  Memory,
  QueryExpansion,
} from "../types.js";
import { memoryToObservation } from "./memory-utils.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import {
  GraphRetrieval,
  type GraphRetrievalResult,
  type GraphQuery,
  type GraphObservationAuthorization,
} from "../functions/graph-retrieval.js";
import { extractEntitiesFromQuery } from "../functions/query-expansion.js";
import { rerank } from "./reranker.js";
import { embedQuery } from "../providers/embedding/query.js";
import { logger } from "../logger.js";

const RRF_K = 60;
const GRAPH_BUDGET_MS = 500;
const MIN_FUSION_POOL = 40;

export interface HybridSearchRequest {
  embedding?: { query: string; value: Promise<Float32Array> };
  candidateCount?: number;
}

// Deliberate memories (mem::remember) share one index with
// hook-captured observations, which outnumber them by orders of
// magnitude, so a saved memory almost never survives into the top
// `limit` of the flat ranking (upstream #819). Reserve a few slots for
// the best memory-only hits whenever the flat ranking surfaced fewer.
const MEMORY_QUOTA = 3;
const isMemoryId = (id: string): boolean => id.startsWith("mem_");

type GraphQueries = { entities: GraphQuery; chunks: GraphQuery };

// Maps one stream's scores onto 0..1 with its best candidate at 1. A stream
// cut off at the pool limit puts its weakest candidate at 0; a stream that
// returned everything it found has no cut-off score and scales from 0, or
// from its weakest candidate when that one is negative.
function unitScale(results: Array<{ score: number }>, cutOff: boolean): (score: number) => number {
  let max = -Infinity;
  let min = Infinity;
  for (const { score } of results) {
    if (score > max) max = score;
    if (score < min) min = score;
  }
  const floor = cutOff ? min : Math.min(0, min);
  return (score) => (max > floor ? (score - floor) / (max - floor) : 1);
}

export class HybridSearch {
  private graphRetrieval: GraphRetrieval;
  private lastGraphTimeoutWarningAt = -Infinity;

  // One request makes two graph queries. The entity search starts before the
  // embedding call and can use up a query's read allowance before the vector
  // hits exist, which would leave chunk expansion nothing to read with.
  private graphQueries(authorize?: GraphObservationAuthorization): GraphQueries {
    return { entities: this.graphRetrieval.createQuery(authorize), chunks: this.graphRetrieval.createQuery(authorize) };
  }

  constructor(
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private embeddingProvider: EmbeddingProvider | null,
    private kv: StateKV,
    private bm25Weight = 0.4,
    private vectorWeight = 0.6,
    private graphWeight = 0.3,
    private rerankEnabled = process.env.RERANK_ENABLED === "true",
  ) {
    this.graphRetrieval = new GraphRetrieval(kv, (id) => this.bm25.layerOf(id), (id) => this.bm25.sessionOf(id));
  }

  async search(query: string, limit = 20, targetLayer: SearchLayer = "all", authorizeGraph?: GraphObservationAuthorization, request?: HybridSearchRequest): Promise<HybridSearchResult[]> {
    return this.tripleStreamSearch(query, limit, targetLayer, this.graphQueries(authorizeGraph), undefined, true, request);
  }

  async searchWithExpansion(
    query: string,
    limit: number,
    expansion: QueryExpansion,
    targetLayer: SearchLayer = "all",
    authorizeGraph?: GraphObservationAuthorization,
  ): Promise<HybridSearchResult[]> {
    const allQueries = [
      query,
      ...expansion.reformulations,
      ...expansion.temporalConcretizations,
    ];

    const allEntities = [
      ...expansion.entityExtractions,
      ...extractEntitiesFromQuery(query),
    ];

    const graph = this.graphQueries(authorizeGraph);
    const retrievalLimit = this.rerankEnabled ? Math.max(limit, 20) : limit;
    const resultSets = await Promise.all(
      allQueries.map((q) => this.tripleStreamSearch(q, retrievalLimit, targetLayer, graph, allEntities, false)),
    );

    const merged = new Map<string, HybridSearchResult>();
    for (const results of resultSets) {
      for (const r of results) {
        const existing = merged.get(r.observation.id);
        if (!existing || r.combinedScore > existing.combinedScore) {
          merged.set(r.observation.id, r);
        }
      }
    }

    const combined = Array.from(merged.values())
      .sort(
        (a, b) =>
          b.combinedScore - a.combinedScore ||
          (a.observation.id < b.observation.id ? -1 : a.observation.id > b.observation.id ? 1 : 0),
      );
    return this.rerankResults(query, combined, limit);
  }

  private async tripleStreamSearch(
    query: string,
    limit: number,
    targetLayer: SearchLayer,
    graph: GraphQueries,
    entityHints?: string[],
    applyReranking = true,
    request?: HybridSearchRequest,
  ): Promise<HybridSearchResult[]> {
    const retrievalLimit = this.rerankEnabled ? Math.max(limit, 20) : limit;
    const poolLimit = Math.max(retrievalLimit * 2, MIN_FUSION_POOL);
    const bm25Results = this.bm25.search(query, poolLimit, targetLayer);

    // The entity search needs only the query, so its storage reads run while
    // the embedding call is in flight instead of after the vector stage.
    const entities =
      entityHints && entityHints.length > 0
        ? entityHints
        : extractEntitiesFromQuery(query);
    const entityHits = this.graphWeight > 0 && entities.length > 0
      ? graph.entities.searchByEntities(entities, 2, retrievalLimit, targetLayer).catch(() => [])
      : undefined;

    let vectorResults: Array<{
      obsId: string;
      sessionId: string;
      score: number;
    }> = [];
    let queryEmbedding: Float32Array | null = null;

    if (this.vector && this.embeddingProvider && this.vector.size > 0) {
      try {
        if (request) {
          if (!request.embedding || request.embedding.query !== query) {
            request.embedding = { query, value: embedQuery(this.embeddingProvider, query) };
          }
          const embedding = request.embedding;
          try {
            queryEmbedding = await embedding.value;
          } catch (error) {
            if (request.embedding === embedding) request.embedding = undefined;
            throw error;
          }
        } else {
          queryEmbedding = await embedQuery(this.embeddingProvider, query);
        }
        vectorResults = this.vector.search(queryEmbedding, poolLimit, targetLayer, (id) => this.bm25.layerOf(id));
      } catch {
        // fall through to BM25-only
      }
    }

    const topVectorObs = vectorResults.slice(0, 5).map((r) => r.obsId);
    const graphResults = this.graphWeight > 0
      ? await this.graphResults(graph, entityHits, topVectorObs, targetLayer)
      : [];

    const scores = new Map<
      string,
      {
        bm25Rank: number;
        vectorRank: number;
        graphRank: number;
        sessionId: string;
        bm25Score: number;
        vectorScore: number;
        graphScore: number;
        graphContext?: string;
      }
    >();

    bm25Results.forEach((r, i) => {
      scores.set(r.obsId, {
        bm25Rank: i + 1,
        vectorRank: Infinity,
        graphRank: Infinity,
        sessionId: r.sessionId,
        bm25Score: r.score,
        vectorScore: 0,
        graphScore: 0,
      });
    });

    vectorResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.vectorRank = i + 1;
        existing.vectorScore = r.score;
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: i + 1,
          graphRank: Infinity,
          sessionId: r.sessionId,
          bm25Score: 0,
          vectorScore: r.score,
          graphScore: 0,
        });
      }
    });

    graphResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.graphRank = Math.min(existing.graphRank, i + 1);
        existing.graphScore = Math.max(existing.graphScore, r.score);
        if (r.graphContext && !existing.graphContext) {
          existing.graphContext = r.graphContext;
        }
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: Infinity,
          graphRank: i + 1,
          sessionId: r.sessionId || this.bm25.sessionOf(r.obsId) || "",
          bm25Score: 0,
          vectorScore: 0,
          graphScore: r.score,
          graphContext: r.graphContext,
        });
      }
    });

    // Each stream's scores go onto a 0..1 scale over its own candidates and
    // are added by weight, over the streams that produced results. Fusing by
    // rank placed any record listed by two streams above the vector stream's
    // best hit, so a question in Chinese about a record written in English
    // lost that record to weak keyword matches: over 160k records it ranked
    // first for 28% of such questions, against 58% from the vector stream
    // alone. The keyword weight shrinks with the share of the query that the
    // best keyword hit covers.
    const fullMatch = bm25Results.length > 0 ? this.bm25.fullMatchScore(query) : 0;
    const coverage = fullMatch > 0 ? Math.min(1, bm25Results[0].score / fullMatch) : 1;
    const bm25Share = bm25Results.length > 0 ? this.bm25Weight * coverage : 0;
    const vectorShare = vectorResults.length > 0 ? this.vectorWeight : 0;
    const graphShare = graphResults.length > 0 ? this.graphWeight : 0;
    const activeWeight = bm25Share + vectorShare + graphShare;
    const bm25Scale = unitScale(bm25Results, bm25Results.length >= poolLimit);
    const vectorScale = unitScale(vectorResults, vectorResults.length >= poolLimit);
    const graphScale = unitScale(graphResults, false);
    const ranked = Array.from(scores.entries()).map(([obsId, s]) => {
      const weighted =
        (Number.isFinite(s.bm25Rank) ? bm25Share * bm25Scale(s.bm25Score) : 0) +
        (Number.isFinite(s.vectorRank) ? vectorShare * vectorScale(s.vectorScore) : 0) +
        (Number.isFinite(s.graphRank) ? graphShare * graphScale(s.graphScore) : 0);
      return {
        obsId,
        s,
        combinedScore: activeWeight > 0 ? weighted / activeWeight : 0,
        minRank: Math.min(s.bm25Rank, s.vectorRank, s.graphRank),
      };
    });

    ranked.sort(
      (a, b) =>
        b.combinedScore - a.combinedScore ||
        a.minRank - b.minRank ||
        (a.obsId < b.obsId ? -1 : a.obsId > b.obsId ? 1 : 0),
    );
    const combined = ranked.map(({ obsId, s, combinedScore }) => ({
      obsId,
      sessionId: s.sessionId,
      bm25Score: s.bm25Score,
      vectorScore: s.vectorScore,
      graphScore: s.graphScore,
      graphContext: s.graphContext,
      combinedScore,
    }));

    if (request) request.candidateCount = combined.length;
    const retrievalDepth = Math.max(limit, 20);
    const diversified = this.diversifyBySession(combined, combined.length);
    const enriched = await this.enrichResults(diversified, retrievalDepth);

    const ordered = applyReranking ? await this.rerankResults(query, enriched, limit) : enriched.slice(0, limit);
    return targetLayer === "all" ? this.withMemoryQuota(query, queryEmbedding, ordered, limit) : ordered;
  }

  // The budget is how long the graph may hold back a search whose keyword and
  // vector streams are done; the entity search has had the embedding call's
  // duration on top of it.
  private async graphResults(
    graph: GraphQueries,
    entityHits: Promise<GraphRetrievalResult[]> | undefined,
    observations: string[],
    layer: SearchLayer,
  ): Promise<GraphRetrievalResult[]> {
    if (!entityHits && !observations.length) return [];
    const used = [...(entityHits ? [graph.entities] : []), ...(observations.length ? [graph.chunks] : [])];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.all([
        entityHits ?? [],
        observations.length ? graph.chunks.expandFromChunks(observations, 1, 5, layer).catch(() => []) : [],
      ]).then((results) => results.flat());
      const results = await Promise.race([
        work,
        new Promise<GraphRetrievalResult[]>((resolve) => {
          timer = setTimeout(() => {
            for (const query of used) query.cancel();
            if (Date.now() - this.lastGraphTimeoutWarningAt >= 60_000) {
              this.lastGraphTimeoutWarningAt = Date.now();
              logger.warn("Graph enrichment exceeded its budget; returning keyword and vector results", { budgetMs: GRAPH_BUDGET_MS });
            }
            resolve([]);
          }, GRAPH_BUDGET_MS);
        }),
      ]);
      const diagnostic = used.map((query) => query.diagnostics()).find((d) => d.status !== "ready" || d.truncated);
      if (diagnostic && Date.now() - this.lastGraphTimeoutWarningAt >= 60_000) {
        this.lastGraphTimeoutWarningAt = Date.now();
        logger.warn("Graph enrichment is unavailable or partial", diagnostic);
      }
      return results;
    } finally {
      clearTimeout(timer);
    }
  }

  private async rerankResults(query: string, results: HybridSearchResult[], limit: number): Promise<HybridSearchResult[]> {
    if (this.rerankEnabled && results.length > 1) {
      try {
        return (await rerank(query, results, 20)).slice(0, limit);
      } catch {
        return results.slice(0, limit);
      }
    }
    return results.slice(0, limit);
  }

  // Fills the reserved memory slots (see MEMORY_QUOTA) from a
  // memory-only retrieval pass, appended at the tail so the flat
  // ranking keeps the head. No-op when the flat ranking already
  // returned enough memories.
  private async withMemoryQuota(
    query: string,
    queryEmbedding: Float32Array | null,
    ranked: HybridSearchResult[],
    limit: number,
  ): Promise<HybridSearchResult[]> {
    const top = ranked.slice(0, limit);
    const quota = Math.min(MEMORY_QUOTA, Math.ceil(limit / 3));
    const missing =
      quota - top.filter((r) => isMemoryId(r.observation.id)).length;
    if (missing <= 0) return top;

    const seen = new Set(top.map((r) => r.observation.id));
    const candidates = this.memoryOnlyCandidates(query, queryEmbedding, quota)
      .filter((c) => !seen.has(c.obsId))
      .slice(0, missing);
    if (candidates.length === 0) return top;

    const memoryResults = await this.enrichResults(
      candidates,
      candidates.length,
    );
    return top
      .slice(0, Math.max(0, limit - memoryResults.length))
      .concat(memoryResults);
  }

  // BM25 + vector over the memory subset only. Ranks come from that
  // subset, so combinedScore is comparable within the returned list but
  // not against the flat ranking's scores.
  private memoryOnlyCandidates(
    query: string,
    queryEmbedding: Float32Array | null,
    limit: number,
  ): Array<{
    obsId: string;
    sessionId: string;
    bm25Score: number;
    vectorScore: number;
    graphScore: number;
    combinedScore: number;
  }> {
    const bm25Hits = this.bm25.search(query, limit, "all", isMemoryId);
    const vectorHits =
      queryEmbedding && this.vector
        ? this.vector.search(queryEmbedding, limit, "all", undefined, isMemoryId)
        : [];

    const scores = new Map<
      string,
      {
        sessionId: string;
        bm25Score: number;
        vectorScore: number;
        bm25Rank: number;
        vectorRank: number;
      }
    >();
    const entryFor = (obsId: string, sessionId: string) => {
      const existing = scores.get(obsId);
      if (existing) return existing;
      const created = {
        sessionId,
        bm25Score: 0,
        vectorScore: 0,
        bm25Rank: Infinity,
        vectorRank: Infinity,
      };
      scores.set(obsId, created);
      return created;
    };

    bm25Hits.forEach((r, i) => {
      const entry = entryFor(r.obsId, r.sessionId);
      entry.bm25Rank = i + 1;
      entry.bm25Score = r.score;
    });
    vectorHits.forEach((r, i) => {
      const entry = entryFor(r.obsId, r.sessionId);
      entry.vectorRank = i + 1;
      entry.vectorScore = r.score;
    });

    return Array.from(scores.entries())
      .map(([obsId, s]) => ({
        obsId,
        sessionId: s.sessionId,
        bm25Score: s.bm25Score,
        vectorScore: s.vectorScore,
        graphScore: 0,
        combinedScore:
          this.bm25Weight * (1 / (RRF_K + s.bm25Rank)) +
          this.vectorWeight * (1 / (RRF_K + s.vectorRank)),
      }))
      .sort((a, b) => {
        // Lexical hits first: the query terms actually occur in those
        // memories. Vector-only hits over the memory subset are
        // routinely unrelated — memory embedding coverage is sparse, so
        // cosine returns a near-arbitrary top-k — and only fill the
        // slots BM25 left empty.
        const aLexical = a.bm25Score > 0;
        const bLexical = b.bm25Score > 0;
        if (aLexical !== bLexical) return aLexical ? -1 : 1;
        return b.combinedScore - a.combinedScore;
      })
      .slice(0, limit);
  }

  private diversifyBySession(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
    maxPerSession = 3,
  ): typeof results {
    const selected: typeof results = [];
    const sessionCounts = new Map<string, number>();

    for (const r of results) {
      if (r.obsId.startsWith("mem_")) {
        selected.push(r);
        if (selected.length >= limit) break;
        continue;
      }
      const count = sessionCounts.get(r.sessionId) || 0;
      if (count >= maxPerSession) continue;
      selected.push(r);
      sessionCounts.set(r.sessionId, count + 1);
      if (selected.length >= limit) break;
    }

    if (selected.length < limit) {
      const picked = new Set(selected.map((s) => s.obsId));
      for (const r of results) {
        if (selected.length >= limit) break;
        if (!picked.has(r.obsId)) {
          selected.push(r);
        }
      }
    }

    return selected;
  }

  private async enrichResults(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    const enriched: HybridSearchResult[] = [];
    let next = 0;
    while (next < results.length && enriched.length < limit) {
      const batch = results.slice(next, next + limit);
      next += batch.length;
      enriched.push(...(await this.enrichBatch(batch)));
    }
    return enriched.slice(0, limit);
  }

  private async enrichBatch(
    sliced: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
  ): Promise<HybridSearchResult[]> {
    const observations = await Promise.all(
      sliced.map(async (r) => {
        const obs = await this.kv
          .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
          .catch(() => null);
        if (obs) return { observation: obs, layer: "observation" as const };
        // Fallback: indexed entry may originate from mem::remember, which
        // writes to KV.memories with a synthetic sessionId ("memory" or the
        // memory's first associated session). Coerce the Memory record into
        // a CompressedObservation so search/recall surface saved memories.
        const mem = await this.kv
          .get<Memory>(KV.memories, r.obsId)
          .catch(() => null);
        return mem ? { observation: memoryToObservation(mem), layer: "memory" as const } : null;
      }),
    );
    const enriched: HybridSearchResult[] = [];
    for (let i = 0; i < sliced.length; i++) {
      const resolved = observations[i];
      if (resolved) {
        enriched.push({
          observation: resolved.observation,
          layer: resolved.layer,
          bm25Score: sliced[i].bm25Score,
          vectorScore: sliced[i].vectorScore,
          graphScore: sliced[i].graphScore,
          combinedScore: sliced[i].combinedScore,
          sessionId: sliced[i].sessionId,
          graphContext: sliced[i].graphContext,
        });
      }
    }
    return enriched;
  }
}
