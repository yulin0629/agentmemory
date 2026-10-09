import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Forwarder, IDLE_MS, main, readProtected } from "../src/index.mjs";
import { sanitizeEvent } from "../src/privacy.mjs";

const event = (fields = {}) => ({
  schema_version: 1, event_id: randomUUID(), event_type: "tool.completed", occurred_at: "2026-10-09T00:00:00Z",
  machine_id: "host", workspace_id: "workspace", project: "example", cwd: "/tmp/example", tool: "read",
  outcome: { status: "success", duration_ms: 1 }, details: { path: "file.ts", read_bytes: 42 }, ...fields,
});
const response = (status = 201, body = { observationId: "obs_fixture" }, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const acknowledged = (request, fields = {}) => response(201, {
  observationId: `obs_event_${JSON.parse(request.body).event_id.toLowerCase().replace(/-/g, "")}`, ...fields,
});

async function fixture(t, fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), "devspace-forwarder-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spoolDir = join(dir, "spool");
  const stateDir = join(dir, "state");
  await mkdir(spoolDir, { mode: 0o700 });
  const calls = [], alerts = [];
  let time = Date.parse(event().occurred_at);
  const options = {
    spoolDir, stateDir, now: () => time, alert: (message) => alerts.push(message),
    fetchImpl: async (url, request) => {
      calls.push({ url, body: JSON.parse(request.body) });
      return fetchImpl ? fetchImpl(url, request, calls) : url.endsWith("session/end") ? response(200, { success: true }) : acknowledged(request);
    },
  };
  const forwarder = new Forwarder(options);
  await forwarder.init();
  return { dir, forwarder, options, calls, alerts, file: join(spoolDir, "0001.jsonl"), tick: (delta) => { time += delta; } };
}

test("tails active segments and checkpoints only complete UTF-8 lines", async (t) => {
  const f = await fixture(t);
  const first = JSON.stringify(event({ details: { path: "繁體中文.ts" } })) + "\n";
  const second = JSON.stringify(event());
  await writeFile(f.file, first + second.slice(0, -7));
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, Buffer.byteLength(first));
  await appendFile(f.file, second.slice(-7) + "\n");
  await f.forwarder.poll();
  assert.equal(f.calls.length, 2);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
  assert.equal(f.calls[0].body.data.tool_input.path, "繁體中文.ts");
});

test("persists the segment before delivery and reuses it after a lost acknowledgement", async (t) => {
  const f = await fixture(t, () => { throw new Error("connection lost after server write"); });
  const original = event();
  await writeFile(f.file, JSON.stringify(original) + "\n");
  await f.forwarder.poll();
  assert.equal(f.forwarder.state.files["0001.jsonl"], undefined);
  const checkpoint = JSON.parse(await readFile(join(f.options.stateDir, "checkpoint.json"), "utf8"));
  assert.ok(Object.values(checkpoint.sessions)[0].segment_id);
  const restarted = new Forwarder({ ...f.options, fetchImpl: async (url, request) => {
    f.calls.push({ url, body: JSON.parse(request.body) });
    return acknowledged(request, { deduplicated: true });
  } });
  await restarted.init();
  await restarted.poll();
  assert.equal(f.calls[0].body.sessionId, f.calls[1].body.sessionId);
  assert.equal(f.calls[1].body.event_id, original.event_id);
  assert.equal(restarted.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

test("resumes at the last acknowledged event after interruption", async (t) => {
  const f = await fixture(t, (_url, request, calls) => calls.length === 2 ? response(503) : acknowledged(request));
  const first = JSON.stringify(event()) + "\n";
  await writeFile(f.file, first + JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, Buffer.byteLength(first));
  const restarted = new Forwarder({ ...f.options, fetchImpl: async (_url, request) => acknowledged(request) });
  await restarted.init();
  await restarted.poll();
  assert.equal(restarted.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

test("persists an allocated session again after a local checkpoint write failure", async (t) => {
  const f = await fixture(t, async (_url, _request, calls) => {
    const disk = JSON.parse(await readFile(join(f.options.stateDir, "checkpoint.json"), "utf8"));
    assert.equal(Object.values(disk.sessions)[0].id, calls[0].body.sessionId);
    return acknowledged(_request);
  });
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  const handle = await open(f.options.stateDir, "r");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const write = t.mock.method(prototype, "writeFile", async () => { throw new Error("checkpoint_write_failure"); });
  await assert.rejects(f.forwarder.poll(), /checkpoint_write_failure/);
  write.mock.restore();
  assert.equal(f.calls.length, 0);
  const allocated = Object.values(f.forwarder.state.sessions)[0].id;
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.sessionId, allocated);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

test("requires directory sync before delivery and retries with the same allocated segment", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  const handle = await open(f.options.stateDir, "r");
  const prototype = Object.getPrototypeOf(handle);
  const originalSync = prototype.sync;
  await handle.close();
  const sync = t.mock.method(prototype, "sync", async function () {
    if ((await this.stat()).isDirectory()) throw Object.assign(new Error("directory_sync_unavailable"), { code: "EINVAL" });
    return originalSync.call(this);
  });
  await assert.rejects(f.forwarder.poll(), /directory_sync_unavailable/);
  assert.equal(f.calls.length, 0);
  const allocated = Object.values(f.forwarder.state.sessions)[0].id;
  sync.mock.restore();
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.sessionId, allocated);
});

test("preserves human machine names without ambiguous session delimiters", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event({ machine_id: "Mac: M4", workspace_id: "work:space" })) + "\n");
  await f.forwarder.poll();
  assert.match(f.calls[0].body.sessionId, /^devspace:Mac%3A%20M4:work%3Aspace:/);
});

test("quarantines malformed, oversized and rejected events without blocking later events", async (t) => {
  const f = await fixture(t, (_url, request, calls) => calls.length === 1 ? response(422, { error: "invalid" }) : acknowledged(request));
  await writeFile(f.file, "malformed password=fixture\n" + "x".repeat(128 * 1024) + "\n" + JSON.stringify(event()) + "\n" + JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  assert.equal(f.calls.length, 2);
  const dead = await readFile(join(f.options.stateDir, "dead-letter.jsonl"), "utf8");
  assert.equal(dead.trim().split("\n").length, 3);
  assert.ok(!dead.includes("password=fixture"));
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
  for (const name of ["checkpoint.json", "dead-letter.jsonl"]) assert.equal((await stat(join(f.options.stateDir, name))).mode & 0o777, 0o600);
  assert.equal((await stat(f.options.stateDir)).mode & 0o777, 0o700);
});

test("quarantines a non-JSON permanent rejection and still delivers the following event", async (t) => {
  const f = await fixture(t, (_url, request, calls) => calls.length === 1 ? new Response("request too large", { status: 413 }) : acknowledged(request));
  await writeFile(f.file, JSON.stringify(event()) + "\n" + JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  assert.equal(f.calls.length, 2);
  assert.match(await readFile(join(f.options.stateDir, "dead-letter.jsonl"), "utf8"), /rejected_http_413/);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

for (const status of [429, 500, 503]) test(`retries HTTP ${status} with backoff and no offset advancement`, async (t) => {
  const f = await fixture(t, (_url, request, calls) => calls.length === 1 ? response(status, {}, { "retry-after": "3" }) : acknowledged(request));
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.forwarder.state.files["0001.jsonl"], undefined);
  f.tick(3001);
  await f.forwarder.poll();
  assert.equal(f.calls.length, 2);
});

for (const status of [401, 403]) test(`pauses and alerts on HTTP ${status}`, async (t) => {
  const f = await fixture(t, () => response(status));
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  f.tick(60_000);
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.forwarder.paused, true);
  assert.match(f.alerts[0], /authentication_paused/);
  assert.equal(f.forwarder.state.files["0001.jsonl"], undefined);
});

test("ends a fully delivered session at 30 minutes, persists closure and starts a new segment", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  f.tick(IDLE_MS - 1);
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  f.tick(1);
  await f.forwarder.poll();
  assert.match(f.calls[1].url, /session\/end$/);
  const previousSession = f.calls[0].body.sessionId;
  const restarted = new Forwarder(f.options);
  await restarted.init();
  await restarted.poll();
  assert.equal(f.calls.length, 2);
  await appendFile(f.file, JSON.stringify(event({ occurred_at: new Date(Date.parse(event().occurred_at) + IDLE_MS + 1).toISOString() })) + "\n");
  await restarted.poll();
  assert.notEqual(f.calls[2].body.sessionId, previousSession);
  assert.match(f.calls[2].body.sessionId, /^devspace:host:workspace:/);
});

test("splits an outage backlog at the event-time idle gap before delivering the next segment", async (t) => {
  const f = await fixture(t);
  const gap = new Date(Date.parse(event().occurred_at) + IDLE_MS).toISOString();
  await writeFile(f.file, JSON.stringify(event()) + "\n" + JSON.stringify(event({ occurred_at: gap })) + "\n");
  f.tick(IDLE_MS);
  await f.forwarder.poll();
  assert.deepEqual(f.calls.map((call) => call.url.split("/").at(-1)), ["observe", "end", "observe"]);
  assert.equal(f.calls[1].body.sessionId, f.calls[0].body.sessionId);
  assert.notEqual(f.calls[2].body.sessionId, f.calls[0].body.sessionId);
  const restarted = new Forwarder(f.options);
  await restarted.init();
  await restarted.poll();
  assert.equal(f.calls.length, 3);
  assert.equal(Object.values(restarted.state.sessions)[0].id, f.calls[2].body.sessionId);
});

test("keeps a backlog gap checkpointed when session end fails before the next observation", async (t) => {
  let failEnd = true;
  const f = await fixture(t, (url, request) => url.endsWith("session/end")
    ? failEnd ? response(503) : response(200, { success: true }) : acknowledged(request));
  const first = JSON.stringify(event()) + "\n";
  const next = event({ occurred_at: new Date(Date.parse(event().occurred_at) + IDLE_MS).toISOString() });
  await writeFile(f.file, first + JSON.stringify(next) + "\n");
  f.tick(IDLE_MS);
  await f.forwarder.poll();
  assert.equal(f.calls.length, 2);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, Buffer.byteLength(first));
  failEnd = false;
  f.tick(1001);
  const restarted = new Forwarder(f.options);
  await restarted.init();
  await restarted.poll();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].body.event_id, next.event_id);
  assert.notEqual(f.calls[3].body.sessionId, f.calls[0].body.sessionId);
});

test("does not end sessions while delivery is failing or a segment has an incomplete tail", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event()) + "\n{");
  await f.forwarder.poll();
  f.tick(IDLE_MS);
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
});

test("preserves the checkpoint and pauses if a spool segment is truncated", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  const offset = f.forwarder.state.files["0001.jsonl"].offset;
  await writeFile(f.file, "");
  await f.forwarder.poll();
  assert.equal(f.forwarder.paused, true);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, offset);
});

test("whitelists and redacts event metadata, retaining benign paths and metrics", () => {
  const clean = sanitizeEvent(event({ tool: "write", details: { path: "token=fixture", content_bytes: 12, lines: 2, content: "raw source" }, tool_input: "raw payload" }));
  assert.deepEqual(clean.details, { path: "token=[redacted]", content_bytes: 12, lines: 2 });
  assert.ok(!JSON.stringify(clean).includes("raw source"));
  assert.ok(!JSON.stringify(clean).includes("raw payload"));
  const shell = sanitizeEvent(event({ tool: "bash", details: { command_summary: "curl --header 'Bearer fixture'; git status --short", output: "const secret = 'fixture';\nPASS", working_directory: "/tmp/example" } }));
  assert.equal(shell.details.command_summary, "curl; git status");
  assert.equal(shell.details.output, "PASS");
  assert.equal(sanitizeEvent(event({ tool: "other", details: { arbitrary: "value" } })).details, undefined);
});

test("keeps redacted machine and workspace identities distinct across restart", async (t) => {
  const f = await fixture(t);
  const raw = [
    event({ machine_id: "token=fixture-alpha" }), event({ machine_id: "token=fixture-beta" }),
    event({ workspace_id: "secret=fixture-alpha" }), event({ workspace_id: "secret=fixture-beta" }),
  ];
  await writeFile(f.file, raw.map((value) => JSON.stringify(value) + "\n").join(""));
  await f.forwarder.poll();
  assert.equal(new Set(f.calls.map((call) => call.body.sessionId)).size, 4);
  const checkpoint = await readFile(join(f.options.stateDir, "checkpoint.json"), "utf8");
  for (const value of ["fixture-alpha", "fixture-beta"]) {
    assert.ok(!checkpoint.includes(value));
    assert.ok(!JSON.stringify(f.calls).includes(value));
  }
  const restarted = new Forwarder(f.options);
  await restarted.init();
  await appendFile(f.file, JSON.stringify(event({ machine_id: raw[0].machine_id })) + "\n");
  await restarted.poll();
  assert.equal(f.calls[4].body.sessionId, f.calls[0].body.sessionId);
  const ordinary = sanitizeEvent(event());
  assert.equal(ordinary.machine_id, "host");
  assert.equal(ordinary.workspace_id, "workspace");
});

test("disabled CLI adds no spool or checkpoint and rejects broadly readable settings", async (t) => {
  const f = await fixture(t);
  const settings = join(f.dir, "settings.json");
  await writeFile(settings, JSON.stringify({ enabled: false, spoolDir: join(f.dir, "absent") }), { mode: 0o600 });
  await main(settings);
  assert.deepEqual(await readdir(f.options.stateDir), []);
  await assert.rejects(stat(join(f.dir, "absent")), { code: "ENOENT" });
  await chmod(settings, 0o644);
  await assert.rejects(readProtected(settings), /unprotected_settings/);
  assert.throws(() => new Forwarder({ apiUrl: "http://remote.example:3111" }), /loopback/);
});

test("starts the CLI through a symlinked entry path", async (t) => {
  const f = await fixture(t);
  const entry = join(f.dir, "entry.mjs"), settings = join(f.dir, "settings.json");
  await symlink(fileURLToPath(new URL("../src/index.mjs", import.meta.url)), entry);
  await writeFile(settings, '{"enabled":false}', { mode: 0o600 });
  const result = await promisify(execFile)(process.execPath, [entry, settings]);
  assert.match(result.stderr, /\[devspace-forwarder\] disabled/);
  assert.deepEqual(await readdir(f.options.stateDir), []);
});

test("pauses without advancing against a server that does not acknowledge the fixed UUID ID", async (t) => {
  for (const body of [{ observationId: "obs_legacy" }, { deduplicated: true }]) {
    const f = await fixture(t, () => response(201, body));
    await writeFile(f.file, JSON.stringify(event()) + "\n");
    await f.forwarder.poll();
    assert.equal(f.forwarder.paused, true);
    assert.equal(f.forwarder.state.files["0001.jsonl"], undefined);
    assert.match(f.alerts[0], /protocol_paused/);
  }
});

test("prunes removed segments from the durable checkpoint without resending retained events", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  await unlink(f.file);
  await f.forwarder.poll();
  assert.deepEqual(f.forwarder.state.files, {});
  const restarted = new Forwarder(f.options);
  await restarted.init();
  assert.deepEqual(restarted.state.files, {});
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await restarted.poll();
  assert.equal(f.calls.length, 2);
  assert.equal(restarted.paused, false);
});

test("dead-letters noncanonical and invalid calendar timestamps while retaining valid UTC events", async (t) => {
  const f = await fixture(t);
  const invalid = ["1", "Fri, 09 Oct 2026 00:00:00 GMT", "2026-02-31T00:00:00Z", "2026-10-09T25:00:00Z"];
  await writeFile(f.file, [...invalid.map((occurred_at) => event({ occurred_at })), event()]
    .map((value) => JSON.stringify(value) + "\n").join(""));
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal((await readFile(join(f.options.stateDir, "dead-letter.jsonl"), "utf8")).trim().split("\n").length, invalid.length);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
  assert.equal(sanitizeEvent(event({ occurred_at: "2026-10-09T00:00:00.001Z" })).occurred_at, "2026-10-09T00:00:00.001Z");
});
