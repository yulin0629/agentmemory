import { TriggerAction, type IIIClient } from "iii-sdk";
import type { CompressedObservation, HookPayload, Session } from "../types.js";
import { listScopeKeys, type StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { afterKeyedLock, isKeyedLockHeld, withKeyedLock } from "../state/keyed-mutex.js";
import { addSessionToProjectIndex } from "../state/session-index.js";
import { lookupObservationSession } from "../state/obs-index.js";
import { requestSummaryRefresh } from "./summary-state.js";
import { clearSessionFinalize } from "./session-finalize.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";

const SEGMENT_SEPARATOR = "--seg-";
const MAX_SESSION_ID_LENGTH = 200;

function parseSegmentIndex(sessionId: string, rootSessionId: string): number {
  const prefix = `${rootSessionId}${SEGMENT_SEPARATOR}`;
  if (!sessionId.startsWith(prefix)) return 1;
  const parsed = Number.parseInt(sessionId.slice(prefix.length), 10);
  return Number.isSafeInteger(parsed) && parsed >= 2 ? parsed : 1;
}

function nextSegmentId(rootSessionId: string, currentSessionId: string): string | null {
  const candidate = `${rootSessionId}${SEGMENT_SEPARATOR}${parseSegmentIndex(currentSessionId, rootSessionId) + 1}`;
  return candidate.length <= MAX_SESSION_ID_LENGTH ? candidate : null;
}

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = `obs:${sessionId}`;
  return isKeyedLockHeld(key) ? fn() : withKeyedLock(key, fn);
}

export async function resolveActiveSessionId(kv: StateKV, sessionId: string): Promise<string> {
  const session = await kv.get<Session>(KV.sessions, sessionId);
  return session?.activeSegmentId || sessionId;
}

export function preserveRolloverState(existing: Session | null): Partial<Session> {
  if (!existing) return {};
  return {
    ...(existing.activeSegmentId ? {
      startedAt: existing.startedAt,
      ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
      ...(existing.endedAt ? { endedAt: existing.endedAt } : {}),
      status: existing.status,
      activeSegmentId: existing.activeSegmentId,
    } : {}),
    ...(existing.contextProjectId ? { contextProjectId: existing.contextProjectId } : {}),
  };
}

export async function expandSessionFamily(
  kv: StateKV,
  sessionIds: Iterable<string>,
  preloaded?: ReadonlyMap<string, Session | null>,
): Promise<Set<string>> {
  const uniqueIds = [...new Set(sessionIds)];
  const expanded = new Set<string>(uniqueIds);
  if (uniqueIds.length === 0) return expanded;

  const sessionMap = new Map<string, Session | null>(preloaded ?? []);
  const uncachedIds = uniqueIds.filter((id) => !sessionMap.has(id));
  if (uncachedIds.length > 0) {
    const fetched = await Promise.all(uncachedIds.map((id) => kv.get<Session>(KV.sessions, id)));
    for (let i = 0; i < uncachedIds.length; i++) {
      sessionMap.set(uncachedIds[i]!, fetched[i] ?? null);
    }
  }

  const rootIds = new Set<string>();
  for (const id of uniqueIds) {
    const session = sessionMap.get(id);
    rootIds.add(session?.parentSessionId ?? id);
  }
  const uncachedRoots = [...rootIds].filter((id) => !sessionMap.has(id));
  if (uncachedRoots.length > 0) {
    const fetched = await Promise.all(uncachedRoots.map((id) => kv.get<Session>(KV.sessions, id)));
    for (let i = 0; i < uncachedRoots.length; i++) {
      sessionMap.set(uncachedRoots[i]!, fetched[i] ?? null);
    }
  }

  for (const rootId of rootIds) {
    const root = sessionMap.get(rootId);
    if (!root?.activeSegmentId) continue;
    expanded.add(rootId);
    expanded.add(root.activeSegmentId);
    const maxIndex = parseSegmentIndex(root.activeSegmentId, rootId);
    for (let i = 2; i <= maxIndex; i++) {
      expanded.add(`${rootId}${SEGMENT_SEPARATOR}${i}`);
    }
  }
  return expanded;
}

export async function findObservationInSessionFamily(
  kv: StateKV,
  rootSessionId: string,
  activeSegmentId: string,
  obsId: string,
): Promise<{ sessionId: string; observation: CompressedObservation } | null> {
  return withSessionLock(activeSegmentId, async () => {
    if (activeSegmentId === rootSessionId) {
      const direct = await kv.get<CompressedObservation>(KV.observations(rootSessionId), obsId);
      return direct ? { sessionId: rootSessionId, observation: direct } : null;
    }

    const [direct, indexedSid, inRoot] = await Promise.all([
      kv.get<CompressedObservation>(KV.observations(activeSegmentId), obsId),
      lookupObservationSession(kv, obsId),
      kv.get<CompressedObservation>(KV.observations(rootSessionId), obsId),
    ]);
    if (direct) return { sessionId: activeSegmentId, observation: direct };

    if (
      indexedSid &&
      indexedSid !== activeSegmentId &&
      indexedSid.startsWith(`${rootSessionId}${SEGMENT_SEPARATOR}`)
    ) {
      const [found, segSession] = await Promise.all([
        kv.get<CompressedObservation>(KV.observations(indexedSid), obsId),
        kv.get<Session>(KV.sessions, indexedSid),
      ]);
      if (found && segSession?.parentSessionId === rootSessionId) {
        return { sessionId: indexedSid, observation: found };
      }
    }

    return inRoot ? { sessionId: rootSessionId, observation: inRoot } : null;
  });
}

export interface WritableSegmentContext {
  sessionId: string;
  existingSession: Session | null;
  existing: CompressedObservation[];
}

export type WritableSegmentResult<T> =
  | { kind: "duplicate"; sessionId: string; observation: CompressedObservation }
  | { kind: "cap_reached"; error: string }
  | { kind: "written"; value: T };

export async function withWritableSegment<T>(
  options: {
    sdk: IIIClient;
    kv: StateKV;
    rootSessionId: string;
    rootSession: Session | null;
    obsId: string;
    checkDuplicate: boolean;
    maxObservationsPerSession?: number;
    payload: HookPayload;
    contextProjectId?: string;
  },
  writeFn: (ctx: WritableSegmentContext) => Promise<T>,
): Promise<WritableSegmentResult<T>> {
  const {
    sdk,
    kv,
    rootSessionId,
    rootSession,
    obsId,
    checkDuplicate,
    maxObservationsPerSession,
    payload,
    contextProjectId,
  } = options;
  const currentSessionId = rootSession?.activeSegmentId || rootSessionId;

  if (checkDuplicate) {
    const stored = await findObservationInSessionFamily(kv, rootSessionId, currentSessionId, obsId);
    if (stored) return { kind: "duplicate", sessionId: stored.sessionId, observation: stored.observation };
  }

  const cap = maxObservationsPerSession && maxObservationsPerSession > 0 ? maxObservationsPerSession : 0;
  let sealed = false;
  let existingCount = 0;
  let nextId: string | null = null;
  let nowIso = "";

  // debt: ceiling: ~1500-2000 obs (~8 MiB SESSION_SOURCE_MAX_BYTES), upgrade: add byte-budget rollover check if any segment hits source_unavailable
  const attempt = await withSessionLock(currentSessionId, async () => {
    const existingSession = currentSessionId === rootSessionId
      ? rootSession
      : await kv.get<Session>(KV.sessions, currentSessionId);

    let full = false;
    let existing: CompressedObservation[] | undefined;

    if (cap > 0 && existingSession && (existingSession.observationCount ?? 0) >= cap) {
      const keyCount = (await listScopeKeys(kv, KV.observations(currentSessionId))).length;
      if (keyCount >= cap) {
        full = true;
        existingCount = keyCount;
      }
    }

    if (!full) {
      existing = await kv.list<CompressedObservation>(KV.observations(currentSessionId));
      if (cap > 0 && existing.length >= cap) {
        full = true;
        existingCount = existing.length;
      }
    }

    if (!full) {
      return {
        rolled: false as const,
        value: await writeFn({ sessionId: currentSessionId, existingSession, existing: existing! }),
      };
    }

    nextId = nextSegmentId(rootSessionId, currentSessionId);
    if (!nextId) {
      return { rolled: "cap_reached" as const };
    }

    nowIso = new Date().toISOString();
    if (existingSession && existingSession.status !== "completed") {
      await requestSummaryRefresh(kv, currentSessionId);
      await kv.update(KV.sessions, currentSessionId, [
        { type: "set", path: "endedAt", value: nowIso },
        { type: "set", path: "status", value: "completed" },
      ]);
      sealed = true;
    }
    return { rolled: true as const };
  });

  if (attempt.rolled === false) {
    return { kind: "written", value: attempt.value };
  }
  if (attempt.rolled === "cap_reached" || !nextId) {
    return { kind: "cap_reached", error: `Session observation limit reached (${cap})` };
  }

  const targetNextId: string = nextId;
  const project = rootSession?.project || payload.project;
  const cwd = rootSession?.cwd || payload.cwd;
  const inheritedAgentId = rootSession ? rootSession.agentId : getAgentId();
  const inheritedContextProjectId = rootSession?.contextProjectId ?? contextProjectId;

  const nextSession: Session = {
    id: targetNextId,
    project,
    cwd,
    startedAt: nowIso,
    updatedAt: nowIso,
    status: "active",
    observationCount: 0,
    parentSessionId: rootSessionId,
    ...(inheritedContextProjectId ? { contextProjectId: inheritedContextProjectId } : {}),
    ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
    ...(rootSession?.tags ? { tags: [...rootSession.tags] } : {}),
  };

  if (sealed) {
    afterKeyedLock(`obs:${rootSessionId}`, async () => {
      await clearSessionFinalize(kv, currentSessionId).catch(() => {});
      try {
        await sdk.trigger({
          function_id: "event::session::stopped",
          payload: { sessionId: currentSessionId },
          action: TriggerAction.Void(),
        });
      } catch (err) {
        logger.warn("rollover session-stopped trigger failed", {
          sessionId: currentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  const value = await withSessionLock(targetNextId, async () => {
    await kv.set(KV.sessions, targetNextId, nextSession);
    await addSessionToProjectIndex(kv, project, {
      id: targetNextId,
      startedAt: nowIso,
      ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
    }).catch((err) => {
      logger.warn("session index update failed", {
        sessionId: targetNextId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (rootSession) {
      await kv.update(KV.sessions, rootSessionId, [
        { type: "set", path: "activeSegmentId", value: targetNextId },
      ]);
    } else {
      await kv.set(KV.sessions, rootSessionId, {
        id: rootSessionId,
        project,
        cwd,
        startedAt: payload.timestamp ?? nowIso,
        updatedAt: nowIso,
        endedAt: nowIso,
        status: "completed",
        observationCount: existingCount,
        activeSegmentId: targetNextId,
        ...(inheritedContextProjectId ? { contextProjectId: inheritedContextProjectId } : {}),
        ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
      } satisfies Session);
    }

    return writeFn({ sessionId: targetNextId, existingSession: nextSession, existing: [] });
  });

  return { kind: "written", value };
}
