#!/usr/bin/env node
import { resolveProject, resolveContextProjectId, hookCwd } from "./_project.js";
import { previousContext } from "./_previous-context.js";
import { isRememberRequest } from "../state/explicit-memory.js";
import { selectiveSettings } from "./_selective-settings.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const settings = selectiveSettings();
const REST_URL = settings.url;
const SECRET = settings.secret;
const SHARED_CLIENT = process.env.AGENTMEMORY_SHARED_CLIENT === "1";
const SELECTIVE_CONTEXT_INJECT = settings.enabled && (settings.owner !== "agent-hooks" || SHARED_CLIENT);
const SELECTIVE_CONTEXT_TIMEOUT_MS = 2000;

// Diagnostic metadata travels separately from model-facing stdout. Never log content or errors verbatim.
function diagnostic(reason: string, fields: Record<string, string | number> = {}) {
  if (process.env.AGENTMEMORY_RECALL_DIAGNOSTICS === "1") {
    process.stderr.write(`AGENTMEMORY_RECALL ${JSON.stringify({ reason, ...fields })}\n`);
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  if (settings.selectiveSecret) h["X-AgentMemory-Selective-Secret"] = settings.selectiveSecret;
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
  if (response.spans.length === 0 || response.spans.length > 2) return null;
  const texts = response.spans
    .map((span) => span && typeof span === "object" ? (span as { text?: unknown }).text : null);
  if (!texts.every((text): text is string => typeof text === "string" && text.trim().length > 0)) return null;
  if (texts.reduce((total, text) => total + text.length, 0) > 1200
    || new Set(texts).size !== texts.length) return null;
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
  const projectId = SELECTIVE_CONTEXT_INJECT ? resolveContextProjectId(cwd) : undefined;
  const prompt = typeof data.prompt === "string" ? data.prompt
    : typeof data.userPrompt === "string" ? data.userPrompt : "";

  const observation = SHARED_CLIENT && !isRememberRequest(prompt) ? Promise.resolve(null) : fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "prompt_submit",
      sessionId,
      project,
      cwd,
      timestamp: new Date().toISOString(),
      data: { prompt, ...(projectId ? { contextProjectId: projectId } : {}), ...(SELECTIVE_CONTEXT_INJECT && isRememberRequest(prompt)
        ? { explicitMemoryRequest: true } : {}) },
    }),
    signal: AbortSignal.timeout(SELECTIVE_CONTEXT_INJECT && isRememberRequest(prompt) ? 5000 : 3000),
  });

  if (SELECTIVE_CONTEXT_INJECT && isRememberRequest(prompt)) {
    let notice = "[Memory update] Storage could not be confirmed. Do not claim this request was saved.";
    try {
      const response = await observation;
      const result = response?.ok ? await response.json() as {
        knowledgeCapture?: { success?: boolean; status?: string; action?: string; knowledgeId?: string };
      } : null;
      const saved = result?.knowledgeCapture;
      diagnostic(saved?.success ? "capture_acknowledged" : "capture_unconfirmed");
      if (saved?.success && saved.action === "replaced" && saved.status === "active") {
        notice = "[Memory update] The exact old project rule was superseded by the new rule. Both sources and their replacement link are retained. Only the new rule is eligible for future recall.";
      } else if (saved?.success && saved.status === "active") {
        notice = "[Memory update] This rule is stored for this project, with its source event. Future recall is relevance-filtered; this is not a global rule.";
      } else if (saved?.success && saved.status === "candidate") {
        notice = "[Memory update] This rule is a candidate only. It is not active and will not be automatically recalled.";
      } else if (saved?.success) {
        notice = "[Memory update] An existing inactive record was left unchanged. This request did not reactivate it.";
      }
    } catch { diagnostic("capture_unconfirmed"); }
    process.stdout.write(contextPayload(data, notice));
    return;
  }
  observation.catch(() => {});

  if (SELECTIVE_CONTEXT_INJECT && prompt.trim()) {
    const started = performance.now();
    try {
      const response = await fetch(`${REST_URL}/agentmemory/selective-context`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt, project, projectId,
          previous: previousContext(data.transcript_path, sessionId, prompt) }),
        signal: AbortSignal.timeout(SELECTIVE_CONTEXT_TIMEOUT_MS),
      });
      if (response.ok) {
        const result = await response.json();
        const context = renderSelectedContext(result);
        diagnostic(context ? "selected" : result?.status === "empty" ? "api_empty"
          : result?.status === "unavailable" ? "api_unavailable" : "invalid_response", {
          http_status: response.status,
          api_ms: Math.round(performance.now() - started),
          selected_spans: context ? result.spans.length : 0,
          ...(Number.isSafeInteger(result?.catalogRevision) ? { catalog_revision: result.catalogRevision } : {}),
        });
        if (context) process.stdout.write(contextPayload(data, context));
      } else diagnostic("http_error", { http_status: response.status, api_ms: Math.round(performance.now() - started) });
    } catch (error) {
      diagnostic(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
        ? "api_timeout" : error instanceof SyntaxError ? "invalid_response" : "network_error",
      { api_ms: Math.round(performance.now() - started) });
      // A slow or unavailable judge must never block a user prompt.
    }
  } else diagnostic("disabled_or_empty_prompt");
  setTimeout(() => process.exit(0), 1500).unref();
}

main().catch(() => process.exit(0));
