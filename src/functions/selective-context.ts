import type { IIIClient } from "iii-sdk";
import { z } from "zod";
import type { StateKV } from "../state/kv.js";
import type { ContextKnowledgeCatalog, RawObservation, Lesson, Session, SessionSummary, CompressedObservation, Memory } from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { selectContext, sameProjectScope, type ContextJudge, type ContextKnowledge } from "../state/selective-context.js";
import { explicitMemoryText, explicitReplacement, type CaptureJudge } from "../state/explicit-memory.js";
import { safeAudit } from "./audit.js";
import { knowledgeSchema } from "../state/context-knowledge-backup.js";
import { findContextLesson, searchContextLessons, searchAllLessons } from "./lessons.js";
import { stripPrivateData } from "./privacy.js";
import { getAgentId, isAgentScopeIsolated } from "../config.js";

const id = z.string().trim().min(1).max(200);

export const contextKnowledgePutSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  confirmedByUser: z.literal(true),
  knowledge: knowledgeSchema,
}).strict();

export const selectiveContextSchema = z.object({
  prompt: z.string().trim().min(1).max(12000),
  previous: z.string().max(8000).default(""),
  project: id.optional(), projectId: id.optional(), task: id.optional(),
  excludedIds: z.array(id).max(100).default([]),
  recallHistory: z.boolean().optional(), sessionId: id.optional(),
  excludedSessionIds: z.array(id).max(100).default([]),
  hermes: z.object({ sessionId: id, ownerId: id, visibility: z.enum(["private", "group"]),
    verifiedSessionIds: z.array(id).max(100).default([]) }).strict().optional(),
}).strict();

function completeSpan(text: string): string | null {
  const clean = text.split(/\s+/).join(" ").trim();
  if (!clean || clean.length <= 1200) return clean || null;
  const prefix = clean.slice(0, 1200);
  const ends = [...prefix.matchAll(/[。！？]|[.!?](?=\s|$)/g)];
  const end = ends.at(-1)?.index;
  return end === undefined ? null : prefix.slice(0, end + 1).trim();
}

function redactJudgeText(text: string): string {
  return stripPrivateData(text).replace(
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    "[REDACTED_SECRET]",
  );
}

function containsCredentials(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?[^\s"']{12,}/i.test(text);
}

async function historyCandidates(sdk: IIIClient, kv: StateKV, query: string, sessionId: string, ownerId: string | undefined,
  verifiedSessionIds: ReadonlySet<string>, excludedSessionIds: ReadonlySet<string>,
  excludedSourceIds: ReadonlySet<string>, includeSummaries: boolean) {
  const candidates: ContextKnowledge[] = [];
  const sources: Array<{ scope: string; key: string; version: string }> = [];
  const sessions = new Map<string, Session>();
  const search = await sdk.trigger({ function_id: "mem::smart-search", payload: {
    query, limit: 100, includeLessons: false, agentId: "*",
  } }) as { results?: Array<{ obsId: string; sessionId: string }> };
  const hits = (search.results ?? []).filter(hit => hit.sessionId !== sessionId
    && !excludedSessionIds.has(hit.sessionId));
  const telemetryHooks = new Set(["prompt_submit", "session_start", "session_end", "stop",
    "notification", "subagent_start", "subagent_stop", "task_completed", "pre_compact"]);
  let observationCount = 0;
  for (const hit of hits.filter(hit => hit.obsId.startsWith("obs_"))) {
    const session = sessions.get(hit.sessionId) ?? await kv.get<Session>(KV.sessions, hit.sessionId);
    if ((ownerId && (!session || (session.agentId && session.agentId !== ownerId)
      || (!session.agentId && !verifiedSessionIds.has(hit.sessionId))))) continue;
    if (session) sessions.set(hit.sessionId, session);
    const observation = await kv.get<CompressedObservation>(KV.observations(hit.sessionId), hit.obsId);
    if (!observation || observation.id !== hit.obsId || observation.sessionId !== hit.sessionId
      || (ownerId && observation.agentId && observation.agentId !== ownerId)
      || (includeSummaries && !(observation.origin?.channel === "agent"
        || (observation.origin?.channel === "tool" && observation.origin.detail === "conversation")))
      || (includeSummaries && !["decision", "discovery", "conversation"].includes(observation.type))
      || (includeSummaries && observation.type === "conversation" && observation.origin?.detail !== "conversation")
      || observation.type === "notification"
      || (observation.confidence === 0.3 && typeof observation.title === "string"
        && telemetryHooks.has(observation.title.split(":")[0]!.trim()))
      || containsCredentials(observation.narrative) || containsCredentials(observation.title || "")) continue;
    const span = completeSpan(observation.narrative);
    if (!span) continue;
    candidates.push({ id: `observation:${observation.id}`, revision: fingerprintId("observation", JSON.stringify(observation)),
      status: "active", scope: { namespace: "" }, sourceTitle: observation.title,
      evidence: { eventId: observation.id, sessionId: hit.sessionId, text: span, adoptedAt: observation.timestamp },
      spans: [{ id: "narrative", text: span }] });
    sources.push({ scope: KV.observations(hit.sessionId), key: observation.id, version: JSON.stringify(observation) });
    if (++observationCount >= 20) break;
  }
  let memoryCount = 0;
  for (const hit of hits.filter(hit => hit.obsId.startsWith("mem_"))) {
    const memory = await kv.get<Memory>(KV.memories, hit.obsId);
    if (!memory || memory.id !== hit.obsId || !memory.isLatest || !memory.content
      || (ownerId && ((memory.agentId && memory.agentId !== ownerId)
        || (!memory.agentId && (!memory.sessionIds?.length
          || !memory.sessionIds.every(id => verifiedSessionIds.has(id))))))
      || memory.sessionIds?.some(id => excludedSessionIds.has(id))
      || (includeSummaries && (memory.sourceObservationIds ?? []).length > 10)
      || memory.sourceObservationIds?.some(id => excludedSourceIds.has(id))
      || containsCredentials(memory.content) || containsCredentials(memory.title || "")) continue;
    if (ownerId && !memory.agentId && memory.sessionIds.length > 10) continue;
    const memorySessions = ownerId && !memory.agentId
      ? await Promise.all(memory.sessionIds.map(id => kv.get<Session>(KV.sessions, id))) : [];
    if (memorySessions.some(session => !session || (session.agentId && session.agentId !== ownerId))) continue;
    for (const session of memorySessions) {
      if (session) sources.push({ scope: KV.sessions, key: session.id, version: JSON.stringify(session) });
    }
    const span = completeSpan(memory.content);
    if (!span) continue;
    candidates.push({ id: `memory:${memory.id}`, revision: fingerprintId("memory", JSON.stringify(memory)),
      status: "active", scope: { namespace: "" }, sourceTitle: memory.title,
      evidence: { eventId: memory.id, text: span, adoptedAt: memory.updatedAt || memory.createdAt },
      spans: [{ id: "content", text: span }] });
    sources.push({ scope: KV.memories, key: memory.id, version: JSON.stringify(memory) });
    if (++memoryCount >= 10) break;
  }
  for (const session of includeSummaries ? sessions.values() : []) {
    if (session.status !== "completed") continue;
    const summary = await kv.get<SessionSummary>(KV.summaries, session.id);
    if (!summary || summary.sessionId !== session.id || summary.project !== session.project) continue;
    const span = completeSpan(summary.narrative);
    if (!span) continue;
    candidates.push({ id: `summary:${session.id}`, revision: fingerprintId("summary", JSON.stringify(summary)),
      status: "active", scope: { namespace: "" },
      evidence: { eventId: `summary:${session.id}`, sessionId: session.id, text: span, adoptedAt: summary.createdAt },
      spans: [{ id: "narrative", text: span }] });
    sources.push({ scope: KV.summaries, key: session.id, version: JSON.stringify(summary) });
  }
  for (const session of sessions.values()) {
    sources.push({ scope: KV.sessions, key: session.id, version: JSON.stringify(session) });
  }
  return { candidates, sources };
}

// iii adds this field to internal invocations. Public HTTP schemas stay strict.
const workerMetadata = { _caller_worker_id: z.string().optional() };

export function registerSelectiveContextFunctions(
  sdk: IIIClient, kv: StateKV,
  options: { namespace: string; judge: ContextJudge; captureJudge?: CaptureJudge; now?: () => string },
): void {
  const namespace = id.parse(options.namespace);
  const key = fingerprintId("ctx", namespace);
  const now = options.now ?? (() => new Date().toISOString());
  const read = async (): Promise<ContextKnowledgeCatalog> =>
    await kv.get<ContextKnowledgeCatalog>(KV.contextKnowledge, key)
      ?? { revision: 0, records: [], events: {} };

  const sameCapturedRule = (a: ContextKnowledge, b: ContextKnowledge) =>
    a.scope.namespace === b.scope.namespace && sameProjectScope(a.scope, b.scope)
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
        namespace,
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
    const knowledge = parsed.data.knowledge;
    if (knowledge.lessonId) {
      const source = knowledge.evidence.sessionId
        ? await kv.get<RawObservation>(KV.observations(knowledge.evidence.sessionId), knowledge.evidence.eventId) : null;
      const session = knowledge.evidence.sessionId
        ? await kv.get<{ contextProjectId?: string }>(KV.sessions, knowledge.evidence.sessionId) : null;
      const lesson = await kv.get<Lesson>(KV.lessons, knowledge.lessonId);
      if (!source || source.id !== knowledge.evidence.eventId || source.sessionId !== knowledge.evidence.sessionId
        || source.origin?.channel !== "user" || source.hookType !== "prompt_submit"
        || (source.raw as { explicitMemoryRequest?: unknown } | null)?.explicitMemoryRequest !== true
        || source.userPrompt !== knowledge.evidence.text || !knowledge.scope.projectId
        || session?.contextProjectId !== knowledge.scope.projectId
        || (source.raw as { contextProjectId?: unknown }).contextProjectId !== knowledge.scope.projectId
        || explicitMemoryText(source.userPrompt) !== lesson?.content
        || !lesson || lesson.deleted || lesson.project !== knowledge.scope.project
        || knowledge.spans.length !== 1 || knowledge.spans[0]!.text !== lesson.content) {
        return { success: false, error: "unverified_lesson_source" };
      }
    }
    return save(parsed.data.knowledge, parsed.data.expectedRevision);
  });

  const replace = async (source: RawObservation, project: string, projectId: string, change: { oldText: string; newText: string }) => {
    const catalog = await read();
    const inScope = (r: ContextKnowledge) => r.scope.namespace === namespace && sameProjectScope(r.scope, { project, projectId }) && !r.scope.task;
    const exact = (r: ContextKnowledge, text: string) => r.spans.length === 1 && r.spans[0]!.text === text;
    const matches = catalog.records.filter(r => inScope(r) && r.status === "active" && exact(r, change.oldText));
    if (matches.length !== 1) {
      // Replay only an intact, direct replacement pair, never an older link in a chain.
      const pairs = catalog.records.filter(r => inScope(r) && r.status === "superseded" && exact(r, change.oldText))
        .flatMap(old => catalog.records.filter(next => inScope(next) && next.status === "active"
          && exact(next, change.newText) && old.supersededBy === next.id
          && next.supersedes?.id === old.id && next.supersedes.revision === old.revision));
      if (matches.length === 0 && pairs.length === 1) {
        return { success: true, action: "existing", status: "active", knowledgeId: pairs[0]!.id };
      }
      return { success: false, error: matches.length ? "ambiguous_old_rule" : "old_rule_not_found" };
    }
    const old = matches[0]!;
    if (catalog.records.some(r => inScope(r) && r.id !== old.id && r.status === "active" && exact(r, change.newText))) {
      return { success: false, error: "new_rule_already_active" };
    }
    const otherRules = catalog.records.filter(r => r.id !== old.id && r.status === "active"
      && r.scope.namespace === namespace && ((!r.scope.project && !r.scope.projectId) || sameProjectScope(r.scope, { project, projectId })))
      .flatMap(r => r.spans.map(span => span.text));
    if (otherRules.join("\n").length > 6000) return { success: false, error: "comparison_budget" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The exact old rule was resolved mechanically. Judge only the new rule
      // against remaining rules; the original confirmation is preserved below.
      const disposition = await Promise.race([
        options.captureJudge!(`記住：${change.newText}`, otherRules, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Replacement deadline")); }, 2500);
        }),
      ]);
      if (disposition !== "project_rule") return { success: false, error: "replacement_needs_review", disposition };
    } catch { return { success: false, error: "replacement_unavailable" }; }
    finally { if (timer) clearTimeout(timer); }
    const next = knowledgeSchema.safeParse({
      id: fingerprintId("replacement", JSON.stringify([namespace, project, old.id, old.revision, source.id])),
      revision: fingerprintId("capture", source.id), status: "active", captureDisposition: "project_rule",
      scope: { ...old.scope }, supersedes: { id: old.id, revision: old.revision },
      evidence: { eventId: source.id, sessionId: source.sessionId, text: source.userPrompt, adoptedAt: now() },
      spans: [{ id: "user-text", text: change.newText }],
    });
    if (!next.success) return { success: false, error: "invalid_save_request" };
    return withKeyedLock(`context-knowledge:${key}`, async () => {
      const latest = await read();
      if (latest.revision !== catalog.revision) return { success: false, error: "revision_conflict" };
      const eventKey = fingerprintId("evt", source.id);
      if (latest.events[eventKey]) return { success: false, error: "event_conflict" };
      if (latest.records.length >= 12 || Object.keys(latest.events).length >= 256) return { success: false, error: "catalog_capacity" };
      await kv.set(KV.contextKnowledge, key, {
        namespace,
        revision: latest.revision + 1,
        records: [...latest.records.map(r => r.id === old.id ? { ...r, status: "superseded" as const, supersededBy: next.data.id } : r), next.data],
        events: { ...latest.events, [eventKey]: fingerprintId("change", JSON.stringify(next.data)) },
      } satisfies ContextKnowledgeCatalog);
      await safeAudit(kv, "context_knowledge_put", "mem::context-knowledge-capture", [old.id, next.data.id], {
        action: "replaced", evidenceEventId: source.id, previousRevision: old.revision, catalogRevision: latest.revision + 1,
      });
      return { success: true, action: "replaced", status: "active", knowledgeId: next.data.id, previousKnowledgeId: old.id };
    });
  };

  sdk.registerFunction("mem::context-knowledge-capture", async (input: unknown) => {
    const parsed = z.object({ sessionId: id, observationId: id, ...workerMetadata }).strict().safeParse(input);
    if (!parsed.success || !options.captureJudge) return { success: false, error: "capture_unavailable" };
    const { sessionId, observationId } = parsed.data;
    const source = await kv.get<RawObservation>(KV.observations(sessionId), observationId);
    const session = await kv.get<{ project?: string; contextProjectId?: string }>(KV.sessions, sessionId);
    if (!source || source.id !== observationId || source.sessionId !== sessionId
      || source.hookType !== "prompt_submit" || source.origin?.channel !== "user"
      || (source.raw as { explicitMemoryRequest?: unknown } | null)?.explicitMemoryRequest !== true) {
      return { success: false, error: "unverified_source" };
    }
    const project = id.safeParse(session?.project);
    if (!project.success) return { success: false, error: "invalid_save_request" };
    const projectId = id.safeParse(session?.contextProjectId);
    if (!projectId.success || (source.raw as { contextProjectId?: unknown }).contextProjectId !== projectId.data) {
      return { success: false, error: "project_scope_mismatch" };
    }
    const replacement = explicitReplacement(source.userPrompt);
    if (replacement) return replace(source, project.data, projectId.data, replacement);
    const text = explicitMemoryText(source.userPrompt);
    if (!text) return { success: false, error: "invalid_save_request" };
    const knowledgeId = fingerprintId("user-rule", JSON.stringify([namespace, projectId.data, text]));
    const catalog = await read();
    const activeMatches = catalog.records.filter(r => r.status === "active" && r.scope.namespace === namespace
      && sameProjectScope(r.scope, { project: project.data, projectId: projectId.data }) && !r.scope.task && r.spans.length === 1 && r.spans[0]!.text === text);
    if (activeMatches.length > 1) return { success: false, error: "ambiguous_existing_rule" };
    const existing = activeMatches[0] ?? catalog.records.find(r => r.id === knowledgeId);
    if (existing) {
      if (existing.scope.namespace !== namespace || !sameProjectScope(existing.scope, { project: project.data, projectId: projectId.data }) || existing.scope.task
        || existing.spans.length !== 1 || existing.spans[0]!.text !== text) {
        return { success: false, error: "knowledge_changed" };
      }
      if (existing.status !== "candidate" || existing.captureDisposition !== "unavailable") {
        return { success: true, action: "existing", knowledgeId: existing.id, status: existing.status };
      }
    }
    const existingRules = catalog.records.filter(r => r.status === "active"
      && r.scope.namespace === namespace && ((!r.scope.project && !r.scope.projectId) || sameProjectScope(r.scope, { project: project.data, projectId: projectId.data })))
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
    const lesson = await findContextLesson(kv, text, project.data);
    const knowledge = knowledgeSchema.safeParse({
      id: knowledgeId, revision: fingerprintId("capture", observationId),
      ...(lesson ? { lessonId: lesson.id } : {}),
      status: disposition === "project_rule" ? "active" : "candidate",
      captureDisposition: disposition,
      scope: { namespace, project: project.data, projectId: projectId.data },
      evidence: { eventId: observationId, sessionId, text: source.userPrompt, adoptedAt: now() },
      spans: [{ id: "user-text", text }],
    });
    if (!knowledge.success) return { success: false, error: "invalid_save_request" };
    return { ...await save(knowledge.data, catalog.revision, true), disposition };
  });

  sdk.registerFunction("mem::selective-context", async (input: unknown) => {
    const parsed = selectiveContextSchema.extend(workerMetadata).safeParse(input);
    if (!parsed.success) return { status: "unavailable", spans: [], error: "invalid_request" };
    const hermes = parsed.data.hermes;
    if (parsed.data.recallHistory && !parsed.data.sessionId) return { status: "unavailable", spans: [], error: "invalid_request" };
    if (hermes && parsed.data.sessionId && parsed.data.sessionId !== hermes.sessionId) {
      return { status: "unavailable", spans: [], error: "invalid_request" };
    }
    if ((hermes || parsed.data.recallHistory)
      && (containsCredentials(parsed.data.prompt) || containsCredentials(parsed.data.previous))) {
      return { status: "unavailable", spans: [], error: "credential_input" };
    }
    const isolatedAgent = parsed.data.recallHistory && isAgentScopeIsolated() ? getAgentId() : undefined;
    if (parsed.data.recallHistory && isAgentScopeIsolated() && !isolatedAgent) {
      return { status: "unavailable", spans: [], error: "agent_scope_unavailable" };
    }
    if (hermes && hermes.visibility !== "private") return { status: "empty", spans: [] };
    if (hermes && /\b(?:do not (?:send|share|upload|transmit)|local only)\b|不要外傳|不得外送|禁止外送|只限本機/i
      .test(`${parsed.data.prompt}\n${parsed.data.previous}`)) return { status: "empty", spans: [] };
    const currentSession = hermes ? await kv.get<Session>(KV.sessions, hermes.sessionId) : null;
    const verifiedSessionIds = new Set(hermes?.verifiedSessionIds ?? []);
    if (hermes && (!currentSession || (currentSession.agentId && currentSession.agentId !== hermes.ownerId)
      || (!currentSession.agentId && !verifiedSessionIds.has(hermes.sessionId)))) {
      return { status: "unavailable", spans: [], error: "unverified_session" };
    }
    const excludedSessions = new Set([hermes?.sessionId, parsed.data.sessionId, ...(parsed.data.excludedSessionIds ?? [])]
      .filter((value): value is string => Boolean(value)));
    const deadline = Date.now() + (hermes || parsed.data.recallHistory ? 6500 : 1500);
    const run = async () => {
      const catalog = await read();
      const excludedSourceIds = new Set<string>();
      if (hermes || parsed.data.recallHistory) {
        const sourceLists = await Promise.all([...excludedSessions].map(id =>
          kv.list<{ id: string }>(KV.observations(id))));
        for (const source of sourceLists.flat()) excludedSourceIds.add(source.id);
      }
      const scoped = catalog.records.filter(r => r.status === "active" && r.scope.namespace === namespace
        && ((!r.scope.project && !r.scope.projectId) || (r.scope.projectId && r.scope.projectId === parsed.data.projectId))
        && (!r.scope.task || r.scope.task === parsed.data.task));
      const lessons = await searchContextLessons(kv, `${parsed.data.prompt}\n${parsed.data.previous}`,
        new Set(scoped.flatMap(r => r.lessonId ? [r.lessonId] : [])));
      const lessonIds = new Set(lessons.map(l => l.id));
      const records = catalog.records.filter(r => !r.lessonId || lessonIds.has(r.lessonId));
      const validRecords: ContextKnowledge[] = [];
      const sourceVersions = new Map<string, string>();
      for (const record of records) {
        if (record.lessonId) {
          const lesson = await kv.get<Lesson>(KV.lessons, record.lessonId);
          if (!lesson || lesson.deleted || lesson.project !== record.scope.project
            || record.spans.length !== 1 || record.spans[0]!.text !== lesson.content) continue;
          sourceVersions.set(lesson.id, JSON.stringify(lesson));
        }
        validRecords.push(record);
      }
      // Lessons the catalog already governs keep the catalog's scope; every
      // other lesson is a candidate regardless of project, and the judge
      // decides relevance. Same-project lessons are ordered first so the
      // candidate budget favours them.
      const governed = new Set(catalog.records.flatMap(r => r.lessonId ? [r.lessonId] : []));
      const ungoverned = (await searchAllLessons(kv, `${parsed.data.prompt}\n${parsed.data.previous}`))
        .filter(l => !governed.has(l.id));
      const corpus = (hermes ? (await Promise.all(ungoverned.map(async lesson => {
        if (!currentSession?.startedAt || lesson.createdAt >= currentSession.startedAt
          || (lesson.sourceIds ?? []).length > 4) return null;
        return lesson;
      }))).filter((lesson): lesson is Lesson => lesson !== null) : ungoverned)
        .filter(lesson => !(hermes || parsed.data.recallHistory)
          || !lesson.sourceIds?.some(id => excludedSessions.has(id) || excludedSourceIds.has(id)));
      const sameProject = (l: Lesson) => l.project === parsed.data.project || l.project === parsed.data.projectId;
      const lessonRecordsForJudge: ContextKnowledge[] = [
        ...corpus.filter(sameProject), ...corpus.filter(l => !sameProject(l)),
      ].map(l => ({
        id: `lesson:${l.id}`, revision: fingerprintId("lesson", JSON.stringify([l.id, l.updatedAt])),
        lessonId: l.id, status: "active" as const,
        scope: { namespace },
        evidence: { eventId: l.id, text: l.content, adoptedAt: l.createdAt },
        spans: [{ id: "lesson", text: hermes ? completeSpan(l.content) ?? "" : l.content.slice(0, 1200) }],
      })).filter(record => record.spans[0]!.text);
      for (const l of corpus) sourceVersions.set(l.id, JSON.stringify(l));
      const historical = hermes || parsed.data.recallHistory
        ? await historyCandidates(sdk, kv, `${parsed.data.prompt}\n${parsed.data.previous}`,
          hermes?.sessionId ?? parsed.data.sessionId!, hermes?.ownerId ?? isolatedAgent,
          verifiedSessionIds, excludedSessions, excludedSourceIds, Boolean(hermes))
        : { candidates: [], sources: [] };
      const sourcePools = [validRecords.filter(record => !record.evidence.sessionId
        || !excludedSessions.has(record.evidence.sessionId)),
        lessonRecordsForJudge,
        historical.candidates.filter(record => record.id.startsWith("memory:")),
        historical.candidates.filter(record => !record.id.startsWith("memory:"))];
      const candidates = hermes || parsed.data.recallHistory
        ? Array.from({ length: Math.max(...sourcePools.map(pool => pool.length)) }, (_, index) =>
          sourcePools.flatMap(pool => pool[index] ? [{ ...pool[index]!, scope: { namespace } }] : [])).flat()
        : [...validRecords, ...lessonRecordsForJudge];
      const eligibleCandidates = candidates.filter(record => !excludedSourceIds.has(record.evidence.eventId)
        && (!(hermes || parsed.data.recallHistory) || !containsCredentials(record.evidence.text)));
      const judgeCandidates = hermes || parsed.data.recallHistory ? eligibleCandidates.map(record => ({ ...record,
        evidence: { ...record.evidence, text: redactJudgeText(record.evidence.text) },
        spans: record.spans.map(span => ({ ...span, text: redactJudgeText(span.text) })),
      })) : eligibleCandidates;
      const request = { project: parsed.data.project, projectId: parsed.data.projectId, task: parsed.data.task,
        excludedIds: parsed.data.excludedIds, namespace, asOf: now(),
        prompt: hermes || parsed.data.recallHistory ? redactJudgeText(parsed.data.prompt) : parsed.data.prompt,
        previous: hermes || parsed.data.recallHistory ? redactJudgeText(parsed.data.previous) : parsed.data.previous };
      if ((hermes || parsed.data.recallHistory) && Date.now() >= deadline) return { status: "unavailable", spans: [] };
      const judgeStarted = Date.now();
      const result = await selectContext(request, judgeCandidates, options.judge,
        hermes || parsed.data.recallHistory ? { timeoutMs: Math.max(1, deadline - Date.now()),
          preserveCandidateOrder: true, sourceMetadata: true } : {});
      const candidateCounts = { catalog: validRecords.length, lessons: lessonRecordsForJudge.length,
        ...(hermes || parsed.data.recallHistory ? { historical: historical.candidates.length } : {}) };
      const latest = await read();
      if (latest.revision !== catalog.revision) {
        return { status: "unavailable", spans: [], error: "knowledge_changed" };
      }
      for (const [lessonId, version] of sourceVersions) {
        if (JSON.stringify(await kv.get<Lesson>(KV.lessons, lessonId)) !== version) {
          return { status: "unavailable", spans: [], error: "knowledge_changed" };
        }
      }
      for (const source of historical.sources) {
        if (JSON.stringify(await kv.get(source.scope, source.key)) !== source.version) {
          return { status: "unavailable", spans: [], error: "knowledge_changed" };
        }
      }
      if (hermes && JSON.stringify(await kv.get(KV.sessions, hermes.sessionId)) !== JSON.stringify(currentSession)) {
        return { status: "unavailable", spans: [], error: "knowledge_changed" };
      }
      return { ...result, catalogRevision: catalog.revision, candidates: candidateCounts,
        ...(hermes || parsed.data.recallHistory ? { timings: {
          retrievalMs: judgeStarted - (deadline - 6500), judgeMs: Date.now() - judgeStarted,
          totalMs: 6500 - (deadline - Date.now()),
        } } : {}) };
    };
    if (!hermes && !parsed.data.recallHistory) return run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Historical recall deadline")), Math.max(1, deadline - Date.now()));
      })]);
    } catch {
      return { status: "unavailable", spans: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
