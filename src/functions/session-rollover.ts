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
const MAX_ROLLOVER_HOPS = 1000;

function hasValidProjectAndCwd(
  project: unknown,
  cwd: unknown,
): { project: string; cwd: string } | null {
  if (
    typeof project === "string" &&
    project.trim().length > 0 &&
    typeof cwd === "string" &&
    cwd.trim().length > 0
  ) {
    return { project, cwd };
  }
  return null;
}

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

export function preserveRolloverState(existing: Session | null, project?: string): Partial<Session> {
  if (!existing) return {};
  return {
    ...(existing.activeSegmentId ? {
      startedAt: existing.startedAt,
      ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
      ...(existing.endedAt ? { endedAt: existing.endedAt } : {}),
      status: existing.status,
      activeSegmentId: existing.activeSegmentId,
    } : {}),
    ...(existing.contextProjectId && (project === undefined || existing.project === project)
      ? { contextProjectId: existing.contextProjectId }
      : {}),
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
  | { kind: "cap_reached"; error: string }
  | { kind: "written"; value: T };

export async function withWritableSegment<T>(
  options: {
    sdk: IIIClient;
    kv: StateKV;
    rootSessionId: string;
    rootSession: Session | null;
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
    maxObservationsPerSession,
    payload,
    contextProjectId,
  } = options;
  const cap = maxObservationsPerSession && maxObservationsPerSession > 0 ? maxObservationsPerSession : 0;
  let liveRoot = options.rootSession;
  let currentSessionId = liveRoot?.activeSegmentId || rootSessionId;
  let pendingRootPointer: string | null = null;
  let rootObsCount = liveRoot?.observationCount ?? 0;
  let hops = 0;

  const ensureRootPointsTo = async (
    targetId: string,
    nowIso: string,
    project: string,
    cwd: string,
    fallback?: { agentId?: string; contextProjectId?: string },
  ) => {
    if (liveRoot) {
      await kv.update(KV.sessions, rootSessionId, [
        { type: "set", path: "activeSegmentId", value: targetId },
      ]);
      liveRoot = { ...liveRoot, activeSegmentId: targetId };
      return;
    }
    const inheritedAgentId = fallback?.agentId ?? getAgentId();
    const inheritedContextProjectId = fallback?.contextProjectId ?? contextProjectId;
    const rootStartedAt = payload.timestamp ?? nowIso;
    const createdRoot: Session = {
      id: rootSessionId,
      project,
      cwd,
      startedAt: rootStartedAt,
      updatedAt: nowIso,
      endedAt: nowIso,
      status: "completed",
      observationCount: rootObsCount,
      activeSegmentId: targetId,
      ...(inheritedContextProjectId ? { contextProjectId: inheritedContextProjectId } : {}),
      ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
    };
    await kv.set(KV.sessions, rootSessionId, createdRoot);
    await addSessionToProjectIndex(kv, project, {
      id: rootSessionId,
      startedAt: rootStartedAt,
      ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
    }).catch((err) => {
      logger.warn("session index update failed", {
        sessionId: rootSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    liveRoot = createdRoot;
  };

  while (hops < MAX_ROLLOVER_HOPS) {
    hops++;

    type AttemptResult =
      | { kind: "written"; value: T }
      | { kind: "cap_reached" }
      | {
          kind: "rollover";
          nextId: string;
          nowIso: string;
          sealed: boolean;
          existingCount: number;
          project: string;
          cwd: string;
        };

    // debt: ceiling: ~1500-2000 obs (~8 MiB SESSION_SOURCE_MAX_BYTES), upgrade: add byte-budget rollover check if any segment hits source_unavailable
    const attempt: AttemptResult = await withSessionLock(currentSessionId, async () => {
      const existingSession = currentSessionId === rootSessionId
        ? liveRoot
        : await kv.get<Session>(KV.sessions, currentSessionId);

      let full = false;
      let existingCount = 0;
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
        if (pendingRootPointer) {
          const meta = hasValidProjectAndCwd(
            liveRoot?.project || existingSession?.project || payload.project,
            liveRoot?.cwd || existingSession?.cwd || payload.cwd,
          );
          if (meta) {
            await ensureRootPointsTo(
              pendingRootPointer,
              new Date().toISOString(),
              meta.project,
              meta.cwd,
              {
                agentId: existingSession?.agentId,
                contextProjectId: existingSession?.contextProjectId,
              },
            );
            pendingRootPointer = null;
          }
        }
        return {
          kind: "written",
          value: await writeFn({ sessionId: currentSessionId, existingSession, existing: existing! }),
        };
      }

      const meta = hasValidProjectAndCwd(
        liveRoot?.project || existingSession?.project || payload.project,
        liveRoot?.cwd || existingSession?.cwd || payload.cwd,
      );
      if (!meta) {
        return { kind: "cap_reached" };
      }

      const nextId = nextSegmentId(rootSessionId, currentSessionId);
      if (!nextId) {
        return { kind: "cap_reached" };
      }

      const nowIso = new Date().toISOString();
      let sealed = false;
      if (existingSession && existingSession.status !== "completed") {
        await requestSummaryRefresh(kv, currentSessionId);
        await kv.update(KV.sessions, currentSessionId, [
          { type: "set", path: "endedAt", value: nowIso },
          { type: "set", path: "status", value: "completed" },
        ]);
        sealed = true;
      }
      return {
        kind: "rollover",
        nextId,
        nowIso,
        sealed,
        existingCount,
        project: meta.project,
        cwd: meta.cwd,
      };
    });

    if (attempt.kind === "written") {
      return { kind: "written", value: attempt.value };
    }
    if (attempt.kind === "cap_reached") {
      return { kind: "cap_reached", error: `Session observation limit reached (${cap})` };
    }

    if (currentSessionId === rootSessionId) {
      rootObsCount = attempt.existingCount;
    }

    if (attempt.sealed) {
      const sealedSessionId = currentSessionId;
      const notifySealed = async () => {
        await clearSessionFinalize(kv, sealedSessionId).catch(() => {});
        try {
          await sdk.trigger({
            function_id: "event::session::stopped",
            payload: { sessionId: sealedSessionId },
            action: TriggerAction.Void(),
          });
        } catch (err) {
          logger.warn("rollover session-stopped trigger failed", {
            sessionId: sealedSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      if (!afterKeyedLock(`obs:${rootSessionId}`, notifySealed)) {
        logger.warn("rollover called without root lock; running seal notification immediately", {
          rootSessionId,
          sessionId: sealedSessionId,
        });
        void notifySealed();
      }
    }

    const inheritedAgentId = liveRoot ? liveRoot.agentId : getAgentId();
    const inheritedContextProjectId = liveRoot?.contextProjectId ?? contextProjectId;

    let targetNextId: string | null = attempt.nextId;
    while (targetNextId && hops <= MAX_ROLLOVER_HOPS) {
      const probeId = targetNextId;
      const probeResult = await withSessionLock(probeId, async (): Promise<
        | { kind: "written"; value: T }
        | { kind: "adopt" }
        | { kind: "skip" }
      > => {
        const existingTarget = await kv.get<Session>(KV.sessions, probeId);
        if (existingTarget) {
          return existingTarget.parentSessionId === rootSessionId
            ? { kind: "adopt" }
            : { kind: "skip" };
        }
        const existingTargetKeys = await listScopeKeys(kv, KV.observations(probeId));
        if (existingTargetKeys.length > 0) {
          return { kind: "adopt" };
        }

        const nextSession: Session = {
          id: probeId,
          project: attempt.project,
          cwd: attempt.cwd,
          startedAt: attempt.nowIso,
          updatedAt: attempt.nowIso,
          status: "active",
          observationCount: 0,
          parentSessionId: rootSessionId,
          ...(inheritedContextProjectId ? { contextProjectId: inheritedContextProjectId } : {}),
          ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
          ...(liveRoot?.tags ? { tags: [...liveRoot.tags] } : {}),
        };
        await kv.set(KV.sessions, probeId, nextSession);
        await addSessionToProjectIndex(kv, attempt.project, {
          id: probeId,
          startedAt: attempt.nowIso,
          ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
        }).catch((err) => {
          logger.warn("session index update failed", {
            sessionId: probeId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        await ensureRootPointsTo(probeId, attempt.nowIso, attempt.project, attempt.cwd);
        pendingRootPointer = null;
        return {
          kind: "written",
          value: await writeFn({ sessionId: probeId, existingSession: nextSession, existing: [] }),
        };
      });

      if (probeResult.kind === "written") {
        return { kind: "written", value: probeResult.value };
      }
      if (probeResult.kind === "adopt") {
        currentSessionId = probeId;
        pendingRootPointer = probeId;
        break;
      }
      hops++;
      targetNextId = nextSegmentId(rootSessionId, probeId);
    }

    if (!targetNextId) {
      return { kind: "cap_reached", error: `Session observation limit reached (${cap})` };
    }
  }

  return { kind: "cap_reached", error: `Session observation limit reached (${cap})` };
}
