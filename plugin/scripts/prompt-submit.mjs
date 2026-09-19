#!/usr/bin/env node
import { execSync } from "node:child_process";
import { basename } from "node:path";
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/prompt-submit.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const SELECTIVE_CONTEXT_INJECT = process.env["AGENTMEMORY_SELECTIVE_CONTEXT_INJECT"] === "true";
const SELECTIVE_CONTEXT_TIMEOUT_MS = 1200;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
function contextPayload(data, context) {
	if (typeof data.cursor_version === "string" || data.hook_event_name === "UserPromptSubmit") return JSON.stringify({ hookSpecificOutput: {
		hookEventName: "UserPromptSubmit",
		additionalContext: context
	} });
	return context;
}
function renderSelectedContext(result) {
	if (!result || typeof result !== "object") return null;
	const response = result;
	if (response.status !== "selected" || !Array.isArray(response.spans)) return null;
	const texts = response.spans.map((span) => span && typeof span === "object" ? span.text : null).filter((text) => typeof text === "string" && text.trim().length > 0);
	if (!texts.length) return null;
	return `[Verified background relevant to this request]\n${texts.map((text) => `- ${text}`).join("\n")}`;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || data.conversation_id || "unknown";
	const cwd = hookCwd(data) || process.cwd();
	const project = resolveProject(cwd);
	const prompt = typeof data.prompt === "string" ? data.prompt : typeof data.userPrompt === "string" ? data.userPrompt : "";
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "prompt_submit",
			sessionId,
			project,
			cwd,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: { prompt }
		}),
		signal: AbortSignal.timeout(3e3)
	}).catch(() => {});
	if (SELECTIVE_CONTEXT_INJECT && prompt.trim()) try {
		const response = await fetch(`${REST_URL}/agentmemory/selective-context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				prompt,
				project
			}),
			signal: AbortSignal.timeout(SELECTIVE_CONTEXT_TIMEOUT_MS)
		});
		if (response.ok) {
			const context = renderSelectedContext(await response.json());
			if (context) process.stdout.write(contextPayload(data, context));
		}
	} catch {}
	setTimeout(() => process.exit(0), 1500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=prompt-submit.mjs.map