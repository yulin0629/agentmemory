import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { IIIClient } from "iii-sdk";
import { markCaptureEventDeleted } from "../capture/event-record.js";
import { resolveDataDir } from "../cli-data-dir.js";
import type {
  CompressedObservation,
  GraphEdge,
  GraphNode,
  Memory,
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
import { needsCompression, type StoredObservation } from "./compression-state.js";
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
const DELETE_CONCURRENCY = 16;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 200;
const SEARCH_BUDGET_MS = 15_000;
const MAX_SESSION_ID_LENGTH = 256;

export type ArchiveSkipReason =
  | "active"
  | "no_summary"
  | "summary_stale"
  | "repair_pending"
  | "nothing_eligible";

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

function archiveFileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.jsonl.gz`;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

async function readArchive(file: string): Promise<CompressedObservation[]> {
  let packed: Buffer;
  try {
    packed = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const text = (await gunzipAsync(packed)).toString("utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CompressedObservation);
}

async function writeArchive(dir: string, file: string, rows: CompressedObservation[]): Promise<number> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
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

function byTimestamp(a: CompressedObservation, b: CompressedObservation): number {
  return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

async function protectedObservationIds(kv: StateKV): Promise<Set<string>> {
  const [access, memories, nodes, edges] = await Promise.all([
    collectAll<AccessLog>(kv, KV.accessLog),
    collectAll<Memory>(kv, KV.memories),
    collectAll<GraphNode>(kv, KV.graphNodes),
    collectAll<GraphEdge>(kv, KV.graphEdges),
  ]);
  const ids = new Set<string>();
  for (const row of access) if (row?.memoryId && row.count > 0) ids.add(row.memoryId);
  for (const row of [...memories, ...nodes, ...edges]) {
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

export function registerObservationArchiveFunctions(sdk: IIIClient, kv: StateKV): void {
  const dir = () => observationArchiveDir();

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

      const wanted = Array.isArray(data?.sessionIds) ? new Set(data.sessionIds.filter(isSessionId)) : null;
      const project = typeof data?.project === "string" && data.project ? data.project : null;
      const candidates = (await kv.list<Session>(KV.sessions))
        .filter((session) => isSessionId(session?.id) && typeof session.startedAt === "string" &&
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
            const rows = await kv.list<StoredObservation>(KV.observations(session.id));
            const selected = rows.filter(eligible);
            if (selected.length === 0) {
              result.skipped.nothing_eligible++;
              result.keptObservations += rows.length;
              return;
            }
            if (!summaryIsCurrent(session, summary, rows)) {
              result.skipped.summary_stale++;
              result.keptObservations += rows.length;
              return;
            }
            result.keptObservations += rows.length - selected.length;
            if (dryRun) {
              result.archivedSessions++;
              result.archivedObservations += selected.length;
              return;
            }

            const file = join(dir(), archiveFileName(session.id));
            const merged = new Map((await readArchive(file)).map((row) => [row.id, row]));
            for (const row of selected) merged.set(row.id, row);
            const archived = [...merged.values()].sort(byTimestamp);
            const bytes = await writeArchive(dir(), file, archived);
            const now = new Date().toISOString();
            const previous = await kv.get<ObservationArchive>(KV.observationArchives, session.id);
            await kv.set<ObservationArchive>(KV.observationArchives, session.id, {
              sessionId: session.id,
              project: session.project,
              file: archiveFileName(session.id),
              observationCount: archived.length,
              bytes,
              firstTimestamp: archived[0].timestamp,
              lastTimestamp: archived[archived.length - 1].timestamp,
              archivedAt: previous?.archivedAt ?? now,
              updatedAt: now,
            });

            indexChanged = true;
            try {
              for (let i = 0; i < selected.length; i += DELETE_CONCURRENCY) {
                await Promise.all(selected.slice(i, i + DELETE_CONCURRENCY).map(async (row) => {
                  await markCaptureEventDeleted(kv, row);
                  await kv.delete(KV.observations(session.id), row.id);
                  getSearchIndex().remove(row.id);
                  vectorIndexRemove(row.id);
                  await unindexObservationSession(kv, row.id).catch(() => {});
                }));
              }
            } finally {
              await rebaseSummary(kv, session, summary, await kv.list<StoredObservation>(KV.observations(session.id)));
            }
            await recordAudit(kv, "observation_archive", "mem::archive-observations", [session.id], {
              action: "archive",
              observations: selected.length,
              archivedTotal: archived.length,
              olderThanDays,
              keepImportance,
            });
            result.archivedSessions++;
            result.archivedObservations += selected.length;
            result.archivedBytes += bytes;
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
      const sessionId = isSessionId(data?.sessionId) ? data.sessionId : null;
      if (terms.length === 0 && !sessionId) return { success: false, error: "query or sessionId is required" };
      const limit = Math.floor(numberInRange(data?.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT));
      const archives = sessionId
        ? [await kv.get<ObservationArchive>(KV.observationArchives, sessionId)].filter((row): row is ObservationArchive => Boolean(row))
        : (await kv.list<ObservationArchive>(KV.observationArchives))
          .filter((row) => row && (!data?.project || row.project === data.project))
          .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      const hits: CompressedObservation[] = [];
      let scannedSessions = 0;
      let truncated = false;
      for (const archive of archives) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        scannedSessions++;
        let rows: CompressedObservation[];
        try {
          rows = await readArchive(join(dir(), archiveFileName(archive.sessionId)));
        } catch (err) {
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
          if (terms.every((term) => text.includes(term))) hits.push(row);
        }
      }
      hits.sort((a, b) => byTimestamp(b, a));
      return {
        success: true,
        scannedSessions,
        truncated,
        total: hits.length,
        observations: hits.slice(0, limit),
      };
    },
  );

  sdk.registerFunction(
    "mem::archive-restore",
    async (data: { sessionId?: string } | undefined) => {
      if (!isSessionId(data?.sessionId)) return { success: false, error: "sessionId is required" };
      const sessionId = data.sessionId;
      const restored = await withKeyedLock(`obs:${sessionId}`, async () => {
        const archive = await kv.get<ObservationArchive>(KV.observationArchives, sessionId);
        if (!archive) return null;
        const file = join(dir(), archiveFileName(sessionId));
        const archived = await readArchive(file);
        const session = await kv.get<Session>(KV.sessions, sessionId);
        const before = await kv.list<StoredObservation>(KV.observations(sessionId));
        const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
        const covered = Boolean(session && summary && summaryIsCurrent(session, summary, before));
        const present = new Set(before.map((row) => row.id));
        const missing = archived.filter((row) => !present.has(row.id));
        for (let i = 0; i < missing.length; i += DELETE_CONCURRENCY) {
          await Promise.all(missing.slice(i, i + DELETE_CONCURRENCY).map(async (row) => {
            await kv.set(KV.observations(sessionId), row.id, row);
            await indexObservationSession(kv, row.id, sessionId);
          }));
        }
        if (session && summary) {
          if (covered) await rebaseSummary(kv, session, summary, [...before, ...missing]);
          else await requestSummaryRefresh(kv, sessionId);
        }
        await kv.delete(KV.observationArchives, sessionId);
        await rm(file, { force: true });
        await recordAudit(kv, "observation_archive", "mem::archive-restore", [sessionId], {
          action: "restore",
          observations: missing.length,
          archivedTotal: archived.length,
        });
        return missing;
      });
      if (!restored) return { success: false, error: "archive_not_found" };
      await indexRecords(restored, []);
      return { success: true, sessionId, restoredObservations: restored.length };
    },
  );
}
