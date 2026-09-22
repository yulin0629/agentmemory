import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
		}, (error, stdout) => {
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