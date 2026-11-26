import { describe, it, expect } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { SearchIndex as ReferenceIndex } from "./fixtures/search-index-reference.js";
import type { CompressedObservation } from "../src/types.js";
import type { SearchLayer, SearchResultLayer } from "../src/state/search-layer.js";

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const COMMON = ["the", "fix", "auth", "authenticate", "authorization", "token", "tokens", "session", "index", "search", "error", "config", "deploy", "memory", "cache", "retry", "timeout", "build", "test", "db"];
const CJK = ["記憶體", "搜尋索引", "部署失敗", "重新啟動", "設定檔", "關鍵字", "備份", "排程"];

function corpus(count: number, random: () => number): CompressedObservation[] {
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const rare = Array.from({ length: 300 }, (_, i) => `term${i}x${Math.floor(random() * 1e6).toString(36)}`);
  const paths = Array.from({ length: 120 }, (_, i) => `src/module-${i % 17}/handlers/request-${i}-handler.ts`);
  const words = (n: number) => Array.from({ length: n }, () => {
    const roll = random();
    if (roll < 0.55) return pick(COMMON);
    if (roll < 0.8) return pick(rare);
    if (roll < 0.9) return pick(CJK);
    return pick(paths);
  }).join(" ");
  return Array.from({ length: count }, (_, i) => ({
    id: `obs_${i.toString(36)}_${Math.floor(random() * 1e9).toString(16)}`,
    sessionId: `ses_${i % 40}`,
    timestamp: new Date(1_790_000_000_000 + i * 60_000).toISOString(),
    type: "file_edit",
    title: words(5),
    subtitle: random() < 0.5 ? words(3) : undefined,
    facts: [words(8), words(4)],
    narrative: `${words(25)} unique${i}token-with-a-long-tail-${i}`,
    concepts: [pick(COMMON), pick(rare)],
    files: [pick(paths)],
    importance: 5,
    source: random() < 0.3 ? { userPrompt: words(30) } : undefined,
  } as CompressedObservation));
}

function queries(count: number, docs: CompressedObservation[], random: () => number) {
  const layers: SearchLayer[] = ["all", "all", "all", "memory", "observation"];
  return Array.from({ length: count }, () => {
    const doc = docs[Math.floor(random() * docs.length)];
    const tokens = `${doc.title} ${doc.narrative}`.split(/\s+/);
    const picked = Array.from({ length: 1 + Math.floor(random() * 5) }, () => tokens[Math.floor(random() * tokens.length)]);
    const roll = random();
    if (roll < 0.25) picked[0] = picked[0].slice(0, 3 + Math.floor(random() * 3));
    if (roll > 0.9) picked.push(...tokens.slice(0, 40));
    return {
      text: picked.join(" "),
      limit: random() < 0.3 ? 200 : 20,
      layer: layers[Math.floor(random() * layers.length)],
      filter: random() < 0.2 ? (id: string) => id.charCodeAt(id.length - 1) % 2 === 0 : undefined,
    };
  });
}

describe("SearchIndex against the Map/Set reference", () => {
  it("returns the same ids, scores and order through adds, updates and removals", () => {
    const random = seededRandom(20261125);
    const docs = corpus(1200, random);
    const index = new SearchIndex();
    const reference = new ReferenceIndex();
    const both = (run: (target: SearchIndex | ReferenceIndex) => void) => { run(index); run(reference); };
    const expectSameResults = (round: string) => {
      let matched = 0;
      for (const query of queries(150, docs, random)) {
        const expected = reference.search(query.text, query.limit, query.layer, query.filter);
        expect(index.search(query.text, query.limit, query.layer, query.filter), `${round}: ${query.text}`).toEqual(expected);
        if (expected.length > 0) matched++;
      }
      expect(matched).toBeGreaterThan(90);
    };

    docs.forEach((doc, i) => {
      const layer: SearchResultLayer = i % 9 === 0 ? "memory" : i % 31 === 0 ? "lesson" : "observation";
      both((target) => target.add(doc, layer));
    });
    expectSameResults("after build");

    for (const doc of docs) {
      const roll = random();
      if (roll < 0.1) {
        const revised = { ...doc, title: `${doc.title} revised`, narrative: doc.narrative.split(" ").reverse().join(" ") };
        both((target) => target.add(revised));
      } else if (roll < 0.25) {
        both((target) => target.remove(doc.id));
        if (random() < 0.5) both((target) => target.add(doc, "memory"));
      } else if (roll < 0.27) {
        both((target) => target.invalidateRevision(doc.id));
      }
    }
    expect(index.size).toBe(reference.size);
    expectSameResults("after updates and removals");

    expect(JSON.parse(index.serialize())).toEqual(JSON.parse(reference.serialize()));
    expect(index.documentKindCounts()).toEqual(reference.documentKindCounts());
    expect([...index.observationCountsBySession()]).toEqual([...reference.observationCountsBySession()]);

    const restored = SearchIndex.deserialize(reference.serialize());
    const copied = new SearchIndex();
    copied.restoreFrom(index);
    for (const query of queries(100, docs, random)) {
      const expected = reference.search(query.text, query.limit, query.layer, query.filter);
      expect(restored.search(query.text, query.limit, query.layer, query.filter)).toEqual(expected);
      expect(copied.search(query.text, query.limit, query.layer, query.filter)).toEqual(expected);
    }

    both((target) => { for (const doc of docs) target.remove(doc.id); });
    expect(index.size).toBe(0);
    both((target) => { for (const doc of docs.slice(0, 200)) target.add(doc); });
    expectSameResults("after emptying and refilling");
  }, 30_000);

  it("leaves a copied index unchanged when the source changes afterwards", () => {
    const random = seededRandom(7);
    const docs = corpus(60, random);
    const source = new SearchIndex();
    for (const doc of docs) source.add(doc);
    const copy = new SearchIndex();
    copy.restoreFrom(source);
    const before = copy.search("auth token", 50);
    for (const doc of docs.slice(0, 30)) source.remove(doc.id);
    source.add({ ...docs[40], title: "auth token auth token" });
    expect(copy.search("auth token", 50)).toEqual(before);
  });

  it("keeps its documents when it is restored from itself", () => {
    const docs = corpus(20, seededRandom(11));
    const index = new SearchIndex();
    const reference = new ReferenceIndex();
    for (const doc of docs) { index.add(doc); reference.add(doc); }
    index.restoreFrom(index);
    reference.restoreFrom(reference);
    expect(index.size).toBe(reference.size);
    expect(index.search("auth token", 50)).toEqual(reference.search("auth token", 50));
    expect(JSON.parse(index.serialize())).toEqual(JSON.parse(reference.serialize()));
  });

  it("returns the reference results when a filter removes a document during the search", () => {
    const docs = corpus(2, seededRandom(13)).map((doc) => ({ ...doc, title: "alpha" }));
    const run = (target: SearchIndex | ReferenceIndex) => {
      for (const doc of docs) target.add(doc);
      return target.search("alpha", 10, "all", (id) => {
        target.remove(docs[1].id);
        return id === docs[0].id;
      });
    };
    const expected = run(new ReferenceIndex());
    expect(expected.map((hit) => hit.obsId)).toEqual([docs[0].id]);
    expect(run(new SearchIndex())).toEqual(expected);
  });

  it("searches like the reference after loading a snapshot whose two halves disagree", () => {
    const [first, second, third, fourth] = corpus(4, seededRandom(17));
    const source = new ReferenceIndex();
    const bare = { subtitle: undefined, facts: [], narrative: "", concepts: [], files: [], source: undefined };
    source.add({ ...first, ...bare, title: "alpha beta" });
    source.add({ ...second, ...bare, title: "alpha gamma" });
    const snapshot = JSON.parse(source.serialize());
    const alphaRow = snapshot.inverted.find(([term]: [string]) => term === "alpha");
    const gammaRow = snapshot.inverted.find(([term]: [string]) => term === "gamma");
    alphaRow[1].reverse();
    snapshot.inverted.push([alphaRow[0], [...alphaRow[1]]]);
    gammaRow[1].length = 0;
    const json = JSON.stringify(snapshot);

    const index = SearchIndex.deserialize(json);
    const reference = ReferenceIndex.deserialize(json);
    const expectSame = () => {
      for (const text of ["alpha", "beta", "gamma", "quuxword", "zorkword"]) {
        expect(index.search(text, 10), text).toEqual(reference.search(text, 10));
      }
    };
    expectSame();
    expect(reference.search("alpha", 10).map((hit) => hit.obsId)).toEqual([second.id, first.id]);
    for (const target of [index, reference]) {
      target.remove(second.id);
      target.remove(first.id);
      target.add({ ...third, ...bare, title: "quuxword" });
      target.add({ ...fourth, ...bare, title: "zorkword" });
    }
    expectSame();
    expect(index.search("quuxword", 10).map((hit) => hit.obsId)).toEqual([third.id]);
  });

  it("matches the reference when a search follows every single add, update and removal", () => {
    const random = seededRandom(23);
    const docs = corpus(260, random);
    const index = new SearchIndex();
    const reference = new ReferenceIndex();
    const both = (apply: (target: SearchIndex | ReferenceIndex) => void) => { apply(index); apply(reference); };
    for (const doc of docs.slice(0, 200)) both((target) => target.add(doc));
    let matched = 0;
    for (let step = 0; step < 120; step++) {
      const fresh = docs[200 + (step % 60)];
      const old = docs[step];
      if (step % 3 === 0) both((target) => target.add({ ...fresh, id: `${fresh.id}_${step}`, title: `${fresh.title} patchword${step}` }));
      else if (step % 3 === 1) both((target) => target.add({ ...old, narrative: `rewritten${step} narrative` }));
      else both((target) => target.remove(old.id));
      for (const text of [`patchw rewri uniq term${step % 10}`, `${fresh.title.split(" ")[0].slice(0, 4)} auth`]) {
        const expected = reference.search(text, 50);
        expect(index.search(text, 50), `step ${step}: ${text}`).toEqual(expected);
        if (expected.length > 0) matched++;
      }
    }
    expect(matched).toBeGreaterThan(200);
  });
});
