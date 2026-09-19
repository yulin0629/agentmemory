import type { ISdk } from "iii-sdk";
import { z } from "zod";
import type { StateKV } from "../state/kv.js";
import type { ContextKnowledgeCatalog } from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { selectContext, type ContextJudge } from "../state/selective-context.js";
import { safeAudit } from "./audit.js";

const id = z.string().trim().min(1).max(200);
const knowledgeSchema = z.object({
  id, revision: id,
  status: z.enum(["candidate", "active", "superseded", "retracted"]),
  scope: z.object({ namespace: id, project: id.optional(), task: id.optional() }).strict(),
  evidence: z.object({ eventId: id, text: z.string().min(1).max(12000),
    adoptedAt: z.iso.datetime() }).strict(),
  spans: z.array(z.object({ id, text: z.string().trim().min(1).max(1200) }).strict()).min(1).max(4),
}).strict().refine(record => record.spans.every(s => record.evidence.text.includes(s.text)),
  "Spans must be exact substrings of the supplied evidence")
  .refine(record => new Set(record.spans.map(s => s.id)).size === record.spans.length,
    "Span IDs must be unique");

export const contextKnowledgePutSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  confirmedByUser: z.literal(true),
  knowledge: knowledgeSchema,
}).strict();

export const selectiveContextSchema = z.object({
  prompt: z.string().trim().min(1).max(12000),
  previous: z.string().max(8000).default(""),
  project: id.optional(), task: id.optional(),
  excludedIds: z.array(id).max(100).default([]),
}).strict();

export function registerSelectiveContextFunctions(
  sdk: ISdk, kv: StateKV,
  options: { namespace: string; judge: ContextJudge; now?: () => string },
): void {
  const namespace = id.parse(options.namespace);
  const key = fingerprintId("ctx", namespace);
  const now = options.now ?? (() => new Date().toISOString());
  const read = async (): Promise<ContextKnowledgeCatalog> =>
    await kv.get<ContextKnowledgeCatalog>(KV.contextKnowledge, key)
      ?? { revision: 0, records: [], events: {} };

  sdk.registerFunction("mem::context-knowledge-put", async (input: unknown) => {
    const parsed = contextKnowledgePutSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: "invalid_knowledge" };
    const { knowledge, expectedRevision } = parsed.data;
    if (knowledge.scope.namespace !== namespace) return { success: false, error: "namespace_mismatch" };
    if (Date.parse(knowledge.evidence.adoptedAt) > Date.parse(now())) {
      return { success: false, error: "future_evidence" };
    }
    return withKeyedLock(`context-knowledge:${key}`, async () => {
      const catalog = await read();
      const eventKey = fingerprintId("evt", knowledge.evidence.eventId);
      const digest = fingerprintId("change", JSON.stringify(knowledge));
      if (catalog.events[eventKey]) {
        return catalog.events[eventKey] === digest
          ? { success: true, action: "replayed", revision: catalog.revision }
          : { success: false, error: "event_conflict" };
      }
      if (catalog.revision !== expectedRevision) return { success: false, error: "revision_conflict", revision: catalog.revision };
      const existing = catalog.records.find(r => r.id === knowledge.id);
      if (existing?.revision === knowledge.revision) return { success: false, error: "unchanged_record_revision" };
      // debt: ceiling: 12 curated records/256 events in one atomic KV value;
      // upgrade: indexed versioned catalog before expanding the pilot corpus.
      if ((!existing && catalog.records.length >= 12) || Object.keys(catalog.events).length >= 256) {
        return { success: false, error: "catalog_capacity" };
      }
      const next: ContextKnowledgeCatalog = {
        revision: catalog.revision + 1,
        records: [...catalog.records.filter(r => r.id !== knowledge.id), knowledge],
        events: { ...catalog.events, [eventKey]: digest },
      };
      await kv.set(KV.contextKnowledge, key, next);
      await safeAudit(kv, "context_knowledge_put", "mem::context-knowledge-put", [knowledge.id], {
        catalogRevision: next.revision,
        knowledgeRevision: knowledge.revision,
        evidenceEventId: knowledge.evidence.eventId,
        status: knowledge.status,
      });
      return { success: true, action: "saved", revision: next.revision };
    });
  });

  sdk.registerFunction("mem::selective-context", async (input: unknown) => {
    const parsed = selectiveContextSchema.safeParse(input);
    if (!parsed.success) return { status: "unavailable", spans: [], error: "invalid_request" };
    const catalog = await read();
    const result = await selectContext({ ...parsed.data, namespace, asOf: now() },
      catalog.records, options.judge);
    const latest = await read();
    if (latest.revision !== catalog.revision) {
      return { status: "unavailable", spans: [], error: "knowledge_changed" };
    }
    return { ...result, catalogRevision: catalog.revision };
  });
}
