import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/eval/schemas.js", () => ({ SummaryOutputSchema: {} }));
vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));
vi.mock("../src/eval/quality.js", () => ({ scoreSummary: () => 100 }));

import { captureEventScope } from "../src/capture/event-record.js";
import {
  clearObservationArchives,
  observationArchiveDir,
  registerObservationArchiveFunctions,
  type ArchiveObservationsResult,
} from "../src/functions/observation-archive.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { getSearchIndex } from "../src/functions/search.js";
import { summaryCovers, summaryFingerprint, summaryObservations } from "../src/functions/summary-state.js";
import { REDUCE_SYSTEM } from "../src/prompts/summary.js";
import { indexObservationSession, lookupObservationSession } from "../src/state/obs-index.js";
import { KV } from "../src/state/schema.js";
import type {
  AuditEntry,
  CompressedObservation,
  MemoryProvider,
  ObservationArchive,
  Session,
  SessionSummary,
} from "../src/types.js";
import { currentAuditScope, mockKV, mockSdk } from "./helpers/mocks.js";

const SESSION = "ses_old";

function daysAgo(days: number, minute = 0): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000 + minute * 60_000).toISOString();
}

function makeObs(n: number, overrides: Partial<CompressedObservation> = {}): CompressedObservation {
  return {
    id: `obs_${String(n).padStart(3, "0")}`,
    sessionId: SESSION,
    timestamp: daysAgo(90, n),
    compressedAt: daysAgo(90, n),
    type: "command_run",
    title: `ran step ${n}`,
    facts: [`fact ${n}`],
    narrative: `narrative about widget ${n}`,
    concepts: ["widgets"],
    files: [`src/file_${n}.ts`],
    importance: 3,
    ...overrides,
  };
}

function summaryXml(title: string): string {
  return `<summary><title>${title}</title><narrative>${title} narrative</narrative><decisions><decision>d</decision></decisions><files><file>src/a.ts</file></files><concepts><concept>c</concept></concepts></summary>`;
}

async function setup(observations: CompressedObservation[], options: { legacySummary?: boolean } = {}) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: SESSION,
    project: "demo",
    cwd: "/repo/demo",
    startedAt: daysAgo(91),
    endedAt: daysAgo(90, 120),
    status: "completed",
    observationCount: observations.length,
  };
  await kv.set(KV.sessions, SESSION, session);
  for (const obs of observations) {
    await kv.set(KV.observations(SESSION), obs.id, obs);
    await indexObservationSession(kv as never, obs.id, SESSION);
    getSearchIndex().add(obs);
  }
  const compressed = summaryObservations(observations);
  const summary: SessionSummary = {
    sessionId: SESSION,
    project: "demo",
    createdAt: daysAgo(90, 121),
    title: "Original summary",
    narrative: "Covers every observation of the session.",
    keyDecisions: ["kept"],
    filesModified: [],
    concepts: [],
    observationCount: compressed.length,
    ...(options.legacySummary ? {} : { coveredFingerprint: summaryFingerprint(session, compressed) }),
  };
  await kv.set(KV.summaries, SESSION, summary);
  const calls: Array<{ system: string; user: string }> = [];
  const provider: MemoryProvider = {
    name: "test",
    compress: async () => "",
    summarize: async (system: string, user: string) => {
      calls.push({ system, user });
      return summaryXml(system === REDUCE_SYSTEM ? "Merged summary" : "Delta summary");
    },
  };
  registerObservationArchiveFunctions(sdk as never, kv as never);
  registerSummarizeFunction(sdk as never, kv as never, provider);
  registerRememberFunction(sdk as never, kv as never);
  const call = <T>(id: string, payload?: unknown) => sdk.fns.get(id)!(payload) as Promise<T>;
  const archive = (payload?: unknown) => call<ArchiveObservationsResult>("mem::archive-observations", payload);
  const hotIds = async () => (await kv.list<CompressedObservation>(KV.observations(SESSION))).map((o) => o.id).sort();
  return { kv, session, summary, calls, call, archive, hotIds };
}

describe("observation cold storage", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.AGENTMEMORY_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "agentmemory-archive-"));
    process.env.AGENTMEMORY_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.AGENTMEMORY_DATA_DIR;
    else process.env.AGENTMEMORY_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
    getSearchIndex().clear();
  });

  it("is a dry run unless dryRun is false", async () => {
    const t = await setup([makeObs(1), makeObs(2)]);

    const result = await t.archive();

    expect(result).toMatchObject({ dryRun: true, archivedSessions: 1, archivedObservations: 2, archivedBytes: 0 });
    expect(await t.hotIds()).toEqual(["obs_001", "obs_002"]);
    expect(existsSync(observationArchiveDir())).toBe(false);
    expect(await t.kv.get(KV.observationArchives, SESSION)).toBeNull();
    expect(await t.kv.get(KV.summaries, SESSION)).toEqual(t.summary);
  });

  it("moves only old, unrecalled, low-importance, uncited text observations to a file", async () => {
    const captureKey = `cap_${"a".repeat(40)}`;
    const t = await setup([
      makeObs(1, { captureKey }),
      makeObs(2),
      makeObs(3, { importance: 6 }),
      makeObs(4, { timestamp: daysAgo(10), compressedAt: daysAgo(10) }),
      makeObs(5),
      makeObs(6),
      makeObs(7),
      makeObs(8, { imageRef: "img_1" }),
    ]);
    await t.kv.set(KV.accessLog, "obs_005", { memoryId: "obs_005", count: 2, lastAt: daysAgo(1), recent: [] });
    await t.kv.set(KV.memories, "mem_1", { id: "mem_1", sourceObservationIds: ["obs_006"] });
    await t.kv.set(KV.graphNodes, "node_1", { id: "node_1", sourceObservationIds: ["obs_007"] });

    const result = await t.archive({ dryRun: false });

    expect(result).toMatchObject({
      success: true, dryRun: false, archivedSessions: 1, archivedObservations: 2, keptObservations: 6, failedSessions: 0,
    });
    expect(await t.hotIds()).toEqual(["obs_003", "obs_004", "obs_005", "obs_006", "obs_007", "obs_008"]);
    expect(getSearchIndex().has("obs_001")).toBe(false);
    expect(getSearchIndex().has("obs_003")).toBe(true);
    expect(await lookupObservationSession(t.kv as never, "obs_001")).toBeNull();
    expect(await lookupObservationSession(t.kv as never, "obs_003")).toBe(SESSION);

    const manifest = await t.kv.get<ObservationArchive>(KV.observationArchives, SESSION);
    expect(manifest).toMatchObject({ sessionId: SESSION, project: "demo", observationCount: 2 });
    expect(readdirSync(observationArchiveDir())).toEqual([`${SESSION}.jsonl.gz`]);
    expect(result.archivedBytes).toBe(manifest!.bytes);
    expect(await t.kv.get(captureEventScope(captureKey), captureKey)).toMatchObject({ state: "deleted" });

    const summary = await t.kv.get<SessionSummary>(KV.summaries, SESSION);
    expect(summary).toMatchObject({ title: "Original summary", narrative: t.summary.narrative, observationCount: 6 });
    const remaining = summaryObservations(await t.kv.list<CompressedObservation>(KV.observations(SESSION)));
    expect(summaryCovers(t.session, remaining, summary)).toBe(true);

    const audit = await t.kv.list<AuditEntry>(currentAuditScope());
    expect(audit.filter((entry) => entry.operation === "observation_archive")).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetIds: [SESSION], details: { action: "archive", observations: 2 } });
  });

  it.each([
    ["active", async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.kv.set(KV.sessions, SESSION, { ...t.session, status: "active" });
    }],
    ["no_summary", async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.kv.delete(KV.summaries, SESSION);
    }],
    ["repair_pending", async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.kv.set(KV.summaryRepairs, SESSION, { sessionId: SESSION, token: "t", dueAt: 0, attempts: 0 });
    }],
    ["summary_stale", async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.kv.set(KV.observations(SESSION), "obs_050", makeObs(50));
    }],
  ] as const)("leaves a session alone when it is %s", async (reason, arrange) => {
    const t = await setup([makeObs(1), makeObs(2)]);
    await arrange(t);
    const before = await t.hotIds();

    const result = await t.archive({ dryRun: false });

    expect(result.archivedObservations).toBe(0);
    expect(result.skipped[reason]).toBe(1);
    expect(await t.hotIds()).toEqual(before);
    expect(existsSync(observationArchiveDir())).toBe(false);
  });

  it("moves only the named observation types when types is given", async () => {
    const t = await setup([makeObs(1), makeObs(2, { type: "decision" }), makeObs(3, { type: "file_read" })]);

    const result = await t.archive({ dryRun: false, types: ["command_run", "file_read"] });

    expect(result).toMatchObject({ archivedObservations: 2, keptObservations: 1, types: ["command_run", "file_read"] });
    expect(await t.hotIds()).toEqual(["obs_002"]);
  });

  it("refuses a types value that is not a list instead of moving every type", async () => {
    const t = await setup([makeObs(1), makeObs(2, { type: "decision" })]);

    const result = await t.archive({ dryRun: false, types: "command_run" });

    expect(result).toMatchObject({ success: false, archivedObservations: 0 });
    expect(await t.hotIds()).toEqual(["obs_001", "obs_002"]);
  });

  it("treats a legacy summary as stale when its count differs from the session", async () => {
    const t = await setup([makeObs(1), makeObs(2)], { legacySummary: true });
    expect((await t.archive()).archivedObservations).toBe(2);

    await t.kv.set(KV.observations(SESSION), "obs_050", makeObs(50));

    expect((await t.archive()).skipped.summary_stale).toBe(1);
  });

  it("pages through sessions with a cursor", async () => {
    const t = await setup([makeObs(1)]);
    await t.kv.set(KV.sessions, "ses_other", { ...t.session, id: "ses_other", startedAt: daysAgo(80) });

    const first = await t.archive({ maxSessions: 1 });
    const second = await t.archive({ maxSessions: 1, cursor: first.nextCursor });

    expect(first).toMatchObject({ scannedSessions: 1, archivedObservations: 1 });
    expect(first.nextCursor).toBeTruthy();
    expect(second).toMatchObject({ scannedSessions: 1, skipped: { no_summary: 1 } });
    expect(second.nextCursor).toBeUndefined();
  });

  it("finds archived observations by text or by session and restores them", async () => {
    const t = await setup([makeObs(1), makeObs(2), makeObs(3, { importance: 9 })]);
    await t.archive({ dryRun: false });

    const byText = await t.call<{ total: number; observations: CompressedObservation[] }>(
      "mem::archive-search", { query: "WIDGET 2" });
    expect(byText.observations.map((o) => o.id)).toEqual(["obs_002"]);
    const bySession = await t.call<{ total: number }>("mem::archive-search", { sessionId: SESSION });
    expect(bySession.total).toBe(2);
    expect(await t.call("mem::archive-search", {})).toMatchObject({ success: false });
    expect(await t.call("mem::archive-list")).toMatchObject({ sessions: 1, observations: 2 });

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const restored = await t.call("mem::archive-restore", { sessionId: SESSION });

    expect(restored).toMatchObject({ success: true, restoredObservations: 2 });
    expect(await t.hotIds()).toEqual(["obs_001", "obs_002", "obs_003"]);
    expect(getSearchIndex().has("obs_001")).toBe(true);
    expect(await lookupObservationSession(t.kv as never, "obs_002")).toBe(SESSION);
    expect(await t.kv.get(KV.observationArchives, SESSION)).toBeNull();
    expect(readdirSync(observationArchiveDir())).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(readdirSync(observationArchiveDir())).toEqual([]));
    const audit = await t.kv.list<AuditEntry>(currentAuditScope());
    expect(audit.map((entry) => entry.details?.action)).toEqual(["archive", "restore"]);
    const summary = await t.kv.get<SessionSummary>(KV.summaries, SESSION);
    const all = summaryObservations(await t.kv.list<CompressedObservation>(KV.observations(SESSION)));
    expect(summary?.title).toBe("Original summary");
    expect(summaryCovers(t.session, all, summary)).toBe(true);
    expect(await t.call("mem::archive-restore", { sessionId: SESSION })).toMatchObject({ error: "archive_not_found" });
  });

  it("finishes a run that stopped after the file was written", async () => {
    const t = await setup([makeObs(1), makeObs(2)]);
    await t.archive({ dryRun: false });
    await t.kv.set(KV.observations(SESSION), "obs_001", makeObs(1));
    await t.kv.set(KV.summaries, SESSION, t.summary);

    const rerun = await t.archive({ dryRun: false });

    expect(rerun).toMatchObject({ archivedObservations: 1, skipped: { summary_stale: 0 } });
    expect(await t.hotIds()).toEqual([]);
    const archived = await t.call<{ observations: CompressedObservation[] }>("mem::archive-search", { sessionId: SESSION });
    expect(archived.observations.map((o) => o.id).sort()).toEqual(["obs_001", "obs_002"]);
    expect(summaryCovers(t.session, [], await t.kv.get<SessionSummary>(KV.summaries, SESSION))).toBe(true);
  });

  it("keeps the manifest and reports an error when the archive file is gone", async () => {
    const t = await setup([makeObs(1), makeObs(2), makeObs(3, { importance: 9 })]);
    await t.archive({ dryRun: false });
    rmSync(observationArchiveDir(), { recursive: true });

    expect(await t.call("mem::archive-restore", { sessionId: SESSION })).toMatchObject({ success: false, error: "archive_unreadable" });
    expect(await t.kv.get(KV.observationArchives, SESSION)).not.toBeNull();
    expect(await t.call("mem::archive-search", { query: "widget" })).toMatchObject({ total: 0, unreadableSessions: 1 });
    expect(await t.call("mem::summarize", { sessionId: SESSION, force: true })).toMatchObject({ error: "observations_archived" });
  });

  it("forgets an archived observation and brings the rest of the session back", async () => {
    const t = await setup([makeObs(1), makeObs(2), makeObs(3, { importance: 9 })]);
    await t.archive({ dryRun: false });

    const result = await t.call("mem::forget", { sessionId: SESSION, observationIds: ["obs_001"] });

    expect(result).toMatchObject({ success: true, deleted: 1 });
    expect(await t.hotIds()).toEqual(["obs_002", "obs_003"]);
    expect(getSearchIndex().has("obs_002")).toBe(true);
    expect(getSearchIndex().has("obs_001")).toBe(false);
    expect(await t.kv.get(KV.observationArchives, SESSION)).toBeNull();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].user).toContain("ran step 2");
    expect(t.calls[0].user).not.toContain("ran step 1");
  });

  it("removes the archive when the session is forgotten or the store is replaced", async () => {
    const t = await setup([makeObs(1), makeObs(2)]);
    await t.archive({ dryRun: false });

    await t.call("mem::forget", { sessionId: SESSION });

    expect(await t.kv.get(KV.observationArchives, SESSION)).toBeNull();
    expect(readdirSync(observationArchiveDir())).toEqual([]);
    expect(await t.call("mem::archive-search", { query: "widget" })).toMatchObject({ total: 0 });

    const other = await setup([makeObs(1), makeObs(2)]);
    await other.archive({ dryRun: false });
    await clearObservationArchives(other.kv as never);
    expect(await other.kv.list(KV.observationArchives)).toEqual([]);
    expect(existsSync(observationArchiveDir())).toBe(false);
  });

  it("merges a new observation into the kept summary instead of rebuilding it from what is left", async () => {
    const t = await setup([makeObs(1), makeObs(2)]);
    await t.archive({ dryRun: false });
    expect(await t.hotIds()).toEqual([]);

    expect(await t.call("mem::summarize", { sessionId: SESSION })).toMatchObject({ error: "no_observations" });

    const late = makeObs(60, { timestamp: daysAgo(0), compressedAt: daysAgo(0), title: "resumed work" });
    await t.kv.set(KV.observations(SESSION), late.id, late);
    const result = await t.call("mem::summarize", { sessionId: SESSION });

    expect(result).toMatchObject({ success: true });
    expect(t.calls.map((c) => c.system === REDUCE_SYSTEM)).toEqual([false, true]);
    expect(t.calls[1].user).toContain("Original summary");
    expect((await t.kv.get<SessionSummary>(KV.summaries, SESSION))?.title).toBe("Merged summary");
  });

  it("refuses a forced full summary while part of the session is archived", async () => {
    const t = await setup([makeObs(1), makeObs(2), makeObs(3, { importance: 9 })]);
    await t.archive({ dryRun: false });

    const result = await t.call("mem::summarize", { sessionId: SESSION, force: true });

    expect(result).toMatchObject({ success: false, error: "observations_archived" });
    expect(t.calls).toHaveLength(0);
    expect((await t.kv.get<SessionSummary>(KV.summaries, SESSION))?.title).toBe("Original summary");
  });
});
