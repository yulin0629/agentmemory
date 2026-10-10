import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const binary = process.env.AGENTMEMORY_TEST_III;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function eventually<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result !== undefined) return result; } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("isolated service did not become ready");
}

describe.skipIf(!binary)("isolated iii persistence and DevSpace forwarding", () => {
  it("serves observations, deduplicates after engine restart, and exposes the idle-session summary", async () => {
    expect(homedir()).toContain("agentmemory-test-home-");
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-devspace-iii-"));
    let engine: ChildProcess | undefined, worker: ChildProcess | undefined;
    const restPort = await freePort(), enginePort = await freePort(), streamPort = await freePort();
    const base = `http://127.0.0.1:${restPort}/agentmemory`;
    const env = { ...process.env, III_ENGINE_URL: `ws://127.0.0.1:${enginePort}`, III_REST_PORT: String(restPort),
      III_STREAM_PORT: String(streamPort), AGENTMEMORY_AUTO_COMPRESS: "false", CONSOLIDATION_ENABLED: "false", AGENTMEMORY_REFLECT: "false" };
    const config = join(dir, "iii.yaml");
    await writeFile(config, `workers:\n  - name: iii-worker-manager\n    config:\n      port: ${enginePort}\n      host: 127.0.0.1\n  - name: iii-http\n    config:\n      port: ${restPort}\n      host: 127.0.0.1\n  - name: iii-state\n    config:\n      adapter:\n        name: kv\n        config:\n          store_method: file_based\n          file_path: ./data/state_store.db\n  - name: iii-queue\n    config:\n      adapter:\n        name: builtin\n  - name: iii-pubsub\n    config:\n      adapter:\n        name: local\n  - name: iii-cron\n    config:\n      adapter:\n        name: kv\n  - name: iii-stream\n    config:\n      port: ${streamPort}\n      host: 127.0.0.1\n      adapter:\n        name: kv\n`);
    let engineLogs = "", workerLogs = "";
    const start = async () => {
      engine = spawn(binary!, ["--config", config, "--no-update-check"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      engine.stdout!.on("data", (data) => { engineLogs += data; });
      engine.stderr!.on("data", (data) => { engineLogs += data; });
      worker = spawn(process.execPath, ["--import", "tsx", resolve("test/fixtures/devspace-worker.ts")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
      worker.stdout!.on("data", (data) => { workerLogs += data; });
      worker.stderr!.on("data", (data) => { workerLogs += data; });
      await eventually(async () => (await fetch(`${base}/health`)).ok ? true : undefined);
    };
    const post = async (path: string, data: unknown) => {
      const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBeGreaterThanOrEqual(200); expect(response.status).toBeLessThan(300);
      return response.json() as Promise<any>;
    };
    try {
      await start();
      const event_id = randomUUID();
      const payload = { event_id, sessionId: "persistent-event-session", hookType: "post_tool_use", project: "example", cwd: "/tmp/example", timestamp: new Date().toISOString(), data: { tool_name: "read", tool_input: { path: "x".repeat(600) } } };
      const first = await post("observe", payload);
      expect(await post("observe", payload)).toMatchObject({ deduplicated: true, observationId: first.observationId });
      const second = await post("observe", { ...payload, event_id: randomUUID() });
      expect(second.observationId).not.toBe(first.observationId);
      await stop(worker);
      worker = spawn(process.execPath, ["--import", "tsx", resolve("test/fixtures/devspace-worker.ts")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
      worker.stdout!.on("data", (data) => { workerLogs += data; });
      worker.stderr!.on("data", (data) => { workerLogs += data; });
      await eventually(async () => (await fetch(`${base}/health`)).ok ? true : undefined);
      expect(await post("observe", payload)).toMatchObject({ deduplicated: true, observationId: first.observationId });
      // The existing iii file adapter acknowledges in memory and flushes every
      // five seconds. Verify disk contents before testing a full engine restart.
      await eventually(async () => {
        const storage = join(dir, "data/state_store.db");
        for (const file of await readdir(storage)) {
          const bytes = await readFile(join(storage, file));
          if (bytes.includes(Buffer.from(first.observationId)) && bytes.includes(Buffer.from(second.observationId))) return true;
        }
        return undefined;
      });
      await stop(worker); await stop(engine);
      await start();
      expect(await post("observe", payload)).toMatchObject({ deduplicated: true, observationId: first.observationId });
      const observations = await (await fetch(`${base}/observations?sessionId=persistent-event-session`)).json() as any;
      expect(observations.observations).toHaveLength(2);
      const { Forwarder, IDLE_MS } = await import("../integrations/devspace-forwarder/dist/forwarder.mjs");
      const spoolDir = join(dir, "spool"), stateDir = join(dir, "forwarder");
      await mkdir(spoolDir, { mode: 0o700 });
      let time = Date.now();
      const lines = ["open_workspace", "read", "show_changes", "write", "edit", "bash"].map((tool) => JSON.stringify({
        schema_version: 1, event_id: randomUUID(), event_type: "tool.completed", occurred_at: new Date(time).toISOString(),
        machine_id: "host", workspace_id: "workspace", project: "example", cwd: "/tmp/example", tool,
        outcome: { status: "success", duration_ms: 1 }, details: { path: "file.ts" },
      }));
      await writeFile(join(spoolDir, "events.jsonl"), lines.join("\n") + "\n");
      const forwarder = new Forwarder({ apiUrl: `http://127.0.0.1:${restPort}`, spoolDir, stateDir, now: () => time });
      await forwarder.init(); await forwarder.poll();
      const session = Object.values(forwarder.state.sessions)[0] as any;
      expect(session.delivered).toBe(true);
      const captured = await (await fetch(`${base}/observations?sessionId=${encodeURIComponent(session.id)}`)).json() as any;
      expect(captured.observations).toHaveLength(6);
      time += IDLE_MS;
      await forwarder.poll();
      expect(session.ended).toBe(true);
      const summary = await eventually(async () => {
        const body = await (await fetch(`${base}/sessions`)).json() as any;
        return body.sessions.find((s: any) => s.id === session.id)?.summary;
      });
      expect(summary.title).toBe("DevSpace tools");
      expect(summary.observationCount).toBe(6);
      expect(JSON.parse(await readFile(join(stateDir, "checkpoint.json"), "utf8")).sessions).toBeTruthy();
    } catch (error) {
      console.error("Isolated engine:", engineLogs.slice(-4000), "\nWorker:", workerLogs.slice(-4000));
      throw error;
    } finally { await stop(worker); await stop(engine); await rm(dir, { recursive: true, force: true }); }
  }, 90_000);
});
