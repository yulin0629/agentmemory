import { constants, createReadStream, realpathSync } from "node:fs";
import { chmod, mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_EVENT_BYTES, sanitizeEvent } from "./privacy.mjs";

export const IDLE_MS = 30 * 60 * 1000;
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function readProtected(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error("unprotected_settings");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(state) + "\n");
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function* readRecords(path, start, size) {
  if (start >= size) return;
  let pending = Buffer.alloc(0);
  let oversized = false;
  let offset = start;
  for await (const chunk of createReadStream(path, { start, end: size - 1, highWaterMark: 64 * 1024 })) {
    let at = 0;
    while (at < chunk.length) {
      const newline = chunk.indexOf(10, at);
      const end = newline === -1 ? chunk.length : newline + 1;
      const part = chunk.subarray(at, end);
      offset += part.length;
      if (pending.length + part.length > MAX_EVENT_BYTES) oversized = true;
      if (!oversized) pending = Buffer.concat([pending, part]);
      if (newline !== -1) {
        yield { nextOffset: offset, line: oversized ? undefined : pending.toString("utf8"), error: oversized ? "event_too_large" : undefined };
        pending = Buffer.alloc(0);
        oversized = false;
      }
      at = end;
    }
  }
  if (pending.length || oversized) yield { partial: true };
}

export class Forwarder {
  constructor({ spoolDir = join(homedir(), ".local/share/devspace/events"), stateDir = join(homedir(), ".local/share/agentmemory/devspace-forwarder"), apiUrl = "http://localhost:3111", token, fetchImpl = fetch, now = Date.now, alert = (message) => console.error(`[devspace-forwarder] ${message}`) } = {}) {
    const url = new URL(apiUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("api_url_must_be_loopback");
    this.spoolDir = spoolDir;
    this.stateDir = stateDir;
    this.apiUrl = url.origin;
    this.token = token;
    this.fetch = fetchImpl;
    this.now = now;
    this.alert = alert;
    this.checkpointPath = join(stateDir, "checkpoint.json");
    this.paused = false;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.running = false;
    this.checkpointPending = false;
  }

  async init() {
    const created = await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    if (created) {
      const existingParent = resolve(dirname(created));
      for (let directory = resolve(this.stateDir); ; directory = dirname(directory)) {
        await syncDirectory(directory);
        if (directory === existingParent) break;
      }
    }
    try {
      this.state = JSON.parse(await readProtected(this.checkpointPath));
      if (this.state.version !== 1 || !this.state.files || !this.state.sessions) throw new Error("invalid_checkpoint");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = { version: 1, files: {}, sessions: {} };
    }
    // Older checkpoints lack closure times; retain those sessions for seven days from migration.
    let migrated = false;
    for (const session of Object.values(this.state.sessions)) {
      if (session.ended && !Number.isFinite(session.endedAt)) {
        session.endedAt = this.now();
        migrated = true;
      }
    }
    if (migrated) await this.saveCheckpoint();
  }

  async saveCheckpoint() {
    this.checkpointPending = true;
    await saveState(this.checkpointPath, this.state);
    this.checkpointPending = false;
  }

  retry() {
    this.failures++;
    this.nextAttemptAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.failures - 1, 6));
  }

  async request(path, payload) {
    let response;
    try {
      response = await this.fetch(`${this.apiUrl}/agentmemory/${path}`, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      });
    } catch {
      this.retry();
      this.alert("delivery_retry network_or_timeout");
      return { retry: true };
    }
    if (response.status === 401 || response.status === 403) {
      this.paused = true;
      this.alert(`authentication_paused http_${response.status}; fix protected settings and restart`);
      return { retry: true };
    }
    if (response.status === 429 || response.status >= 500) {
      this.retry();
      const seconds = Number(response.headers.get("retry-after"));
      if (Number.isFinite(seconds) && seconds > 0) this.nextAttemptAt = Math.max(this.nextAttemptAt, this.now() + Math.min(seconds * 1000, 300_000));
      this.alert(`delivery_retry http_${response.status}`);
      return { retry: true };
    }
    if (response.status === 404) {
      if (path === "session/end") {
        let missing;
        try { missing = await response.json(); } catch { /* A missing route is not an unknown session. */ }
        if (missing?.error === "unknown session" && (!missing.sessionId || missing.sessionId === payload.sessionId)) {
          this.failures = 0;
          this.nextAttemptAt = 0;
          this.alert("session_end_unknown_session; treating as ended");
          return { success: true };
        }
      }
      this.paused = true;
      this.alert(`protocol_paused ${path} http_404; inspect service configuration`);
      return { retry: true };
    }
    if ([400, 413, 422].includes(response.status)) return { error: `rejected_http_${response.status}` };
    let body;
    try { body = await response.json(); } catch {
      this.retry();
      this.alert("delivery_retry invalid_acknowledgement");
      return { retry: true };
    }
    if (response.ok && (path === "observe"
      ? body?.observationId === `obs_event_${payload.event_id.toLowerCase().replace(/-/g, "")}` && body?.success !== false
      : body?.success === true)) {
      this.failures = 0;
      this.nextAttemptAt = 0;
      return { success: true };
    }
    if (response.ok && body?.success === false) return { error: `rejected_http_${response.status}` };
    this.paused = true;
    this.alert(`protocol_paused http_${response.status}; inspect service configuration`);
    return { retry: true };
  }

  async deadLetter(file, record, reason, event) {
    const handle = await open(join(this.stateDir, "dead-letter.jsonl"), "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify({ file, offset: record.nextOffset, reason, ...(event ? { event } : {}) }) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    this.alert(`dead_letter ${reason}`);
  }

  async sessionFor(event) {
    const key = JSON.stringify([event.machine_id, event.workspace_id]);
    let session = this.state.sessions[key];
    if (session && !session.ended && session.delivered
      && Date.parse(event.occurred_at) - session.lastActivityAt >= IDLE_MS) {
      if (!await this.endSession(session)) return;
    }
    if (!session || session.ended) {
      const segment_id = randomUUID();
      session = { segment_id, id: `devspace:${encodeURIComponent(event.machine_id)}:${encodeURIComponent(event.workspace_id)}:${segment_id}`, lastActivityAt: Date.parse(event.occurred_at), delivered: false, ended: false };
      this.state.sessions[key] = session;
      await this.saveCheckpoint();
    }
    return session;
  }

  async endSession(session) {
    const result = await this.request("session/end", { sessionId: session.id });
    if (!result.success) {
      if (result.error) { this.paused = true; this.alert(`session_end_paused ${result.error}`); }
      return false;
    }
    session.ended = true;
    session.endedAt = this.now();
    await this.saveCheckpoint();
    return true;
  }

  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      if (this.checkpointPending) await this.saveCheckpoint();
      const expired = Object.entries(this.state.sessions).filter(([, session]) =>
        session.ended && this.now() - session.endedAt > SESSION_RETENTION_MS);
      if (expired.length) {
        for (const [key] of expired) delete this.state.sessions[key];
        await this.saveCheckpoint();
      }
      if (this.paused || this.now() < this.nextAttemptAt) return;
      let files;
      try { files = (await readdir(this.spoolDir)).filter((file) => file.endsWith(".jsonl")).sort(); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      const present = new Set(files);
      const previousFiles = this.state.files;
      if (Object.keys(previousFiles).some((file) => !present.has(file))) {
        this.state.files = Object.fromEntries(Object.entries(previousFiles).filter(([file]) => present.has(file)));
        try { await this.saveCheckpoint(); }
        catch (error) { this.state.files = previousFiles; throw error; }
      }
      let partial = false;
      for (const file of files) {
        const path = join(this.spoolDir, file);
        let info;
        try { info = await stat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!info.isFile()) continue;
        const previous = this.state.files[file];
        if (previous && (previous.inode !== String(info.ino) || info.size < previous.offset)) {
          this.paused = true;
          this.alert("spool_replaced_or_truncated; checkpoint preserved");
          return;
        }
        for await (const record of readRecords(path, previous?.offset ?? 0, info.size)) {
          if (record.partial) { partial = true; continue; }
          let event;
          let error = record.error;
          if (!error) {
            try { event = sanitizeEvent(JSON.parse(record.line)); } catch { error = "invalid_event"; }
          }
          if (error) await this.deadLetter(file, record, error);
          else {
            const session = await this.sessionFor(event);
            if (!session) return;
            const acknowledgement = await this.request("observe", {
              event_id: event.event_id, sessionId: session.id,
              hookType: event.outcome.status === "success" ? "post_tool_use" : "post_tool_failure",
              project: event.project, cwd: event.cwd, timestamp: event.occurred_at,
              data: { tool_name: event.tool, tool_input: event.details ?? {}, tool_output: { outcome: event.outcome } },
            });
            if (acknowledgement.retry) return;
            if (acknowledgement.error) await this.deadLetter(file, record, acknowledgement.error, event);
            else session.delivered = true;
            session.lastActivityAt = Math.max(session.lastActivityAt, Date.parse(event.occurred_at));
          }
          this.state.files[file] = { inode: String(info.ino), offset: record.nextOffset };
          await this.saveCheckpoint();
        }
      }
      if (partial) return;
      const currentFiles = (await readdir(this.spoolDir)).filter((file) => file.endsWith(".jsonl")).sort();
      if (JSON.stringify(currentFiles) !== JSON.stringify(files)) return;
      for (const file of files) {
        const info = await stat(join(this.spoolDir, file));
        if (info.size !== (this.state.files[file]?.offset ?? 0)) return;
      }
      for (const session of Object.values(this.state.sessions)) {
        if (session.delivered && !session.ended && this.now() - session.lastActivityAt >= IDLE_MS) {
          if (!await this.endSession(session)) return;
        }
      }
    } finally { this.running = false; }
  }
}

export async function main(configPath = join(homedir(), ".config/agentmemory/devspace-forwarder.json")) {
  const config = JSON.parse(await readProtected(configPath));
  if (config.enabled !== true) { console.error("[devspace-forwarder] disabled"); return; }
  const token = config.tokenFile ? (await readProtected(resolve(config.tokenFile))).trim() : undefined;
  if (config.tokenFile && !token) throw new Error("empty_token_file");
  const forwarder = new Forwarder({ apiUrl: config.apiUrl, token });
  await forwarder.init();
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  while (!stopping) {
    try { await forwarder.poll(); } catch { console.error("[devspace-forwarder] local_io_error; checkpoint preserved"); }
    await new Promise((done) => setTimeout(done, 1000));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  main(process.argv[2]).catch(() => { console.error("[devspace-forwarder] startup_failed; inspect protected settings"); process.exitCode = 1; });
}
