import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { StateKV } from "./kv.js";
import { KV, fingerprintId } from "./schema.js";
import { withKeyedLock } from "./keyed-mutex.js";
import type { ContextKnowledgeBackup, ContextKnowledgeCatalog } from "../types.js";
import { sameProjectScope } from "./selective-context.js";

const id = z.string().trim().min(1).max(200);
export const knowledgeSchema = z.object({
  id, revision: id,
  status: z.enum(["candidate", "active", "superseded", "retracted"]),
  captureDisposition: z.enum(["project_rule", "task_only", "unclear", "unavailable"]).optional(),
  supersedes: z.object({ id, revision: id }).strict().optional(), supersededBy: id.optional(),
  scope: z.object({ namespace: id, project: id.optional(), projectId: id.optional(), task: id.optional() }).strict(),
  evidence: z.object({ eventId: id, text: z.string().min(1).max(12000), adoptedAt: z.iso.datetime(), sessionId: id.optional() }).strict(),
  spans: z.array(z.object({ id, text: z.string().trim().min(1).max(1200) }).strict()).min(1).max(4),
}).strict().refine(r => r.spans.every(s => r.evidence.text.includes(s.text)), "Spans must match evidence")
  .refine(r => new Set(r.spans.map(s => s.id)).size === r.spans.length, "Span IDs must be unique");

const backupsSchema = z.array(z.object({
  namespace: id,
  catalog: z.object({ namespace: id.optional(), revision: z.number().int().nonnegative(),
    records: z.array(knowledgeSchema).max(12), events: z.record(z.string(), z.string()),
  }).strict(),
}).strict()).superRefine((entries, ctx) => {
  if (new Set(entries.map(e => e.namespace)).size !== entries.length) ctx.addIssue({ code: "custom", message: "Duplicate namespaces" });
  for (const { namespace, catalog } of entries) {
    if ((catalog.namespace && catalog.namespace !== namespace) || Object.keys(catalog.events).length > 256
      || catalog.records.some(r => r.scope.namespace !== namespace)
      || new Set(catalog.records.map(r => r.id)).size !== catalog.records.length) {
      ctx.addIssue({ code: "custom", message: "Invalid context catalog" });
    }
    const records = new Map(catalog.records.map(r => [r.id, r]));
    for (const r of catalog.records) {
      if (r.supersedes) {
        const old = records.get(r.supersedes.id);
        if (!old || old.revision !== r.supersedes.revision || old.status !== "superseded" || old.supersededBy !== r.id
          || !sameProjectScope(old.scope, r.scope) || old.scope.task !== r.scope.task) ctx.addIssue({ code: "custom", message: "Broken replacement link" });
      }
      if (r.supersededBy && records.get(r.supersededBy)?.supersedes?.id !== r.id) {
        ctx.addIssue({ code: "custom", message: "Broken successor link" });
      }
      const visited = new Set<string>();
      let next: typeof r | undefined = r;
      while (next) {
        if (visited.has(next.id)) { ctx.addIssue({ code: "custom", message: "Cyclic replacement links" }); break; }
        visited.add(next.id);
        next = next.supersededBy ? records.get(next.supersededBy) : undefined;
      }
    }
  }
});

export function parseContextKnowledgeBackups(value: unknown): ContextKnowledgeBackup[] {
  return backupsSchema.parse(value ?? []);
}

export async function exportContextKnowledge(kv: StateKV): Promise<ContextKnowledgeBackup[]> {
  const catalogs = await kv.list<ContextKnowledgeCatalog>(KV.contextKnowledge);
  return parseContextKnowledgeBackups(catalogs.map(catalog => ({
    namespace: catalog.namespace ?? catalog.records[0]?.scope.namespace, catalog,
  })));
}

function sameContent(a: ContextKnowledgeCatalog, b: ContextKnowledgeCatalog): boolean {
  return isDeepStrictEqual(a.records, b.records) && isDeepStrictEqual(a.events, b.events);
}

export async function restoreContextKnowledge(kv: StateKV, entries: ContextKnowledgeBackup[], strategy: string): Promise<void> {
  if (!["merge", "replace", "skip"].includes(strategy)) throw new Error("Invalid context import strategy");
  // Preflight ordinary conflicts before mutating any namespace. Like the existing
  // importer, this is not a transaction across unrelated KV namespaces.
  if (strategy === "merge") for (const entry of entries) {
    const current = await kv.get<ContextKnowledgeCatalog>(KV.contextKnowledge, fingerprintId("ctx", entry.namespace));
    if (current && !sameContent(current, entry.catalog)) throw new Error(`Context namespace conflict: ${entry.namespace}; choose replace or skip`);
  }
  for (const entry of entries) {
    const key = fingerprintId("ctx", entry.namespace);
    await withKeyedLock(`context-knowledge:${key}`, async () => {
      const current = await kv.get<ContextKnowledgeCatalog>(KV.contextKnowledge, key);
      if (current && (strategy === "skip" || sameContent(current, entry.catalog))) return;
      if (current && strategy === "merge") throw new Error(`Context namespace changed: ${entry.namespace}`);
      await kv.set(KV.contextKnowledge, key, { ...entry.catalog, namespace: entry.namespace,
        revision: Math.max(current?.revision ?? 0, entry.catalog.revision) + 1 });
    });
  }
}
