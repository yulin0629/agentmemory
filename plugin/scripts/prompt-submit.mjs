#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
//#region src/hooks/_project.ts
/** Selective memory identity is separate from legacy human-readable project labels. */
function resolveContextProjectId(cwd) {
	const hash = (value) => `project:${createHash("sha256").update(value).digest("hex")}`;
	const explicit = process.env["AGENTMEMORY_CONTEXT_PROJECT"]?.trim();
	if (explicit) return hash(`explicit:${explicit}`);
	const git = (args) => execFileSync("git", args, {
		cwd,
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		],
		timeout: 500,
		encoding: "utf8"
	}).trim();
	try {
		const remote = git([
			"remote",
			"get-url",
			"origin"
		]);
		const scp = /^[A-Za-z]:[\\/]/.test(remote) || remote.includes("::") ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
		const url = new URL(remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : "file:///unshared");
		if ([
			"https:",
			"http:",
			"ssh:"
		].includes(url.protocol) && url.hostname) {
			const port = url.protocol === "ssh:" && url.port === "22" ? "" : url.port;
			const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
			return hash(`remote:${url.hostname.toLowerCase()}${port ? `:${port}` : ""}${path}`);
		}
	} catch {}
	let path = cwd;
	try {
		path = resolve(cwd, git(["rev-parse", "--git-common-dir"]));
	} catch {}
	try {
		path = realpathSync(path);
	} catch {
		path = resolve(path);
	}
	return hash(`local:${hostname()}:${path}`);
}
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
//#region src/functions/privacy.ts
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const SECRET_PATTERN_SOURCES = [
	/(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
	/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
	/sk-proj-[A-Za-z0-9\-_]{20,}/g,
	/(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g,
	/sk-ant-[A-Za-z0-9\-_]{20,}/g,
	/gh[pus]_[A-Za-z0-9]{36,}/g,
	/github_pat_[A-Za-z0-9_]{22,}/g,
	/xoxb-[A-Za-z0-9\-]+/g,
	/AKIA[0-9A-Z]{16}/g,
	/AIza[A-Za-z0-9\-_]{35}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/npm_[A-Za-z0-9]{36}/g,
	/glpat-[A-Za-z0-9\-_]{20,}/g,
	/dop_v1_[A-Za-z0-9]{64}/g
];
function stripPrivateData(input) {
	let result = input.replace(PRIVATE_TAG_RE, "[REDACTED]");
	for (const source of SECRET_PATTERN_SOURCES) {
		const pattern = new RegExp(source.source, source.flags);
		result = result.replace(pattern, "[REDACTED_SECRET]");
	}
	return result;
}
//#endregion
//#region src/hooks/_previous-context.ts
/** Only same-session dialogue is eligible; tool results and reasoning are excluded. */
function previousContext(path, sessionId, prompt) {
	if (typeof path !== "string" || !path.endsWith(".jsonl") || sessionId === "unknown") return "";
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return "";
		const head = Buffer.alloc(Math.min(stat.size, 8192));
		readSync(fd, head, 0, head.length, 0);
		let codexSession = false;
		try {
			const meta = JSON.parse(head.toString("utf8").split("\n")[0]);
			if (meta.type === "session_meta") {
				if (meta.payload?.id !== sessionId) return "";
				codexSession = true;
			}
		} catch {}
		const tail = Buffer.alloc(Math.min(stat.size, 65536));
		const offset = stat.size - tail.length;
		readSync(fd, tail, 0, tail.length, offset);
		const lines = tail.toString("utf8").split("\n");
		if (offset > 0) lines.shift();
		const messages = [];
		for (const line of lines) {
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			const message = codexSession ? row.type === "response_item" && row.payload?.type === "message" ? row.payload : null : row.sessionId === sessionId && ["user", "assistant"].includes(row.type) ? row.message : null;
			if (!message || !["user", "assistant"].includes(message.role)) continue;
			const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((block) => [
				"text",
				"input_text",
				"output_text"
			].includes(block.type ?? "") && typeof block.text === "string").map((block) => block.text).join("\n") : "";
			if (text.trim()) messages.push({
				role: message.role,
				text: stripPrivateData(text)
			});
		}
		const last = messages.at(-1);
		if (last?.role === "user" && last.text.trim() === stripPrivateData(prompt).trim()) messages.pop();
		const selected = [];
		for (const message of messages.slice(-4).reverse()) {
			if (JSON.stringify([message, ...selected]).length > 8e3) break;
			selected.unshift(message);
		}
		return selected.length ? JSON.stringify(selected) : "";
	} catch {
		return "";
	} finally {
		if (fd !== void 0) closeSync(fd);
	}
}
//#endregion
//#region src/state/explicit-memory.ts
/** Only an explicit, top-level save command enters the knowledge-writing path. */
function isRememberRequest(prompt) {
	return typeof prompt === "string" && /^(?:(?:請)?記住|確認取代)[：:]/u.test(prompt.trim());
}
//#endregion
//#region src/hooks/_selective-settings.ts
function selectiveSettings() {
	let local = {};
	try {
		local = JSON.parse(readFileSync(join(homedir(), ".config", "agentmemory", "selective-context.json"), "utf8"));
	} catch {}
	return {
		enabled: process.env.AGENTMEMORY_SELECTIVE_CONTEXT_INJECT !== void 0 ? process.env.AGENTMEMORY_SELECTIVE_CONTEXT_INJECT === "true" : local?.enabled === true,
		url: process.env.AGENTMEMORY_URL || local?.url || "http://localhost:3111",
		secret: process.env.AGENTMEMORY_SECRET || local?.secret || "",
		selectiveSecret: process.env.AGENTMEMORY_SELECTIVE_CONTEXT_SECRET || local?.selectiveSecret || "",
		owner: local?.owner
	};
}
//#endregion
//#region src/hooks/prompt-submit.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const settings = selectiveSettings();
const REST_URL = settings.url;
const SECRET = settings.secret;
const SHARED_CLIENT = process.env.AGENTMEMORY_SHARED_CLIENT === "1";
const SELECTIVE_CONTEXT_INJECT = settings.enabled && (settings.owner !== "agent-hooks" || SHARED_CLIENT);
const SELECTIVE_CONTEXT_TIMEOUT_MS = 2e3;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	if (settings.selectiveSecret) h["X-AgentMemory-Selective-Secret"] = settings.selectiveSecret;
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
	if (response.spans.length === 0 || response.spans.length > 2) return null;
	const texts = response.spans.map((span) => span && typeof span === "object" ? span.text : null);
	if (!texts.every((text) => typeof text === "string" && text.trim().length > 0)) return null;
	if (texts.reduce((total, text) => total + text.length, 0) > 1200 || new Set(texts).size !== texts.length) return null;
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
	const projectId = SELECTIVE_CONTEXT_INJECT ? resolveContextProjectId(cwd) : void 0;
	const prompt = typeof data.prompt === "string" ? data.prompt : typeof data.userPrompt === "string" ? data.userPrompt : "";
	const observation = SHARED_CLIENT && !isRememberRequest(prompt) ? Promise.resolve(null) : fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "prompt_submit",
			sessionId,
			project,
			cwd,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				prompt,
				...projectId ? { contextProjectId: projectId } : {},
				...SELECTIVE_CONTEXT_INJECT && isRememberRequest(prompt) ? { explicitMemoryRequest: true } : {}
			}
		}),
		signal: AbortSignal.timeout(SELECTIVE_CONTEXT_INJECT && isRememberRequest(prompt) ? 5e3 : 3e3)
	});
	if (SELECTIVE_CONTEXT_INJECT && isRememberRequest(prompt)) {
		let notice = "[Memory update] Storage could not be confirmed. Do not claim this request was saved.";
		try {
			const response = await observation;
			const saved = (response?.ok ? await response.json() : null)?.knowledgeCapture;
			if (saved?.success && saved.action === "replaced" && saved.status === "active") notice = "[Memory update] The exact old project rule was superseded by the new rule. Both sources and their replacement link are retained. Only the new rule is eligible for future recall.";
			else if (saved?.success && saved.status === "active") notice = "[Memory update] This rule is stored for this project, with its source event. Future recall is relevance-filtered; this is not a global rule.";
			else if (saved?.success && saved.status === "candidate") notice = "[Memory update] This rule is a candidate only. It is not active and will not be automatically recalled.";
			else if (saved?.success) notice = "[Memory update] An existing inactive record was left unchanged. This request did not reactivate it.";
		} catch {}
		process.stdout.write(contextPayload(data, notice));
		return;
	}
	observation.catch(() => {});
	if (SELECTIVE_CONTEXT_INJECT && prompt.trim()) try {
		const response = await fetch(`${REST_URL}/agentmemory/selective-context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				prompt,
				project,
				projectId,
				previous: previousContext(data.transcript_path, sessionId, prompt)
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