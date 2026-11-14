import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/secret-store.ts
const SECRET_KEY = "AGENTMEMORY_SECRET";
function agentmemoryHomeDir() {
	return join(homedir(), ".agentmemory");
}
function secretFilePath() {
	return join(agentmemoryHomeDir(), "secret");
}
function usable(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("${") && trimmed.endsWith("}")) return "";
	return trimmed;
}
function unquote(value) {
	const quote = value[0];
	if ((quote === "\"" || quote === "'") && value.length > 1) {
		const close = value.indexOf(quote, 1);
		if (close !== -1) return value.slice(1, close);
	}
	const hash = value.indexOf(" #");
	return hash === -1 ? value : value.slice(0, hash).trim();
}
function readEnvFileSecret() {
	let content;
	try {
		content = readFileSync(join(agentmemoryHomeDir(), ".env"), "utf-8");
	} catch {
		return "";
	}
	if (typeof content !== "string") return "";
	let found = "";
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq).replace(/^export\s+/, "").trim() !== SECRET_KEY) continue;
		found = usable(unquote(trimmed.slice(eq + 1).trim()));
	}
	return found;
}
function readStoredSecret() {
	try {
		return usable(readFileSync(secretFilePath(), "utf-8"));
	} catch {
		return "";
	}
}
function isLoopbackUrl(url) {
	let hostname;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	const bare = hostname.replace(/^\[|\]$/g, "");
	return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}
function resolveClientSecret(baseUrl, env = process.env) {
	const fromEnv = usable(env[SECRET_KEY]);
	if (fromEnv) return fromEnv;
	if (!isLoopbackUrl(baseUrl)) return "";
	return readEnvFileSecret() || readStoredSecret();
}
//#endregion
//#region src/hooks/_selective-settings.ts
function selectiveSettings() {
	let local = {};
	try {
		local = JSON.parse(readFileSync(join(homedir(), ".config", "agentmemory", "selective-context.json"), "utf8"));
	} catch {}
	const url = process.env.AGENTMEMORY_URL || local?.url || "http://localhost:3111";
	return {
		enabled: process.env.AGENTMEMORY_SELECTIVE_CONTEXT_INJECT !== void 0 ? process.env.AGENTMEMORY_SELECTIVE_CONTEXT_INJECT === "true" : local?.enabled === true,
		url,
		secret: process.env.AGENTMEMORY_SECRET || local?.secret || resolveClientSecret(url),
		selectiveSecret: process.env.AGENTMEMORY_SELECTIVE_CONTEXT_SECRET || local?.selectiveSecret || "",
		owner: local?.owner
	};
}
//#endregion
//#region src/hooks/selective-client.ts
async function recallForPrompt(prompt, sessionId, cwd, transcriptPath) {
	if (!selectiveSettings().enabled || !prompt.trim()) return "";
	return new Promise((resolve) => {
		execFile(process.execPath, [fileURLToPath(new URL("./prompt-submit.mjs", import.meta.url))], {
			timeout: 6500,
			maxBuffer: 16384,
			env: {
				...process.env,
				AGENTMEMORY_SHARED_CLIENT: "1"
			}
		}, (error, stdout, stderr) => {
			if (process.env.AGENTMEMORY_RECALL_DIAGNOSTICS === "1") {
				for (const line of stderr.split("\n")) if (line.startsWith("AGENTMEMORY_RECALL ")) process.stderr.write(line + "\n");
				if (error) process.stderr.write(`AGENTMEMORY_RECALL ${JSON.stringify({ reason: error.killed ? "client_timeout" : "client_error" })}\n`);
			}
			if (error) return resolve("");
			try {
				const text = JSON.parse(stdout).hookSpecificOutput?.additionalContext;
				resolve(typeof text === "string" ? text : "");
			} catch {
				resolve("");
			}
		}).stdin?.end(JSON.stringify({
			prompt,
			session_id: sessionId,
			cwd,
			transcript_path: transcriptPath,
			hook_event_name: "UserPromptSubmit"
		}));
	});
}
if (process.argv.includes("--stdin")) (async () => {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > 65536) return;
	}
	const data = JSON.parse(input);
	if (typeof data.prompt !== "string" || typeof data.session_id !== "string" || typeof data.cwd !== "string") return;
	process.stdout.write(await recallForPrompt(data.prompt, data.session_id, data.cwd, data.transcript_path));
})().catch(() => {});
//#endregion
export { recallForPrompt, selectiveSettings };

//# sourceMappingURL=selective-client.mjs.map