import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { IIIClient } from "iii-sdk";
import { markCaptureEventDeleted } from "../capture/event-record.js";
import { resolveDataDir } from "../cli-data-dir.js";
import type {
  CompressedObservation,
  ObservationArchive,
  Session,
  SessionSummary,
} from "../types.js";
import { KV } from "../state/schema.js";
import { type StateKV, collectAll } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { indexObservationSession, unindexObservationSession } from "../state/obs-index.js";
import { logger } from "../logger.js";
import { type AccessLog } from "./access-tracker.js";
import { recordAudit } from "./audit.js";
import { serverDurableAfterMs } from "./capture.js";
import { needsCompression, type StoredObservation } from "./compression-state.js";
import { withoutObservationSource } from "./observation-source.js";
import { flushIndexSave, getSearchIndex, indexRecords, vectorIndexRemove } from "./search.js";
import { requestSummaryRefresh, summaryCovers, summaryFingerprint, summaryObservations } from "./summary-state.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_OLDER_THAN_DAYS = 60;
const MIN_OLDER_THAN_DAYS = 7;
const DEFAULT_KEEP_IMPORTANCE = 6;
const DEFAULT_MAX_SESSIONS = 50;
const MAX_SESSIONS_PER_CALL = 500;
const WRITE_CONCURRENCY = 16;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 200;
const SEARCH_BUDGET_MS = 15_000;
const MAX_FILE_NAME_BYTES = 200;
const CITING_SCOPES = [KV.memories, KV.graphNodes, KV.graphEdges, KV.actions, KV.procedural];

export type ArchiveSkipReason =
  | "active"
  | "no_summary"
  | "summary_stale"
  | "repair_pending"
  | "nothing_eligible";

export type ArchiveRestoreError = "archive_not_found" | "archive_unreadable" | "session_not_found";

export interface ArchiveObservationsInput {
  dryRun?: boolean;
  olderThanDays?: number;
  keepImportance?: number;
  maxSessions?: number;
  cursor?: string;
  sessionIds?: string[];
  project?: string;
}

export interface ArchiveObservationsResult {
  success: boolean;
  dryRun: boolean;
  olderThanDays: number;
  keepImportance: number;
  scannedSessions: number;
  archivedSessions: number;
  archivedObservations: number;
  archivedBytes: number;
  keptObservations: number;
  skipped: Record<ArchiveSkipReason, number>;
  failedSessions: number;
  nextCursor?: string;
  error?: string;
}

export function observationArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir({ args: [], env }).dataDir, "observation-archive");
}

function archiveFile(sessionId: unknown): string | null {
  if (typeof sessionId !== "string" || !sessionId) return null;
  let name: string;
  try {
    name = encodeURIComponent(sessionId);
  } catch {
    return null;
  }
  return name.length <= MAX_FILE_NAME_BYTES ? join(observationArchiveDir(), `${name}.jsonl.gz`) : null;
}

async function readArchive(file: string): Promise<CompressedObservation[]> {
  const text = (await gunzipAsync(await readFile(file))).toString("utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CompressedObservation);
}

async function writeArchive(file: string, rows: CompressedObservation[]): Promise<number> {
  await mkdir(observationArchiveDir(), { recursive: true, mode: 0o700 });
  const packed = await gzipAsync(Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8"));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(packed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return packed.length;
}

function sessionCursor(session: Session): string {
  return `${session.startedAt}|${session.id}`;
}

function newestFirst(a: CompressedObservation, b: CompressedObservation): number {
  return b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id);
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

async function inChunks<T>(items: T[], run: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += WRITE_CONCURRENCY) {
    await Promise.all(items.slice(i, i + WRITE_CONCURRENCY).map(run));
  }
}

async function protectedObservationIds(kv: StateKV): Promise<Set<string>> {
  const [access, lessons, ...citing] = await Promise.all([
    collectAll<AccessLog>(kv, KV.accessLog),
    collectAll<{ sourceIds?: string[] }>(kv, KV.lessons),
    ...CITING_SCOPES.map((scope) => collectAll<{ sourceObservationIds?: string[] }>(kv, scope)),
  ]);
  const ids = new Set<string>();
  for (const row of access) if (row?.memoryId && row.count > 0) ids.add(row.memoryId);
  for (const row of lessons) if (Array.isArray(row?.sourceIds)) for (const id of row.sourceIds) ids.add(id);
  for (const row of citing.flat()) {
    if (Array.isArray(row?.sourceObservationIds)) for (const id of row.sourceObservationIds) ids.add(id);
  }
  return ids;
}

async function rebaseSummary(
  kv: StateKV,
  session: Session,
  summary: SessionSummary,
  rows: StoredObservation[],
): Promise<void> {
  const compressed = summaryObservations(rows as CompressedObservation[]);
  await kv.set<SessionSummary>(KV.summaries, session.id, {
    ...summary,
    observationCount: compressed.length,
    coveredFingerprint: summaryFingerprint(session, compressed),
  });
}

function summaryIsCurrent(session: Session, summary: SessionSummary, rows: StoredObservation[]): boolean {
  const compressed = summaryObservations(rows as CompressedObservation[]);
  return summary.coveredFingerprint
    ? summaryCovers(session, compressed, summary)
    : summary.observationCount === compressed.length;
}

// Call with the obs:<sessionId> lock held. The caller indexes the returned rows.
export async function restoreArchivedSession(
  kv: StateKV,
  sessionId: string,
  functionId = "mem::archive-restore",
): Promise<{ restored: CompressedObservation[] } | { error: ArchiveRestoreError }> {
  const archive = await kv.get<ObservationArchive>(KV.observationArchives, sessionId);
  const file = archiveFile(sessionId);
  if (!archive || !file) return { error: "archive_not_found" };
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (!session) return { error: "session_not_found" };
  let archived: CompressedObservation[];
  try {
    archived = await readArchive(file);
  } catch (err) {
    logger.warn("Observation archive unreadable", { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { error: "archive_unreadable" };
  }
  if (archived.length < archive.observationCount) return { error: "archive_unreadable" };

  const before = await kv.list<StoredObservation>(KV.observations(sessionId));
  const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
  const covered = Boolean(summary && summaryIsCurrent(session, summary, before));
  const present = new Set(before.map((row) => row.id));
  const restored = archived.filter((row) => !present.has(row.id));
  await inChunks(restored, async (row) => {
    await kv.set(KV.observations(sessionId), row.id, row);
    await indexObservationSession(kv, row.id, sessionId);
  });
  if (summary && covered) await rebaseSummary(kv, session, summary, [...before, ...restored]);
  else if (summary) await requestSummaryRefresh(kv, sessionId);
  await kv.delete(KV.observationArchives, sessionId);
  // The restored rows reach the disk with the next state snapshot; the file is
  // their only durable copy until then.
  setTimeout(() => void rm(file, { force: true }).catch(() => {}), serverDurableAfterMs()).unref();
  await recordAudit(kv, "observation_archive", functionId, [sessionId], {
    action: "restore",
    observations: restored.length,
    archivedTotal: archived.length,
  });
  return { restored };
}

// Call with the obs:<sessionId> lock held.
export async function dropObservationArchive(kv: StateKV, sessionId: string): Promise<void> {
  await kv.delete(KV.observationArchives, sessionId);
  const file = archiveFile(sessionId);
  if (file) await rm(file, { force: true });
}

export async function clearObservationArchives(kv: StateKV): Promise<void> {
  const archives = await kv.list<ObservationArchive>(KV.observationArchives);
  await inChunks(archives, (archive) => kv.delete(KV.observationArchives, archive.sessionId));
  await rm(observationArchiveDir(), { recursive: true, force: true });
}

export function registerObservationArchiveFunctions(sdk: IIIClient, kv: StateKV): void {
  sdk.registerFunction(
    "mem::archive-observations",
    async (data: ArchiveObservationsInput | undefined): Promise<ArchiveObservationsResult> => {
      const dryRun = data?.dryRun !== false;
      const olderThanDays = numberInRange(data?.olderThanDays, DEFAULT_OLDER_THAN_DAYS, MIN_OLDER_THAN_DAYS, 36_500);
      const keepImportance = numberInRange(data?.keepImportance, DEFAULT_KEEP_IMPORTANCE, 1, 11);
      const maxSessions = Math.floor(numberInRange(data?.maxSessions, DEFAULT_MAX_SESSIONS, 1, MAX_SESSIONS_PER_CALL));
      const cutoff = Date.now() - olderThanDays * MS_PER_DAY;
      const result: ArchiveObservationsResult = {
        success: true,
        dryRun,
        olderThanDays,
        keepImportance,
        scannedSessions: 0,
        archivedSessions: 0,
        archivedObservations: 0,
        archivedBytes: 0,
        keptObservations: 0,
        skipped: { active: 0, no_summary: 0, summary_stale: 0, repair_pending: 0, nothing_eligible: 0 },
        failedSessions: 0,
      };

      const wanted = Array.isArray(data?.sessionIds) ? new Set(data.sessionIds) : null;
      const project = typeof data?.project === "string" && data.project ? data.project : null;
      const candidates = (await kv.list<Session>(KV.sessions))
        .filter((session) => archiveFile(session?.id) && typeof session.startedAt === "string" &&
          Date.parse(session.startedAt) < cutoff &&
          (!wanted || wanted.has(session.id)) && (!project || session.project === project))
        .sort((a, b) => (sessionCursor(a) < sessionCursor(b) ? -1 : sessionCursor(a) > sessionCursor(b) ? 1 : 0));
      const cursor = typeof data?.cursor === "string" ? data.cursor : "";
      const start = cursor ? candidates.findIndex((session) => sessionCursor(session) > cursor) : 0;
      const batch = start < 0 ? [] : candidates.slice(start, start + maxSessions);
      if (start >= 0 && start + maxSessions < candidates.length) {
        result.nextCursor = sessionCursor(batch[batch.length - 1]);
      }
      if (batch.length === 0) return result;

      const keepHot = await protectedObservationIds(kv);
      const eligible = (row: StoredObservation): row is CompressedObservation =>
        "title" in row && Boolean(row.title) && !needsCompression(row) &&
        Date.parse(row.timestamp) < cutoff &&
        (typeof row.importance === "number" ? row.importance : 5) < keepImportance &&
        !row.imageData && !row.imageRef && !keepHot.has(row.id);

      let indexChanged = false;
      for (const candidate of batch) {
        result.scannedSessions++;
        try {
          await withKeyedLock(`obs:${candidate.id}`, async () => {
            const session = await kv.get<Session>(KV.sessions, candidate.id);
            if (!session || session.id !== candidate.id || session.status === "active") {
              result.skipped.active++;
              return;
            }
            const summary = await kv.get<SessionSummary>(KV.summaries, session.id);
            if (!summary) {
              result.skipped.no_summary++;
              return;
            }
            if (await kv.get(KV.summaryRepairs, session.id)) {
              result.skipped.repair_pending++;
              return;
            }
            const file = archiveFile(session.id)!;
            const rows = await kv.list<StoredObservation>(KV.observations(session.id));
            const hot = new Set(rows.map((row) => row.id));
            const previous = await kv.get<ObservationArchive>(KV.observationArchives, session.id);
            const alreadyArchived = previous ? (await readArchive(file)).filter((row) => !hot.has(row.id)) : [];
            // A run that died between the file write and the last delete leaves a
            // summary that covers the hot rows plus the archived ones.
            const interrupted = !summaryIsCurrent(session, summary, rows);
            if (interrupted && !(previous && summaryIsCurrent(session, summary, [...rows, ...alreadyArchived]))) {
              result.skipped.summary_stale++;
              result.keptObservations += rows.length;
              return;
            }
            const selected = rows.filter(eligible);
            result.keptObservations += rows.length - selected.length;
            if (dryRun) {
              if (selected.length === 0) result.skipped.nothing_eligible++;
              else {
                result.archivedSessions++;
                result.archivedObservations += selected.length;
              }
              return;
            }
            if (selected.length === 0) {
              if (interrupted) await rebaseSummary(kv, session, summary, rows);
              result.skipped.nothing_eligible++;
              return;
            }

            const archived = [...alreadyArchived, ...selected].sort(newestFirst).reverse();
            const bytes = await writeArchive(file, archived);
            const now = new Date().toISOString();
            await kv.set<ObservationArchive>(KV.observationArchives, session.id, {
              sessionId: session.id,
              project: session.project,
              observationCount: archived.length,
              bytes,
              firstTimestamp: archived[0].timestamp,
              lastTimestamp: archived[archived.length - 1].timestamp,
              archivedAt: previous?.archivedAt ?? now,
              updatedAt: now,
            });

            indexChanged = true;
            let removed = 0;
            try {
              await inChunks(selected, async (row) => {
                await markCaptureEventDeleted(kv, row);
                await kv.delete(KV.observations(session.id), row.id);
                getSearchIndex().remove(row.id);
                vectorIndexRemove(row.id);
                await unindexObservationSession(kv, row.id).catch(() => {});
                removed++;
              });
            } finally {
              await rebaseSummary(kv, session, summary, await kv.list<StoredObservation>(KV.observations(session.id)));
              await recordAudit(kv, "observation_archive", "mem::archive-observations", [session.id], {
                action: "archive",
                observations: removed,
                archivedTotal: archived.length,
                olderThanDays,
                keepImportance,
              });
              result.archivedSessions++;
              result.archivedObservations += removed;
              result.archivedBytes += bytes;
            }
          });
        } catch (err) {
          result.failedSessions++;
          result.success = false;
          logger.warn("Observation archive failed", {
            sessionId: candidate.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (indexChanged) await flushIndexSave();
      if (result.failedSessions > 0) result.error = `${result.failedSessions} session(s) failed`;
      logger.info("Observation archive complete", { ...result });
      return result;
    },
  );

  sdk.registerFunction(
    "mem::archive-list",
    async (data: { project?: string; limit?: number } | undefined) => {
      const limit = Math.floor(numberInRange(data?.limit, 100, 1, 1000));
      const all = (await kv.list<ObservationArchive>(KV.observationArchives))
        .filter((row) => row && (!data?.project || row.project === data.project));
      return {
        success: true,
        sessions: all.length,
        observations: all.reduce((sum, row) => sum + row.observationCount, 0),
        bytes: all.reduce((sum, row) => sum + row.bytes, 0),
        archives: all.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp)).slice(0, limit),
      };
    },
  );

  sdk.registerFunction(
    "mem::archive-search",
    async (data: { query?: string; sessionId?: string; project?: string; limit?: number } | undefined) => {
      const terms = (typeof data?.query === "string" ? data.query : "").toLowerCase().split(/\s+/).filter(Boolean);
      const sessionId = typeof data?.sessionId === "string" && data.sessionId ? data.sessionId : null;
      if (terms.length === 0 && !sessionId) return { success: false, error: "query or sessionId is required" };
      const limit = Math.floor(numberInRange(data?.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT));
      const listed = sessionId
        ? [await kv.get<ObservationArchive>(KV.observationArchives, sessionId)]
        : await kv.list<ObservationArchive>(KV.observationArchives);
      const archives = listed
        .filter((row): row is ObservationArchive => Boolean(row) && (!data?.project || row?.project === data.project))
        .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      let hits: CompressedObservation[] = [];
      let total = 0;
      let scannedSessions = 0;
      let unreadableSessions = 0;
      let truncated = false;
      for (const archive of archives) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        scannedSessions++;
        const file = archiveFile(archive.sessionId);
        let rows: CompressedObservation[];
        try {
          rows = file ? await readArchive(file) : [];
        } catch (err) {
          unreadableSessions++;
          logger.warn("Observation archive unreadable", {
            sessionId: archive.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        for (const row of rows) {
          const text = terms.length
            ? [row.title, row.subtitle, row.narrative, ...(row.facts ?? []), ...(row.concepts ?? []), ...(row.files ?? [])]
              .join("\n").toLowerCase()
            : "";
          if (!terms.every((term) => text.includes(term))) continue;
          total++;
          hits.push(row);
        }
        if (hits.length > limit * 4) hits = hits.sort(newestFirst).slice(0, limit);
      }
      return {
        success: true,
        scannedSessions,
        unreadableSessions,
        truncated,
        total,
        observations: hits.sort(newestFirst).slice(0, limit).map(withoutObservationSource),
      };
    },
  );

  sdk.registerFunction(
    "mem::archive-restore",
    async (data: { sessionId?: string } | undefined) => {
      if (typeof data?.sessionId !== "string" || !data.sessionId) return { success: false, error: "sessionId is required" };
      const sessionId = data.sessionId;
      const outcome = await withKeyedLock(`obs:${sessionId}`, () => restoreArchivedSession(kv, sessionId));
      if ("error" in outcome) return { success: false, error: outcome.error };
      await indexRecords(outcome.restored, []);
      return { success: true, sessionId, restoredObservations: outcome.restored.length };
    },
  );
}
