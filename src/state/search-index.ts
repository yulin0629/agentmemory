import type { CompressedObservation } from "../types.js";
import { getSearchResultLayer, isSearchResultLayer, matchesSearchLayer, type SearchLayer, type SearchResultLayer } from "./search-layer.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";

const MIN_PREFIX_TERM_LENGTH = 3;
const COMMON_TERM_DOC_RATIO = 0.5;
const COMMON_TERM_MIN_DOCS = 1000;
const MAX_QUERY_TERMS = 32;

interface IndexEntry {
  obsId: string;
  sessionId: string;
  termCount: number;
  layer: SearchResultLayer;
  timestamp?: string;
  slot: number;
}

const INITIAL_TERM_CAPACITY = 1024;
const INITIAL_POSTING_PAIRS = 4;
// V8 keeps a 13+ character token as a slice of the text it was split from.
const SLICED_STRING_MIN_LENGTH = 13;
// Bounds the work of patching the sorted vocabulary; past it one full sort runs.
const SORTED_TERMS_PATCH_LIMIT = 512;

function grown(array: Uint32Array, minLength: number): Uint32Array {
  let length = array.length;
  while (length < minLength) {
    length = length < 2048 ? length * 2 : (Math.ceil(length * 1.25) + 1) & ~1;
  }
  const next = new Uint32Array(length);
  next.set(array);
  return next;
}

const USER_PROMPT_TERM_CAP = 2000;
const ASSISTANT_RESPONSE_TERM_CAP = 1000;
const TOOL_OUTPUT_TERM_CAP = 1000;

export interface SearchIndexRevision {
  isCurrent(): boolean;
  release(): void;
}

export class SearchIndex {
  // Documents and terms are numbered, and postings are [slot, tf] pairs in
  // typed arrays: one Map entry and one string per posting cost about 125
  // bytes each, which was 2.6 GB for 21 million postings. A term found in one
  // document keeps that posting in singleSlot/singleTf and has no array.
  private entries: Map<string, IndexEntry> = new Map();
  private slotEntries: Array<IndexEntry | undefined> = [];
  private slotTermIds: Array<Uint32Array | undefined> = [];
  private freeSlots: number[] = [];
  private slotSequences: number[] = [];
  private nextSequence = 0;
  private termIds: Map<string, number> = new Map();
  private termNames: Array<string | undefined> = [];
  private postings: Array<Uint32Array | undefined> = [];
  private postingCounts: Uint32Array = new Uint32Array(INITIAL_TERM_CAPACITY);
  private singleSlot: Uint32Array = new Uint32Array(INITIAL_TERM_CAPACITY);
  private singleTf: Uint32Array = new Uint32Array(INITIAL_TERM_CAPACITY);
  private freeTermIds: number[] = [];
  private matchMarks: Uint32Array = new Uint32Array(INITIAL_TERM_CAPACITY);
  private matchEpoch = 0;
  private totalDocLength = 0;
  private sortedTerms: string[] | null = null;
  private sortedTermChanges: string[] = [];
  private revisionGeneration: object = {};
  private absentRevisions = new Map<string, { token: object; readers: number }>();

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(obs: CompressedObservation, layer: SearchResultLayer = "observation"): void {
    this.invalidateAbsentRevision(obs.id);
    if (this.entries.has(obs.id)) this.remove(obs.id);
    const terms = this.extractTerms(obs);
    const termFreq = new Map<string, number>();
    let termCount = 0;

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      termCount++;
    }

    const slot = this.freeSlots.pop() ?? this.slotEntries.length;
    const entry: IndexEntry = {
      obsId: obs.id,
      sessionId: obs.sessionId,
      termCount,
      layer,
      timestamp: obs.timestamp,
      slot,
    };
    this.entries.set(obs.id, entry);
    this.slotEntries[slot] = entry;
    this.slotSequences[slot] = this.nextSequence++;
    this.totalDocLength += termCount;

    const termIds = new Uint32Array(termFreq.size);
    let position = 0;
    for (const [term, tf] of termFreq) {
      const termId = this.termIdFor(term);
      this.appendPosting(termId, slot, tf);
      termIds[position++] = termId;
    }
    this.slotTermIds[slot] = termIds;
  }

  private termIdFor(term: string): number {
    const known = this.termIds.get(term);
    if (known !== undefined) return known;
    const termId = this.freeTermIds.pop() ?? this.termNames.length;
    if (termId >= this.postingCounts.length) {
      this.postingCounts = grown(this.postingCounts, termId + 1);
      this.singleSlot = grown(this.singleSlot, termId + 1);
      this.singleTf = grown(this.singleTf, termId + 1);
    }
    // The copy lets the document text a long token was sliced from be freed.
    let name = term;
    if (term.length >= SLICED_STRING_MIN_LENGTH) {
      name = Buffer.from(term, "latin1").toString("latin1");
      if (name !== term) name = Buffer.from(term, "utf16le").toString("utf16le");
    }
    this.termIds.set(name, termId);
    this.termNames[termId] = name;
    this.noteTermChange(name);
    this.postings[termId] = undefined;
    return termId;
  }

  private appendPosting(termId: number, slot: number, tf: number): void {
    const count = this.postingCounts[termId];
    if (count === 0) {
      this.singleSlot[termId] = slot;
      this.singleTf[termId] = tf;
    } else {
      let pairs = this.postings[termId];
      if (!pairs) {
        pairs = new Uint32Array(INITIAL_POSTING_PAIRS * 2);
        pairs[0] = this.singleSlot[termId];
        pairs[1] = this.singleTf[termId];
        this.postings[termId] = pairs;
      } else if (count * 2 === pairs.length) {
        pairs = grown(pairs, count * 2 + 2);
        this.postings[termId] = pairs;
      }
      pairs[count * 2] = slot;
      pairs[count * 2 + 1] = tf;
    }
    this.postingCounts[termId] = count + 1;
  }

  // Keeps the remaining postings in insertion order, as Set.delete did:
  // equal scores come back in that order.
  private removePosting(termId: number, slot: number): void {
    const count = this.postingCounts[termId];
    if (count === 0) return;
    const pairs = this.postings[termId];
    let remaining = count;
    if (!pairs) {
      if (this.singleSlot[termId] === slot) remaining = 0;
    } else {
      const at = this.postingPosition(pairs, count, slot);
      if (at >= 0) {
        pairs.copyWithin(at * 2, at * 2 + 2, count * 2);
        remaining = count - 1;
        if (remaining * 8 <= pairs.length && pairs.length > INITIAL_POSTING_PAIRS * 2) {
          this.postings[termId] = pairs.slice(0, Math.max(INITIAL_POSTING_PAIRS * 2, remaining * 4));
        }
      }
    }
    this.postingCounts[termId] = remaining;
    if (remaining > 0) return;
    this.noteTermChange(this.termNames[termId]!);
    this.termIds.delete(this.termNames[termId]!);
    this.termNames[termId] = undefined;
    this.postings[termId] = undefined;
    this.freeTermIds.push(termId);
  }

  // Postings are appended in the order documents were added, so a slot is
  // found by its add sequence; a loaded snapshot may list them in another
  // order, which the scan covers.
  private postingPosition(pairs: Uint32Array, count: number, slot: number): number {
    const sequences = this.slotSequences;
    const target = sequences[slot];
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const midSlot = pairs[mid * 2];
      if (midSlot === slot) return mid;
      if (sequences[midSlot] < target) low = mid + 1;
      else high = mid - 1;
    }
    for (let i = 0; i < count; i++) {
      if (pairs[i * 2] === slot) return i;
    }
    return -1;
  }

  private documentFrequency(term: string): number {
    const termId = this.termIds.get(term);
    return termId === undefined ? 0 : this.postingCounts[termId];
  }

  watchRevision(id: string): SearchIndexRevision {
    const generation = this.revisionGeneration;
    const entry = this.entries.get(id);
    if (entry) {
      return {
        isCurrent: () => this.revisionGeneration === generation && this.entries.get(id) === entry,
        release: () => {},
      };
    }
    // Only absent IDs need a lease: retaining deleted-ID tombstones would grow
    // forever, while one shared absent epoch would cancel unrelated writes.
    let slot = this.absentRevisions.get(id);
    if (!slot) {
      slot = { token: {}, readers: 0 };
      this.absentRevisions.set(id, slot);
    }
    slot.readers++;
    const token = slot.token;
    let released = false;
    return {
      isCurrent: () => !released && this.revisionGeneration === generation &&
        this.entries.get(id) === undefined && slot.token === token,
      release: () => {
        if (released) return;
        released = true;
        slot.readers--;
        if (slot.readers === 0 && this.absentRevisions.get(id) === slot) this.absentRevisions.delete(id);
      },
    };
  }

  private invalidateAbsentRevision(id: string): void {
    const slot = this.absentRevisions.get(id);
    if (slot) slot.token = {};
  }

  invalidateRevision(id: string): void {
    this.invalidateAbsentRevision(id);
    const entry = this.entries.get(id);
    if (entry) {
      const copy = { ...entry };
      this.entries.set(id, copy);
      this.slotEntries[entry.slot] = copy;
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  sessionOf(id: string): string | undefined {
    return this.entries.get(id)?.sessionId;
  }

  layerOf(id: string): SearchResultLayer | undefined {
    return this.entries.get(id)?.layer;
  }

  countMissingDocuments(hasDocument: (id: string) => boolean, since?: string | null, activeIds?: ReadonlySet<string>): number {
    const cutoff = typeof since === "string" ? Date.parse(since) : Number.NaN;
    let missing = 0;
    for (const entry of this.entries.values()) {
      if (entry.layer !== "observation" && entry.layer !== "memory") continue;
      if (Number.isFinite(cutoff) && !(Date.parse(entry.timestamp ?? "") > cutoff) && !activeIds?.has(entry.obsId)) continue;
      if (!hasDocument(entry.obsId)) missing++;
    }
    return missing;
  }

  observationCountsBySession(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.layer !== "observation") continue;
      counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  documentKindCounts(): { memories: number; lessons: number } {
    let memories = 0;
    let lessons = 0;
    for (const entry of this.entries.values()) {
      if (entry.layer === "memory") memories++;
      else if (entry.layer === "lesson") lessons++;
    }
    return { memories, lessons };
  }

  remove(id: string): void {
    this.invalidateAbsentRevision(id);
    const entry = this.entries.get(id);
    if (!entry) return;

    const termIds = this.slotTermIds[entry.slot];
    if (termIds) {
      for (let i = 0; i < termIds.length; i++) {
        this.removePosting(termIds[i], entry.slot);
      }
    }
    this.slotTermIds[entry.slot] = undefined;
    this.slotEntries[entry.slot] = undefined;
    this.freeSlots.push(entry.slot);

    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
  }

  search(
    query: string,
    limit = 20,
    targetLayer: SearchLayer = "all",
    filter?: (obsId: string) => boolean,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const rawTerms = this.tokenize(query.toLowerCase());
    if (rawTerms.length === 0) return [];

    const N = this.entries.size;
    if (N === 0) return [];
    const avgDocLen = this.totalDocLength / N;

    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of rawTerms) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1.0 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<number, number>();
    const sorted = this.getSortedTerms();
    if (this.matchMarks.length < this.slotEntries.length) {
      this.matchMarks = new Uint32Array(Math.max(this.slotEntries.length, this.matchMarks.length * 2));
    }
    const marks = this.matchMarks;
    const slotEntries = this.slotEntries;

    for (const { term, weight } of this.costBoundedTerms(queryTerms, N)) {
      const termId = this.termIds.get(term);
      let exactMatch = 0;
      if (termId !== undefined) {
        if (this.matchEpoch === 0xffffffff) {
          marks.fill(0);
          this.matchEpoch = 0;
        }
        exactMatch = ++this.matchEpoch;
        const df = this.postingCounts[termId];
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const pairs = this.postings[termId];

        for (let i = 0; i < df; i++) {
          const slot = pairs ? pairs[i * 2] : this.singleSlot[termId];
          marks[slot] = exactMatch;
          const entry = slotEntries[slot]!;
          if (!matchesSearchLayer(entry.obsId, entry.sessionId, targetLayer, entry.layer)) continue;
          const tf = pairs ? pairs[i * 2 + 1] : this.singleTf[termId];
          const docLen = entry.termCount;

          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const bm25Score = idf * (numerator / denominator) * weight;

          scores.set(slot, (scores.get(slot) || 0) + bm25Score);
        }
      }

      const prefixScores = new Map<number, number>();
      const expandPrefix = hasCjk(term) || Array.from(term).length >= MIN_PREFIX_TERM_LENGTH;
      const startIdx = expandPrefix ? this.lowerBound(sorted, term) : sorted.length;
      for (let si = startIdx; si < sorted.length; si++) {
        const indexTerm = sorted[si];
        if (!indexTerm.startsWith(term)) break;
        if (indexTerm === term) continue;

        const prefixTermId = this.termIds.get(indexTerm)!;
        const prefixDf = this.postingCounts[prefixTermId];
        const prefixIdf =
          Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5;
        const pairs = this.postings[prefixTermId];
        for (let i = 0; i < prefixDf; i++) {
          const slot = pairs ? pairs[i * 2] : this.singleSlot[prefixTermId];
          if (exactMatch !== 0 && marks[slot] === exactMatch) continue;
          const entry = slotEntries[slot]!;
          if (!matchesSearchLayer(entry.obsId, entry.sessionId, targetLayer, entry.layer)) continue;
          const tf = pairs ? pairs[i * 2 + 1] : this.singleTf[prefixTermId];
          const docLen = entry.termCount;
          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const score = prefixIdf * (numerator / denominator) * weight;
          prefixScores.set(slot, Math.max(prefixScores.get(slot) ?? 0, score));
        }
      }
      for (const [slot, score] of prefixScores) {
        scores.set(slot, (scores.get(slot) ?? 0) + score);
      }
    }

    return Array.from(scores, ([slot, score]) => {
      const entry = slotEntries[slot]!;
      return { obsId: entry.obsId, sessionId: entry.sessionId, score };
    })
      .filter((hit) => (filter ? filter(hit.obsId) : true))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Each term walks its whole posting list synchronously, so a pasted prompt
  // (a Hermes cron job sends ~1.8k chars) held the event loop for 15-35 s.
  // In an index of COMMON_TERM_MIN_DOCS or more, terms in more than half of
  // all documents add an idf below ln 2 and are dropped while another term
  // still matches; a long query keeps its rarest terms.
  private costBoundedTerms(
    queryTerms: Array<{ term: string; weight: number }>,
    docCount: number,
  ): Array<{ term: string; weight: number }> {
    const ranked = queryTerms.map((q, order) => ({ ...q, order, df: this.documentFrequency(q.term) }));
    const informative = docCount >= COMMON_TERM_MIN_DOCS
      ? ranked.filter((q) => q.df <= docCount * COMMON_TERM_DOC_RATIO)
      : ranked;
    const pool = informative.some((q) => q.df > 0) ? informative : ranked;
    if (pool.length <= MAX_QUERY_TERMS) return pool;
    return [...pool]
      .sort((a, b) => a.df - b.df || a.order - b.order)
      .slice(0, MAX_QUERY_TERMS)
      .sort((a, b) => a.order - b.order);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.revisionGeneration = {};
    this.absentRevisions.clear();
    this.entries.clear();
    this.slotEntries = [];
    this.slotTermIds = [];
    this.freeSlots = [];
    this.slotSequences = [];
    this.nextSequence = 0;
    this.termIds.clear();
    this.termNames = [];
    this.postings = [];
    this.postingCounts = new Uint32Array(INITIAL_TERM_CAPACITY);
    this.singleSlot = new Uint32Array(INITIAL_TERM_CAPACITY);
    this.singleTf = new Uint32Array(INITIAL_TERM_CAPACITY);
    this.freeTermIds = [];
    this.matchMarks = new Uint32Array(INITIAL_TERM_CAPACITY);
    this.matchEpoch = 0;
    this.totalDocLength = 0;
    this.sortedTerms = null;
  }

  restoreFrom(other: SearchIndex): void {
    this.revisionGeneration = {};
    this.absentRevisions.clear();
    if (other === this) return;
    this.entries = new Map();
    this.slotEntries = new Array(other.slotEntries.length);
    for (const [id, entry] of other.entries) {
      const copy = { ...entry };
      this.entries.set(id, copy);
      this.slotEntries[copy.slot] = copy;
    }
    this.slotTermIds = other.slotTermIds.map((ids) => ids?.slice());
    this.freeSlots = other.freeSlots.slice();
    this.slotSequences = other.slotSequences.slice();
    this.nextSequence = other.nextSequence;
    this.termIds = new Map(other.termIds);
    this.termNames = other.termNames.slice();
    this.postings = other.postings.map((pairs) => pairs?.slice());
    this.postingCounts = other.postingCounts.slice();
    this.singleSlot = other.singleSlot.slice();
    this.singleTf = other.singleTf.slice();
    this.freeTermIds = other.freeTermIds.slice();
    this.totalDocLength = other.totalDocLength;
    this.sortedTerms = null;
  }

  serialize(): string {
    const entries = Array.from(
      this.entries,
      ([id, { slot: _slot, ...entry }]) => [id, entry] as const,
    );
    const tfBySlot = new Map<number, Map<number, number>>();
    const inverted: [string, string[]][] = [];
    for (const [term, termId] of this.termIds) {
      const count = this.postingCounts[termId];
      const pairs = this.postings[termId];
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const slot = pairs ? pairs[i * 2] : this.singleSlot[termId];
        const tf = pairs ? pairs[i * 2 + 1] : this.singleTf[termId];
        ids.push(this.slotEntries[slot]!.obsId);
        let counts = tfBySlot.get(slot);
        if (!counts) {
          counts = new Map();
          tfBySlot.set(slot, counts);
        }
        counts.set(termId, tf);
      }
      inverted.push([term, ids]);
    }
    const docTerms = Array.from(this.entries.values(), (entry) => {
      const counts = tfBySlot.get(entry.slot);
      const terms = Array.from(
        this.slotTermIds[entry.slot] ?? [],
        (termId) => [this.termNames[termId]!, counts?.get(termId) ?? 0] as [string, number],
      );
      return [entry.obsId, terms] as [string, [string, number][]];
    });
    return JSON.stringify({
      v: 3,
      entries,
      inverted,
      docTerms,
      totalDocLength: this.totalDocLength,
    });
  }

  static deserialize(json: string): SearchIndex {
    try {
      const idx = new SearchIndex();
      const data = JSON.parse(json);
      if (!data?.entries || !data?.inverted || !data?.docTerms) return idx;
      for (const [key, val] of data.entries) {
        const entry: IndexEntry = {
          ...val,
          layer: isSearchResultLayer(val.layer) ? val.layer : getSearchResultLayer(key, val.sessionId),
          slot: idx.slotEntries.length,
        };
        idx.entries.set(key, entry);
        idx.slotEntries.push(entry);
        idx.slotSequences.push(idx.nextSequence++);
      }
      const termCounts = new Map<string, Map<string, number>>();
      for (const [id, counts] of data.docTerms) {
        termCounts.set(id, new Map(counts));
      }
      const posted = new Map<string, Set<string>>();
      for (const [term, ids] of data.inverted) {
        posted.set(term, new Set<string>(ids));
      }
      // A posting is kept only when both halves of the snapshot list it, so
      // every posting can be found again when its document is removed.
      for (const [term, ids] of posted) {
        for (const id of ids) {
          const entry = idx.entries.get(id);
          const tf = termCounts.get(id)?.get(term);
          if (!entry || tf === undefined) continue;
          idx.appendPosting(idx.termIdFor(term), entry.slot, tf);
        }
      }
      for (const [id, counts] of termCounts) {
        const entry = idx.entries.get(id);
        if (!entry) continue;
        const termIds: number[] = [];
        for (const term of counts.keys()) {
          if (posted.get(term)?.has(id)) termIds.push(idx.termIds.get(term)!);
        }
        idx.slotTermIds[entry.slot] = Uint32Array.from(termIds);
      }
      const rawLen = Number(data.totalDocLength);
      idx.totalDocLength =
        Number.isFinite(rawLen) && rawLen >= 0 ? Math.floor(rawLen) : 0;
      return idx;
    } catch {
      return new SearchIndex();
    }
  }

  private extractTerms(obs: CompressedObservation): string[] {
    const parts = [
      obs.title,
      obs.subtitle || "",
      obs.narrative,
      ...obs.facts,
      ...obs.concepts,
      ...obs.files,
      obs.type,
    ];
    if (obs.source?.userPrompt) {
      parts.push(obs.source.userPrompt.slice(0, USER_PROMPT_TERM_CAP));
    }
    if (obs.source?.assistantResponse) {
      parts.push(
        obs.source.assistantResponse.slice(0, ASSISTANT_RESPONSE_TERM_CAP),
      );
    }
    if (
      obs.source?.toolName === "conversation" &&
      typeof obs.source.toolOutput === "string"
    ) {
      parts.push(obs.source.toolOutput.slice(0, TOOL_OUTPUT_TERM_CAP));
    }
    return this.tokenize(parts.join(" ").toLowerCase());
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2) continue;
      if (hasCjk(raw)) {
        for (const seg of segmentCjk(raw)) {
          if (seg.length >= 1) out.push(seg);
        }
      } else {
        out.push(stem(raw));
      }
    }
    return out;
  }

  private noteTermChange(name: string): void {
    if (!this.sortedTerms) return;
    if (this.sortedTermChanges.length < SORTED_TERMS_PATCH_LIMIT) {
      this.sortedTermChanges.push(name);
    } else {
      this.sortedTerms = null;
      this.sortedTermChanges = [];
    }
  }

  // Sorting the whole vocabulary again after every add or removal cost the
  // next search 0.7 s at 600k terms, so the terms that appeared or
  // disappeared since the last search are patched into the sorted copy.
  private getSortedTerms(): string[] {
    const sorted = this.sortedTerms;
    if (!sorted) {
      this.sortedTerms = Array.from(this.termIds.keys()).sort();
      this.sortedTermChanges = [];
      return this.sortedTerms;
    }
    for (const name of this.sortedTermChanges) {
      const at = this.lowerBound(sorted, name);
      const listed = sorted[at] === name;
      if (this.termIds.has(name)) {
        if (!listed) sorted.splice(at, 0, name);
      } else if (listed) {
        sorted.splice(at, 1);
      }
    }
    this.sortedTermChanges = [];
    return sorted;
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
