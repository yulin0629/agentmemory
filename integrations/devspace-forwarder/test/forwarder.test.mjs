import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Forwarder, IDLE_MS, main, readProtected } from "../src/index.mjs";
import { sanitizeEvent } from "../src/privacy.mjs";

const event = (fields = {}) => ({
  schema_version: 1, event_id: randomUUID(), event_type: "tool.completed", occurred_at: "2026-10-09T00:00:00Z",
  machine_id: "host", workspace_id: "workspace", project: "example", cwd: "/tmp/example", tool: "read",
  outcome: { status: "success", duration_ms: 1 }, details: { path: "file.ts", read_bytes: 42 }, ...fields,
});
const response = (status = 201, body = { observationId: "obs_fixture" }, headers = {}) => new Response(JSON.stringify(body), { status, headers });

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
      return fetchImpl ? fetchImpl(url, request, calls) : response(url.endsWith("session/end") ? 200 : 201, url.endsWith("session/end") ? { success: true } : { observationId: "obs_fixture" });
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
    return response(201, { deduplicated: true });
  } });
  await restarted.init();
  await restarted.poll();
  assert.equal(f.calls[0].body.sessionId, f.calls[1].body.sessionId);
  assert.equal(f.calls[1].body.event_id, original.event_id);
  assert.equal(restarted.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

test("resumes at the last acknowledged event after interruption", async (t) => {
  const f = await fixture(t, (_url, _req, calls) => calls.length === 2 ? response(503) : response());
  const first = JSON.stringify(event()) + "\n";
  await writeFile(f.file, first + JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, Buffer.byteLength(first));
  const restarted = new Forwarder({ ...f.options, fetchImpl: async () => response() });
  await restarted.init();
  await restarted.poll();
  assert.equal(restarted.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

test("persists an allocated session again after a local checkpoint write failure", async (t) => {
  const f = await fixture(t, async (_url, _request, calls) => {
    const disk = JSON.parse(await readFile(join(f.options.stateDir, "checkpoint.json"), "utf8"));
    assert.equal(Object.values(disk.sessions)[0].id, calls[0].body.sessionId);
    return response();
  });
  await writeFile(f.file, JSON.stringify(event()) + "\n");
  await chmod(f.options.stateDir, 0o500);
  try { await assert.rejects(f.forwarder.poll()); } finally { await chmod(f.options.stateDir, 0o700); }
  assert.equal(f.calls.length, 0);
  const allocated = Object.values(f.forwarder.state.sessions)[0].id;
  await f.forwarder.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.sessionId, allocated);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

test("preserves human machine names without ambiguous session delimiters", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(event({ machine_id: "Mac: M4", workspace_id: "work:space" })) + "\n");
  await f.forwarder.poll();
  assert.match(f.calls[0].body.sessionId, /^devspace:Mac%3A%20M4:work%3Aspace:/);
});

test("quarantines malformed, oversized and rejected events without blocking later events", async (t) => {
  const f = await fixture(t, (_url, _req, calls) => calls.length === 1 ? response(422, { error: "invalid" }) : response());
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
  const f = await fixture(t, (_url, _request, calls) => calls.length === 1 ? new Response("request too large", { status: 413 }) : response());
  await writeFile(f.file, JSON.stringify(event()) + "\n" + JSON.stringify(event()) + "\n");
  await f.forwarder.poll();
  assert.equal(f.calls.length, 2);
  assert.match(await readFile(join(f.options.stateDir, "dead-letter.jsonl"), "utf8"), /rejected_http_413/);
  assert.equal(f.forwarder.state.files["0001.jsonl"].offset, (await stat(f.file)).size);
});

for (const status of [429, 500, 503]) test(`retries HTTP ${status} with backoff and no offset advancement`, async (t) => {
  const f = await fixture(t, (_url, _req, calls) => calls.length === 1 ? response(status, {}, { "retry-after": "3" }) : response());
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
