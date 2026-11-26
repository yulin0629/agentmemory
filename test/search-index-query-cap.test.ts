import { describe, it, expect } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

function lesson(id: string, narrative: string): CompressedObservation {
  return {
    id,
    sessionId: "lessons",
    timestamp: "2026-11-26T00:00:00.000Z",
    type: "decision",
    title: narrative,
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance: 5,
  } as CompressedObservation;
}

describe("SearchIndex query term cap", () => {
  it("keeps a term some document uses when the query has more unmatched terms than the cap", () => {
    const index = new SearchIndex();
    index.add(lesson("lsn_target", "guardrail regression finished in october"), "lesson");
    index.add(lesson("lsn_other", "deploy checklist for the staging cluster"), "lesson");

    // 40 distinct terms that no document uses and that are a prefix of no indexed term,
    // as conversation context appended to a short prompt would add.
    const noise = Array.from({ length: 40 }, (_, i) => `zq${i}xw${i}vk`).join(" ");
    const hits = index.search(`guardrail ${noise}`, 10);

    expect(hits.map((h) => h.obsId)).toContain("lsn_target");
  });
});
