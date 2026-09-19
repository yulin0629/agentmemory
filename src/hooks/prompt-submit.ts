#!/usr/bin/env node
import { resolveProject, hookCwd } from "./_project.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const SELECTIVE_CONTEXT_INJECT = process.env["AGENTMEMORY_SELECTIVE_CONTEXT_INJECT"] === "true";
const SELECTIVE_CONTEXT_TIMEOUT_MS = 1200;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

function contextPayload(data: Record<string, unknown>, context: string): string {
  if (
    typeof data.cursor_version === "string" ||
    data.hook_event_name === "UserPromptSubmit"
  ) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    });
  }
  return context;
}

function renderSelectedContext(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const response = result as { status?: unknown; spans?: unknown };
  if (response.status !== "selected" || !Array.isArray(response.spans)) return null;
  const texts = response.spans
    .map((span) => span && typeof span === "object" ? (span as { text?: unknown }).text : null)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  if (!texts.length) return null;
  return `[Verified background relevant to this request]\n${texts.map(text => `- ${text}`).join("\n")}`;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;

  const sessionId = ((data.session_id || data.sessionId || data.conversation_id) as string) || "unknown";

  const cwd = hookCwd(data) || process.cwd();
  const project = resolveProject(cwd);
  const prompt = typeof data.prompt === "string" ? data.prompt
    : typeof data.userPrompt === "string" ? data.userPrompt : "";

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "prompt_submit",
      sessionId,
      project,
      cwd,
      timestamp: new Date().toISOString(),
      data: { prompt },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  if (SELECTIVE_CONTEXT_INJECT && prompt.trim()) {
    try {
      const response = await fetch(`${REST_URL}/agentmemory/selective-context`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt, project }),
        signal: AbortSignal.timeout(SELECTIVE_CONTEXT_TIMEOUT_MS),
      });
      if (response.ok) {
        const context = renderSelectedContext(await response.json());
        if (context) process.stdout.write(contextPayload(data, context));
      }
    } catch {
      // A slow or unavailable judge must never block a user prompt.
    }
  }
  setTimeout(() => process.exit(0), 1500).unref();
}

main().catch(() => process.exit(0));
