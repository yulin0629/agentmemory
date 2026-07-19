import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = join(resolve(__dirname, ".."), "plugin");

async function runHook(
  script: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
  responseDelayMs = 0,
) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      setTimeout(() => {
        if (res.destroyed) return;
        requests.push({
          path: req.url ?? "",
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ context: "remembered context" }));
      }, responseDelayMs);
    });
  });

  await new Promise<void>((resolveServer) => {
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server bind failed");

  try {
    const child = spawn(process.execPath, [join(pluginRoot, "scripts", script)], {
      env: {
        ...process.env,
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
        AGENTMEMORY_SECRET: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(JSON.stringify(payload));

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`${script} timed out`));
      }, 5000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });
    expect(exitCode, stderr).toBe(0);
    return { requests, stdout };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function codexPayload(event: string, extra: Record<string, unknown> = {}) {
  return {
    cwd: "C:\\repo",
    hook_event_name: event,
    model: "gpt-test",
    permission_mode: "default",
    session_id: "codex-session",
    transcript_path: null,
    ...extra,
  };
}

describe("Codex hook runtime contract", () => {
  it("SessionStart registers the session and emits Codex JSON context", async () => {
    const result = await runHook(
      "session-start.mjs",
      codexPayload("SessionStart", { source: "startup" }),
      { AGENTMEMORY_INJECT_CONTEXT: "true" },
    );
    expect(result.requests[0]).toMatchObject({
      path: "/agentmemory/session/start",
      body: { sessionId: "codex-session", cwd: "C:\\repo" },
    });
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
      };
    };
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "remembered context",
      },
    });
  });

  it("UserPromptSubmit waits long enough for a remote observation response", async () => {
    const result = await runHook(
      "prompt-submit.mjs",
      codexPayload("UserPromptSubmit", {
        turn_id: "turn-1",
        prompt: "hello",
      }),
      {},
      750,
    );
    expect(result.requests[0]?.path).toBe("/agentmemory/observe");
    expect(result.stdout).toBe("");
  });

  it.each([
    ["post-tool-use.mjs", "PostToolUse", { turn_id: "turn-1", tool_use_id: "tool-1", tool_name: "Bash", tool_input: { command: "pwd" }, tool_response: "ok" }, "/agentmemory/observe"],
    ["stop.mjs", "Stop", { turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "done" }, "/agentmemory/session/end"],
  ])("%s accepts Codex payload, sends telemetry, and stays silent", async (script, event, extra, path) => {
    const result = await runHook(script, codexPayload(event, extra));
    expect(result.requests[0]?.path).toBe(path);
    expect(result.stdout).toBe("");
  });
});
