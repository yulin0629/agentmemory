import type { ISdk } from "iii-sdk";
import { z } from "zod";
import type { StateKV } from "../state/kv.js";
import type { ContextKnowledgeCatalog, RawObservation } from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { selectContext, type ContextJudge, type ContextKnowledge } from "../state/selective-context.js";
import { explicitMemoryText, type CaptureJudge } from "../state/explicit-memory.js";
import { safeAudit } from "./audit.js";

const id = z.string().trim().min(1).max(200);
const knowledgeSchema = z.object({
  id, revision: id,
  status: z.enum(["candidate", "active", "superseded", "retracted"]),
  captureDisposition: z.enum(["project_rule", "task_only", "unclear", "unavailable"]).optional(),
  scope: z.object({ namespace: id, project: id.optional(), task: id.optional() }).strict(),
  evidence: z.object({ eventId: id, text: z.string().min(1).max(12000),
    adoptedAt: z.iso.datetime(), sessionId: id.optional() }).strict(),
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

// iii adds this field to internal invocations. Public HTTP schemas stay strict.
const workerMetadata = { _caller_worker_id: z.string().optional() };

export function registerSelectiveContextFunctions(
  sdk: ISdk, kv: StateKV,
  options: { namespace: string; judge: ContextJudge; captureJudge?: CaptureJudge; now?: () => string },
): void {
  const namespace = id.parse(options.namespace);
  const key = fingerprintId("ctx", namespace);
  const now = options.now ?? (() => new Date().toISOString());
  const read = async (): Promise<ContextKnowledgeCatalog> =>
    await kv.get<ContextKnowledgeCatalog>(KV.contextKnowledge, key)
      ?? { revision: 0, records: [], events: {} };

  const sameCapturedRule = (a: ContextKnowledge, b: ContextKnowledge) =>
    a.scope.namespace === b.scope.namespace && a.scope.project === b.scope.project
    && a.scope.task === b.scope.task && a.spans.length === 1 && b.spans.length === 1
    && a.spans[0]!.text === b.spans[0]!.text;
  const save = async (knowledge: ContextKnowledge, expectedRevision: number, fromCapture = false) => {
    if (knowledge.scope.namespace !== namespace) return { success: false, error: "namespace_mismatch" };
    if (Date.parse(knowledge.evidence.adoptedAt) > Date.parse(now())) {
      return { success: false, error: "future_evidence" };
    }
    return withKeyedLock(`context-knowledge:${key}`, async () => {
      const catalog = await read();
      const existing = catalog.records.find(r => r.id === knowledge.id);
      // Capture may retry an unavailable classification, but must not reactivate
      // withdrawn rules or overwrite reviewed knowledge.
      if (fromCapture && existing) {
        if (!sameCapturedRule(existing, knowledge)) return { success: false, error: "knowledge_changed" };
        if (existing.status !== "candidate" || existing.captureDisposition !== "unavailable"
          || knowledge.captureDisposition === "unavailable") {
          return { success: true, action: "existing", revision: catalog.revision, knowledgeId: existing.id, status: existing.status };
        }
      }
      const eventKey = fingerprintId("evt", knowledge.evidence.eventId);
      const digest = fingerprintId("change", JSON.stringify(knowledge));
      if (catalog.events[eventKey]) {
        return catalog.events[eventKey] === digest
          ? { success: true, action: "replayed", revision: catalog.revision }
          : { success: false, error: "event_conflict" };
      }
      if (catalog.revision !== expectedRevision) return { success: false, error: "revision_conflict", revision: catalog.revision };
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
      return { success: true, action: "saved", revision: next.revision, knowledgeId: knowledge.id, status: knowledge.status };
    });
  };

  sdk.registerFunction("mem::context-knowledge-put", async (input: unknown) => {
    const parsed = contextKnowledgePutSchema.extend(workerMetadata).safeParse(input);
    if (!parsed.success) return { success: false, error: "invalid_knowledge" };
    return save(parsed.data.knowledge, parsed.data.expectedRevision);
  });

  sdk.registerFunction("mem::context-knowledge-capture", async (input: unknown) => {
    const parsed = z.object({ sessionId: id, observationId: id, ...workerMetadata }).strict().safeParse(input);
    if (!parsed.success || !options.captureJudge) return { success: false, error: "capture_unavailable" };
    const { sessionId, observationId } = parsed.data;
    const source = await kv.get<RawObservation>(KV.observations(sessionId), observationId);
    const session = await kv.get<{ project?: string }>(KV.sessions, sessionId);
    if (!source || source.id !== observationId || source.sessionId !== sessionId
      || source.hookType !== "prompt_submit" || source.origin?.channel !== "user"
      || (source.raw as { explicitMemoryRequest?: unknown } | null)?.explicitMemoryRequest !== true) {
      return { success: false, error: "unverified_source" };
    }
    const text = explicitMemoryText(source.userPrompt);
    const project = id.safeParse(session?.project);
    if (!text || !project.success) return { success: false, error: "invalid_save_request" };
    const knowledgeId = fingerprintId("user-rule", JSON.stringify([namespace, project.data, text]));
    const catalog = await read();
    const existing = catalog.records.find(r => r.id === knowledgeId);
    if (existing) {
      if (existing.scope.namespace !== namespace || existing.scope.project !== project.data || existing.scope.task
        || existing.spans.length !== 1 || existing.spans[0]!.text !== text) {
        return { success: false, error: "knowledge_changed" };
      }
      if (existing.status !== "candidate" || existing.captureDisposition !== "unavailable") {
        return { success: true, action: "existing", knowledgeId, status: existing.status };
      }
    }
    const existingRules = catalog.records.filter(r => r.status === "active"
      && r.scope.namespace === namespace && (!r.scope.project || r.scope.project === project.data))
      .flatMap(r => r.spans.map(span => span.text));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposition: "project_rule" | "task_only" | "unclear" | "unavailable" = "unavailable";
    try {
      if (existingRules.join("\n").length > 6000) throw new Error("Capture comparison budget exceeded");
      disposition = await Promise.race([
        options.captureJudge(source.userPrompt!, existingRules, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Capture deadline exceeded")); }, 2500);
        }),
      ]);
    } catch { /* Preserve source as a candidate; unavailable judgment never activates it. */ }
    finally { if (timer) clearTimeout(timer); }
    const knowledge = knowledgeSchema.safeParse({
      id: knowledgeId, revision: fingerprintId("capture", observationId),
      status: disposition === "project_rule" ? "active" : "candidate",
      captureDisposition: disposition,
      scope: { namespace, project: project.data },
      evidence: { eventId: observationId, sessionId, text: source.userPrompt, adoptedAt: now() },
      spans: [{ id: "user-text", text }],
    });
    if (!knowledge.success) return { success: false, error: "invalid_save_request" };
    return { ...await save(knowledge.data, catalog.revision, true), disposition };
  });

  sdk.registerFunction("mem::selective-context", async (input: unknown) => {
    const parsed = selectiveContextSchema.extend(workerMetadata).safeParse(input);
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
