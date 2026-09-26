import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { parseContextKnowledgeBackups, restoreContextKnowledge } from "../src/state/context-knowledge-backup.js";
import { KV, fingerprintId } from "../src/state/schema.js";
import type { ContextKnowledgeCatalog } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/functions/search.js", () => ({ indexRecords: vi.fn() }));
vi.mock("../src/functions/lessons.js", () => ({ resetLessonIndex: vi.fn() }));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup() {
  const store = new Map<string, Map<string, any>>();
  const kv = {
    get: async (scope: string, key: string) => store.get(scope)?.get(key) ?? null,
    set: async (scope: string, key: string, value: any) => { if (!store.has(scope)) store.set(scope, new Map()); store.get(scope)!.set(key, value); return value; },
    list: async (scope: string) => [...(store.get(scope)?.values() ?? [])],
    delete: async (scope: string, key: string) => { store.get(scope)?.delete(key); },
  };
  const handlers = new Map<string, (data: any) => Promise<any>>();
  const sdk = { registerFunction: (id: string, handler: (data: any) => Promise<any>) => handlers.set(id, handler) };
  registerExportImportFunction(sdk as never, kv as never);
  const call = (id: string, data: any = {}) => handlers.get(id)!(data);
  return { kv, sdk, call };
}
function catalog(): ContextKnowledgeCatalog {
  const old = { id: "old", revision: "r1", status: "superseded" as const, supersededBy: "new",
    scope: { namespace: "personal", project: "same", projectId: "repo-a" },
    evidence: { eventId: "event-old", text: "old rule", adoptedAt: "2026-09-18T00:00:00Z" }, spans: [{ id: "s", text: "old rule" }] };
  return { revision: 3, records: [old, { ...old, id: "new", revision: "r2", status: "active",
    supersededBy: undefined, supersedes: { id: old.id, revision: old.revision },
    evidence: { ...old.evidence, eventId: "event-new", text: "new rule" }, spans: [{ id: "s", text: "new rule" }] }], events: { first: "digest1", second: "digest2" } };
}
const key = fingerprintId("ctx", "personal");

describe("context knowledge backup", () => {
  it("round-trips export/import with sources, states, links and scope intact", async () => {
    const a = setup(), b = setup(); const original = catalog();
    await a.kv.set(KV.contextKnowledge, key, original);
    const exported = await a.call("mem::export");
    expect(exported.contextKnowledge).toHaveLength(1);
    expect((await b.call("mem::import", { exportData: exported })).success).toBe(true);
    const restored = await b.kv.get(KV.contextKnowledge, key);
    expect(restored.records).toEqual(original.records); expect(restored.events).toEqual(original.events);
    expect(restored.revision).toBeGreaterThan(original.revision);
  });
  it("rejects merge conflicts and malformed links before touching existing data", async () => {
    const app = setup(); await app.kv.set(KV.contextKnowledge, key, catalog());
    const backup = await app.call("mem::export");
    const invalid = structuredClone(backup); invalid.contextKnowledge[0].catalog.records[1].supersedes.id = "missing";
    expect((await app.call("mem::import", { exportData: invalid, strategy: "replace" })).success).toBe(false);
    expect(await app.kv.get(KV.contextKnowledge, key)).toEqual(catalog());
    const changed = structuredClone(backup); changed.contextKnowledge[0].catalog.records[1].status = "retracted";
    expect((await app.call("mem::import", { exportData: changed })).success).toBe(false);
    expect((await app.call("mem::import", { exportData: changed, strategy: "skip" })).success).toBe(true);
    expect((await app.kv.get(KV.contextKnowledge, key)).records[1].status).toBe("active");
    expect((await app.call("mem::import", { exportData: changed, strategy: "replace" })).success).toBe(true);
    expect((await app.kv.get(KV.contextKnowledge, key)).records[1].status).toBe("retracted");
  });
  it("preserves current knowledge when an older export lacks the collection", async () => {
    const app = setup(); await app.kv.set(KV.contextKnowledge, key, catalog());
    const old = await app.call("mem::export"); delete old.contextKnowledge;
    expect((await app.call("mem::import", { exportData: old, strategy: "replace" })).success).toBe(true);
    expect(await app.kv.get(KV.contextKnowledge, key)).toEqual(catalog());
  });
  it("round-trips an actual git snapshot and increases the live revision on restore", async () => {
    const app = setup(); const dir = mkdtempSync(join(tmpdir(), "context-snapshot-")); dirs.push(dir);
    registerSnapshotFunction(app.sdk as never, app.kv as never, dir);
    await app.kv.set(KV.contextKnowledge, key, catalog());
    const created = await app.call("mem::snapshot-create");
    expect(created.success).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).contextKnowledge).toHaveLength(1);
    const updated = catalog(); updated.revision = 12; updated.records[1]!.status = "retracted";
    await app.kv.set(KV.contextKnowledge, key, updated);
    const restored = await app.call("mem::snapshot-restore", { commitHash: created.snapshot.commitHash });
    expect(restored.success).toBe(true);
    const value = await app.kv.get(KV.contextKnowledge, key);
    expect(value.records).toEqual(catalog().records); expect(value.revision).toBe(13);
  });
  it("rejects cross-namespace data and preserves namespaces not present in a restore", async () => {
    const app = setup(); await app.kv.set(KV.contextKnowledge, key, catalog());
    expect(() => parseContextKnowledgeBackups([{ namespace: "wrong", catalog: catalog() }])).toThrow();
    await restoreContextKnowledge(app.kv as never, [], "replace");
    expect(await app.kv.get(KV.contextKnowledge, key)).toEqual(catalog());
  });
});
